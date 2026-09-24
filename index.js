const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const http = require('http');
const pdfParse = require('pdf-parse');
const { MongoClient } = require('mongodb');
const FormData = require('form-data'); 

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MONGO_URI = process.env.MONGO_URI;

// ضع رابط موقعك على Render هنا (مثال: https://nursing-bot.onrender.com)
// أو دعه يتعرف عليه تلقائياً إذا أضفت متغير بيئة، لكن يفضل وضع الرابط الثابت مباشرة
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || "https://nursing-telegram-bot.onrender.com"; // استبدل الرابط برابط موقعك الحقيقي على Render

console.log("🔥 APP INITIALIZING...");

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

const ramDB = {
  activeQuizzes: {},
  activeFlashcards: {},
  activeRequests: {},
  pendingDocs: {} 
};

const systemPrompt = `أنت مساعد أكاديمي محترف لطالب تمريض. التزم بالدقة العلمية ولا تقم بتأليف معلومات غير موجودة. كن مباشراً وواضحاً في الإجابة.`;

async function getUser(chatId) {
  if (!usersCollection) return { history: [], documents: {} };
  let user = await usersCollection.findOne({ chatId });
  if (!user) {
    user = { chatId, history: [], documents: {} };
    await usersCollection.insertOne(user);
  }
  return user;
}

async function saveUserHistory(chatId, history) {
  if (!usersCollection) return;
  const trimmedHistory = history.length > 8 ? history.slice(-8) : history;
  await usersCollection.updateOne({ chatId }, { $set: { history: trimmedHistory } }, { upsert: true });
}

async function saveUserDocuments(chatId, documents) {
  if (!usersCollection) return;
  await usersCollection.updateOne({ chatId }, { $set: { documents } }, { upsert: true });
}

function chunkText(text, chunkSize = 1000, overlap = 150) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + chunkSize));
    i += (chunkSize - overlap);
  }
  return chunks;
}

