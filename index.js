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
    user = { chatId, history: [], documents: {}, lastSubject: null };
    await usersCollection.insertOne(user);
  }
  return user;
}

async function saveUserHistory(chatId, history) {
  await usersCollection.updateOne({ chatId }, { $set: { history: history } }, { upsert: true });
}

async function saveUserDocuments(chatId, documents, lastSubject = null) {
  const updateData = { documents };
  if (lastSubject) updateData.lastSubject = lastSubject;
  await usersCollection.updateOne({ chatId }, { $set: updateData }, { upsert: true });
}

function chunkText(text, chunkSize = 2000, overlap = 400) {

  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + chunkSize));
    i += (chunkSize - overlap);
  }
  return chunks;
}

function searchRelevantChunks(query, allDocsObject, lastSubject) {
  if (!allDocsObject) return null;
  
  let targetSubject = (lastSubject && allDocsObject[lastSubject]) ? lastSubject : Object.keys(allDocsObject)[0];
  let recentChunks = allDocsObject[targetSubject] || [];
  
  let allChunks = [];
  Object.values(allDocsObject).forEach(arr => { if(Array.isArray(arr)) allChunks = allChunks.concat(arr); });
  if (allChunks.length === 0) return null;

  const queryLower = query.toLowerCase();
  
  if (queryLower.includes('ترجم') || queryLower.includes('اول') || queryLower.includes('صفحة') || queryLower.includes('ملف') || queryLower.includes('ملزمة')) {
    if (recentChunks.length > 0) {
      return recentChunks[0]; 
    }
  }

  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2 && !['هل','ما','كيف','اشرحلي','اشرح', 'ترجم'].includes(w));
  
  for (let chunk of recentChunks) {
      const chunkLower = chunk.toLowerCase();
      for (let word of queryWords) {
          if (chunkLower.includes(word)) return chunk;
      }
  }

  for (let chunk of allChunks) {
    const chunkLower = chunk.toLowerCase();
    for (let word of queryWords) {
      if (chunkLower.includes(word)) return chunk;
    }
  }
  
  return recentChunks[0] || allChunks[0];
}

