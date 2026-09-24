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
  userHistory[chatId] = []; // تصفير الذاكرة
  bot.sendMessage(chatId, "أهلاً بك! تم إصلاح مشكلة توقف الذاكرة بشكل نهائي.\n\n• اسأل عن أي موضوع تمريضي.\n• أرسل صورة لتحليلها.\n• أرسل /quiz في أي وقت وسأقوم باختبارك في آخر موضوع تحدثنا فيه!");
});

// 2. أمر /quiz
bot.onText(/\/quiz/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, 'typing');

  const history = userHistory[chatId] || [];

  if (history.length === 0) {
    return bot.sendMessage(chatId, "لم نناقش أي موضوع بعد! الرجاء طرح سؤال أولاً.");
  }

  const recentContext = history.slice(-4);
  const quizPrompt = `Based ONLY on the MOST RECENT nursing topic discussed in the latest messages above, generate ONE high-yield academic NCLEX-style nursing multiple-choice question (MCQ) in ENGLISH. 
Focus strictly on the LATEST topic we just talked about. 
Provide 4 options (A, B, C, D). Ask the user to choose the correct option first without giving the answer immediately.`;

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

// 4. المحادثة النصية العادية (هنا تم إصلاح المشكلة!)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text;

  if (!userMessage || userMessage.startsWith('/') || msg.photo) return;

  bot.sendChatAction(chatId, 'typing');

  if (!userHistory[chatId]) userHistory[chatId] = [];

  // إنشاء ذاكرة "مؤقتة" للطلب الحالي، ولا يتم حفظها في الذاكرة الدائمة إلا عند النجاح
  const tempMessages = [
    ...userHistory[chatId],
    { role: "user", content: userMessage }
  ];

  const models = [
    "openai/gpt-oss-120b",
    "llama-3.3-70b-versatile"
  ];

  let replied = false;
  let finalResponse = "";
  let usedModel = "";

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
            ...tempMessages
          ],
          temperature: 0.5,
          max_tokens: 2000
        })
      });

      const data = await response.json();

      // إذا رد الـ API برسالة خطأ بدلاً من الاستجابة، ننتقل للنموذج التالي فوراً
      if (data.error) {
        console.log(`Error from model ${model}:`, data.error.message);
        continue;
      }

      if (data.choices && data.choices[0]?.message?.content) {
        finalResponse = data.choices[0].message.content.trim();
        if (finalResponse.length > 0) {
          replied = true;
          usedModel = model;
          break; // نخرج من الحلقة بمجرد نجاح أول نموذج
        }
      }
    } catch (e) {
      console.log(`Model failed: ${model}`);
    }
  }

  // إذا نجح أحد النماذج بالرد، نقوم بتحديث الذاكرة الدائمة بشكل آمن
  if (replied) {
    userHistory[chatId].push({ role: "user", content: userMessage });
    userHistory[chatId].push({ role: "assistant", content: finalResponse });

    if (userHistory[chatId].length > 10) {
      userHistory[chatId] = userHistory[chatId].slice(-10);
    }

    await bot.sendMessage(chatId, `${finalResponse}\n\n---\n🤖 النموذج المستخدم: \`${usedModel}\``, { parse_mode: 'Markdown' });
  } else {
    // لم يتم الحفظ في الذاكرة! مما يعني أن محاولتك القادمة ستنجح بدون مشاكل.
    bot.sendMessage(chatId, "عذراً، تعذر معالجة الطلب حالياً (قد يكون هناك ضغط على السيرفر). يرجى إعادة الإرسال.");
  }
});

// سيرفر الـ Port الخاص بـ Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot active');
}).listen(PORT);
