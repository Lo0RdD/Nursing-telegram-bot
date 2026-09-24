const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const http = require('http');

// 1. قراءة التوكن والمفاتيح من بيئة العمل
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// 2. توجيه أكاديمي تمريضي مباشر
const systemPrompt = `أنت رفيق معرفي أكاديمي لمستخدم بمسار موسوعي يدرس التمريض. أجب بدقة وعمق علمي وبشكل مباشر لأغراض التعليم والبحث الأكاديمي.`;

const selectedModels = [
  "openai/gpt-oss-120b",
  "qwen/qwen3.8-27b",
  "openai/gpt-oss-20b"
];

// 3. الاستجابة لرسائل تلغرام
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text;

  if (!userMessage || userMessage.startsWith('/start')) {
    return bot.sendMessage(chatId, "أهلاً بك! أنا جاهز لمساعدتك في دراستك الأكاديمية والتمريضية.");
  }

  // إرسال إشارة "جاري الكتابة..."
  bot.sendChatAction(chatId, 'typing');

  let replied = false;

  for (const model of selectedModels) {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage }
          ],
          temperature: 0.5,
          max_tokens: 2000
        })
      });

      const data = await response.json();

      if (data.choices && data.choices[0]?.message?.content) {
        const content = data.choices[0].message.content.trim();
        if (content.length > 0) {
          await bot.sendMessage(chatId, `${content}\n\n---\n🤖 *النموذج المستخدم:* \`${model}\``, { parse_mode: 'Markdown' });
          replied = true;
          break;
        }
      }
    } catch (e) {
      console.log(`فشل النموذج ${model}، جاري الانتقال للبديل...`);
    }
  }

  if (!replied) {
    bot.sendMessage(chatId, "عذراً، تعذر معالجة الطلب حالياً. يرجى إعادة إرساله بعبارة قصيرة.");
  }
});

// 4. سيرفر وهمي لإرضاء Render ومنع خطأ الـ Port
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running live!');
}).listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

console.log("البوت يعمل بنجاح...");
