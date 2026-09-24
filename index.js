const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const http = require('http');
const pdfParse = require('pdf-parse');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const db = {
  history: {},
  activeQuizzes: {},
  documents: {},
  activeFlashcards: {}
};

const systemPrompt = `أنت رفيق معرفي أكاديمي محترف في مجال التمريض. تقدم إجابات دقيقة، علمية، ومنظمة مخصصة لدعم طلبة التمريض في المرحلة الثانية.`;

// دالة تقسيم الرسائل الطويلة
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

// تم تصغير حجم القطع لتقليل استهلاك الكلمات (Tokens) ومنع الـ Rate Limit
function chunkText(text, chunkSize = 1500, overlap = 200) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + chunkSize));
    i += (chunkSize - overlap);
  }
  return chunks;
}

// تقليل البحث إلى قطعتين فقط لتخفيف الضغط
function searchRelevantChunks(query, chunks, topN = 2) {
  if (!chunks || chunks.length === 0) return [];
  const queryWords = query.toLowerCase().split(/\W+/).filter(w => w.length > 2);
  if (queryWords.length === 0) return chunks.slice(0, topN);

  const scoredChunks = chunks.map(chunk => {
    let score = 0;
    const chunkLower = chunk.toLowerCase();
    queryWords.forEach(word => { if (chunkLower.includes(word)) score += 1; });
    return { chunk, score };
  });
  
  scoredChunks.sort((a, b) => b.score - a.score);
  if (scoredChunks[0].score === 0) return chunks.slice(0, topN);
  return scoredChunks.slice(0, topN).map(c => c.chunk);
}

async function callGroqAPI(messages, model = "openai/gpt-oss-120b", maxTokens = 1200) {
  try {
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      { model, messages, temperature: 0.4, max_tokens: maxTokens },
      { headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" }, timeout: 20000 }
    );
    return response.data.choices[0]?.message?.content || null;
  } catch (error) {
    return null;
  }
}

function getStudyContext(chatId) {
  let contextStr = "";
  if (db.documents[chatId] && db.documents[chatId].length > 0) {
    const randomChunk = db.documents[chatId][Math.floor(Math.random() * db.documents[chatId].length)];
    contextStr = `\n\n[المصدر: ملزمة الطالب المرفقة]:\n${randomChunk}`;
  } else if (db.history[chatId] && db.history[chatId].length > 0) {
    contextStr = `\n\n[المصدر: آخر نقاشاتنا]:\n${db.history[chatId].slice(-4).map(m => m.content).join('\n')}`;
  }
  return contextStr;
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!db.history[chatId]) db.history[chatId] = [];
  if (!db.documents[chatId]) db.documents[chatId] = [];

  const welcomeMessage = `أهلاً بك في منصتك التمريضية المحسّنة والجاهزة! 🩺\n\n` +
    `• 📄 أرسل ملزمة PDF لفهرستها.\n` +
    `• 🎓 أرسل /study لفتح قائمة أوضاع الدراسة التفاعلية.\n` +
    `• 📝 أرسل /quiz لاختبارك السريع.\n` +
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
  bot.sendMessage(chatId, 'اختر وضع الدراسة الذي تفضله الآن:', options);
});

