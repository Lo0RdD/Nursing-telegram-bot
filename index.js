const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const http = require('http');
const pdfParse = require('pdf-parse');
const { MongoClient } = require('mongodb');
const FormData = require('form-data'); 

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MONGO_URI = process.env.MONGO_URI;

const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || "https://lord-bot.onrender.com";

console.log("🔥 APP INITIALIZING...");

const client = new MongoClient(MONGO_URI);
let usersCollection;
let bot; 

const ramDB = {
  activeQuizzes: {},
  activeFlashcards: {},
  activeRequests: {},
  pendingDocs: {} 
};

const systemPrompt = `أنت مساعد أكاديمي محترف لطالب تمريض. التزم بالدقة العلمية. أجب بناءً على النصوص المتاحة بوضوح واختصار.`;

async function initDBAndBot() {
  try {
    await client.connect();
    const database = client.db('NursingBotDB');
    usersCollection = database.collection('users');
    console.log("✅ MongoDB Connected Successfully!");
    
    bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
    
    // 1. إضافة Polling Error Listener للتشخيص
    bot.on('polling_error', (error) => {
      console.error('❌ TELEGRAM POLLING ERROR:', error.code, error.message);
    });

    setupBotListeners();
  } catch (err) {
    console.error("❌ MongoDB Connection Error:", err);
  }
}
initDBAndBot();

async function getUser(chatId) {
  let user = await usersCollection.findOne({ chatId });
  if (!user) {
    user = { chatId, history: [], documents: {} };
    await usersCollection.insertOne(user);
  }
  return user;
}

async function saveUserHistory(chatId, history) {
  const trimmedHistory = history.length > 8 ? history.slice(-8) : history;
  await usersCollection.updateOne({ chatId }, { $set: { history: trimmedHistory } }, { upsert: true });
}

async function saveUserDocuments(chatId, documents) {
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

function searchRelevantChunks(query, allDocsObject) {
  if (!allDocsObject) return null;
  let allChunks = [];
  Object.values(allDocsObject).forEach(subjectChunks => {
    if (Array.isArray(subjectChunks)) allChunks = allChunks.concat(subjectChunks);
  });
  if (allChunks.length === 0) return null;

  const queryLower = query.toLowerCase();
  if (queryLower.includes('ملزمة') || queryLower.includes('اشرح') || queryLower.includes('ملف')) {
    return allChunks[0]; 
  }

  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2 && !['هل','ما','كيف','اشرحلي','اشرح'].includes(w));
  for (let chunk of allChunks) {
    const chunkLower = chunk.toLowerCase();
    for (let word of queryWords) {
      if (chunkLower.includes(word)) return chunk;
    }
  }
  return allChunks[0];
}

async function callGroqAPI(messages, model = "openai/gpt-oss-120b", maxTokens = 800, isJson = false) {
  try {
    const payload = { model, messages, temperature: 0.3, max_tokens: maxTokens };
    if (isJson) payload.response_format = { type: "json_object" };

    const response = await axios.post("https://api.groq.com/openai/v1/chat/completions", payload, {
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" }, timeout: 10000 
    });

    let content = response.data?.choices?.[0]?.message?.content || null;
    if (!content) return null;
    
    if (isJson) {
      try {
        return JSON.parse(content);
      } catch (e) {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      }
    }
    return content;
  } catch (error) {
    console.error("Groq API Error:", error.message);
    return null; 
  }
}

function validateQuiz(data) {
  if (!data) return false;
  if (typeof data.question !== "string") return false;
  if (!data.options) return false;
  for (const key of ["A", "B", "C", "D"]) {
    if (typeof data.options[key] !== "string" || !data.options[key].trim()) return false;
  }
  if (!["A", "B", "C", "D"].includes(String(data.correctAnswer).toUpperCase())) return false;
  if (typeof data.explanation !== "string" || !data.explanation.trim()) return false;
  data.correctAnswer = String(data.correctAnswer).toUpperCase();
  return true;
}

