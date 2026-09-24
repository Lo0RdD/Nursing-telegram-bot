const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const http = require('http');
const pdfParse = require('pdf-parse');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// قاعدة البيانات المؤقتة المحسنة
const db = {
  history: {},
  activeQuizzes: {},
  documents: {} // لتخزين قطع الـ PDF (Chunks) لكل مستخدم
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

// دالة تقسيم النصوص الطويلة (Chunking)
function chunkText(text, chunkSize = 2000, overlap = 300) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + chunkSize));
    i += (chunkSize - overlap); // التداخل لضمان عدم قطع الجمل المهمة
  }
  return chunks;
}

// دالة البحث الذكي داخل الملزمة (RAG Retrieval)
function searchRelevantChunks(query, chunks, topN = 3) {
  // استخراج الكلمات المفتاحية (الإنجليزية والعربية) التي يتجاوز طولها حرفين
  const queryWords = query.toLowerCase().split(/\W+/).filter(w => w.length > 2);
  
  if (queryWords.length === 0) return chunks.slice(0, topN);

  const scoredChunks = chunks.map(chunk => {
    let score = 0;
    const chunkLower = chunk.toLowerCase();
    queryWords.forEach(word => {
      if (chunkLower.includes(word)) score += 1;
    });
    return { chunk, score };
  });
  
  // ترتيب القطع حسب الارتباط (الأعلى نقاطاً أولاً)
  scoredChunks.sort((a, b) => b.score - a.score);
  
  // إذا لم يجد تطابقاً دقيقاً، يرسل أول أجزاء كافتراضي
  if (scoredChunks[0].score === 0) return chunks.slice(0, topN);
  
  return scoredChunks.slice(0, topN).map(c => c.chunk);
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
  db.documents[chatId] = []; // تصفير الملزمة القديمة عند البدء من جديد

  const welcomeMessage = `أهلاً بك في منصة التمريض الأكاديمية! 🩺\n\n` +
    `• أرسل ملزمة PDF وسأقوم بفهرستها لتتمكن من سؤالي عن أي تفصيل داخلها.\n` +
    `• اكتب /quiz لاختبارك بناءً على آخر النقاشات أو محتوى الملزمة.\n` +
    `• أجب عن الاختبار باختيار الحرف (A, B, C, D) للتقييم والشرح.`;

  sendLongMessage(chatId, welcomeMessage);
});

// 2. أمر /quiz الذكي
bot.onText(/\/quiz/, async (msg) => {
  const chatId = msg.chat.id;
  let typingInterval = setInterval(() => { bot.sendChatAction(chatId, 'typing').catch(()=>{}); }, 3000);

  try {
    const history = db.history[chatId] || [];
    if (history.length === 0 && (!db.documents[chatId] || db.documents[chatId].length === 0)) {
      clearInterval(typingInterval);
      return sendLongMessage(chatId, "لم نناقش أي موضوع بعد ولم يتم رفع ملزمة! أرسل سؤالاً أو ملفاً أولاً.");
    }

    let quizContextPrompt = systemPrompt;
    
    // إذا كانت هناك ملزمة مرفوعة، نستخدم أجزاء منها لتوليد الكويز
    if (db.documents[chatId] && db.documents[chatId].length > 0) {
      // نختار قطعة عشوائية من الملزمة ليكون الاختبار شاملاً
      const randomChunkIndex = Math.floor(Math.random() * db.documents[chatId].length);
      const randomChunk = db.documents[chatId][randomChunkIndex];
      quizContextPrompt += `\n\n[المادة العلمية المرجعية من ملزمة الطالب]:\n${randomChunk}`;
    }

    const recentContext = history.slice(-4);
    const quizRequest = `Based SPECIFICALLY on the nursing topics discussed or the provided document context, generate ONE high-yield academic NCLEX-style nursing multiple-choice question (MCQ).
CRITICAL FORMAT RULES:
1. The Question and Options (A, B, C, D) must be strictly in ENGLISH.
2. At the very end of your response, include a hidden tag for the correct answer like this: [CORRECT: X] (where X is A, B, C, or D).
3. Do NOT provide the explanation or correct answer in the main text.`;

    const messages = [
      { role: "system", content: quizContextPrompt },
      ...recentContext,
      { role: "user", content: quizRequest }
    ];

    let quizText = await callGroqAPI(messages, "openai/gpt-oss-120b", 1000);
    if (!quizText) quizText = await callGroqAPI(messages, "llama-3.3-70b-versatile", 1000);

    clearInterval(typingInterval);

    if (quizText) {
      const match = quizText.match(/\[CORRECT:\s*([A-Da-d])\]/i);
      const correctAnswer = match ? match[1].toUpperCase() : null;

      db.activeQuizzes[chatId] = { correctAnswer: correctAnswer, fullQuizText: quizText };
      const cleanQuizText = quizText.replace(/\[CORRECT:\s*[A-Da-d]\]/i, '').trim();

      sendLongMessage(chatId, `📝 **Nursing Quiz (Context & Document Based):**\n\n${cleanQuizText}\n\n👉 *أجب الآن بكتابة الحرف فقط (A, B, C, أو D)*`);
    } else {
      sendLongMessage(chatId, "حدث خطأ أثناء توليد الكويز.");
    }
  } catch (e) {
    clearInterval(typingInterval);
    sendLongMessage(chatId, "حدث خطأ غير متوقع.");
  }
});

