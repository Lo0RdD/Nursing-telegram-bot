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

function getStudyContext(chatId) {
  if (db.documents[chatId] && db.documents[chatId].length > 0) {
    const docs = db.documents[chatId];
    const randomStart = Math.floor(Math.random() * Math.max(1, docs.length - 2));
    return `[المصدر: ملزمة الطالب]\n${docs.slice(randomStart, randomStart + 2).join("\n\n")}`;
  }
  if (db.history[chatId] && db.history[chatId].length > 0) {
    return `[المصدر: آخر نقاشاتنا]\n${db.history[chatId].slice(-4).map(m => m.content).join("\n")}`;
  }
  return "أساسيات التمريض العامة";
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "أهلاً بك في منصة التمريض الأكاديمية! 🩺\n\nأرسل /study لفتح أوضاع الدراسة.");
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

// معالجة الأزرار بشكل مباشر ومضمون
bot.on('callback_query', async (query) => {
  console.log("🔥 BUTTON CLICKED:", query.data);
  const chatId = query.message.chat.id;
  const action = query.data;

  // إرسال تنبيه فوري لتيليجرام لإنهاء حالة التحميل للزر
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

  bot.sendMessage(chatId, "⏳ جاري توليد المادة العلمية...");

  try {
    const studyContext = getStudyContext(chatId);

    if (action === 'mode_quiz') {
      const prompt = `Based on: ${studyContext}\nGenerate ONE NCLEX-style MCQ. Output ONLY a valid JSON object:\n{"question": "Q", "options": {"A": "1", "B": "2", "C": "3", "D": "4"}, "correctAnswer": "A", "explanation": "شرح بالعربي"}`;
      let data = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "openai/gpt-oss-120b", 1000, true);
      if (!data) data = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "llama-3.3-70b-versatile", 1000, true);

      if (data && validateQuiz(data)) {
        db.activeQuizzes[chatId] = data;
        bot.sendMessage(chatId, `📝 **Quiz:**\n\n${data.question}\n\nA) ${data.options.A}\nB) ${data.options.B}\nC) ${data.options.C}\nD) ${data.options.D}\n\n👉 *أجب بحرف الخيار فقط (A, B, C, D)*`);
      } else {
        bot.sendMessage(chatId, "عذراً، فشل توليد الاختبار.");
      }
    } else if (action === 'mode_flashcard') {
      const prompt = `Based on: ${studyContext}\nExtract one nursing term. Output ONLY JSON:\n{"term": "Term", "definition": "تعريف بالعربي"}`;
      let data = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "openai/gpt-oss-120b", 800, true);
      if (!data) data = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "llama-3.3-70b-versatile", 800, true);

      if (data && data.term) {
        db.activeFlashcards[chatId] = data;
        bot.sendMessage(chatId, `🎴 **مصطلح:** **${data.term}**\n\nاضغط لقلب البطاقة:`, {
          reply_markup: { inline_keyboard: [[{ text: 'قلب البطاقة 🔄', callback_data: 'flip_flashcard' }]] }
        });
      } else {
        bot.sendMessage(chatId, "فشل توليد البطاقة.");
      }
    } else if (action === 'mode_clinical') {
      const prompt = `Based on: ${studyContext}\nGenerate a short clinical case study ending with: "What is the priority nursing intervention?" with Arabic hints.`;
      let text = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "openai/gpt-oss-120b", 1000);
      if (!text) text = await callGroqAPI([{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], "llama-3.3-70b-versatile", 1000);

      if (text) {
        bot.sendMessage(chatId, `👨‍⚕️ **حالة سريرية:**\n\n${text}`);
      } else {
        bot.sendMessage(chatId, "تعذر توليد الحالة السريرية.");
      }
    }
  } catch (e) {
    bot.sendMessage(chatId, "حدث خطأ أثناء المعالجة.");
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : "";
  if (!text || text.startsWith('/')) return;

  const quiz = db.activeQuizzes[chatId];
  if (quiz && /^[A-Da-d]$/.test(text)) {
    const isCorrect = text.toUpperCase() === quiz.correctAnswer;
    const res = isCorrect ? "✅ إجابة صحيحة!" : "❌ إجابة خاطئة.";
    bot.sendMessage(chatId, `${res}\nالإجابة: ${quiz.correctAnswer}\n\nالشرح:\n${quiz.explanation}`);
    delete db.activeQuizzes[chatId];
    return;
  }

  bot.sendMessage(chatId, `وصلت رسالتك: ${text}`);
});

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot active');
}).listen(PORT);
