const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const http = require('http');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const userHistory = {};
const systemPrompt = `أنت رفيق معرفي أكاديمي لمستخدم بمسار موسوعي يدرس التمريض. أجب بدقة وعمق علمي وبشكل مباشر لأغراض التعليم والبحث الأكاديمي.`;

// 1. أمر البداية
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userHistory[chatId] = [];
  bot.sendMessage(chatId, "أهلاً بك! أنا جاهز الآن بكامل كفاءتي.\n\n• اسأل عن أي موضوع تمريضي مهما كان طويلاً.\n• أرسل صورة لتحليلها بوضوح.\n• أرسل /quiz في أي وقت وسأقوم باختبارك في آخر موضوع تحدثنا فيه!");
});

// 2. أمر /quiz
bot.onText(/\/quiz/, async (msg) => {
  const chatId = msg.chat.id;
  let typingInterval = setInterval(() => { bot.sendChatAction(chatId, 'typing').catch(()=>{}); }, 4000);
  bot.sendChatAction(chatId, 'typing');

  try {
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
          headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: model,
            messages: [{ role: "system", content: systemPrompt }, ...recentContext, { role: "user", content: quizPrompt }],
            temperature: 0.5
          })
        });

        if (!response.ok) continue; // إذا فشل هذا النموذج، انتقل للتالي مباشرة
        const data = await response.json();
        
        if (data.choices && data.choices[0]?.message?.content) {
          bot.sendMessage(chatId, `📝 **Nursing Quiz (Context-Based):**\n\n${data.choices[0].message.content}`, { parse_mode: 'Markdown' });
          quizGenerated = true;
          break;
        }
      } catch (e) { console.log(`Quiz failed on ${model}`); }
    }

    if (!quizGenerated) bot.sendMessage(chatId, "حدث خطأ مؤقت أثناء توليد الاختبار. جرب مرة أخرى.");
  } finally {
    clearInterval(typingInterval); // إيقاف إشعار الكتابة
  }
});

// 3. معالجة الصور (تم حل المشكلة باختيار حجم متوسط للصورة)
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const caption = msg.caption || "اقرأ واشرح ما في الصورة بدقة طبية وتمريضية.";

  let typingInterval = setInterval(() => { bot.sendChatAction(chatId, 'typing').catch(()=>{}); }, 4000);
  bot.sendChatAction(chatId, 'typing');

  try {
    // السر هنا: اختيار صورة بحجم مناسب (ليست الأكبر لتجنب رفض السيرفر بسبب الحجم)
    const photo = msg.photo.length > 2 ? msg.photo[msg.photo.length - 2] : msg.photo[msg.photo.length - 1];
    const file = await bot.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;

    const imgResponse = await fetch(fileUrl);
    const buffer = await imgResponse.buffer();
    const base64Image = buffer.toString('base64');
    const dataUrl = `data:image/jpeg;base64,${base64Image}`;

    // إضافة نماذج الرؤية بالترتيب لضمان النجاح
    const visionModels = ["llama-3.2-11b-vision-preview", "llama-3.2-90b-vision-preview"];
    let imageAnalyzed = false;

    for (const model of visionModels) {
      try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: model,
            messages: [{
              role: "user",
              content: [
                { type: "text", text: caption },
                { type: "image_url", image_url: { url: dataUrl } }
              ]
            }],
            temperature: 0.3,
            max_tokens: 1500
          })
        });

        if (!response.ok) continue; // تخطي في حال الرفض
        const data = await response.json();

        if (data.choices && data.choices[0]?.message?.content) {
          const analysis = data.choices[0].message.content;
          if (!userHistory[chatId]) userHistory[chatId] = [];
          userHistory[chatId].push({ role: "user", content: `محتوى الصورة الأخير: ${analysis}` });
          userHistory[chatId].push({ role: "assistant", content: analysis });

          if (userHistory[chatId].length > 10) userHistory[chatId] = userHistory[chatId].slice(-10);

          bot.sendMessage(chatId, `📷 **تحليل الصورة:**\n\n${analysis}`);
          imageAnalyzed = true;
          break;
        }
      } catch (e) { console.log(`Vision failed on ${model}`); }
    }

    if (!imageAnalyzed) bot.sendMessage(chatId, "عذراً، حجم الصورة كبير جداً أو تعذر تحليلها. جرب اقتصاصها (Crop) وإرسالها مجدداً.");

  } catch (e) {
    bot.sendMessage(chatId, "حدث خطأ أثناء معالجة الصورة. تأكد من وضوح الصورة.");
  } finally {
    clearInterval(typingInterval); // إيقاف إشعار الكتابة
  }
});

// 4. المحادثة النصية العادية (تم إصلاح مشكلة الانتظار للأسئلة الطويلة)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text;

  if (!userMessage || userMessage.startsWith('/') || msg.photo) return;

  // إبقاء إشعار "يكتب..." شغالاً حتى يكتمل الرد الطويل
  let typingInterval = setInterval(() => { bot.sendChatAction(chatId, 'typing').catch(()=>{}); }, 4000);
  bot.sendChatAction(chatId, 'typing');

  try {
    if (!userHistory[chatId]) userHistory[chatId] = [];

    const tempMessages = [
      ...userHistory[chatId],
      { role: "user", content: userMessage }
    ];

    const models = ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"];
    let replied = false;
    let finalResponse = "";
    let usedModel = "";

    for (const model of models) {
      try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: model,
            messages: [{ role: "system", content: systemPrompt }, ...tempMessages],
            temperature: 0.5,
            max_tokens: 3000 // السماح بردود علمية أطول
          })
        });

        if (!response.ok) continue; // إذا استغرق وقتاً طويلاً أو فشل، لا تنهار، بل انتقل للنموذج التالي!

        const data = await response.json();

        if (data.choices && data.choices[0]?.message?.content) {
          finalResponse = data.choices[0].message.content.trim();
          if (finalResponse.length > 0) {
            replied = true;
            usedModel = model;
            break; 
          }
        }
      } catch (e) {
        console.log(`Model failed: ${model}`);
      }
    }

    if (replied) {
      userHistory[chatId].push({ role: "user", content: userMessage });
      userHistory[chatId].push({ role: "assistant", content: finalResponse });
      if (userHistory[chatId].length > 10) userHistory[chatId] = userHistory[chatId].slice(-10);

      await bot.sendMessage(chatId, `${finalResponse}\n\n---\n🤖 النموذج المستخدم: \`${usedModel}\``, { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId, "عذراً، تعذر معالجة الطلب حالياً (قد يكون هناك ضغط على السيرفر). يرجى إعادة الإرسال.");
    }
  } finally {
    clearInterval(typingInterval); // إيقاف إشعار الكتابة بمجرد انتهاء الرد أو حدوث خطأ
  }
});

// سيرفر الـ Port الخاص بـ Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot active');
}).listen(PORT);
