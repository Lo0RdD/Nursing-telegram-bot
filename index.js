const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const http = require('http');
const pdfParse = require('pdf-parse');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

console.log("🔥 APP INITIALIZING...");
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const db = {
  history: {},
  activeQuizzes: {},
  activeFlashcards: {},
  documents: {}
};

const activeRequests = {};
const systemPrompt = `أنت مساعد أكاديمي محترف لطالب تمريض. التزم بالدقة العلمية ولا تقم بتأليف معلومات غير موجودة.`;

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

function getStudyContext(chatId) {
  if (db.documents[chatId] && db.documents[chatId].length > 0) {
    const docs = db.documents[chatId];
    const randomStart = Math.floor(Math.random() * Math.max(1, docs.length - 2));
    return `[المصدر: ملزمة الطالب Mapped PDF]\n${docs.slice(randomStart, randomStart + 2).join("\n\n")}`;
  }
  // رفعنا ذاكرة سياق الأزرار إلى آخر 10 رسائل بدل 4
  if (db.history[chatId] && db.history[chatId].length > 0) {
    return `[المصدر: آخر نقاشاتنا]\n${db.history[chatId].slice(-10).map(m => m.content).join("\n")}`;
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
  bot.sendMessage(chatId, "أهلاً بك في منصة التمريض الأكاديمية! 🩺\n\n• 📄 أرسل ملزمة PDF لقراءتها.\n• 🎓 أرسل /study لفتح أوضاع الدراسة.");
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
  const loadingMsg = await bot.sendMessage(chatId, '⏳ جاري استخراج النصوص من الملزمة وفهرستها...');

  try {
    const fileLink = await bot.getFileLink(doc.file_id);
    const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
    const pdfData = await pdfParse(response.data);
    const pdfText = pdfData.text.trim();

    if (!pdfText || pdfText.length < 20) {
      return bot.editMessageText("عذراً، الملف فارغ أو مصور.", { chat_id: chatId, message_id: loadingMsg.message_id });
    }

    db.documents[chatId] = chunkText(pdfText, 1200, 200); 
    if (!db.history[chatId]) db.history[chatId] = [];

    bot.editMessageText(`📚 **تمت فهرسة الملزمة بنجاح!** (${db.documents[chatId].length} قسم)\n\n✅ الملزمة مرتبطة الآن بأسئلة الـ Study والمحادثة. استخدم /study للاختبار.`, { chat_id: chatId, message_id: loadingMsg.message_id });
  } catch (e) {
    bot.editMessageText("حدث خطأ أثناء فهرسة الملف.", { chat_id: chatId, message_id: loadingMsg.message_id });
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const action = query.data;

  bot.answerCallbackQuery(query.id).catch(() => {});

  if (action === 'flip_flashcard') {
    const fc = db.activeFlashcards[chatId];
    if (fc) {
      bot.sendMessage(chatId, `✅ **الشرح:**\n${fc.definition}`);
      delete db.activeFlashcards[chatId];
    } else {
      bot.sendMessage(chatId, "انتهت صلاحية البطاقة، اطلب /study جديدة.");
    }
    return;
  }

  const loadingMsg = await bot.sendMessage(chatId, "⏳ جاري تجهيز المادة العلمية بناءً على ملزمتك أو سياقك الدراسي...");

  try {
    const studyContext = getStudyContext(chatId);

    if (action === 'mode_quiz') {
      const prompt = `Based strictly on this context: ${studyContext}\nGenerate ONE NCLEX-style MCQ. Output ONLY a valid JSON object:\n{"question": "Q in English", "options": {"A": "1", "B": "2", "C": "3", "D": "4"}, "correctAnswer": "A", "explanation": "شرح مفصل بالعربي"}`;
      let data = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "openai/gpt-oss-120b", 1000, true);
      if (!data) data = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "llama-3.3-70b-versatile", 1000, true);

      if (data && validateQuiz(data)) {
        db.activeQuizzes[chatId] = data;
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
        db.activeFlashcards[chatId] = data;
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
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : "";
  if (!text || text.startsWith('/') || msg.document) return;

  const quiz = db.activeQuizzes[chatId];
  if (quiz && /^[A-Da-d]$/.test(text)) {
    const isCorrect = text.toUpperCase() === quiz.correctAnswer;
    const res = isCorrect ? "✅ إجابة صحيحة! أحسنت." : "❌ إجابة خاطئة.";
    bot.sendMessage(chatId, `${res}\nالإجابة الصحيحة: ${quiz.correctAnswer}\n\n📝 **الشرح الأكاديمي:**\n${quiz.explanation}`);
    delete db.activeQuizzes[chatId];
    return;
  }

  bot.sendChatAction(chatId, 'typing').catch(() => {});

  try {
    if (!db.history[chatId]) db.history[chatId] = [];
    let currentSystemPrompt = systemPrompt;

    if (db.documents[chatId] && db.documents[chatId].length > 0) {
      const relevantChunks = searchRelevantChunks(text, db.documents[chatId], 2);
      if (relevantChunks.length > 0) {
        const documentContext = relevantChunks.join("\n\n...[فاصل المادة]...\n\n");
        currentSystemPrompt += `\n\n[مقتطفات من ملزمة الطالب]:\n${documentContext}\n\nأجب بناءً على المقتطفات فقط.`;
      }
    }

    const tempMessages = [
      { role: "system", content: currentSystemPrompt },
      ...db.history[chatId],
      { role: "user", content: text }
    ];

    // تتبع اسم النموذج المستخدم
    let usedModel = "GPT-OSS-120B";
    let content = await callGroqAPI(tempMessages, "openai/gpt-oss-120b", 1000);
    
    if (!content) {
      usedModel = "Llama-3.3-70B";
      content = await callGroqAPI(tempMessages, "llama-3.3-70b-versatile", 1000);
    }

    if (content) {
      db.history[chatId].push({ role: "user", content: text });
      db.history[chatId].push({ role: "assistant", content: content });
      
      // رفعنا حد الذاكرة من 6 إلى 30 رسالة (15 سؤال و 15 جواب)
      if (db.history[chatId].length > 30) {
        db.history[chatId] = db.history[chatId].slice(-30);
      }

      // إضافة توقيع النموذج في نهاية الرد
      const finalReply = `${content}\n\n*(تم الرد بواسطة: ${usedModel})*`;
      bot.sendMessage(chatId, finalReply);
    } else {
      bot.sendMessage(chatId, "عذراً، تعذر الاتصال بالذكاء الاصطناعي حالياً.");
    }
  } catch (e) {
    bot.sendMessage(chatId, "حدث خطأ في النظام الداخلي.");
  }
});

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot active');
}).listen(PORT);
