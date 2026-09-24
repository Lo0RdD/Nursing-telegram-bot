const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const http = require('http');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ذاكرة المحادثة (12 رسالة)
const userHistory = {};

const systemPrompt = `أنت رفيق معرفي أكاديمي لمستخدم بمسار موسوعي يدرس التمريض. أجب بدقة وعمق علمي وبشكل مباشر لأغراض التعليم والبحث الأكاديمي.`;

// 1. أمر البداية
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "أهلاً بك! أنا رفيقك الأكاديمي في التمريض:\n\n• يمكنك نقاش أي موضوع نصي مع حفظ السياق.\n• أرسل صورة ملزمة أو مخطط طبي لتحليلها.\n• أرسل /quiz في أي وقت لتوليد سؤال تمريضي باللغة الإنجليزية بناءً على الموضوع الحالي!");
});

// 2. أمر /quiz باللغة الإنجليزية معتمداً على النموذج الأفضل
bot.onText(/\/quiz/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, 'typing');

  const history = userHistory[chatId] || [];
  
  const quizPrompt = `Based on our recent context or nursing topics discussed, generate ONE high-yield academic NCLEX-style nursing multiple-choice question (MCQ) in ENGLISH ONLY. 
Provide 4 options (A, B, C, D). Do NOT give the answer immediately. Ask the user to choose the correct option first.`;

  const modelsForQuiz = [
    "openai/gpt-oss-120b",
    "qwen/qwen3.8-27b",
    "llama-3.2-11b-vision-preview"
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
            ...history,
            { role: "user", content: quizPrompt }
          ],
          temperature: 0.6
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
      console.log(`Quiz failed on model ${model}`);
    }
  }

  if (!quizGenerated) {
    bot.sendMessage(chatId, "ناقش موضوعاً تمريضياً أولاً أو أرسل صورة، ثم أرسل /quiz.");
  }
});

// 3. معالجة الصور بدقة مع تحويل Base64 لتفادي حظر الروابط
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
      userHistory[chatId].push({ role: "user", content: `[محتوى الصورة المرفقة]: ${analysis}` });

      bot.sendMessage(chatId, `📷 **تحليل واستخراج محتوى الصورة:**\n\n${analysis}`);
    } else {
      bot.sendMessage(chatId, "تعذر تحليل الصورة، يرجى إعادة إرسالها بشكل واضح.");
    }
  } catch (e) {
    console.log("Vision Error:", e.message);
    bot.sendMessage(chatId, "حدث خطأ أثناء معالجة الصورة، حاول مرة أخرى.");
  }
});

// 4. معالجة الرسائل النصية والذاكرة مع إعطاء الأولوية القصوى لـ gpt-oss-120b
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
    "qwen/qwen3.8-27b",
    "llama-3.2-11b-vision-preview"
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
      console.log(`فشل النموذج ${model}، تجربة النموذج البديل...`);
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
