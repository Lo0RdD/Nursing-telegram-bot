const axios = require('axios');
const http = require('http');
const pdfParse = require('pdf-parse');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

console.log("🔥 APP INITIALIZING...");
if (!TELEGRAM_TOKEN) console.error("❌ ERROR: TELEGRAM_TOKEN is missing!");

let offset = 0; // لمتابعة الرسائل القادمة وتجنب التكرار

// دالة إرسال الرسائل عبر API تيليجرام مباشرة
async function sendMessage(chatId, text, replyMarkup = null) {
  try {
    const body = {
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown'
    };
    if (replyMarkup) body.reply_markup = replyMarkup;

    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, body);
  } catch (error) {
    console.error("❌ Telegram Send Error:", error.response?.data || error.message);
  }
}

// دالة جلب الرسائل (Polling اليدوي البسيط والمستقر)
async function pollTelegram() {
  try {
    const response = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates`, {
      params: { offset: offset, timeout: 30 }
    });

    if (response.data && response.data.ok) {
      const updates = response.data.result;
      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    }
  } catch (error) {
    // إذا كان الخطأ 404، سيطبع بوضوح لنعرف سببه تماماً
    console.error("❌ Polling Error:", error.response?.data || error.message);
  }

  // الاستمرار في جلب الرسائل كل ثانية
  setTimeout(pollTelegram, 1000);
}

// معالجة الرسائل والأزرار الواردة
async function handleUpdate(update) {
  if (update.message) {
    const chatId = update.message.chat.id;
    const text = update.message.text ? update.message.text.trim() : "";

    console.log(`📩 Message received: ${text}`);

    if (text === '/start') {
      await sendMessage(chatId, "أهلاً بك في منصة التمريض الأكاديمية! 🩺\n\nأرسل /study لفتح أوضاع الدراسة.");
    } else if (text === '/study') {
      const options = {
        inline_keyboard: [
          [{ text: '👨‍⚕️ حالة سريرية (Clinical Case)', callback_data: 'mode_clinical' }],
          [{ text: '🎴 بطاقة استذكار (Flashcard)', callback_data: 'mode_flashcard' }],
          [{ text: '📝 اختبار سريع (Quiz)', callback_data: 'mode_quiz' }]
        ]
      };
      await sendMessage(chatId, "📚 **اختر وضع الدراسة الذي تفضله الآن:**", options);
    } else {
      await sendMessage(chatId, `وصلت رسالتك: ${text}`);
    }
  } else if (update.callback_query) {
    const callbackQuery = update.callback_query;
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;

    console.log(`🔥 CALLBACK RECEIVED: ${data}`);

    // الرد على الضغطة لإلغاء علامة التحميل
    try {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
        callback_query_id: callbackQuery.id,
        text: "تم الاستلام ✅"
      });
    } catch (e) {}

    await sendMessage(chatId, `✅ وصلني ضغط الزر بنجاح!\n\nالزر: ${data}`);
  }
}

// تشغيل سيرفر HTTP ليبقى Render نشطاً
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot active and running via HTTP API');
}).listen(PORT, () => {
  console.log(`🔥 HTTP Server running on port ${PORT}`);
  // بدء استقبال رسائل تيليجرام
  pollTelegram();
});
