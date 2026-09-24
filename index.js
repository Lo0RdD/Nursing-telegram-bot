const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const http = require('http');
const pdfParse = require('pdf-parse');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// هيكل الذاكرة المطورة (جاهز للتحويل لقاعدة بيانات لاحقاً)
const db = {
  users: {}, // تخزين تفضيلات المستخدمين
  history: {}, // سجل المحادثات
  quizzes: {} // تتبع الكويزات النشطة
};

const systemPrompt = `أنت رفيق معرفي أكاديمي محترف في مجال التمريض. تقدم إجابات دقيقة، علمية، ومنظمة لطلبة التمريض والمهتمين بالقطاع الصحي.`;

// دالة تقسيم وإرسال الرسائل الطويلة لتجنب حدود تيليجرام
async function sendLongMessage(chatId, text, extra = {}) {
  const MAX_LENGTH = 4000;
  if (!text) return;
  
  if (text.length <= MAX_LENGTH) {
    try {
      return await bot.sendMessage(chatId, text, extra);
    } catch (e) {
      // لو فشل بـ Markdown، أرسله كنص عادي تفادياً للتعطل
      delete extra.parse_mode;
      return await bot.sendMessage(chatId, text, extra);
    }
  }

  const parts = [];
  let currentIndex = 0;
  while (currentIndex < text.length) {
    parts.push(text.substring(currentIndex, currentIndex + MAX_LENGTH));
    currentIndex += MAX_LENGTH;
  }

  for (const part of parts) {
    try {
      await bot.sendMessage(chatId, part, extra);
    } catch (e) {
      delete extra.parse_mode;
      await bot.sendMessage(chatId, part, extra);
    }
  }
}

