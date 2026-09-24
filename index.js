const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const http = require('http');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ذاكرة المؤقتة لـ 12 رسالة لكل مستخدم
const userHistory = {};

const systemPrompt = `أنت رفيق معرفي أكاديمي لمستخدم بمسار موسوعي يدرس التمريض. أجب بدقة وعمق علمي وبشكل مباشر لأغراض التعليم والبحث الأكاديمي.`;

// 1. أمر البداية مع أزرار تفاعلية
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const opts = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🩺 اختبرني بسؤال تمريضي (Quiz)", callback_data: "generate_quiz" }],
        [{ text: "🗑️ مسح ذاكرة المحادثة", callback_data: "clear_memory" }]
      ]
    }
  };
  bot.sendMessage(chatId, "أهلاً بك! البوت جاهز الآن بميزات مطوّرة:\n\n• إرسال الأسئلة النصية بحفظ السياق (حتى 12 رسالة).\n• إرسال صور المحاضرات والمخططات لتحليلها.\n• خيار الاختبارات الفلاشية السريعة.", opts);
});

// 2. معالجة الضغط على الأزرار التفاعلية
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  
  if (query.data === 'clear_memory') {
    userHistory[chatId] = [];
    await bot.answerCallbackQuery(query.id, { text: "تم مسح الذاكرة بنجاح!" });
    return bot.sendMessage(chatId, "🧹 تم مسح الذاكرة المؤقتة. يمكنك البدء بموضوع جديد الآن.");
  }

  if (query.data === 'generate_quiz') {
    await bot.answerCallbackQuery(query.id, { text: "جاري إنشاء سؤال..." });
    bot.sendChatAction(chatId, 'typing');
    
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-120b",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: "اطرح عليّ سؤالاً تمريضياً متعدد الخيارات (MCQ) مع 4 خيارات، دون إعطاء الإجابة الصحيحة فوراً، واطلب مني اختيار الإجابة." }
          ],
          temperature: 0.7
        })
      });
      const data = await response.json();
      const quizText = data.choices[0]?.message?.content;
      bot.sendMessage(chatId, `📝 **سؤال اختباري:**\n\n${quizText}`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, "تعذر إنشاء السؤال حالياً، حاول مرة أخرى.");
    }
  }
});

// 3. معالجة الصور (Vision - OCR وتحليل)
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const caption = msg.caption || "اشرح واقرأ ما يوجد في هذه الصورة بدقة علمية وتمريضية.";

  bot.sendChatAction(chatId, 'typing');

  try {
    const photo = msg.photo[msg.photo.length - 1]; // الحصول على أعلى دقة
    const fileLink = await bot.getFileLink(photo.file_id);

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.2-11b-vision-preview",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: caption },
              { type: "image_url", image_url: { url: fileLink } }
            ]
          }
        ],
        temperature: 0.4
      })
    });

    const data = await response.json();
    if (data.choices && data.choices[0]?.message?.content) {
      bot.sendMessage(chatId, `📷 **تحليل الصورة:**\n\n${data.choices[0].message.content}`);
    } else {
      bot.sendMessage(chatId, "تعذر تحليل الصورة، تأكد من وضوح النص فيها.");
    }
  } catch (e) {
    console.log("خطأ في تحليل الصورة:", e.message);
    bot.sendMessage(chatId, "حدث خطأ أثناء معالجة الصورة عبر نموذج الرؤية.");
  }
});

// 4. معالجة الرسائل النصية مع الذاكرة (Memory Context - 12 رسالة)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text;

  // تجاهل الصور والأوامر لتجنب التكرار والتعارض
  if (!userMessage || userMessage.startsWith('/') || msg.photo) return;

  bot.sendChatAction(chatId, 'typing');

  // تهيئة الذاكرة للمستخدم
  if (!userHistory[chatId]) userHistory[chatId] = [];

  // إضافة رسالة المستخدم للذاكرة
  userHistory[chatId].push({ role: "user", content: userMessage });

  // حفظ آخر 12 رسالة فقط (6 من المستخدم و 6 من البوت)
  if (userHistory[chatId].length > 12) {
    userHistory[chatId] = userHistory[chatId].slice(-12);
  }

  const selectedModels = [
    "openai/gpt-oss-120b",
    "qwen/qwen3.8-27b",
    "openai/gpt-oss-20b"
  ];

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
            ...userHistory[chatId]
          ],
          temperature: 0.5,
          max_tokens: 2000
        })
      });

      const data = await response.json();

      if (data.choices && data.choices[0]?.message?.content) {
        const content = data.choices[0].message.content.trim();
        if (content.length > 0) {
          // إضافة رد البوت للذاكرة
          userHistory[chatId].push({ role: "assistant", content: content });
          
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

// سيرفر الـ Port الخفيف لـ Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running live!');
}).listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
