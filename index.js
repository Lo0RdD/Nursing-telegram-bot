const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const http = require('http');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ذاكرة المحادثة لكل مستخدم
const userHistory = {};

const systemPrompt = `أنت رفيق معرفي أكاديمي لمستخدم بمسار موسوعي يدرس التمريض. أجب بدقة وعمق علمي وبشكل مباشر لأغراض التعليم والبحث الأكاديمي.`;

// 1. أمر البداية /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userHistory[chatId] = []; // إعادة إعادة ضبط الذاكرة عند البداية
  bot.sendMessage(chatId, "أهلاً بك! أنا رفيقك الأكاديمي في التمريض:\n\n• يمكنك نقاش أي موضوع نصي مع حفظ السياق.\n• أرسل صورة ملزمة أو مخطط طبي لتحليلها.\n• أرسل /quiz في أي وقت لتوليد سؤال تمريضي (NCLEX MCQ) يعتمد على *آخر موضوع* تناقشنا فيه!");
});

// 2. أمر /quiz باللغة الإنجليزية بناءً على أحدث موضوع بالذاكرة
bot.onText(/\/quiz/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, 'typing');

  const history = userHistory[chatId] || [];

  if (history.length === 0) {
    return bot.sendMessage(chatId, "لم نناقش أي موضوع بعد! أرسل سؤالاً نصياً أو صورة أولاً، ثم أرسل /quiz.");
  }

  // أخذ أحدث الرسائل فقط (التركيز على المواضيع الأخيرة)
  const recentHistory = history.slice(-6);

  const quizPrompt = `Based SPECIFICALLY on the MOST RECENT nursing topics or medical image analysis discussed in our recent messages above, generate ONE high-yield academic NCLEX-style nursing multiple-choice question (MCQ) in ENGLISH ONLY. 
Focus strictly on the LATEST topic we were talking about. 
Provide 4 options (A, B, C, D). Do NOT provide the answer immediately. Ask the user to choose the correct option.`;

  const modelsForQuiz = [
    "openai/gpt-oss-120b",
    "llama-3.3-70b-versatile",
    "qwen/qwen3.8-27b"
  ];

  let quizGenerated = false;

  for (const model of modelsForQuiz) {
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
            ...recentHistory,
            { role: "user", content: quizPrompt }
          ],
          temperature: 0.5
        })
      });

      const data = await response.json();
      const quizText = data.choices[0]?.message?.content;

      if (quizText) {
        bot.sendMessage(chatId, `📝 **Nursing Quiz (Based on latest topic):**\n\n${quizText}`, { parse_mode: 'Markdown' });
        quizGenerated = true;
        break;
      }
    } catch (e) {
      console.log(`Quiz error on model ${model}:`, e.message);
    }
  }

  if (!quizGenerated) {
    bot.sendMessage(chatId, "حدث خطأ أثناء توليد الاختبار. يرجى تجربة إعادة إرسال السؤال ثم /quiz.");
  }
});

// 3. معالجة الصور بدقة وتحويلها لـ Base64 لضمان حفظها في الذاكرة
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const caption = msg.caption || "اقرأ واشرح النص والمحتوى الموجود في هذه الصورة بدقة تمريضية وأكاديمية.";

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
      
      // إضافة تحليل الصورة لآخر الذاكرة لتصبح هي الموضوع الأحدث
      userHistory[chatId].push({ role: "user", content: `[Latest Image Topic]: ${analysis}` });
      userHistory[chatId].push({ role: "assistant", content: analysis });

      if (userHistory[chatId].length > 12) {
        userHistory[chatId] = userHistory[chatId].slice(-12);
      }

      bot.sendMessage(chatId, `📷 **تحليل ومحتوى الصورة:**\n\n${analysis}`);
    } else {
      bot.sendMessage(chatId, "تعذر تحليل الصورة، يرجى إعادة إرسالها بشكل واضح.");
    }
  } catch (e) {
    console.log("Vision Error:", e.message);
    bot.sendMessage(chatId, "حدث خطأ أثناء معالجة الصورة، حاول مرة أخرى.");
  }
});

// 4. معالجة الرسائل النصية وحفظ السياق بالترتيب الصحيح
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text;

  if (!userMessage || userMessage.startsWith('/') || msg.photo) return;

  bot.sendChatAction(chatId, 'typing');

  if (!userHistory[chatId]) userHistory[chatId] = [];

  userHistory[chatId].push({ role: "user", content: userMessage });

  if (userHistory[chatId].length > 12) {
    userHistory[chatId] = userHistory[chatId].slice(-12);
  }

  // الترتيب الأساسي: gpt-oss-120b هو الخيار الأول دائماً
  const selectedModels = [
    "openai/gpt-oss-120b",
    "llama-3.3-70b-versatile",
    "qwen/qwen3.8-27b"
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
          userHistory[chatId].push({ role: "assistant", content: content });
          await bot.sendMessage(chatId, `${content}\n\n---\n🤖 *النموذج المستخدم:* \`${model}\``, { parse_mode: 'Markdown' });
          replied = true;
          break;
        }
      }
    } catch (e) {
      console.log(`فشل النموذج ${model}، تجربة التالي...`);
    }
  }

  if (!replied) {
    bot.sendMessage(chatId, "عذراً، تعذر معالجة الطلب حالياً. يرجى إعادة الإرسال.");
  }
});

// سيرفر الـ Port الخاص بـ Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot active');
}).listen(PORT);