// دالة الاتصال المضمونة بـ Groq API
async function callGroqAPI(messages, model = "openai/gpt-oss-120b", maxTokens = 1500) {
  try {
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: model,
        messages: messages,
        temperature: 0.4,
        max_tokens: maxTokens
      },
      {
        headers: {
          "Authorization": `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 20000
      }
    );
    return response.data.choices[0]?.message?.content || null;
  } catch (error) {
    console.error(`Error on model ${model}:`, error.message);
    return null;
  }
}

// 1. أمر البداية /start (لا يحذف السجل القديم بل يرحب بالمستخدم فقط)
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!db.history[chatId]) db.history[chatId] = [];

  const welcomeMessage = `أهلاً بك مجدداً في منصة التمريض الأكاديمية! 🩺\n\n` +
    `• يمكنك مناقشة أي موضوع علمي أو إرسال ملزمة PDF للتلخيص.\n` +
    `• اكتب /quiz في أي وقت لاختبارك بناءً على آخر النقاشات.\n` +
    `• ابدأ لطفاَ بطرح سؤالك أو رفع ملفك الدراسي!`;

  sendLongMessage(chatId, welcomeMessage);
});

// 2. أمر /quiz الذكي
bot.onText(/\/quiz/, async (msg) => {
  const chatId = msg.chat.id;
  let typingInterval = setInterval(() => { bot.sendChatAction(chatId, 'typing').catch(()=>{}); }, 3000);

  try {
    const history = db.history[chatId] || [];
    if (history.length === 0) {
      clearInterval(typingInterval);
      return sendLongMessage(chatId, "لم نناقش أي موضوع بعد! أرسل سؤالاً أو ملفاً أولاً، ثم اطلب /quiz.");
    }

    const recentContext = history.slice(-6);
    const quizPrompt = `Based SPECIFICALLY on the MOST RECENT nursing topics/documents in our conversation above, generate ONE high-yield academic NCLEX-style nursing multiple-choice question (MCQ) in ENGLISH. 
Provide 4 options (A, B, C, D). Clearly specify the correct answer at the very end in a hidden format or keep track so you can validate user answers (e.g., "Correct Answer: B"). Provide a brief explanation.`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...recentContext,
      { role: "user", content: quizPrompt }
    ];

    let quizText = await callGroqAPI(messages, "openai/gpt-oss-120b", 1000);
    if (!quizText) {
      quizText = await callGroqAPI(messages, "llama-3.3-70b-versatile", 1000);
    }

    clearInterval(typingInterval);

    if (quizText) {
      db.history[chatId].push({ role: "assistant", content: quizText });
      sendLongMessage(chatId, `📝 **Nursing Quiz (NCLEX-Style):**\n\n${quizText}`);
    } else {
      sendLongMessage(chatId, "حدث خطأ أثناء توليد الكويز. حاول مرة أخرى.");
    }
  } catch (e) {
    clearInterval(typingInterval);
    sendLongMessage(chatId, "حدث خطأ غير متوقع.");
  }
});

// 3. معالجة ملفات الـ PDF
bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const doc = msg.document;

  if (!doc.mime_type || !doc.mime_type.includes('pdf')) {
    return sendLongMessage(chatId, "يرجى إرسال ملفات بصيغة PDF فقط.");
  }

  let typingInterval = setInterval(() => { bot.sendChatAction(chatId, 'typing').catch(()=>{}); }, 3000);

  try {
    const fileLink = await bot.getFileLink(doc.file_id);
    const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
    const pdfData = await pdfParse(response.data);

    const pdfText = pdfData.text.trim();
    if (!pdfText || pdfText.length < 20) {
      clearInterval(typingInterval);
      return sendLongMessage(chatId, "عذراً، لم أستطع استخراج النصوص من هذا الملف (قد يكون مسحوباً كصور).");
    }

    // تجهيز النص للاستيعاب الذكي
    const trimmedText = pdfText.substring(0, 5000);
    const summaryPrompt = `إليك محتوى من ملزمة PDF أرسلها الطالب:\n\n${trimmedText}\n\nقدم تلخيصاً أكاديمياً شاملاً لأهم المفاهيم، النقاط السريرية، والتدخلات التمريضية المرتبطة بهذا المحتوى.`;

    const summary = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: summaryPrompt }], "openai/gpt-oss-120b", 2000);

    clearInterval(typingInterval);

    if (summary) {
      if (!db.history[chatId]) db.history[chatId] = [];
      db.history[chatId].push({ role: "user", content: `[ملف PDF مرفق - محتوى مستخرج]` });
      db.history[chatId].push({ role: "assistant", content: summary });

      if (db.history[chatId].length > 12) db.history[chatId] = db.history[chatId].slice(-12);

      sendLongMessage(chatId, `📄 **تلخيص الملزمة الأكاديمية:**\n\n${summary}\n\n---\n💡 *يمكنك الآن طرح أسئلة تفصيلية حول الملزمة أو إرسال /quiz لاختبارك منها!*`);
    } else {
      sendLongMessage(chatId, "تعذر تلخيص الملزمة حالياً.");
    }
  } catch (e) {
    clearInterval(typingInterval);
    console.error("PDF Error:", e.message);
    sendLongMessage(chatId, "حدث خطأ أثناء معالجة ملف الـ PDF.");
  }
});

// 4. المحادثة النصية العامة
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text;

  if (!userMessage || userMessage.startsWith('/') || msg.document) return;

  let typingInterval = setInterval(() => { bot.sendChatAction(chatId, 'typing').catch(()=>{}); }, 3000);

  try {
    if (!db.history[chatId]) db.history[chatId] = [];

    const tempMessages = [
      { role: "system", content: systemPrompt },
      ...db.history[chatId],
      { role: "user", content: userMessage }
    ];

    let content = await callGroqAPI(tempMessages, "openai/gpt-oss-120b", 2000);
    let usedModel = "openai/gpt-oss-120b";

    if (!content) {
      content = await callGroqAPI(tempMessages, "llama-3.3-70b-versatile", 2000);
      usedModel = "llama-3.3-70b-versatile";
    }

    clearInterval(typingInterval);

    if (content) {
      db.history[chatId].push({ role: "user", content: userMessage });
      db.history[chatId].push({ role: "assistant", content: content });

      if (db.history[chatId].length > 12) db.history[chatId] = db.history[chatId].slice(-12);

      sendLongMessage(chatId, `${content}\n\n---\n🤖 النموذج: \`${usedModel}\``);
    } else {
      sendLongMessage(chatId, "عذراً، لم يتلق البوت استجابة من السيرفر. أعد إرسال رسالتك.");
    }
  } catch (e) {
    clearInterval(typingMarkdownError => {});
    clearInterval(typingInterval);
    sendLongMessage(chatId, "حدث خطأ في النظام.");
  }
});

// سيرفر الـ Port لخدمة Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot active');
}).listen(PORT);
