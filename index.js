const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const http = require('http');
const pdfParse = require('pdf-parse');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// تشغيل البوت
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const db = {
  history: {},
  documents: {}
};

// 1. أوامر تيليجرام
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "أهلاً بك! البوت جاهز لاختبار الأزرار. أرسل /study");
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
  bot.sendMessage(chatId, '📚 **اختر وضع الدراسة الذي تفضله الآن لاختبار الأزرار:**', { parse_mode: 'Markdown', reply_markup: options });
});

// 2. اختبار الـ Callback Query المباشر
bot.on('callback_query', async (callbackQuery) => {
  console.log("🔥 CALLBACK RECEIVED:", callbackQuery.data);
  const chatId = callbackQuery.message?.chat?.id;
  try {
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: "تم استلام الزر ✅"
    });
    if (chatId) {
      await bot.sendMessage(
        chatId,
        `✅ وصلني ضغط الزر!\n\nالزر: ${callbackQuery.data}`
      );
    }
  } catch (error) {
    console.error("❌ CALLBACK ERROR:", error);
  }
});

// 3. المحادثة النصية البسيطة
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text ? msg.text.trim() : "";
  if (!userMessage || userMessage.startsWith('/')) return;
  bot.sendMessage(chatId, `وصلت رسالتك: ${userMessage}`);
});

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot active');
}).listen(PORT);