function searchRelevantChunks(query, chunks, topN = 1) {
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

async function getStudyContext(chatId) {
  const user = await getUser(chatId);
  let docs = user.documents;
  
  if (Array.isArray(docs)) docs = { "General": docs };

  const subjects = Object.keys(docs || {});
  
  if (subjects.length > 0) {
    const randomSubject = subjects[Math.floor(Math.random() * subjects.length)];
    const subjectChunks = docs[randomSubject];
    
    if (subjectChunks && subjectChunks.length > 0) {
      const randomStart = Math.floor(Math.random() * Math.max(1, subjectChunks.length - 1));
      return `[المصدر: ملزمة ${randomSubject}]\n${subjectChunks[randomStart]}`;
    }
  }

  if (user.history && user.history.length > 0) {
    return `[المصدر: آخر نقاشاتنا]\n${user.history.slice(-4).map(m => m.content).join("\n")}`;
  }
  return "مواضيع التمريض العامة";
}

async function callGroqAPI(messages, model = "openai/gpt-oss-120b", maxTokens = 800, isJson = false) {
  try {
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      { model, messages, temperature: 0.3, max_tokens: maxTokens },
      { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" }, timeout: 10000 }
    );
    let content = response.data?.choices?.[0]?.message?.content || null;
    if (!content) return null;
    if (isJson) {
      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        return JSON.parse(jsonMatch[0]);
      } catch (e) { return null; }
    }
    return content;
  } catch (error) {
    console.error("Groq API Error Details:", error.response?.data || error.message);
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
  bot.sendMessage(chatId, "أهلاً بك في منصة التمريض الأكاديمية! 🩺\n\n• 📄 أرسل ملزمة PDF لتصنيفها وقراءتها.\n• 🎤 أرسل رسالة صوتية وسأفهمها فوراً!\n• 🎓 أرسل /study لفتح أوضاع الدراسة.");
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
  const loadingMsg = await bot.sendMessage(chatId, '⏳ جاري قراءة الملزمة وتحليلها...');

  try {
    const fileLink = await bot.getFileLink(doc.file_id);
    const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
    const pdfData = await pdfParse(response.data);
    const pdfText = pdfData.text.trim();

    if (!pdfText || pdfText.length < 20) return bot.editMessageText("عذراً، الملف فارغ أو مصور.", { chat_id: chatId, message_id: loadingMsg.message_id });

    const chunks = chunkText(pdfText, 1000, 150);
    ramDB.pendingDocs[chatId] = chunks;

    const options = {
      inline_keyboard: [
        [{ text: '🤰 نسائية', callback_data: 'tag_نسائية' }],
        [{ text: '📊 طرائق البحث', callback_data: 'tag_طرائق البحث' }],
        [{ text: '🍎 تغذية', callback_data: 'tag_تغذية' }],
        [{ text: '👥 علم الاجتماع', callback_data: 'tag_علم الاجتماع' }]
      ]
    };

    bot.editMessageText(`📚 **تم استخراج النصوص بنجاح!** (${chunks.length} قسم)\n\n👇 **إلى أي مادة تنتمي هذه الملزمة؟** (اختر لكي يتم حفظها في مكتبتك):`, { 
      chat_id: chatId, 
      message_id: loadingMsg.message_id,
      reply_markup: options
    });
  } catch (e) {
    bot.editMessageText("حدث خطأ أثناء الفهرسة.", { chat_id: chatId, message_id: loadingMsg.message_id });
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const action = query.data;

  bot.answerCallbackQuery(query.id).catch(() => {});

  if (action.startsWith('tag_')) {
    const subject = action.split('_')[1];
    const chunks = ramDB.pendingDocs[chatId];
    
    if (!chunks) return bot.sendMessage(chatId, "عذراً، انتهت صلاحية الجلسة. يرجى رفع الملزمة مجدداً.");

    bot.sendMessage(chatId, "⏳ جاري حفظ الملزمة في مكتبتك الدائمة...");
    
    const user = await getUser(chatId);
    let docs = user.documents;
    
    if (Array.isArray(docs)) docs = { "General": docs };
    if (!docs) docs = {};

    if (!docs[subject]) docs[subject] = [];
    docs[subject] = docs[subject].concat(chunks);

    await saveUserDocuments(chatId, docs);
    delete ramDB.pendingDocs[chatId]; 

    return bot.sendMessage(chatId, `✅ **تم الأرشفة!**\nحُفظت الملزمة بنجاح في قسم: **${subject}** 📁\nالآن كل الأزرار والاختبارات ستكون أدق وأكثر تنظيماً.`);
  }

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

  if (ramDB.activeRequests[chatId]) return bot.sendMessage(chatId, "⏳ يرجى الانتظار، أعالج طلبك السابق...");
  ramDB.activeRequests[chatId] = true;
  const loadingMsg = await bot.sendMessage(chatId, "⏳ جاري تجهيز المادة العلمية من مكتبتك...");

  try {
    const studyContext = await getStudyContext(chatId);

    if (action === 'mode_quiz') {
      const prompt = `Based strictly on this context: ${studyContext}\nGenerate ONE NCLEX-style MCQ. Output ONLY a valid JSON object:\n{"question": "Q in English", "options": {"A": "1", "B": "2", "C": "3", "D": "4"}, "correctAnswer": "A", "explanation": "شرح مفصل بالعربي"}`;
      let data = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "openai/gpt-oss-120b", 800, true);
      if (!data) data = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "qwen/qwen3.6-27b", 800, true);

      if (data && validateQuiz(data)) {
        ramDB.activeQuizzes[chatId] = data;
        bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
        bot.sendMessage(chatId, `📝 **Nursing Quiz:**\n\n${data.question}\n\nA) ${data.options.A}\nB) ${data.options.B}\nC) ${data.options.C}\nD) ${data.options.D}\n\n👉 *أجب بحرف الخيار فقط (A, B, C, D)*`);
      } else {
        bot.editMessageText("عذراً، فشل توليد الاختبار.", { chat_id: chatId, message_id: loadingMsg.message_id });
      }
    } else if (action === 'mode_flashcard') {
      const prompt = `Based strictly on this context: ${studyContext}\nExtract one important nursing term. Output ONLY JSON:\n{"term": "Term", "definition": "تعريف دقيق بالعربي"}`;
      let data = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "openai/gpt-oss-120b", 600, true);
      if (!data) data = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "qwen/qwen3.6-27b", 600, true);

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
      let text = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "openai/gpt-oss-120b", 800);
      if (!text) text = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "qwen/qwen3.6-27b", 800);

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
  if (msg.document || (msg.text && msg.text.startsWith('/'))) return;

  let userText = "";
  let loadingMsgId = null;

  if (msg.voice) {
    if (ramDB.activeRequests[chatId]) return bot.sendMessage(chatId, "⏳ يرجى الانتظار...");
    ramDB.activeRequests[chatId] = true;
    
    const loadingMsg = await bot.sendMessage(chatId, "🎙️ جاري الاستماع...");
    loadingMsgId = loadingMsg.message_id;
    
    try {
      const fileLink = await bot.getFileLink(msg.voice.file_id);
      const audioRes = await axios.get(fileLink, { responseType: 'arraybuffer' });
      
      const form = new FormData();
      form.append('file', audioRes.data, { filename: 'voice.ogg', contentType: 'audio/ogg' });
      form.append('model', 'whisper-large-v3');

      const whisperRes = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
        headers: { ...form.getHeaders(), 'Authorization': `Bearer ${GROQ_API_KEY}` }
      });

      userText = whisperRes.data.text.trim();
      bot.editMessageText(`🗣️ **أنت قلت:**\n"${userText}"\n\n⏳ جاري تجهيز الرد...`, { chat_id: chatId, message_id: loadingMsgId });
    } catch (e) {
      delete ramDB.activeRequests[chatId];
      return bot.editMessageText("❌ تعذر تحويل الصوت لنص.", { chat_id: chatId, message_id: loadingMsgId });
    }
    ramDB.activeRequests[chatId] = false; 
  } else if (msg.text) {
    userText = msg.text.trim();
  }

  if (!userText) return;

  const quiz = ramDB.activeQuizzes[chatId];
  if (quiz && /^[A-Da-d]$/.test(userText)) {
    const isCorrect = userText.toUpperCase() === quiz.correctAnswer;
    const res = isCorrect ? "✅ إجابة صحيحة! أحسنت." : "❌ إجابة خاطئة.";
    bot.sendMessage(chatId, `${res}\nالإجابة الصحيحة: ${quiz.correctAnswer}\n\n📝 **الشرح الأكاديمي:**\n${quiz.explanation}`);
    delete ramDB.activeQuizzes[chatId];
    return;
  }

  if (ramDB.activeRequests[chatId]) return bot.sendMessage(chatId, "⏳ يرجى الانتظار...");
  ramDB.activeRequests[chatId] = true;

  bot.sendChatAction(chatId, 'typing').catch(() => {});

  try {
    const user = await getUser(chatId);
    let history = user.history || [];
    let currentSystemPrompt = systemPrompt;

    let docs = user.documents;
    if (Array.isArray(docs)) docs = { "General": docs };

    let allChunks = [];
    if (docs) {
        Object.values(docs).forEach(subjectChunks => {
            allChunks = allChunks.concat(subjectChunks);
        });
    }

    if (allChunks.length > 0) {
      const relevantChunks = searchRelevantChunks(userText, allChunks, 1);
      if (relevantChunks.length > 0) {
        currentSystemPrompt += `\n\n[مقتطف من الملزمة]:\n${relevantChunks[0]}\n\nأجب بناءً على هذا المقتطف.`;
      }
    }

    const tempMessages = [
      { role: "system", content: currentSystemPrompt },
      ...history,
      { role: "user", content: userText }
    ];

    let usedModel = "GPT-OSS-120B";
    let content = await callGroqAPI(tempMessages, "openai/gpt-oss-120b", 800);
    
    if (!content) {
      usedModel = "Qwen-3.6-27B";
      content = await callGroqAPI(tempMessages, "qwen/qwen3.6-27b", 800);
    }

    if (content) {
      history.push({ role: "user", content: userText });
      history.push({ role: "assistant", content: content });
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
  res.end('Bot active & awake');
}).listen(PORT, () => {
  console.log(`🔥 Server running on port ${PORT}`);

  // آلية منع النوم (Self-Ping): يقوم السيرفر بطلب نفسه كل 9 دقائق ليبقي السيرفر مستيقظاً دائماً
  if (RENDER_EXTERNAL_URL) {
    setInterval(() => {
      axios.get(RENDER_EXTERNAL_URL)
        .then(() => console.log("🔄 Keep-Alive Ping sent successfully!"))
        .catch(err => console.log("⚠️ Keep-Alive Ping failed:", err.message));
    }, 9 * 60 * 1000); // كل 9 دقائق
  }
});
