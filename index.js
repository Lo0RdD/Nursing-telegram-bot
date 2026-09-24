const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const http = require('http');
const pdfParse = require('pdf-parse');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const db = {
  history: {},
  activeQuizzes: {} // تتبع حالة الكويز النشط لكل مستخدم لمعرفة الإجابة الصحيحة
};

const systemPrompt = `أنت رفيق معرفي أكاديمي محترف في مجال التمريض. تقدم إجابات دقيقة، علمية، ومنظمة لطلبة التمريض والمهتمين بالقطاع الصحي.`;

// دالة تقسيم وإرسال الرسائل الطويلة
async function sendLongMessage(chatId, text, extra = {}) {
  const MAX_LENGTH = 4000;
  if (!text) return;
  
  if (text.length <= MAX_LENGTH) {
    try {
      return await bot.sendMessage(chatId, text, extra);
    } catch (e) {
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

// دالة الاتصال بـ Groq API
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

// 1. أمر البداية /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!db.history[chatId]) db.history[chatId] = [];

  const welcomeMessage = `أهلاً بك في منصة التمريض الأكاديمية! 🩺\n\n` +
    `• ناقش أي موضوع علمي أو أرسل ملزمة PDF للتلخيص.\n` +
    `• اكتب /quiz لاختبارك بناءً على آخر النقاشات (السؤال بالإنجليزية والشرح بالعربية).\n` +
    `• أجب باختيار الحرف (A, B, C, D) وسأقوم بتقييم إجابتك فوراً!`;

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
    
    // توجيه دقيق: السؤال بالإنجليزية، وتحديد الحرف الصحيح بشكل خفي للنظام، والشرح مستقبلاً بالعربية
    const quizPrompt = `Based SPECIFICALLY on the MOST RECENT nursing topics or documents in our conversation above, generate ONE high-yield academic NCLEX-style nursing multiple-choice question (MCQ).
CRITICAL FORMAT RULES:
1. The Question and Options (A, B, C, D) must be strictly in ENGLISH.
2. At the very end of your response, include a hidden or clear tag for the correct answer like this format: [CORRECT: X] (where X is A, B, C, or D).
3. Do NOT provide the explanation or correct answer in the main text yet; wait for the user to answer.`;

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
      // استخراج الحرف الصحيح من الرد لتخزينه واختبار إجابة المستخدم لاحقاً
      const match = quizText.match(/\[CORRECT:\s*([A-Da-d])\]/i);
      const correctAnswer = match ? match[1].toUpperCase() : null;

      // حفظ حالة الكويز النشط لهذا المستخدم
      db.activeQuizzes[chatId] = {
        correctAnswer: correctAnswer,
        fullQuizText: quizText
      };

      // إخفاء وسم الإجابة الصحيحة عن المستخدم كي لا يراه مباشرة
      const cleanQuizText = quizText.replace(/\[CORRECT:\s*[A-Da-d]\]/i, '').trim();

      sendLongMessage(chatId, `📝 **Nursing Quiz (NCLEX-Style):**\n\n${cleanQuizText}\n\n👉 *أجب الآن بكتابة الحرف فقط (A, B, C, أو D)*`);
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
      return sendLongMessage(chatId, "عذراً، لم أستطع استخراج النصوص من هذا الملف.");
    }

    const trimmedText = pdfText.substring(0, 5000);
    const summaryPrompt = `إليك محتوى من ملزمة PDF أرسلها الطالب:\n\n${trimmedText}\n\nقدم تلخيصاً أكاديمياً شاملاً لأهم المفاهيم، النقاط السريرية، والتدخلات التمريضية المرتبطة بهذا المحتوى باللغة العربية.`;

    const summary = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: summaryPrompt }], "openai/gpt-oss-120b", 2000);

    clearInterval(typingInterval);

    if (summary) {
      if (!db.history[chatId]) db.history[chatId] = [];
      db.history[chatId].push({ role: "user", content: `[ملف PDF مرفق]` });
      db.history[chatId].push({ role: "assistant", content: summary });

      if (db.history[chatId].length > 12) db.history[chatId] = db.history[chatId].slice(-12);

      sendLongMessage(chatId, `📄 **تلخيص الملزمة الأكاديمية:**\n\n${summary}\n\n---\n💡 *يمكنك الآن طرح أسئلة أو إرسال /quiz لاختبارك منها!*`);
    } else {
      sendLongMessage(chatId, "تعذر تلخيص الملزمة حالياً.");
    }
  } catch (e) {
    clearInterval(typingInterval);
    sendLongMessage(chatId, "حدث خطأ أثناء معالجة ملف الـ PDF.");
  }
});

// 4. المحادثة النصية العامة والتعامل مع إجابات الـ Quiz
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text ? msg.text.trim() : "";

  if (!userMessage || userMessage.startsWith('/') || msg.document) return;

  let typingInterval = setInterval(() => { bot.sendChatAction(chatId, 'typing').catch(()=>{}); }, 3000);

  try {
    // التحقق هل أرسل المستخدم إجابة على كويز نشط (مثل A, B, C, D)
    const activeQuiz = db.activeQuizzes[chatId];
    if (activeQuiz && /^[A-Da-d]$/.test(userMessage)) {
      const userChoice = userMessage.toUpperCase();
      const isCorrect = activeQuiz.correctAnswer && userChoice === activeQuiz.correctAnswer;

      // بناء طلب تقييم الإجابة بحيث يكون الشرح بالعربية
      const evaluationPrompt = `The user is answering a nursing quiz question.
The original question was:
${activeQuiz.fullQuizText}

The correct answer is: ${activeQuiz.correctAnswer || "Not specified"}
The user's selected answer is: ${userChoice}

Please evaluate the user's answer. 
Provide a clear response in ARABIC language (اللغة العربية فقط):
1. State whether the answer is correct or incorrect (إجابة صحيحة ✅ أو إجابة خاطئة ❌).
2. Provide a detailed academic nursing explanation in ARABIC explaining why this option is correct/incorrect and reviewing the clinical concept.`;

      let evaluation = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: evaluationPrompt }], "openai/gpt-oss-120b", 1200);
      
      // إزالة الكويز النشط من الذاكرة كي لا يعلق عليه
      delete db.activeQuizzes[chatId];

      clearInterval(typingInterval);

      if (evaluation) {
        return sendLongMessage(chatId, evaluation);
      }
    }

    // إذا لم تكن إجابة كويز، تتم معاملتها كمحادثة نصية عادية
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
