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
  activeFlashcards: {} // لتخزين ظهر البطاقة (التعريف) حتى يقلبها الطالب
};

// تم توجيه الذكاء الاصطناعي ليتناسب مع مستواك الدراسي واهتماماتك
const systemPrompt = `أنت رفيق معرفي أكاديمي محترف في مجال التمريض. تقدم إجابات دقيقة، علمية، ومنظمة مخصصة لدعم طلبة التمريض في المرحلة الثانية، مع التركيز على مواد مثل الباثوفسيولوجي والتدريب السريري الصيفي في المستشفيات وأقسام الطوارئ.`;

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

function chunkText(text, chunkSize = 2000, overlap = 300) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + chunkSize));
    i += (chunkSize - overlap);
  }
  return chunks;
}

function searchRelevantChunks(query, chunks, topN = 3) {
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

async function callGroqAPI(messages, model = "openai/gpt-oss-120b", maxTokens = 1500) {
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

// دالة مساعدة لاستخراج السياق (لجعل الأسئلة مبنية على الملزمة أو المحادثة)
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
  db.documents[chatId] = [];

  const welcomeMessage = `أهلاً بك في منصتك التمريضية! 🩺\n\n` +
    `• 📄 أرسل ملزمة PDF لفهرستها.\n` +
    `• 🎓 أرسل /study لفتح قائمة أوضاع الدراسة التفاعلية.\n` +
    `• 📝 أرسل /quiz لاختبارك السريع.\n` +
    `أنا جاهز لخدمتك!`;

  sendLongMessage(chatId, welcomeMessage);
});

// الأمر الجديد: قائمة الدراسة التفاعلية
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
  bot.sendMessage(chatId, 'اختر وضع الدراسة الذي تفضله الآن (الأسئلة ستكون مبنية على ملزمتك أو آخر نقاش لنا):', options);
});

// معالج الأزرار التفاعلية
bot.on('callback_query', async (callbackQuery) => {
  const message = callbackQuery.message;
  const chatId = message.chat.id;
  const action = callbackQuery.data;
  
  // إخفاء علامة التحميل من الزر
  bot.answerCallbackQuery(callbackQuery.id);
  
  if (!db.history[chatId]) db.history[chatId] = [];
  const studyContext = getStudyContext(chatId);

  bot.sendChatAction(chatId, 'typing');

  try {
    if (action === 'mode_quiz') {
      const quizRequest = `Based on this context: ${studyContext}\nGenerate ONE high-yield NCLEX-style nursing MCQ in ENGLISH. Format rules:\n1. English only.\n2. Hidden tag at the very end: [CORRECT: X]\n3. No explanation in the text.`;
      
      let quizText = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: quizRequest }], "openai/gpt-oss-120b", 1000) || 
                     await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: quizRequest }], "llama-3.3-70b-versatile", 1000);
      
      if (quizText) {
        const match = quizText.match(/\[CORRECT:\s*([A-Da-d])\]/i);
        db.activeQuizzes[chatId] = { correctAnswer: match ? match[1].toUpperCase() : null, fullQuizText: quizText };
        sendLongMessage(chatId, `📝 **Nursing Quiz:**\n\n${quizText.replace(/\[CORRECT:\s*[A-Da-d]\]/i, '').trim()}\n\n👉 *أجب الآن بكتابة الحرف فقط (A, B, C, أو D)*`);
      }

    } else if (action === 'mode_flashcard') {
      const flashcardRequest = `Based on this context: ${studyContext}\nExtract one important nursing/medical term and its definition.
Format your response exactly like this:
[TERM] The medical term here
[DEF] The definition and clinical significance here (in Arabic)`;

      let fcText = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: flashcardRequest }], "openai/gpt-oss-120b", 800) || 
                   await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: flashcardRequest }], "llama-3.3-70b-versatile", 800);
      
      if (fcText) {
        const termMatch = fcText.match(/\[TERM\](.*?)(?=\[DEF\])/s);
        const defMatch = fcText.match(/\[DEF\](.*)/s);
        
        if (termMatch && defMatch) {
          const term = termMatch[1].trim();
          db.activeFlashcards[chatId] = defMatch[1].trim();
          
          bot.sendMessage(chatId, `🎴 **مصطلح طبي:**\n\n**${term}**\n\n🤔 فكر في الإجابة ثم اضغط الزر بالأسفل لعرض الشرح!`, {
            reply_markup: { inline_keyboard: [[{ text: 'قلب البطاقة 🔄', callback_data: 'flip_flashcard' }]] }
          });
        }
      }

    } else if (action === 'flip_flashcard') {
      const definition = db.activeFlashcards[chatId];
      if (definition) {
        bot.sendMessage(chatId, `✅ **الشرح:**\n\n${definition}`);
        delete db.activeFlashcards[chatId];
      } else {
        bot.sendMessage(chatId, "البطاقة انتهت صلاحيتها، اطلب بطاقة جديدة عبر /study");
      }

    } else if (action === 'mode_clinical') {
      const caseRequest = `Based on this context: ${studyContext}\nGenerate a short nursing clinical case study (A patient presenting to the emergency or ward). 
End the case by asking the student: "What is the priority nursing intervention?"
Write the case in ENGLISH, but you can explain in ARABIC. Do NOT provide the answer.`;
      
      let caseText = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: caseRequest }], "openai/gpt-oss-120b", 1200) || 
                     await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: caseRequest }], "llama-3.3-70b-versatile", 1200);
      
      if (caseText) {
        db.history[chatId].push({ role: "assistant", content: caseText }); // نحفظ الحالة في الذاكرة ليفهم إجابتك النصية اللاحقة
        sendLongMessage(chatId, `👨‍⚕️ **حالة سريرية (Clinical Case):**\n\n${caseText}\n\n👉 *اكتب إجابتك وتدخلك التمريضي وسأقوم بمناقشته معك!*`);
      }
    }
  } catch (e) {
    bot.sendMessage(chatId, "حدث خطأ أثناء معالجة وضع الدراسة.");
  }
});