// تم جعل Llama في المقدمة ليتم اختباره ورؤيته في الـ Logs
async function callGroqAPI(messages, maxTokens = 800, isJson = false) {
  const modelsSequence = [
    "openai/gpt-oss-120b",
    "qwen/qwen3.8-27b"
  ];

  for (let model of modelsSequence) {
    try {
      const payload = { model, messages, temperature: 0.3, max_tokens: maxTokens };
      if (isJson) payload.response_format = { type: "json_object" };

      const response = await axios.post("https://api.groq.com/openai/v1/chat/completions", payload, {
        headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" }, timeout: 25000 
      });

      let content = response.data?.choices?.[0]?.message?.content || null;
      if (!content) continue;

      console.log(`✅ SUCCESS with model: ${model}`);
      
      if (isJson) {
        try { 
          const parsed = JSON.parse(content);
          return { data: parsed, usedModel: model };
        } 
        catch (e) {
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            return { data: JSON.parse(jsonMatch[0]), usedModel: model };
          }
          continue;
        }
      }
      return { data: content, usedModel: model };

    } catch (error) {
      console.error(`⚠️ Model ${model} failed:`, error.message);
    }
  }
  return null;
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
    bot.onText(/\/testapi/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "⏳ جاري فحص مفتاح Codecraft الخاص بك...");
    
    try {
      const response = await axios.post("https://codecraftapi.com/v1/chat/completions", {
        model: "gpt-5.6-luna", // 👈 تم تغيير اسم النموذج هنا ليتطابق مع الموقع
        messages: [{ role: "user", content: "هل تسمعني؟ أجب بكلمة 'شغال' فقط." }]
      }, {
        headers: {
          "Authorization": "Bearer cc_sQsXE2JCfRkORN1mUxyzarCGh5dYELqUcddjtp7FkjWeZRQV",
          "Content-Type": "application/json"
        },
        timeout: 10000
      });
      
      const reply = response.data.choices[0].message.content;
      bot.sendMessage(chatId, `✅ مبروك! المفتاح شغال والـ API متصل.\nرد النموذج (GPT-5.6 Luna): ${reply}`);
      
    } catch (error) {
      console.error(error.message);
      bot.sendMessage(chatId, `❌ للأسف فشل الاتصال.\nالخطأ: ${error.message}`);
    }
  });


  bot.onText(/\/reset/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (ramDB.activeRequests[chatId]) {
      return bot.sendMessage(chatId, "⏳ يرجى الانتظار حتى تنتهي العملية الحالية...");
    }

    try {
      await usersCollection.updateOne(
        { chatId: chatId },
        { $set: { history: [], documents: {}, lastSubject: null } },
        { upsert: true }
      );

      delete ramDB.pendingDocs[chatId];
      delete ramDB.activeQuizzes[chatId];
      delete ramDB.activeFlashcards[chatId];

      bot.sendMessage(chatId, "🗑️ **تمت التهيئة بنجاح!**\nتم مسح جميع الملازم وسجل المحادثات الخاص بك. البوت الآن نظيف تماماً وكأنك مشترك جديد.\n\nأرسل /start للبدء من جديد.", { parse_mode: 'Markdown' });
    } catch (e) {
      console.error("❌ Reset Error:", e);
      bot.sendMessage(chatId, "❌ حدث خطأ أثناء محاولة مسح البيانات.");
    }
  });

  bot.onText(/\/study/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);
    let docs = user.documents || {};
    
    const subjects = Object.keys(docs).filter(k => Array.isArray(docs[k]) && docs[k].length > 0);
    
    if (subjects.length === 0) {
      return bot.sendMessage(chatId, "📚 مكتبتك فارغة حالياً! يرجى إرسال ملف PDF وتصنيفه أولاً.");
    }

    const keyboard = subjects.map(sub => [{ text: `📚 مادة: ${sub}`, callback_data: `study_subj_${sub}` }]);

    bot.sendMessage(chatId, '👇 **اختر المادة التي تريد دراستها الآن:**', {
      reply_markup: { inline_keyboard: keyboard },
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

      ramDB.pendingDocs[chatId] = chunkText(pdfText, 2000, 400);


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

    if (!action.startsWith('tag_') && !action.startsWith('study_subj_') && !action.startsWith('mode_') && action !== 'flip_flashcard') {
      return bot.sendMessage(chatId, "⚠️ هذا الزر لم يعد صالحاً. أرسل /study من جديد.");
    }

    if (action.startsWith('tag_')) {
      const subject = action.substring(4); 
      const chunks = ramDB.pendingDocs[chatId];
      if (!chunks) return bot.sendMessage(chatId, "انتهت الجلسة. أرسل الملزمة مجدداً.");

      bot.sendMessage(chatId, "⏳ جاري الأرشفة...");
      const user = await getUser(chatId);
      let docs = user.documents || {};
      
      if (!docs[subject]) docs[subject] = [];
      docs[subject] = docs[subject].concat(chunks);
      
      await saveUserDocuments(chatId, docs, subject);
      delete ramDB.pendingDocs[chatId]; 

      return bot.sendMessage(chatId, `✅ حفظت في قسم: **${subject}** 📁\nيمكنك الآن طلب ترجمتها أو شرحها.`, { parse_mode: 'Markdown' });
    }

    if (action.startsWith('study_subj_')) {
      const subject = action.substring(11); 
      bot.editMessageText(`📚 **اختر وضع الدراسة لمادة:** *${subject}*`, {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: {
          inline_keyboard: [
            [{ text: '👨‍⚕️ حالة سريرية (Clinical Case)', callback_data: `mode_clinical_${subject}` }],
            [{ text: '🎴 بطاقة استذكار (Flashcard)', callback_data: `mode_flashcard_${subject}` }],
            [{ text: '📝 اختبار سريع (Quiz)', callback_data: `mode_quiz_${subject}` }]
          ]
        },
        parse_mode: 'Markdown'
      });
      return;
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

    if (action.startsWith('mode_')) {
      if (ramDB.activeRequests[chatId]) return bot.sendMessage(chatId, "⏳ يرجى الانتظار...");
      ramDB.activeRequests[chatId] = true;
      let loadingMsg;

      try {
        const parts = action.split('_');
        const modeType = parts[0] + '_' + parts[1]; 
        const subject = parts.slice(2).join('_'); 

        loadingMsg = await bot.sendMessage(chatId, `⏳ جاري التجهيز من مادة ${subject}...`);
        
        const user = await getUser(chatId);
        let docs = user.documents || {};
        let subjectChunks = docs[subject] || [];
        
        let studyContext = "أساسيات التمريض";
        if (subjectChunks.length > 0) {
          studyContext = `[Nursing Lecture Excerpt - Subject: ${subject}]:\n${subjectChunks[Math.floor(Math.random() * subjectChunks.length)]}`;
        }

        if (modeType === 'mode_quiz') {
          const prompt = `Based strictly on this context: ${studyContext}
Generate ONE NCLEX-style MCQ in ENGLISH. 
The 'explanation' field MUST be in Arabic. 
Output strictly a valid JSON object exactly like this: 
{"question": "English question?", "options": {"A": "Eng 1", "B": "Eng 2", "C": "Eng 3", "D": "Eng 4"}, "correctAnswer": "A", "explanation": "شرح مفصل بالعربية حول سبب اختيار هذه الإجابة"}`;
          
          let resObj = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], 800, true);
          let data = resObj ? resObj.data : null;

          if (validateQuiz(data)) {
            ramDB.activeQuizzes[chatId] = data;
            bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
            bot.sendMessage(chatId, `📝 **Quiz (${subject}):**\n\n${data.question}\n\nA) ${data.options.A}\nB) ${data.options.B}\nC) ${data.options.C}\nD) ${data.options.D}`, { parse_mode: 'Markdown' });
          } else {
            bot.editMessageText("عذراً، فشل التوليد. حاول مجدداً.", { chat_id: chatId, message_id: loadingMsg.message_id });
          }
        } else if (modeType === 'mode_flashcard') {
          const prompt = `Based strictly on this context: ${studyContext}
Extract ONE key nursing or medical concept/definition. 
Output strictly a valid JSON object exactly like this: 
{"term": "Term in English", "definition": "Definition in English with a brief Arabic explanation"}`;
          
          let resObj = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], 600, true);
          let data = resObj ? resObj.data : null;

          if (data && data.term) {
            ramDB.activeFlashcards[chatId] = data;
            bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
            bot.sendMessage(chatId, `🎴 **مفهوم طبي (${subject}):**\n**${data.term}**\n\nاضغط للقلب لمعرفة المعنى:`, {
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: [[{ text: 'قلب البطاقة 🔄', callback_data: 'flip_flashcard' }]] }
            });
          } else {
            bot.editMessageText("فشل توليد البطاقة. حاول مجدداً.", { chat_id: chatId, message_id: loadingMsg.message_id });
          }
        } else if (modeType === 'mode_clinical') {
          const prompt = `Based strictly on this context: ${studyContext}
Generate a short nursing clinical case study in ENGLISH ending with a priority intervention question (What is the priority nursing action?). 
Include a brief Arabic hint at the very end. Do not use JSON, just text.`;
          
          let resObj = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], 800, false);
          let text = resObj ? resObj.data : null;

          if (text) {
            bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
            bot.sendMessage(chatId, `👨‍⚕️ **Clinical Case (${subject}):**\n\n${text}`, { parse_mode: 'Markdown' });
          } else {
            bot.editMessageText("تعذر توليد الحالة السريرية.", { chat_id: chatId, message_id: loadingMsg.message_id });
          }
        }
      } catch (e) {
        console.error("❌ Study callback error:", e);
        if (loadingMsg) bot.editMessageText("حدث خطأ في التجهيز.", { chat_id: chatId, message_id: loadingMsg.message_id }).catch(() => {});
      } finally {
        delete ramDB.activeRequests[chatId];
      }
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

      let contextHistory = history.length > 5 ? history.slice(-5) : history;
      let docs = user.documents || {};
      
      const relevantChunk = searchRelevantChunks(userText, docs, user.lastSubject);
      
      if (relevantChunk) {
        currentSystemPrompt += `\n\n[مقتطف من ملزمة الطالب المرجعية]:\n${relevantChunk}\n\nتوجيه حاسم: إذا طلب الطالب ترجمة أو شرح النص، فقم بذلك فوراً اعتماداً على المقتطف المرفق أعلاه ولا تطلب منه نسخه أو إعادة كتابته.`;
      }

      const tempMessages = [
        { role: "system", content: currentSystemPrompt },
        ...contextHistory, 
        { role: "user", content: userText }
      ];

      let apiResult = await callGroqAPI(tempMessages, 800, false);

      if (apiResult && apiResult.data) {
        let content = apiResult.data;
        let usedModel = apiResult.usedModel.includes('gpt') ? "GPT-120B" : "Qwen-27B";


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
