const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

// طباعة إضافية للتأكد من قراءة التوكن والبدء
console.log("🔥 APP INITIALIZING...");

if (!TELEGRAM_TOKEN) {
  console.error("❌ ERROR: TELEGRAM_TOKEN is missing in environment variables!");
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

console.log("🔥 BOT STARTED - TEST VERSION");

// اختبار أمر /start
bot.onText(/\/start/, (msg) => {
  console.log("🔥 START COMMAND RECEIVED from chat ID:", msg.chat.id);
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    "أهلاً بك! البوت يعمل بنجاح. أرسل /study"
  );
});

// اختبار أمر /study والأزرار
bot.onText(/\/study/, (msg) => {
  console.log("🔥 STUDY COMMAND RECEIVED from chat ID:", msg.chat.id);
  const chatId = msg.chat.id;
  const options = {
    inline_keyboard: [
      [{ text: 'Clinical Case', callback_data: 'mode_clinical' }],
      [{ text: 'Flashcard', callback_data: 'mode_flashcard' }],
      [{ text: 'Quiz', callback_data: 'mode_quiz' }]
    ]
  };
  bot.sendMessage(
    chatId,
    'اختر وضع الدراسة:',
    { reply_markup: options }
  );
});

// اختبار استقبال الأزرار
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

// سيرفر HTTP البسيط لكي يستيقظ Render ولا يدخل في Sleep دائم
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot active and running');
}).listen(PORT, () => {
  console.log(`🔥 HTTP Server running on port ${PORT}`);
});