// الأمر القديم /quiz محتفظ به للاختصار
bot.onText(/\/quiz/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "انتقلنا للنظام الجديد! أرسل /study واختر 'اختبار سريع' أو أي وضع يعجبك.");
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

    db.documents[chatId] = chunkText(pdfText, 2500, 300);
    const initialContext = db.documents[chatId].slice(0, 2).join("\n\n");
    const summaryPrompt = `إليك بداية ملزمة PDF. قدم تلخيصاً أكاديمياً شاملاً باللغة العربية.\n\n${initialContext}`;
    const summary = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: summaryPrompt }], "openai/gpt-oss-120b", 2000);

    clearInterval(typingInterval);
    if (summary) {
      if (!db.history[chatId]) db.history[chatId] = [];
      db.history[chatId].push({ role: "assistant", content: `تمت فهرسة الملزمة بنجاح. ${summary}` });
      sendLongMessage(chatId, `📚 **تمت فهرسة الملزمة بنجاح!** (${db.documents[chatId].length} قسم)\n\n📄 **نظرة عامة:**\n${summary}\n\n---\n💡 *أرسل /study الآن لاختبارك في هذه الملزمة تحديداً!*`);
    } else {
      sendLongMessage(chatId, "تمت قراءة الملزمة ولكن تعذر توليد التلخيص.");
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
      const evaluationPrompt = `Original question: ${activeQuiz.fullQuizText}\nCorrect answer: ${activeQuiz.correctAnswer}\nUser selected: ${userChoice}\nEvaluate the answer ONLY in ARABIC (صحيحة ✅ / خاطئة ❌) with academic nursing explanation.`;
      let evaluation = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: evaluationPrompt }], "openai/gpt-oss-120b", 1200);
      delete db.activeQuizzes[chatId];
      clearInterval(typingInterval);
      if (evaluation) return sendLongMessage(chatId, evaluation);
    }

    if (!db.history[chatId]) db.history[chatId] = [];
    let currentSystemPrompt = systemPrompt;
    
    if (db.documents[chatId] && db.documents[chatId].length > 0) {
      const relevantChunks = searchRelevantChunks(userMessage, db.documents[chatId], 3);
      const documentContext = relevantChunks.join("\n\n...[فاصل المادة]...\n\n");
      currentSystemPrompt += `\n\n[مقتطفات من ملزمة الطالب للرد على سؤاله]:\n${documentContext}`;
    }

    const tempMessages = [
      { role: "system", content: currentSystemPrompt },
      ...db.history[chatId],
      { role: "user", content: userMessage }
    ];

    let content = await callGroqAPI(tempMessages, "openai/gpt-oss-120b", 2000) || await callGroqAPI(tempMessages, "llama-3.3-70b-versatile", 2000);
    clearInterval(typingInterval);

    if (content) {
      db.history[chatId].push({ role: "user", content: userMessage });
      db.history[chatId].push({ role: "assistant", content: content });
      if (db.history[chatId].length > 10) db.history[chatId] = db.history[chatId].slice(-10);
      sendLongMessage(chatId, `${content}`);
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