// 3. معالجة وملفات الـ PDF (الفهرسة الشاملة)
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

    // 1. تقسيم الملزمة بالكامل إلى أجزاء (Chunks) وتخزينها
    db.documents[chatId] = chunkText(pdfText, 2500, 300);

    // 2. أخذ أول جزءين لعمل تلخيص عام للملزمة
    const initialContext = db.documents[chatId].slice(0, 2).join("\n\n");
    const summaryPrompt = `إليك بداية ملزمة PDF أرسلها الطالب (مقسمة وفهرست بالكامل في الخلفية). بناءً على هذه المقدمة:\n\n${initialContext}\n\nقدم تلخيصاً أكاديمياً شاملاً للموضوع الرئيسي للملزمة باللغة العربية.`;

    const summary = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: summaryPrompt }], "openai/gpt-oss-120b", 2000);

    clearInterval(typingInterval);

    if (summary) {
      if (!db.history[chatId]) db.history[chatId] = [];
      db.history[chatId].push({ role: "assistant", content: `تمت فهرسة الملزمة بنجاح. ${summary}` });

      sendLongMessage(chatId, `📚 **تمت فهرسة الملزمة بنجاح!** (${db.documents[chatId].length} قسم)\n\n📄 **نظرة عامة:**\n${summary}\n\n---\n💡 *الملزمة الآن محفوظة في الذاكرة بالكامل. يمكنك طرح أي سؤال دقيق عن أي صفحة أو إرسال /quiz لاختبارك من محتواها!*`);
    } else {
      sendLongMessage(chatId, "تمت قراءة الملزمة ولكن تعذر توليد التلخيص.");
    }
  } catch (e) {
    clearInterval(typingInterval);
    sendLongMessage(chatId, "حدث خطأ أثناء فهرسة ملف الـ PDF.");
  }
});

// 4. المحادثة النصية والبحث الذكي داخل الملزمة
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text ? msg.text.trim() : "";

  if (!userMessage || userMessage.startsWith('/') || msg.document) return;

  let typingInterval = setInterval(() => { bot.sendChatAction(chatId, 'typing').catch(()=>{}); }, 3000);

  try {
    // التحقق من إجابات الـ Quiz
    const activeQuiz = db.activeQuizzes[chatId];
    if (activeQuiz && /^[A-Da-d]$/.test(userMessage)) {
      const userChoice = userMessage.toUpperCase();
      const evaluationPrompt = `The original question: ${activeQuiz.fullQuizText}
The correct answer is: ${activeQuiz.correctAnswer}
User selected: ${userChoice}

Evaluate the answer. Provide a response ONLY in ARABIC:
1. Is it correct or incorrect (إجابة صحيحة ✅ أو إجابة خاطئة ❌).
2. A detailed academic nursing explanation in ARABIC.`;

      let evaluation = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: evaluationPrompt }], "openai/gpt-oss-120b", 1200);
      delete db.activeQuizzes[chatId];
      clearInterval(typingInterval);
      if (evaluation) return sendLongMessage(chatId, evaluation);
    }

    if (!db.history[chatId]) db.history[chatId] = [];

    // **نظام الـ RAG: بناء السياق الموجه إذا كانت هناك ملزمة**
    let currentSystemPrompt = systemPrompt;
    if (db.documents[chatId] && db.documents[chatId].length > 0) {
      // البحث عن أكثر 3 قطع في الملزمة ارتباطاً بسؤال الطالب
      const relevantChunks = searchRelevantChunks(userMessage, db.documents[chatId], 3);
      const documentContext = relevantChunks.join("\n\n...[فاصل المادة]...\n\n");
      
      currentSystemPrompt += `\n\n[مقتطفات من ملزمة الطالب الحالية تم استخراجها للرد على سؤاله]:\n${documentContext}\n\nاعتمد على هذه المقتطفات كمصدر أساسي للإجابة إن كانت متعلقة بالسؤال.`;
    }

    const tempMessages = [
      { role: "system", content: currentSystemPrompt },
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

      if (db.history[chatId].length > 10) db.history[chatId] = db.history[chatId].slice(-10);

      sendLongMessage(chatId, `${content}\n\n---\n🤖 النموذج: \`${usedModel}\``);
    } else {
      sendLongMessage(chatId, "عذراً، لم يتلق البوت استجابة من السيرفر. أعد إرسال رسالتك.");
    }
  } catch (e) {
    clearInterval(typingInterval);
    sendLongMessage(chatId, "حدث خطأ في النظام.");
  }
});

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot active');
}).listen(PORT);
