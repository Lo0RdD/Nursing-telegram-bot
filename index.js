const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const http = require('http');
const pdfParse = require('pdf-parse');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// قاعدة البيانات (مهيأة للتحول إلى SQLite/PostgreSQL لاحقاً)
const db = {
  history: {},
  activeQuizzes: {},    // ستخزن بصيغة JSON مهيكلة
  activeFlashcards: {}, // ستخزن بصيغة JSON مهيكلة
  documents: {},
  preferences: {}       // لتخزين مستوى الطالب وتفضيلاته
};

const systemPrompt = `أنت مساعد أكاديمي محترف لطالب تمريض. التزم بالدقة العلمية ولا تقم بتأليف معلومات غير موجودة.`;

// 1. أدوات مساعدة (Helper Functions)
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

// دالة اتصال محسنة تدعم استخراج JSON
async function callGroqAPI(messages, model = "openai/gpt-oss-120b", maxTokens = 1200, isJson = false) {
  try {
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      { 
        model, 
        messages, 
        temperature: 0.3, 
        max_tokens: maxTokens
      },
      { headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" }, timeout: 15000 }
    );
    let content = response.data.choices[0]?.message?.content || null;
    
    if (isJson && content) {
      // استخراج الـ JSON في حال قام الذكاء بإضافة نصوص إضافية
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
      return null;
    }
    return content;
  } catch (error) {
    return null;
  }
}

function getStudyContext(chatId) {
  // بدلاً من العشوائية، نركز على آخر نقاش، وإذا كان فارغاً نأخذ مقدمة الملزمة
  if (db.history[chatId] && db.history[chatId].length > 0) {
    return `[المصدر: آخر نقاشاتنا]:\n${db.history[chatId].slice(-4).map(m => m.content).join('\n')}`;
  } else if (db.documents[chatId] && db.documents[chatId].length > 0) {
    return `[المصدر: مقدمة ملزمة الطالب المرفقة]:\n${db.documents[chatId][0]}`;
  }
  return "أساسيات التمريض العامة (Nursing Fundamentals)";
}

// 2. أوامر تيليجرام الأساسية
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!db.history[chatId]) db.history[chatId] = [];
  if (!db.documents[chatId]) db.documents[chatId] = [];

  const welcomeMessage = `أهلاً بك في منصة التمريض الأكاديمية! 🩺\n\n` +
    `• 📄 أرسل ملزمة PDF لقراءتها (بدون استهلاك السيرفر).\n` +
    `• 🎓 أرسل /study لفتح قائمة أوضاع الدراسة.\n` +
    `أنا جاهز لخدمتك!`;
  sendLongMessage(chatId, welcomeMessage);
});

bot.onText(/\/study/, (msg) => {
  const chatId = msg.chat.id;
  const options = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '👨‍⚕️ حالة سريرية (Clinical Case)', callback_data: 'mode_clinical' }],
        [{ text: '🎴 بطاقة استذكار (Flashcard)', callback_data: 'mode_flashcard' }],
        [{ text: '📝 اختبار سريع (Quiz)', callback_data: 'mode_quiz' }]
      ]
    }
  };
  bot.sendMessage(chatId, '📚 **اختر وضع الدراسة الذي تفضله الآن:**', options);
});

