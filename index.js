const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const http = require('http');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const userHistory = {};
const systemPrompt = `أنت رفيق معرفي أكاديمي لمستخدم بمسار موسوعي يدرس التمريض. أجب بدقة وعمق علمي وبشكل مباشر، منظم وموجز دون إطالة مفرطة تسد السيرفر.`;

// دالة جلب البيانات مع مهلة زمنية صارمة (Timeout)
async function fetchWithTimeout(url, options, timeoutMs = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// 1. أمر البداية /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userHistory[chatId] = [];
  bot.sendMessage(chatId, "أهلاً بك! تم تحسين سرعة واستجابة البوت وإضافة حماية كاملة من التعليق.\n\n• اسأل عن أي موضوع تمريضي.\n• أرسل صورة لتحليلها.\n• أرسل /quiz للاختبار في أحدث موضوع.");
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
        const response = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: model,
            messages: [{ role: "system", content: systemPrompt }, ...recentContext, { role: "user", content: quizPrompt }],
            temperature: 0.5,
            max_tokens: 800
          })
        }, 10000);

        if (!response.ok) continue;
        const data = await response.json();
        
        if (data.choices && data.choices[0]?.message?.content) {
          bot.sendMessage(chatId, `📝 **Nursing Quiz (Context-Based):**\n\n${data.choices[0].message.content}`, { parse_mode: 'Markdown' });
          quizGenerated = true;
          break;
        }
      } catch (e) {
        console.log(`Quiz failed or timed out on model ${model}`);
      }
    }

    if (!quizGenerated) {
      bot.sendMessage(chatId, "حدث خطأ أثناء توليد الاختبار. حاول مرة أخرى.");
    }
  } catch (err) {
    bot.sendMessage(chatId, "حدث خطأ غير متوقع. جرب مجدداً.");
  } finally {
    clearInterval(typingInterval);
  }
});

// 3. معالجة الصور
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const caption = msg.caption || "اقرأ واشرح ما في الصورة بدقة طبية وتمريضية.";

  let typingInterval = setInterval(() => { bot.sendChatAction(chatId, 'typing').catch(()=>{}); }, 4000);
  bot.sendChatAction(chatId, 'typing');

  try {
    const photo = msg.photo.length > 1 ? msg.photo[msg.photo.length - 2] : msg.photo[0];
    const file = await bot.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;

    const imgResponse = await fetch(fileUrl);
    const buffer = await imgResponse.buffer();
    const base64Image = buffer.toString('base64');
    const dataUrl = `data:image/jpeg;base64,${base64Image}`;

    const visionModels = ["llama-3.2-11b-vision-preview", "llama-3.2-90b-vision-preview"];
    let imageAnalyzed = false;

    for (const model of visionModels) {
      try {
        const response = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
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
            max_tokens: 1200
          })
        }, 12000);

        if (!response.ok) continue;
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
      } catch (e) {
        console.log(`Vision failed on ${model}`);
      }
    }

    if (!imageAnalyzed) bot.sendMessage(chatId, "عذراً، تعذر تحليل الصورة حالياً.");
  } catch (e) {
    bot.sendMessage(chatId, "حدث خطأ أثناء معالجة الصورة.");
  } finally {
    clearInterval(typingInterval);
  }
});

// 4. المحادثة النصية العادية مع خاصية المهلة الذكية
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text;

  if (!userMessage || userMessage.startsWith('/') || msg.photo) return;

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
        // إذا لم يجب النموذج الأول خلال 10 ثوانٍ يتم الانتقال تلقائياً للثاني
        const response = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: model,
            messages: [{ role: "system", content: systemPrompt }, ...tempMessages],
            temperature: 0.5,
            max_tokens: 1500
          })
        }, 10000);

        if (!response.ok) continue;

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
        console.log(`Model failed/timed out: ${model}`);
      }
    }

    if (replied) {
      userHistory[chatId].push({ role: "user", content: userMessage });
      userHistory[chatId].push({ role: "assistant", content: finalResponse });
      if (userHistory[chatId].length > 10) userHistory[chatId] = userHistory[chatId].slice(-10);

      await bot.sendMessage(chatId, `${finalResponse}\n\n---\n🤖 النموذج المستخدم: \`${usedModel}\``, { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId, "عذراً، لم يتلق البوت استجابة سريعة من السيرفر. يرجى إعادة الإرسال.");
    }
  } catch (err) {
    bot.sendMessage(chatId, "حدث خطأ في النظام. يرجى إعادة المحاولة.");
  } finally {
    clearInterval(typingInterval);
  }
});

// سيرفر الـ Port الخاص بـ Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot active');
}).listen(PORT);
