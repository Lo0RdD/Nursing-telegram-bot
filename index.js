const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const http = require('http');
const pdfParse = require('pdf-parse');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

console.log("🔥 APP INITIALIZING...");
if (!TELEGRAM_TOKEN) console.error("❌ ERROR: TELEGRAM_TOKEN is missing!");
if (!GROQ_API_KEY) console.error("❌ ERROR: GROQ_API_KEY is missing!");

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const db = {
  history: {},
  activeQuizzes: {},
  activeFlashcards: {},
  documents: {},
  preferences: {}
};

const activeRequests = {}; 
const systemPrompt = `أنت مساعد أكاديمي محترف لطالب تمريض. التزم بالدقة العلمية ولا تقم بتأليف معلومات غير موجودة.`;

async function sendLongMessage(chatId, text, extra = {}) {
  const MAX_LENGTH = 4000;
  if (!text) return;
  if (text.length <= MAX_LENGTH) {
    try { return await bot.sendMessage(chatId, text, extra); } 
    catch (e) { delete extra.parse_mode; return await bot.sendMessage(chatId, text, extra); }
  }
  const parts = [];
  let currentIndex = 0;
  while (currentIndex < text.length) {
    parts.push(text.substring(currentIndex, currentIndex + MAX_LENGTH));
    currentIndex += MAX_LENGTH;
  }
  for (const part of parts) {
    try { await bot.sendMessage(chatId, part, extra); } 
    catch (e) { delete extra.parse_mode; await bot.sendMessage(chatId, part, extra); }
  }
}

function chunkText(text, chunkSize = 1200, overlap = 200) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + chunkSize));
    i += (chunkSize - overlap);
  }
  return chunks;
}

function searchRelevantChunks(query, chunks, topN = 2) {
  if (!chunks || chunks.length === 0) return [];
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 1 && !['هل','ما','كيف','اشرحلي','اشرح','اللي','من'].includes(w));
  if (queryWords.length === 0) return []; 
  
  const scoredChunks = chunks.map(chunk => {
    let score = 0;
    const chunkLower = chunk.toLowerCase();
    queryWords.forEach(word => { if (chunkLower.includes(word)) score += 1; });
    return { chunk, score };
  });
  
  scoredChunks.sort((a, b) => b.score - a.score);
  if (scoredChunks[0].score === 0) return []; 
  return scoredChunks.slice(0, topN).map(c => c.chunk);
}

async function callGroqAPI(messages, model = "openai/gpt-oss-120b", maxTokens = 1200, isJson = false) {
  try {
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      { model, messages, temperature: 0.3, max_tokens: maxTokens },
      { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" }, timeout: 8000 }
    );
    
    let content = response.data?.choices?.[0]?.message?.content || null;
    if (!content) {
      console.error("Groq returned empty content:", response.data);
      return null;
    }
    
    if (isJson) {
      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          console.error("No JSON found:", content);
          return null;
        }
        return JSON.parse(jsonMatch[0]);
      } catch (jsonError) {
        console.error("JSON parse error:", jsonError.message);
        return null;
      }
    }
    return content;
  } catch (error) {
    if (error.response) {
      console.error(`Groq API Error ${error.response.status}:`, error.response.data);
    } else if (error.code === "ECONNABORTED") {
      console.error("Groq API Timeout");
    } else {
      console.error("Groq Network Error:", error.message);
    }
    return null;
  }
}

function validateQuiz(data) {
  if (!data) return false;
  if (typeof data.question !== "string") return false;
  if (!data.options) return false;
  if (typeof data.options.A !== "string" || typeof data.options.B !== "string" || typeof data.options.C !== "string" || typeof data.options.D !== "string") return false;
  if (!["A", "B", "C", "D"].includes(String(data.correctAnswer).toUpperCase())) return false;
  if (typeof data.explanation !== "string") return false;
  data.correctAnswer = String(data.correctAnswer).toUpperCase();
  return true;
}

function getStudyContext(chatId) {
  if (db.documents[chatId] && db.documents[chatId].length > 0) {
    const docs = db.documents[chatId];
    const randomStart = Math.floor(Math.random() * Math.max(1, docs.length - 2));
    const chunks = docs.slice(randomStart, randomStart + 2).join("\n\n");
    return `[المصدر: ملزمة الطالب]\n${chunks}`;
  }
  if (db.history[chatId] && db.history[chatId].length > 0) {
    return `[المصدر: آخر نقاشاتنا]\n${db.history[chatId].slice(-4).map(m => m.content).join("\n")}`;
  }
  return "أساسيات التمريض العامة";
}

bot.onText(/\/start/, (msg) => {
  console.log("🔥 START COMMAND RECEIVED");
  const chatId = msg.chat.id;
  if (!db.history[chatId]) db.history[chatId] = [];
  if (!db.documents[chatId]) db.documents[chatId] = [];

  const welcomeMessage = `أهلاً بك في منصة التمريض الأكاديمية! 🩺\n\n` +
    `• 📄 أرسل ملزمة PDF لقراءتها.\n` +
    `• 🎓 أرسل /study لفتح قائمة أوضاع الدراسة.\n` +
    `أنا جاهز لخدمتك!`;
  sendLongMessage(chatId, welcomeMessage);
});