// 3. معالجة الأزرار التفاعلية (Async & Non-Blocking)
bot.on('callback_query', async (callbackQuery) => {
  const { message, data: action, id } = callbackQuery;
  const chatId = message.chat.id;
  
  // 1. تحرير زر تيليجرام فوراً لمنع التعليق
  bot.answerCallbackQuery(id).catch(()=>{});
  
  if (action === 'flip_flashcard') {
    // التقليب محلي (Zero-API) وسريع جداً
    const flashcard = db.activeFlashcards[chatId];
    if (flashcard) {
      bot.sendMessage(chatId, `✅ **الشرح:**\n${flashcard.definition}`);
      delete db.activeFlashcards[chatId];
    } else {
      bot.sendMessage(chatId, "البطاقة غير موجودة. اطلب /study لبطاقة جديدة.");
    }
    return;
  }

  // 2. إرسال رسالة تحميل للمستخدم ليعرف أن البوت يعمل
  const loadingMsg = await bot.sendMessage(chatId, '⏳ جاري تجهيز المادة العلمية بناءً على سياق دراستك...');

  try {
    if (!db.history[chatId]) db.history[chatId] = [];
    const studyContext = getStudyContext(chatId);

    if (action === 'mode_quiz') {
      const quizRequest = `Based on: ${studyContext}
Generate ONE NCLEX-style MCQ.
You MUST output ONLY a valid JSON object with this exact structure:
{
  "question": "The question in English",
  "options": {
    "A": "Option A in English",
    "B": "Option B in English",
    "C": "Option C in English",
    "D": "Option D in English"
  },
  "correctAnswer": "A",
  "explanation": "Detailed explanation in ARABIC (شرح أكاديمي دقيق)"
}`;
      
      let quizData = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: quizRequest }], "openai/gpt-oss-120b", 1000, true);
      if (!quizData) quizData = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: quizRequest }], "llama-3.3-70b-versatile", 1000, true);
      
      if (quizData && quizData.question && quizData.options) {
        db.activeQuizzes[chatId] = quizData; // حفظ הJSON بالكامل في الذاكرة
        
        const quizText = `📝 **Nursing Quiz:**\n\n${quizData.question}\n\nA) ${quizData.options.A}\nB) ${quizData.options.B}\nC) ${quizData.options.C}\nD) ${quizData.options.D}\n\n👉 *أجب بكتابة الحرف (A, B, C, D) للتقييم الفوري!*`;
        bot.deleteMessage(chatId, loadingMsg.message_id).catch(()=>{});
        bot.sendMessage(chatId, quizText);
      } else {
        bot.editMessageText("عذراً، يوجد ضغط على السيرفر، جرب مرة أخرى.", { chat_id: chatId, message_id: loadingMsg.message_id });
      }

    } else if (action === 'mode_flashcard') {
      const fcRequest = `Based on: ${studyContext}
Extract one important nursing term. Output ONLY a valid JSON object:
{
  "term": "Medical term in English",
  "definition": "Detailed definition in Arabic"
}`;

      let fcData = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: fcRequest }], "openai/gpt-oss-120b", 800, true);
      if (!fcData) fcData = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: fcRequest }], "llama-3.3-70b-versatile", 800, true);
      
      if (fcData && fcData.term) {
        db.activeFlashcards[chatId] = fcData;
        bot.deleteMessage(chatId, loadingMsg.message_id).catch(()=>{});
        bot.sendMessage(chatId, `🎴 **مصطلح طبي:**\n\n**${fcData.term}**\n\n🤔 فكر في الإجابة ثم اضغط الزر:`, {
          reply_markup: { inline_keyboard: [[{ text: 'قلب البطاقة 🔄', callback_data: 'flip_flashcard' }]] }
        });
      } else {
        bot.editMessageText("فشل توليد البطاقة بسبب الضغط، جرب لاحقاً.", { chat_id: chatId, message_id: loadingMsg.message_id });
      }

    } else if (action === 'mode_clinical') {
      const caseRequest = `Based on: ${studyContext}\nGenerate a short clinical case study. End with: "What is the priority nursing intervention?" in English. Add clinical hints in Arabic.`;
      
      let caseText = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: caseRequest }], "openai/gpt-oss-120b", 800);
      if (!caseText) caseText = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: caseRequest }], "llama-3.3-70b-versatile", 800);
      
      if (caseText) {
        db.history[chatId].push({ role: "assistant", content: caseText }); 
        bot.deleteMessage(chatId, loadingMsg.message_id).catch(()=>{});
        sendLongMessage(chatId, `👨‍⚕️ **حالة سريرية:**\n\n${caseText}\n\n👉 *اكتب تدخلك التمريضي لنتناقش!*`);
      } else {
        bot.editMessageText("تعذر توليد الحالة السريرية، السيرفر مشغول.", { chat_id: chatId, message_id: loadingMsg.message_id });
      }
    }
  } catch (e) {
    bot.editMessageText("حدث خطأ غير متوقع.", { chat_id: chatId, message_id: loadingMsg.message_id }).catch(()=>{});
  }
});

// 4. قراءة الـ PDF بسرعة بدون API
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

    bot.editMessageText(`📚 **تمت فهرسة الملزمة بنجاح!** (${db.documents[chatId].length} قسم)\n\n✅ الملزمة في الذاكرة. استخدم /study أو اسألني أسئلة دقيقة عنها.`, { chat_id: chatId, message_id: loadingMsg.message_id });
  } catch (e) {
    bot.editMessageText("حدث خطأ أثناء فهرسة الملف.", { chat_id: chatId, message_id: loadingMsg.message_id });
  }
});

// 5. المحادثة والتقييم السريع (Zero-API)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text ? msg.text.trim() : "";

  if (!userMessage || userMessage.startsWith('/') || msg.document) return;

  // تقييم الكويز محلياً عبر JavaScript وبشكل فوري (بدون Groq)
  const activeQuiz = db.activeQuizzes[chatId];
  if (activeQuiz && /^[A-Da-d]$/.test(userMessage)) {
    const userChoice = userMessage.toUpperCase();
    const isCorrect = userChoice === activeQuiz.correctAnswer;
    
    const icon = isCorrect ? "✅ **إجابة صحيحة! أحسنت!**" : "❌ **إجابة خاطئة.**";
    const replyText = `${icon}\n\nالإجابة الصحيحة هي: **${activeQuiz.correctAnswer}**\n\n📝 **الشرح الأكاديمي:**\n${activeQuiz.explanation}`;
    
    delete db.activeQuizzes[chatId]; // إنهاء الكويز الحالي (مستقبلاً سنضيف زر "السؤال التالي")
    return bot.sendMessage(chatId, replyText, { parse_mode: 'Markdown' });
  }

  // المحادثة العادية مع الـ RAG
  bot.sendChatAction(chatId, 'typing').catch(()=>{});
  
  try {
    if (!db.history[chatId]) db.history[chatId] = [];
    let currentSystemPrompt = systemPrompt;
    
    // التقييد الصارم بالمادة العلمية
    if (db.documents[chatId] && db.documents[chatId].length > 0) {
      const relevantChunks = searchRelevantChunks(userMessage, db.documents[chatId], 2);
      if (relevantChunks.length > 0) {
        const documentContext = relevantChunks.join("\n\n...[فاصل المادة]...\n\n");
        currentSystemPrompt += `\n\n[مقتطفات من ملزمة الطالب]:\n${documentContext}\n\nأجب بناءً على المقتطفات فقط. إذا كانت المقتطفات المسترجعة لا تكفي للإجابة، صرّح بذلك بوضوح ولا تؤلف إجابة خارجية.`;
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
      bot.sendMessage(chatId, "عذراً، السيرفر مشغول حالياً.");
    }
  } catch (e) {
    bot.sendMessage(chatId, "حدث خطأ في النظام.");
  }
});

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot active');
}).listen(PORT);
