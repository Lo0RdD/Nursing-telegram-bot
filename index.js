const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const http = require('http');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ذاكرة المحادثة لآخر 12 رسالة
const userHistory = {};

const systemPrompt = `أنت رفيق معرفي أكاديمي لمستخدم بمسار موسوعي يدرس التمريض. أجب بدقة وعمق علمي وبشكل مباشر لأغراض التعليم والبحث الأكاديمي.`;

// 1. أمر البداية
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "أهلاً بك! البوت جاهز للاستخدام الأكاديمي المتقدم:\n\n• ارسل أي سؤال نصي لمناقشته مع حفظ السياق.\n• ارسل صورة ملزمة أو مخطط طبي لتحليل نصوصها.\n• اكتب الأمر /quiz في أي وقت ليقوم بتوليد سؤال تمريضي إنجليزي (MCQ) مستوحى من الموضوع الحالي الذي تتناقشان فيه!");
});

// 2. أمر /quiz باللغة الإنجليزية بناءً على السياق
bot.onText(/\/quiz/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, 'typing');

  const history = userHistory[chatId] || [];
  
  const quizPrompt = `Based on the recent context or topics discussed in our chat history, generate ONE high-yield academic NCLEX-style nursing multiple-choice question (MCQ) in ENGLISH ONLY. 
Provide 4 options (A, B, C, D). Do NOT provide the correct answer immediately. Ask the user to choose the correct option first.`;

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          ...history,
          { role: "user", content: quizPrompt }
        ],
        temperature: 0.5
      })
    });

    const data = await response.json();
    const quizText = data.choices[0]?.message?.content;

    if (quizText) {
      bot.sendMessage(chatId, `📝 **Nursing Quiz (Context-Based):**\n\n${quizText}`, { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId, "Please discuss a topic or send a photo first, then type /quiz.");
    }
  } catch (e) {
    bot.sendMessage(chatId, "Error generating quiz. Please try again.");
  }
});

// 3. معالجة الصور عبر التحويل إلى Base64 مع معالجة الأخطاء
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const caption = msg.caption || "اقرأ واشرح ما يوجد في هذه الصورة بدقة علمية وتمريضية باللغة العربية.";

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
      userHistory[chatId].push({ role: "user", content: `[Topic Image Content]: ${analysis}` });

      bot.sendMessage(chatId, `📷 **تحليل واستخراج النص:**\n\n${analysis}`);
    } else {
      bot.sendMessage(chatId, "تعذر تحليل الصورة، يرجى التأكد من وضوح الصورة ومفاتيح API.");
    }
  } catch (e) {
    console.log("Vision Error:", e.message);
    bot.sendMessage(chatId, "حدث خطأ أثناء معالجة الصورة، جرب مرة أخرى.");
  }
});

// 4. معالجة الرسائل النصية مع الذاكرة ونماذج معتمدة
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

  // نماذج Groq الشغالة والمضمونة
  const selectedModels = [
    "llama-3.3-70b-versatile",
    "qwen/qwen3.8-27b",
    "llama3-70b-8192"
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
      console.log(`Model failed: ${model}`);
    }
  }

  if (!replied) {
    bot.sendMessage(chatId, "عذراً، تعذر معالجة الطلب حالياً. يرجى إعادة إرساله بعد دقيقة.");
  }
});

// سيرفر الـ Port الخاص بـ Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot active');
}).listen(PORT);
