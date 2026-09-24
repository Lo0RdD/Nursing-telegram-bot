const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const http = require('http');
const pdfParse = require('pdf-parse');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const userHistory = {};
const systemPrompt = `أنت رفيق معرفي أكاديمي لمستخدم بمسار موسوعي يدرس التمريض. أجب بدقة وعمق علمي وبشكل مباشر لأغراض التعليم والبحث الأكاديمي.`;

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
        timeout: 15000
      }
    );
    return response.data.choices[0]?.message?.content || null;
  } catch (error) {
    console.error(`Error on model ${model}:`, error.message);
    return null;
  }
}

// 1. أمر البداية /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userHistory[chatId] = [];
  bot.sendMessage(chatId, "أهلاً بك! البوت جاهز الآن لمساعدتك:\n\n• اسأل عن أي موضوع تمريضي أو أكاديمي.\n• أرسل أي ملف ملزمة بصيغة PDF وسأقرأه وألخصه لك.\n• أرسل /quiz في أي وقت لاختبارك في أحدث موضوع تناقشنا فيه (ثم أجب بحرف A أو B أو C أو D).");
});

// 2. أمر /quiz (مع حفظ السؤال بالذاكرة)
bot.onText(/\/quiz/, async (msg) => {
  const chatId = msg.chat.id;
  let typingInterval = setInterval(() => { bot.sendChatAction(chatId, 'typing').catch(()=>{}); }, 3000);

  try {
    const history = userHistory[chatId] || [];
    if (history.length === 0) {
      clearInterval(typingInterval);
      return bot.sendMessage(chatId, "لم نناقش أي موضوع بعد! أرسل ملفاً أو اطرح سؤالاً أولاً، ثم أرسل /quiz.");
    }

    const recentContext = history.slice(-4);
    const quizPrompt = `Based SPECIFICALLY on the MOST RECENT nursing topics/documents in our conversation above, generate ONE high-yield academic NCLEX-style nursing multiple-choice question (MCQ) in ENGLISH. 
Provide 4 options (A, B, C, D). Do NOT provide the correct answer or explanation yet. Ask the user to choose (A, B, C, or D).`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...recentContext,
      { role: "user", content: quizPrompt }
    ];

    let quizText = await callGroqAPI(messages, "openai/gpt-oss-120b", 800);
    if (!quizText) {
      quizText = await callGroqAPI(messages, "llama-3.3-70b-versatile", 800);
    }

    clearInterval(typingInterval);

    if (quizText) {
      if (!userHistory[chatId]) userHistory[chatId] = [];
      userHistory[chatId].push({ role: "user", content: "Generate a quiz for me." });
      userHistory[chatId].push({ role: "assistant", content: quizText });

      bot.sendMessage(chatId, `📝 **Nursing Quiz (Context-Based):**\n\n${quizText}`, { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId, "حدث خطأ أثناء توليد الكويز. يرجى المحاولة مرة أخرى.");
    }
  } catch (e) {
    clearInterval(typingInterval);
    bot.sendMessage(chatId, "حدث خطأ غير متوقع أثناء توليد الكويز.");
  }
});

// 3. قراءة ومعالجة ملفات الـ PDF
bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const doc = msg.document;

  if (!doc.mime_type || !doc.mime_type.includes('pdf')) {
    return bot.sendMessage(chatId, "يرجى إرسال ملفات بصيغة PDF فقط.");
  }

  let typingInterval = setInterval(() => { bot.sendChatAction(chatId, 'typing').catch(()=>{}); }, 3000);

  try {
    const fileLink = await bot.getFileLink(doc.file_id);
    const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
    const pdfData = await pdfParse(response.data);

    const pdfText = pdfData.text.trim();
    if (!pdfText || pdfText.length < 20) {
      clearInterval(typingInterval);
      return bot.sendMessage(chatId, "عذراً، لم أستطع استخراج النصوص من هذا الملف (قد يكون عبارة عن صور مسحوبة ضوئياً).");
    }

    const trimmedText = pdfText.substring(0, 4000);
    const summaryPrompt = `لقد أرسل المستخدم ملف PDF أكاديمي في التمريض. إليك محتوى الملزمة:\n\n${trimmedText}\n\nيرجى تقديم تلخيص أكاديمي شامل لأهم المفاهيم، النقاط التمريضية، والتدخلات المذكورة في هذا الملف.`;

    const summary = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: summaryPrompt }]);

    clearInterval(typingInterval);

    if (summary) {
      if (!userHistory[chatId]) userHistory[chatId] = [];
      userHistory[chatId].push({ role: "user", content: `محتوى ملزمة PDF: ${trimmedText.substring(0, 1000)}` });
      userHistory[chatId].push({ role: "assistant", content: summary });

      if (userHistory[chatId].length > 10) userHistory[chatId] = userHistory[chatId].slice(-10);

      bot.sendMessage(chatId, `📄 **ملخص ملزمة الـ PDF:**\n\n${summary}\n\n---\n💡 *يمكنك الآن طرح أي أسئلة حول الملف أو إرسال /quiz لتوليد أسئلة منه!*`);
    } else {
      bot.sendMessage(chatId, "تعذر تحليل ملف الـ PDF حالياً، يرجى المحاولة لاحقاً.");
    }
  } catch (e) {
    clearInterval(typingInterval);
    console.error("PDF Parsing Error:", e.message);
    bot.sendMessage(chatId, "حدث خطأ أثناء معالجة ملف الـ PDF.");
  }
});

// 4. المحادثة النصية العامة والإجابة على الـ Quiz
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text;

  // تجاهل الأوامر وملفات الـ PDF لئلا تتداخل مع المعالج الخاص بها
  if (!userMessage || userMessage.startsWith('/') || msg.document) return;

  let typingInterval = setInterval(() => { bot.sendChatAction(chatId, 'typing').catch(()=>{}); }, 3000);

  try {
    if (!userHistory[chatId]) userHistory[chatId] = [];

    const tempMessages = [
      { role: "system", content: systemPrompt },
      ...userHistory[chatId],
      { role: "user", content: userMessage }
    ];

    let content = await callGroqAPI(tempMessages, "openai/gpt-oss-120b", 1500);
    let usedModel = "openai/gpt-oss-120b";

    if (!content) {
      content = await callGroqAPI(tempMessages, "llama-3.3-70b-versatile", 1500);
      usedModel = "llama-3.3-70b-versatile";
    }

    clearInterval(typingInterval);

    if (content) {
      userHistory[chatId].push({ role: "user", content: userMessage });
      userHistory[chatId].push({ role: "assistant", content: content });

      if (userHistory[chatId].length > 10) userHistory[chatId] = userHistory[chatId].slice(-10);

      await bot.sendMessage(chatId, `${content}\n\n---\n🤖 النموذج المستخدم: \`${usedModel}\``, { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId, "عذراً، لم يتلق البوت استجابة من السيرفر. يرجى إعادة محاولة إرسال رسالتك.");
    }
  } catch (e) {
    clearInterval(typingInterval);
    console.error("Message Error:", e.message);
    bot.sendMessage(chatId, "حدث خطأ في النظام.");
  }
});

// سيرفر الـ Port لخدمة Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot active');
}).listen(PORT);
