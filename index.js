const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const http = require('http');
const pdfParse = require('pdf-parse');
const { MongoClient } = require('mongodb');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MONGO_URI = process.env.MONGO_URI;

console.log("🔥 APP INITIALIZING...");

// إعداد قاعدة البيانات MongoDB
const client = new MongoClient(MONGO_URI);
let usersCollection;

async function connectDB() {
  try {
    await client.connect();
    const database = client.db('NursingBotDB');
    usersCollection = database.collection('users');
    console.log("✅ MongoDB Connected Successfully!");
  } catch (err) {
    console.error("❌ MongoDB Connection Error:", err);
  }
}
connectDB();

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// الذاكرة المؤقتة للطلبات العابرة (تتفرغ تلقائياً لتسريع البوت)
const ramDB = {
  activeQuizzes: {},
  activeFlashcards: {},
  activeRequests: {}
};

const systemPrompt = `أنت مساعد أكاديمي محترف لطالب تمريض. التزم بالدقة العلمية ولا تقم بتأليف معلومات غير موجودة.`;

// دوال جلب وتحديث بيانات المستخدم من MongoDB
async function getUser(chatId) {
  if (!usersCollection) return { history: [], documents: [] };
  let user = await usersCollection.findOne({ chatId });
  if (!user) {
    user = { chatId, history: [], documents: [] };
    await usersCollection.insertOne(user);
  }
  return user;
}

async function saveUserHistory(chatId, history) {
  if (!usersCollection) return;
  // نحتفظ بآخر 30 رسالة فقط في قاعدة البيانات (15 سؤال و 15 جواب) لعدم تجاوز سعة الذكاء الاصطناعي
  const trimmedHistory = history.length > 30 ? history.slice(-30) : history;
  await usersCollection.updateOne({ chatId }, { $set: { history: trimmedHistory } }, { upsert: true });
}

async function saveUserDocuments(chatId, documents) {
  if (!usersCollection) return;
  await usersCollection.updateOne({ chatId }, { $set: { documents } }, { upsert: true });
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

// دالة جلب السياق وتعتمد الآن على الذاكرة الدائمة!
async function getStudyContext(chatId) {
  const user = await getUser(chatId);
  if (user.documents && user.documents.length > 0) {
    const randomStart = Math.floor(Math.random() * Math.max(1, user.documents.length - 2));
    return `[المصدر: ملزمة الطالب Mapped PDF]\n${user.documents.slice(randomStart, randomStart + 2).join("\n\n")}`;
  }
  if (user.history && user.history.length > 0) {
    return `[المصدر: آخر نقاشاتنا]\n${user.history.slice(-10).map(m => m.content).join("\n")}`;
  }
  return "أساسيات التمريض العامة (Nursing Fundamentals)";
}

async function callGroqAPI(messages, model = "openai/gpt-oss-120b", maxTokens = 1200, isJson = false) {
  try {
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      { model, messages, temperature: 0.3, max_tokens: maxTokens },
      { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" }, timeout: 8000 }
    );
    let content = response.data?.choices?.[0]?.message?.content || null;
    if (!content) return null;
    
    if (isJson) {
      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        return JSON.parse(jsonMatch[0]);
      } catch (e) {
        return null;
      }
    }
    return content;
  } catch (error) {
    return null;
  }
}

function validateQuiz(data) {
  if (!data) return false;
  if (typeof data.question !== "string" || !data.options) return false;
  if (!["A", "B", "C", "D"].includes(String(data.correctAnswer).toUpperCase())) return false;
  data.correctAnswer = String(data.correctAnswer).toUpperCase();
  return true;
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "أهلاً بك في منصة التمريض الأكاديمية! 🩺\n\n• 📄 أرسل ملزمة PDF لقراءتها (ستُحفظ دائمًا).\n• 🎓 أرسل /study لفتح أوضاع الدراسة.");
});

bot.onText(/\/study/, (msg) => {
  const chatId = msg.chat.id;
  const options = {
    inline_keyboard: [
      [{ text: '👨‍⚕️ حالة سريرية (Clinical Case)', callback_data: 'mode_clinical' }],
      [{ text: '🎴 بطاقة استذكار (Flashcard)', callback_data: 'mode_flashcard' }],
      [{ text: '📝 اختبار سريع (Quiz)', callback_data: 'mode_quiz' }]
    ]
  };
  bot.sendMessage(chatId, '📚 **اختر وضع الدراسة الذي تفضله الآن:**', { reply_markup: options });
});

bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const doc = msg.document;

  if (!doc.mime_type || !doc.mime_type.includes('pdf')) return bot.sendMessage(chatId, "أرسل ملفات PDF فقط.");
  const loadingMsg = await bot.sendMessage(chatId, '⏳ جاري استخراج النصوص من الملزمة وحفظها في قاعدة البيانات...');

  try {
    const fileLink = await bot.getFileLink(doc.file_id);
    const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
    const pdfData = await pdfParse(response.data);
    const pdfText = pdfData.text.trim();

    if (!pdfText || pdfText.length < 20) {
      return bot.editMessageText("عذراً، الملف فارغ أو مصور.", { chat_id: chatId, message_id: loadingMsg.message_id });
    }

    const chunks = chunkText(pdfText, 1200, 200);
    
    // حفظ الملف في قاعدة البيانات الدائمة
    await saveUserDocuments(chatId, chunks);

    bot.editMessageText(`📚 **تمت فهرسة الملزمة وحفظها دائمًا!** (${chunks.length} قسم)\n\n✅ لن ينساها البوت أبدًا. استخدم /study للاختبار.`, { chat_id: chatId, message_id: loadingMsg.message_id });
  } catch (e) {
    bot.editMessageText("حدث خطأ أثناء فهرسة الملف.", { chat_id: chatId, message_id: loadingMsg.message_id });
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const action = query.data;

  bot.answerCallbackQuery(query.id).catch(() => {});

  if (action === 'flip_flashcard') {
    const fc = ramDB.activeFlashcards[chatId];
    if (fc) {
      bot.sendMessage(chatId, `✅ **الشرح:**\n${fc.definition}`);
      delete ramDB.activeFlashcards[chatId];
    } else {
      bot.sendMessage(chatId, "انتهت صلاحية البطاقة، اطلب /study جديدة.");
    }
    return;
  }

  if (ramDB.activeRequests[chatId]) {
    return bot.sendMessage(chatId, "⏳ يرجى الانتظار، النظام يعالج طلبك السابق...");
  }

  ramDB.activeRequests[chatId] = true;
  const loadingMsg = await bot.sendMessage(chatId, "⏳ جاري تجهيز المادة العلمية بناءً على ملزمتك أو سياقك الدراسي...");

  try {
    const studyContext = await getStudyContext(chatId);

    if (action === 'mode_quiz') {
      const prompt = `Based strictly on this context: ${studyContext}\nGenerate ONE NCLEX-style MCQ. Output ONLY a valid JSON object:\n{"question": "Q in English", "options": {"A": "1", "B": "2", "C": "3", "D": "4"}, "correctAnswer": "A", "explanation": "شرح مفصل بالعربي"}`;
      let data = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "openai/gpt-oss-120b", 1000, true);
      if (!data) data = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "llama-3.3-70b-versatile", 1000, true);

      if (data && validateQuiz(data)) {
        ramDB.activeQuizzes[chatId] = data;
        bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
        bot.sendMessage(chatId, `📝 **Nursing Quiz:**\n\n${data.question}\n\nA) ${data.options.A}\nB) ${data.options.B}\nC) ${data.options.C}\nD) ${data.options.D}\n\n👉 *أجب بحرف الخيار فقط (A, B, C, D)*`);
      } else {
        bot.editMessageText("عذراً، فشل توليد الاختبار.", { chat_id: chatId, message_id: loadingMsg.message_id });
      }
    } else if (action === 'mode_flashcard') {
      const prompt = `Based strictly on this context: ${studyContext}\nExtract one important nursing term. Output ONLY JSON:\n{"term": "Term", "definition": "تعريف دقيق بالعربي"}`;
      let data = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "openai/gpt-oss-120b", 800, true);
      if (!data) data = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "llama-3.3-70b-versatile", 800, true);

      if (data && data.term) {
        ramDB.activeFlashcards[chatId] = data;
        bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
        bot.sendMessage(chatId, `🎴 **مصطلح طبي:** **${data.term}**\n\nاضغط لقلب البطاقة:`, {
          reply_markup: { inline_keyboard: [[{ text: 'قلب البطاقة 🔄', callback_data: 'flip_flashcard' }]] }
        });
      } else {
        bot.editMessageText("فشل توليد البطاقة.", { chat_id: chatId, message_id: loadingMsg.message_id });
      }
    } else if (action === 'mode_clinical') {
      const prompt = `Based strictly on this context: ${studyContext}\nGenerate a short clinical case study ending with: "What is the priority nursing intervention?" with Arabic hints.`;
      let text = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "openai/gpt-oss-120b", 1000);
      if (!text) text = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "llama-3.3-70b-versatile", 1000);

      if (text) {
        bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
        bot.sendMessage(chatId, `👨‍⚕️ **حالة سريرية:**\n\n${text}`);
      } else {
        bot.editMessageText("تعذر توليد الحالة السريرية.", { chat_id: chatId, message_id: loadingMsg.message_id });
      }
    }
  } catch (e) {
    bot.editMessageText("حدث خطأ أثناء المعالجة.", { chat_id: chatId, message_id: loadingMsg.message_id });
  } finally {
    delete ramDB.activeRequests[chatId];
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : "";
  if (!text || text.startsWith('/') || msg.document) return;

  const quiz = ramDB.activeQuizzes[chatId];
  if (quiz && /^[A-Da-d]$/.test(text)) {
    const isCorrect = text.toUpperCase() === quiz.correctAnswer;
    const res = isCorrect ? "✅ إجابة صحيحة! أحسنت." : "❌ إجابة خاطئة.";
    bot.sendMessage(chatId, `${res}\nالإجابة الصحيحة: ${quiz.correctAnswer}\n\n📝 **الشرح الأكاديمي:**\n${quiz.explanation}`);
    delete ramDB.activeQuizzes[chatId];
    return;
  }

  if (ramDB.activeRequests[chatId]) {
    return bot.sendMessage(chatId, "⏳ يرجى الانتظار، النظام يعالج طلبك السابق...");
  }
  ramDB.activeRequests[chatId] = true;

  bot.sendChatAction(chatId, 'typing').catch(() => {});

  try {
    // استدعاء معلومات المستخدم من الذاكرة الدائمة
    const user = await getUser(chatId);
    let history = user.history || [];
    let currentSystemPrompt = systemPrompt;

    // تفعيل RAG مع الملفات المحفوظة
    if (user.documents && user.documents.length > 0) {
      const relevantChunks = searchRelevantChunks(text, user.documents, 2);
      if (relevantChunks.length > 0) {
        const documentContext = relevantChunks.join("\n\n...[فاصل المادة]...\n\n");
        currentSystemPrompt += `\n\n[مقتطفات من ملزمة الطالب]:\n${documentContext}\n\nأجب بناءً على المقتطفات فقط.`;
      }
    }

    const tempMessages = [
      { role: "system", content: currentSystemPrompt },
      ...history,
      { role: "user", content: text }
    ];

    let usedModel = "GPT-OSS-120B";
    let content = await callGroqAPI(tempMessages, "openai/gpt-oss-120b", 1000);
    
    if (!content) {
      usedModel = "Llama-3.3-70B";
      content = await callGroqAPI(tempMessages, "llama-3.3-70b-versatile", 1000);
    }

    if (content) {
      history.push({ role: "user", content: text });
      history.push({ role: "assistant", content: content });
      
      // حفظ المحادثة الجديدة في MongoDB
      await saveUserHistory(chatId, history);

      const finalReply = `${content}\n\n*(تم الرد بواسطة: ${usedModel})*`;
      bot.sendMessage(chatId, finalReply);
    } else {
      bot.sendMessage(chatId, "عذراً، تعذر الاتصال بالذكاء الاصطناعي حالياً.");
    }
  } catch (e) {
    bot.sendMessage(chatId, "حدث خطأ في النظام الداخلي.");
  } finally {
    delete ramDB.activeRequests[chatId];
  }
});

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot active with MongoDB Database');
}).listen(PORT, () => console.log(`🔥 Server running on port ${PORT}`));