bot.onText(/\/study/, (msg) => {
  console.log("🔥 STUDY COMMAND RECEIVED");
  const chatId = msg.chat.id;
  const options = {
    inline_keyboard: [
      [{ text: '👨‍⚕️ حالة سريرية (Clinical Case)', callback_data: 'mode_clinical' }],
      [{ text: '🎴 بطاقة استذكار (Flashcard)', callback_data: 'mode_flashcard' }],
      [{ text: '📝 اختبار سريع (Quiz)', callback_data: 'mode_quiz' }]
    ]
  };
  bot.sendMessage(chatId, '📚 **اختر وضع الدراسة الذي تفضله الآن:**', { parse_mode: 'Markdown', reply_markup: options });
});

bot.on('callback_query', async (callbackQuery) => {
  console.log("🔥 CALLBACK RECEIVED:", callbackQuery.data);
  const { message, data: action, id } = callbackQuery;
  const chatId = message.chat.id;
  
  bot.answerCallbackQuery(id).catch(()=>{});

  if (action === 'flip_flashcard') {
    const flashcard = db.activeFlashcards[chatId];
    if (flashcard) {
      bot.sendMessage(chatId, `✅ **الشرح:**\n${flashcard.definition}`, { parse_mode: 'Markdown' });
      delete db.activeFlashcards[chatId];
    } else {
      bot.sendMessage(chatId, "البطاقة غير موجودة. اطلب /study لبطاقة جديدة.");
    }
    return;
  }

  if (activeRequests[chatId]) {
    return bot.sendMessage(chatId, "⏳ ما زلت أجهز لك الطلب السابق، انتظر قليلًا.");
  }
  
  activeRequests[chatId] = true;
  let loadingMsg;

  try {
    loadingMsg = await bot.sendMessage(chatId, '⏳ جاري تجهيز المادة العلمية...');
    if (!db.history[chatId]) db.history[chatId] = [];
    const studyContext = getStudyContext(chatId);

    if (action === 'mode_quiz') {
      const quizRequest = `Based on: ${studyContext}
Generate ONE NCLEX-style MCQ. Output ONLY a valid JSON object:
{
  "question": "The question in English",
  "options": { "A": "Option A", "B": "Option B", "C": "Option C", "D": "Option D" },
  "correctAnswer": "A",
  "explanation": "Detailed explanation in ARABIC"
}`;
      
      let quizData = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: quizRequest }], "openai/gpt-oss-120b", 1000, true);
      if (!quizData) quizData = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: quizRequest }], "llama-3.3-70b-versatile", 1000, true);
      
      if (quizData && validateQuiz(quizData)) {
        db.activeQuizzes[chatId] = quizData; 
        const quizText = `📝 **Nursing Quiz:**\n\n${quizData.question}\n\nA) ${quizData.options.A}\nB) ${quizData.options.B}\nC) ${quizData.options.C}\nD) ${quizData.options.D}\n\n👉 *أجب بكتابة الحرف (A, B, C, D) للتقييم الفوري!*`;
        bot.deleteMessage(chatId, loadingMsg.message_id).catch(()=>{});
        bot.sendMessage(chatId, quizText, { parse_mode: 'Markdown' });
      } else {
        bot.editMessageText("عذراً، فشل توليد الاختبار بشكل صحيح.", { chat_id: chatId, message_id: loadingMsg.message_id });
      }

    } else if (action === 'mode_flashcard') {
      const fcRequest = `Based on: ${studyContext}\nExtract one important nursing term. Output ONLY a valid JSON object:\n{"term": "Term in English", "definition": "Definition in Arabic"}`;

      let fcData = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: fcRequest }], "openai/gpt-oss-120b", 800, true);
      if (!fcData) fcData = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: fcRequest }], "llama-3.3-70b-versatile", 800, true);
      
      if (fcData && fcData.term) {
        db.activeFlashcards[chatId] = fcData;
        bot.deleteMessage(chatId, loadingMsg.message_id).catch(()=>{});
        bot.sendMessage(chatId, `🎴 **مصطلح طبي:**\n\n**${fcData.term}**\n\n🤔 فكر في الإجابة ثم اضغط الزر:`, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: 'قلب البطاقة 🔄', callback_data: 'flip_flashcard' }]] }
        });
      } else {
        bot.editMessageText("فشل توليد البطاقة.", { chat_id: chatId, message_id: loadingMsg.message_id });
      }

    } else if (action === 'mode_clinical') {
      const caseRequest = `Based on: ${studyContext}\nGenerate a short clinical case study. End with: "What is the priority nursing intervention?" in English. Add clinical hints in Arabic.`;
      
      let caseText = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: caseRequest }], "openai/gpt-oss-120b", 1000);
      if (!caseText) caseText = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: caseRequest }], "llama-3.3-70b-versatile", 1000);
      
      if (caseText) {
        db.history[chatId].push({ role: "assistant", content: caseText }); 
        bot.deleteMessage(chatId, loadingMsg.message_id).catch(()=>{});
        sendLongMessage(chatId, `👨‍⚕️ **حالة سريرية:**\n\n${caseText}\n\n👉 *اكتب تدخلك التمريضي لنتناقش!*`);
      } else {
        bot.editMessageText("تعذر توليد الحالة السريرية.", { chat_id: chatId, message_id: loadingMsg.message_id });
      }
    }
  } catch (e) {
    if (loadingMsg) bot.editMessageText("حدث خطأ غير متوقع.", { chat_id: chatId, message_id: loadingMsg.message_id }).catch(()=>{});
  } finally {
    delete activeRequests[chatId];
  }
});

bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const doc = msg.document;

  if (!doc.mime_type || !doc.mime_type.includes('pdf')) return bot.sendMessage(chatId, "أرسل PDF فقط.");
  const loadingMsg = await bot.sendMessage(chatId, '⏳ جاري استخراج النصوص من الملزمة...');

  try {
    const fileLink = await bot.getFileLink(doc.file_id);
    const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
    const pdfData = await pdfParse(response.data);
    const pdfText = pdfData.text.trim();

    if (!pdfText || pdfText.length < 20) {
      return bot.editMessageText("عذراً، الملف فارغ أو مسحوب كصور.", { chat_id: chatId, message_id: loadingMsg.message_id });
    }

    db.documents[chatId] = chunkText(pdfText, 1200, 200); 
    if (!db.history[chatId]) db.history[chatId] = [];

    bot.editMessageText(`📚 **تمت فهرسة الملزمة بنجاح!** (${db.documents[chatId].length} قسم)\n\n✅ الملزمة في الذاكرة. استخدم /study للاختبار.`, { parse_mode: 'Markdown', chat_id: chatId, message_id: loadingMsg.message_id });
  } catch (e) {
    bot.editMessageText("حدث خطأ أثناء فهرسة الملف.", { chat_id: chatId, message_id: loadingMsg.message_id });
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text ? msg.text.trim() : "";

  if (!userMessage || userMessage.startsWith('/') || msg.document) return;

  const activeQuiz = db.activeQuizzes[chatId];
  if (activeQuiz && /^[A-Da-d]$/.test(userMessage)) {
    const userChoice = userMessage.toUpperCase();
    const isCorrect = userChoice === activeQuiz.correctAnswer;
    const icon = isCorrect ? "✅ **إجابة صحيحة! أحسنت!**" : "❌ **إجابة خاطئة.**";
    const replyText = `${icon}\n\nالإجابة الصحيحة هي: **${activeQuiz.correctAnswer}**\n\n📝 **الشرح الأكاديمي:**\n${activeQuiz.explanation}`;
    delete db.activeQuizzes[chatId]; 
    return bot.sendMessage(chatId, replyText, { parse_mode: 'Markdown' });
  }

  if (activeRequests[chatId]) {
    return bot.sendMessage(chatId, "⏳ جاري معالجة طلبك السابق، يرجى الانتظار...");
  }
  activeRequests[chatId] = true;
  bot.sendChatAction(chatId, 'typing').catch(()=>{});
  
  try {
    if (!db.history[chatId]) db.history[chatId] = [];
    let currentSystemPrompt = systemPrompt;
    
    if (db.documents[chatId] && db.documents[chatId].length > 0) {
      const relevantChunks = searchRelevantChunks(userMessage, db.documents[chatId], 2);
      if (relevantChunks.length > 0) {
        const documentContext = relevantChunks.join("\n\n...[فاصل المادة]...\n\n");
        currentSystemPrompt += `\n\n[مقتطفات من ملزمة الطالب]:\n${documentContext}\n\nأجب بناءً على المقتطفات فقط. إذا كانت المقتطفات لا تكفي، صرّح بذلك بوضوح.`;
      }
    }

    const tempMessages = [
      { role: "system", content: currentSystemPrompt },
      ...db.history[chatId],
      { role: "user", content: userMessage }
    ];

    let content = await callGroqAPI(tempMessages, "openai/gpt-oss-120b", 1000);
    if (!content) content = await callGroqAPI(tempMessages, "llama-3.3-70b-versatile", 1000);
    
    if (content) {
      db.history[chatId].push({ role: "user", content: userMessage });
      db.history[chatId].push({ role: "assistant", content: content });
      if (db.history[chatId].length > 6) db.history[chatId] = db.history[chatId].slice(-6); 
      sendLongMessage(chatId, content);
    } else {
      bot.sendMessage(chatId, "عذراً، تعذر الاتصال بالسيرفر.");
    }
  } catch (e) {
    bot.sendMessage(chatId, "حدث خطأ في النظام.");
  } finally {
    delete activeRequests[chatId];
  }
});

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot active');
}).listen(PORT, () => {
  console.log(`🔥 HTTP Server running on port ${PORT}`);
});
