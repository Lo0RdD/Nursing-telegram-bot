const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const http = require('http');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ذاكرة المحادثة لكل مستخدم
const userHistory = {};

const systemPrompt = `أنت رفيق معرفي أكاديمي لمستخدم بمسار موسوعي يدرس التمريض. أجب بدقة وعمق علمي وبشكل مباشر لأغراض التعليم والبحث الأكاديمي.`;

// 1. أمر البداية
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userHistory[chatId] = []; // تصفير الذاكرة لتجنب أي تعليق
  bot.sendMessage(chatId, "أهلاً بك! تم استعادة النموذج الخاص بك (gpt-oss-120b).\n\n• اسأل عن أي موضوع تمريضي.\n• أرسل صورة لتحليلها.\n• أرسل /quiz في أي وقت وسأقوم باختبارك في *آخر موضوع* تحدثنا فيه فقط!");
});

// 2. أمر /quiz (تم إصلاحه ليركز على أحدث موضوع فقط)
bot.onText(/\/quiz/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, 'typing');

  const history = userHistory[chatId] || [];

  if (history.length === 0) {
    return bot.sendMessage(chatId, "لم نناقش أي موضوع بعد! الرجاء طرح سؤال أولاً.");
  }

  // **الحل السحري لمشكلة الـ Quiz:** 
  // جلب آخر 4 رسائل فقط (سؤالك وجواب البوت الأخير) لضمان عدم الرجوع للمواضيع القديمة
  const recentContext = history.slice(-4);

  const quizPrompt = `Based ONLY on the MOST RECENT nursing topic discussed in the latest messages above, generate ONE high-yield academic NCLEX-style nursing multiple-choice question (MCQ) in ENGLISH. 
Focus strictly on the LATEST topic we just talked about. 
Provide 4 options (A, B, C, D). Ask the user to choose the correct option first without giving the answer immediately.`;

  // النموذج المفضل لديك هو الأساس
  const models = ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"];
  let quizGenerated = false;

  for (const model of models) {
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
            ...recentContext,
            { role: "user", content: quizPrompt }
          ],
          temperature: 0.5
        })
      });

      const data = await response.json();
      const quizText = data.choices[0]?.message?.content;

      if (quizText) {
        bot.sendMessage(chatId, `📝 **Nursing Quiz (Context-Based):**\n\n${quizText}`, { parse_mode: 'Markdown' });
        quizGenerated = true;
        break;
      }
    } catch (e) {
      console.log(`Quiz failed on model ${model}:`, e.message);
    }
  }

  if (!quizGenerated) {
    bot.sendMessage(chatId, "حدث خطأ مؤقت في السيرفر أثناء توليد الاختبار. جرب مرة أخرى.");
  }
});

// 3. معالجة الصور
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const caption = msg.caption || "اقرأ واشرح ما في الصورة بدقة طبية وتمريضية.";

  bot.sendChatAction(chatId, 'typing');

  try {
    const photo = msg.photo[msg.photo.length - 1];
    const file = await bot.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;

    const imgResponse = await fetch(fileUrl);
    const buffer = await imgResponse.buffer();
    const base64Image = buffer.toString('base64');
    const dataUrl = `data:image/jpeg;base64,${base64Image}`;

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
              { type: "image_url", image_url: { url: dataUrl } }
            ]
          }
        ],
        temperature: 0.3
      })
    });

    const data = await response.json();
    if (data.choices && data.choices[0]?.message?.content) {
      const analysis = data.choices[0].message.content;

      if (!userHistory[chatId]) userHistory[chatId] = [];
      
      // حفظ محتوى الصورة في الذاكرة لتكون هي الموضوع الأحدث للـ quiz
      userHistory[chatId].push({ role: "user", content: `محتوى الصورة الأخير: ${analysis}` });
      userHistory[chatId].push({ role: "assistant", content: analysis });

      if (userHistory[chatId].length > 10) {
        userHistory[chatId] = userHistory[chatId].slice(-10);
      }

      bot.sendMessage(chatId, `📷 **تحليل الصورة:**\n\n${analysis}`);
    } else {
      bot.sendMessage(chatId, "تعذر تحليل الصورة.");
    }
  } catch (e) {
    bot.sendMessage(chatId, "حدث خطأ أثناء معالجة الصورة.");
  }
});

// 4. المحادثة النصية العادية
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text;

  if (!userMessage || userMessage.startsWith('/') || msg.photo) return;

  bot.sendChatAction(chatId, 'typing');

  if (!userHistory[chatId]) userHistory[chatId] = [];

  userHistory[chatId].push({ role: "user", content: userMessage });

  // تقليل حجم الذاكرة لتجنب خطأ "تعذر معالجة الطلب" بسبب حجم السياق (Context Limit)
  if (userHistory[chatId].length > 10) {
    userHistory[chatId] = userHistory[chatId].slice(-10);
  }

  // ترتيب النماذج بحيث يكون gpt-oss-120b هو الأساس
  const models = [
    "openai/gpt-oss-120b",
    "llama-3.3-70b-versatile"
  ];

  let replied = false;

  for (const model of models) {
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
          userHistory[chatId].push({ role: "assistant", content: content });
          await bot.sendMessage(chatId, `${content}\n\n---\n🤖 النموذج المستخدم: \`${model}\``, { parse_mode: 'Markdown' });
          replied = true;
          break;
        }
      }
    } catch (e) {
      console.log(`Model failed: ${model}`);
    }
  }

  if (!replied) {
    bot.sendMessage(chatId, "عذراً، تعذر معالجة الطلب حالياً (قد يكون هناك ضغط على السيرفر). يرجى إعادة الإرسال.");
  }
});

// سيرفر الـ Port الخاص بـ Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot active');
}).listen(PORT);