function setupBotListeners() {
  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "أهلاً بك في منصة التمريض الأكاديمية! 🩺\n\n• 📄 أرسل ملزمة لتصنيفها.\n• 🎤 أرسل بصمة صوتية.\n• 🎓 أرسل /study للوضع الأكاديمي.");
  });

  bot.onText(/\/study/, (msg) => {
    bot.sendMessage(msg.chat.id, '📚 **اختر وضع الدراسة:**', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '👨‍⚕️ حالة سريرية (Clinical Case)', callback_data: 'mode_clinical' }],
          [{ text: '🎴 بطاقة استذكار (Flashcard)', callback_data: 'mode_flashcard' }],
          [{ text: '📝 اختبار سريع (Quiz)', callback_data: 'mode_quiz' }]
        ]
      },
      parse_mode: 'Markdown'
    });
  });

  bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    const doc = msg.document;
    if (!doc.mime_type || !doc.mime_type.includes('pdf')) return bot.sendMessage(chatId, "أرسل ملفات PDF فقط.");
    
    const loadingMsg = await bot.sendMessage(chatId, '⏳ جاري قراءة الملزمة...');
    try {
      const fileLink = await bot.getFileLink(doc.file_id);
      const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
      const pdfData = await pdfParse(response.data);
      const pdfText = pdfData.text.trim();

      if (!pdfText || pdfText.length < 20) return bot.editMessageText("الملف فارغ أو مصور.", { chat_id: chatId, message_id: loadingMsg.message_id });

      ramDB.pendingDocs[chatId] = chunkText(pdfText, 1000, 150);

      bot.editMessageText(`👇 **إلى أي مادة تنتمي هذه الملزمة؟**`, { 
        chat_id: chatId, 
        message_id: loadingMsg.message_id,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🤰 نسائية', callback_data: 'tag_نسائية' }],
            [{ text: '📊 طرائق البحث', callback_data: 'tag_طرائق البحث' }],
            [{ text: '🍎 تغذية', callback_data: 'tag_تغذية' }],
            [{ text: '👥 علم الاجتماع', callback_data: 'tag_علم الاجتماع' }]
          ]
        }
      });
    } catch (e) {
      bot.editMessageText("حدث خطأ أثناء الفهرسة.", { chat_id: chatId, message_id: loadingMsg.message_id });
    }
  });

  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const action = query.data;
    bot.answerCallbackQuery(query.id).catch(() => {});

    // 2. حماية الـ Callbacks من الأزرار القديمة أو غير المعروفة
    const validActions = ['mode_quiz', 'mode_flashcard', 'mode_clinical', 'flip_flashcard'];
    if (!action.startsWith('tag_') && !validActions.includes(action)) {
      return bot.sendMessage(chatId, "⚠️ هذا الزر لم يعد صالحاً. أرسل /study من جديد.");
    }

    if (action.startsWith('tag_')) {
      const subject = action.substring(4); 
      const chunks = ramDB.pendingDocs[chatId];
      if (!chunks) return bot.sendMessage(chatId, "انتهت الجلسة. أرسل الملزمة مجدداً.");

      bot.sendMessage(chatId, "⏳ جاري الأرشفة...");
      const user = await getUser(chatId);
      let docs = user.documents || {};
      if (Array.isArray(docs)) docs = { "General": docs };
      
      if (!docs[subject]) docs[subject] = [];
      docs[subject] = docs[subject].concat(chunks);
      await saveUserDocuments(chatId, docs);
      delete ramDB.pendingDocs[chatId]; 

      return bot.sendMessage(chatId, `✅ حفظت في قسم: **${subject}** 📁`, { parse_mode: 'Markdown' });
    }

    if (action === 'flip_flashcard') {
      const fc = ramDB.activeFlashcards[chatId];
      if (fc) {
        bot.sendMessage(chatId, `✅ **الشرح:**\n${fc.definition}`, { parse_mode: 'Markdown' });
        delete ramDB.activeFlashcards[chatId];
      } else {
        bot.sendMessage(chatId, "البطاقة قديمة، اطلب /study جديدة.");
      }
      return;
    }

    if (ramDB.activeRequests[chatId]) return bot.sendMessage(chatId, "⏳ يرجى الانتظار...");
    
    ramDB.activeRequests[chatId] = true;
    let loadingMsg;

    try {
      loadingMsg = await bot.sendMessage(chatId, "⏳ جاري التجهيز...");
      const user = await getUser(chatId);
      let studyContext = "أساسيات التمريض";
      let docs = user.documents || {};
      if (Array.isArray(docs)) docs = { "General": docs };
      
      let allChunks = [];
      Object.values(docs).forEach(arr => { if(Array.isArray(arr)) allChunks = allChunks.concat(arr); });
      if (allChunks.length > 0) studyContext = `[مقتطف من مكتبة ملازمك]:\n${allChunks[Math.floor(Math.random() * allChunks.length)]}`;

      if (action === 'mode_quiz') {
        const prompt = `Based on this context: ${studyContext}\nGenerate ONE NCLEX MCQ. Output strictly a JSON object: {"question": "Q?", "options": {"A": "1", "B": "2", "C": "3", "D": "4"}, "correctAnswer": "A", "explanation": "شرح بالعربي"}`;
        let data = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "openai/gpt-oss-120b", 800, true);
        if (!data) data = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "qwen/qwen3.8-27b", 800, true);

        if (validateQuiz(data)) {
          ramDB.activeQuizzes[chatId] = data;
          bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
          bot.sendMessage(chatId, `📝 **Quiz:**\n\n${data.question}\n\nA) ${data.options.A}\nB) ${data.options.B}\nC) ${data.options.C}\nD) ${data.options.D}`, { parse_mode: 'Markdown' });
        } else {
          bot.editMessageText("عذراً، فشل التوليد.", { chat_id: chatId, message_id: loadingMsg.message_id });
        }
      } else if (action === 'mode_flashcard') {
        const prompt = `Based on this context: ${studyContext}\nExtract one nursing term. Output strictly JSON: {"term": "Term", "definition": "شرح بالعربي"}`;
        let data = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "openai/gpt-oss-120b", 600, true);
        if (!data) data = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "qwen/qwen3.8-27b", 600, true);

        if (data && data.term) {
          ramDB.activeFlashcards[chatId] = data;
          bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
          bot.sendMessage(chatId, `🎴 **مصطلح طبي:** **${data.term}**\n\nاضغط للقلب:`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: 'قلب البطاقة 🔄', callback_data: 'flip_flashcard' }]] }
          });
        } else {
          bot.editMessageText("فشل التوليد.", { chat_id: chatId, message_id: loadingMsg.message_id });
        }
      } else if (action === 'mode_clinical') {
        const prompt = `Based on context: ${studyContext}\nGenerate a short clinical case study ending with priority intervention. Use Arabic hints.`;
        let text = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "openai/gpt-oss-120b", 800);
        if (!text) text = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "qwen/qwen3.8-27b", 800);

        if (text) {
          bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
          bot.sendMessage(chatId, `👨‍⚕️ **حالة سريرية:**\n\n${text}`, { parse_mode: 'Markdown' });
        } else {
          bot.editMessageText("تعذر التوليد.", { chat_id: chatId, message_id: loadingMsg.message_id });
        }
      }
    } catch (e) {
      console.error("❌ Study callback error:", e);
      if (loadingMsg) {
        bot.editMessageText("حدث خطأ في التجهيز.", { chat_id: chatId, message_id: loadingMsg.message_id }).catch(() => {});
      } else {
        bot.sendMessage(chatId, "حدث خطأ.");
      }
    } finally {
      delete ramDB.activeRequests[chatId];
    }
  });

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (msg.document || (msg.text && msg.text.startsWith('/'))) return;

    const quiz = ramDB.activeQuizzes[chatId];
    if (msg.text && quiz && /^[A-Da-d]$/.test(msg.text.trim())) {
      const isCorrect = msg.text.trim().toUpperCase() === quiz.correctAnswer;
      const res = isCorrect ? "✅ صحيحة!" : "❌ خاطئة.";
      bot.sendMessage(chatId, `${res}\nالإجابة: ${quiz.correctAnswer}\n\n📝 **الشرح:**\n${quiz.explanation}`, { parse_mode: 'Markdown' });
      delete ramDB.activeQuizzes[chatId];
      return;
    }

    if (ramDB.activeRequests[chatId]) return bot.sendMessage(chatId, "⏳ يرجى الانتظار...");
    
    ramDB.activeRequests[chatId] = true;
    let userText = "";
    let loadingMsgId = null;

    try {
      if (msg.voice) {
        const loadingMsg = await bot.sendMessage(chatId, "🎙️ جاري الاستماع...");
        loadingMsgId = loadingMsg.message_id;
        
        const fileLink = await bot.getFileLink(msg.voice.file_id);
        const audioRes = await axios.get(fileLink, { responseType: 'arraybuffer' });
        
        const form = new FormData();
        form.append('file', audioRes.data, { filename: 'voice.ogg', contentType: 'audio/ogg' });
        form.append('model', 'whisper-large-v3');

        const whisperRes = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
          headers: { ...form.getHeaders(), 'Authorization': `Bearer ${GROQ_API_KEY}` }
        });

        userText = whisperRes.data.text.trim();
        await bot.editMessageText(`🗣️ "${userText}"\n⏳ جاري الرد...`, { chat_id: chatId, message_id: loadingMsgId });
      } else if (msg.text) {
        userText = msg.text.trim();
        bot.sendChatAction(chatId, 'typing').catch(() => {});
      }

      if (!userText) throw new Error("Empty text");

      const user = await getUser(chatId);
      let history = user.history || [];
      let currentSystemPrompt = systemPrompt;

      let docs = user.documents || {};
      if (Array.isArray(docs)) docs = { "General": docs };
      const relevantChunk = searchRelevantChunks(userText, docs);
      
      if (relevantChunk) {
        currentSystemPrompt += `\n\n[مقتطف من الملزمة]:\n${relevantChunk}\n\nأجب معتمداً عليه إذا كان ذو صلة.`;
      }

      const tempMessages = [
        { role: "system", content: currentSystemPrompt },
        ...history,
        { role: "user", content: userText }
      ];

      let usedModel = "GPT-OSS-120B";
      let content = await callGroqAPI(tempMessages, "openai/gpt-oss-120b", 800);
      if (!content) {
        usedModel = "Qwen-3.8-27B";
        content = await callGroqAPI(tempMessages, "qwen/qwen3.8-27b", 800);
      }

      if (content) {
        history.push({ role: "user", content: userText }, { role: "assistant", content: content });
        await saveUserHistory(chatId, history);

        const finalReply = `${content}\n\n*(بواسطة: ${usedModel})*`;
        if (loadingMsgId) {
          bot.deleteMessage(chatId, loadingMsgId).catch(()=>{});
        }
        bot.sendMessage(chatId, finalReply);

      } else {
        bot.sendMessage(chatId, "تعذر الاتصال بالذكاء الاصطناعي.");
      }
    } catch (e) {
      if (loadingMsgId) bot.editMessageText("❌ حدث خطأ في المعالجة.", { chat_id: chatId, message_id: loadingMsgId });
      else bot.sendMessage(chatId, "حدث خطأ في النظام.");
    } finally {
      delete ramDB.activeRequests[chatId];
    }
  });
}

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot active & awake');
}).listen(PORT, () => {
  console.log(`🔥 Server running on port ${PORT}`);
  if (RENDER_EXTERNAL_URL) {
    setInterval(() => {
      axios.get(RENDER_EXTERNAL_URL).catch(() => {});
    }, 9 * 60 * 1000);
  }
});