bot.on('callback_query', async (callbackQuery) => {
  const message = callbackQuery.message;
  const chatId = message.chat.id;
  const action = callbackQuery.data;
  
  // معالجة آمنة لزر التيليجرام لمنع الانهيار
  bot.answerCallbackQuery(callbackQuery.id).catch(()=>{});
  let typingInterval = setInterval(() => { bot.sendChatAction(chatId, 'typing').catch(()=>{}); }, 3000);

  try {
    if (!db.history[chatId]) db.history[chatId] = [];
    const studyContext = getStudyContext(chatId);

    if (action === 'mode_quiz') {
      const quizRequest = `Based on this context: ${studyContext}\nGenerate ONE high-yield NCLEX-style nursing MCQ in ENGLISH. Format rules:\n1. English only.\n2. Hidden tag at the very end: [CORRECT: X]\n3. No explanation in the text.`;
      
      let quizText = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: quizRequest }], "openai/gpt-oss-120b", 1000);
      if (!quizText) quizText = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: quizRequest }], "llama-3.3-70b-versatile", 1000);
      if (!quizText) quizText = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: quizRequest }], "llama3-8b-8192", 1000);
      
      clearInterval(typingInterval);
      if (quizText) {
        const match = quizText.match(/\[CORRECT:\s*([A-Da-d])\]/i);
        db.activeQuizzes[chatId] = { correctAnswer: match ? match[1].toUpperCase() : null, fullQuizText: quizText };
        sendLongMessage(chatId, `📝 **Nursing Quiz:**\n\n${quizText.replace(/\[CORRECT:\s*[A-Da-d]\]/i, '').trim()}\n\n👉 *أجب الآن بكتابة الحرف فقط (A, B, C, أو D)*`);
      } else {
        bot.sendMessage(chatId, "عذراً، يوجد ضغط عالي على السيرفر الآن (Rate Limit). انتظر ثواني وجرب مرة أخرى.");
      }

    } else if (action === 'mode_flashcard') {
      const flashcardRequest = `Based on this context: ${studyContext}\nExtract one important nursing term and its definition.\nFormat exactly like this:\n[TERM] The medical term\n[DEF] The definition (in Arabic)`;

      let fcText = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: flashcardRequest }], "openai/gpt-oss-120b", 800);
      if (!fcText) fcText = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: flashcardRequest }], "llama-3.3-70b-versatile", 800);
      if (!fcText) fcText = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: flashcardRequest }], "llama3-8b-8192", 800);
      
      clearInterval(typingInterval);
      if (fcText) {
        const termMatch = fcText.match(/\[TERM\](.*?)(?=\[DEF\])/s);
        const defMatch = fcText.match(/\[DEF\](.*)/s);
        
        if (termMatch && defMatch) {
          const term = termMatch[1].trim();
          db.activeFlashcards[chatId] = defMatch[1].trim();
          bot.sendMessage(chatId, `🎴 **مصطلح طبي:**\n\n**${term}**\n\n🤔 فكر في الإجابة ثم اضغط الزر لعرض الشرح!`, {
            reply_markup: { inline_keyboard: [[{ text: 'قلب البطاقة 🔄', callback_data: 'flip_flashcard' }]] }
          });
        } else {
          bot.sendMessage(chatId, "لم يتمكن الذكاء من صياغة البطاقة بشكل صحيح. جرب مجدداً.");
        }
      } else {
        bot.sendMessage(chatId, "عذراً، يوجد ضغط عالي على السيرفر (Rate Limit). انتظر قليلاً.");
      }

    } else if (action === 'flip_flashcard') {
      clearInterval(typingInterval);
      const definition = db.activeFlashcards[chatId];
      if (definition) {
        bot.sendMessage(chatId, `✅ **الشرح:**\n\n${definition}`);
        delete db.activeFlashcards[chatId];
      } else {
        bot.sendMessage(chatId, "البطاقة انتهت صلاحيتها، اطلب بطاقة جديدة عبر /study");
      }

    } else if (action === 'mode_clinical') {
      const caseRequest = `Based on this context: ${studyContext}\nGenerate a short nursing clinical case study. End by asking: "What is the priority nursing intervention?"\nWrite the case in ENGLISH, but explain clinical hints in ARABIC. Do NOT provide the final answer.`;
      
      let caseText = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: caseRequest }], "openai/gpt-oss-120b", 1200);
      if (!caseText) caseText = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: caseRequest }], "llama-3.3-70b-versatile", 1200);
      if (!caseText) caseText = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: caseRequest }], "llama3-8b-8192", 1200);
      
      clearInterval(typingInterval);
      if (caseText) {
        db.history[chatId].push({ role: "assistant", content: caseText }); 
        sendLongMessage(chatId, `👨‍⚕️ **حالة سريرية (Clinical Case):**\n\n${caseText}\n\n👉 *اكتب إجابتك وتدخلك التمريضي لنتناقش!*`);
      } else {
        bot.sendMessage(chatId, "تعذر توليد الحالة السريرية بسبب الضغط على السيرفر. جرب بعد دقيقة.");
      }
    }
  } catch (e) {
    clearInterval(typingInterval);
    bot.sendMessage(chatId, "حدث خطأ أثناء معالجة طلبك.");
  }
});

bot.onText(/\/quiz/, (msg) => {
  bot.sendMessage(msg.chat.id, "انتقلنا للنظام الجديد! أرسل /study واختر 'اختبار سريع'.");
});

bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const doc = msg.document;

  if (!doc.mime_type || !doc.mime_type.includes('pdf')) return sendLongMessage(chatId, "يرجى إرسال ملفات بصيغة PDF فقط.");
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

    db.documents[chatId] = chunkText(pdfText, 1500, 200); // تصغير الحجم لتجنب الحظر
    const initialContext = db.documents[chatId].slice(0, 1).join("\n\n"); 
    const summaryPrompt = `إليك بداية ملزمة PDF. قدم تلخيصاً أكاديمياً باللغة العربية.\n\n${initialContext}`;
    
    let summary = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: summaryPrompt }], "openai/gpt-oss-120b", 1200);
    let usedModel = "openai/gpt-oss-120b";
    
    if (!summary) {
      summary = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: summaryPrompt }], "llama-3.3-70b-versatile", 1200);
      usedModel = "llama-3.3-70b-versatile";
    }
    if (!summary) {
      summary = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: summaryPrompt }], "llama3-8b-8192", 1200);
      usedModel = "llama3-8b-8192";
    }

    clearInterval(typingInterval);
    if (summary) {
      if (!db.history[chatId]) db.history[chatId] = [];
      db.history[chatId].push({ role: "assistant", content: `تمت فهرسة الملزمة بنجاح. ${summary}` });
      sendLongMessage(chatId, `📚 **تمت فهرسة الملزمة بنجاح!** (${db.documents[chatId].length} قسم)\n\n📄 **نظرة عامة:**\n${summary}\n\n---\n💡 *أرسل /study الآن لاختبارك في الملزمة!*\n🤖 النموذج: \`${usedModel}\``);
    } else {
      sendLongMessage(chatId, "تمت قراءة الملزمة بنجاح، لكن تعذر توليد التلخيص حالياً بسبب ضغط السيرفر.");
    }
  } catch (e) {
    clearInterval(typingInterval);
    sendLongMessage(chatId, "حدث خطأ أثناء فهرسة ملف الـ PDF.");
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text ? msg.text.trim() : "";

  if (!userMessage || userMessage.startsWith('/') || msg.document) return;
  let typingInterval = setInterval(() => { bot.sendChatAction(chatId, 'typing').catch(()=>{}); }, 3000);

  try {
    const activeQuiz = db.activeQuizzes[chatId];
    if (activeQuiz && /^[A-Da-d]$/.test(userMessage)) {
      const userChoice = userMessage.toUpperCase();
      const evaluationPrompt = `Original question: ${activeQuiz.fullQuizText}\nCorrect answer: ${activeQuiz.correctAnswer}\nUser selected:${userChoice}\nEvaluate the answer ONLY in ARABIC (صحيحة ✅ / خاطئة ❌) with academic explanation.`;
      
      let evaluation = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: evaluationPrompt }], "openai/gpt-oss-120b", 1200);
      if (!evaluation) evaluation = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: evaluationPrompt }], "llama-3.3-70b-versatile", 1200);
      if (!evaluation) evaluation = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: evaluationPrompt }], "llama3-8b-8192", 1200);
      
      delete db.activeQuizzes[chatId];
      clearInterval(typingInterval);
      if (evaluation) return sendLongMessage(chatId, evaluation);
    }

    if (!db.history[chatId]) db.history[chatId] = [];
    let currentSystemPrompt = systemPrompt;
    
    if (db.documents[chatId] && db.documents[chatId].length > 0) {
      const relevantChunks = searchRelevantChunks(userMessage, db.documents[chatId], 2);
      if (relevantChunks.length > 0) {
        const documentContext = relevantChunks.join("\n\n...[فاصل المادة]...\n\n");
        currentSystemPrompt += `\n\n[مقتطفات من ملزمة الطالب للرد على سؤاله]:\n${documentContext}`;
      }
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
    if (!content) {
      content = await callGroqAPI(tempMessages, "llama3-8b-8192", 2000);
      usedModel = "llama3-8b-8192";
    }
    
    clearInterval(typingInterval);

    if (content) {
      db.history[chatId].push({ role: "user", content: userMessage });
      db.history[chatId].push({ role: "assistant", content: content });
      if (db.history[chatId].length > 6) db.history[chatId] = db.history[chatId].slice(-6); // تقليل الذاكرة لمنع الضغط
      
      sendLongMessage(chatId, `${content}\n\n---\n🤖 النموذج: \`${usedModel}\``);
    } else {
      sendLongMessage(chatId, "عذراً، لم يتلق البوت استجابة من السيرفر. يوجد ضغط عالي، أعد المحاولة بعد ثواني.");
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
