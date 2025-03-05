require("dotenv").config();
const { Telegraf } = require("telegraf");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const axios = require("axios");
const express = require("express");
const app = express();

const bot = new Telegraf(process.env.BOT_TOKEN);
const session = new StringSession(process.env.STRING_SESSION || "");
const client = new TelegramClient(
  session,
  Number(process.env.API_ID),
  process.env.API_HASH,
  {
    connectionRetries: 10,
    connectionTimeout: 120000,
  }
);
const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY;

function parseTelegramLink(link) {
  const match = link.match(/https:\/\/t\.me\/([^\/]+)\/(\d+)/);
  if (match) return { channel: match[1], postId: parseInt(match[2], 10) };
  throw new Error("Невірний формат посилання.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureClientConnected(client) {
  try {
    const isConnected = await client.is_connected();
    if (!isConnected) {
      console.log("Клієнт відключений, підключаю...");
      await client.connect();
      console.log("Клієнт Telegram підключений.");
    } else {
      console.log("Клієнт уже підключений.");
    }
    return client;
  } catch (error) {
    console.error("Помилка перевірки підключення:", error);
    await client.connect();
    return client;
  }
}

async function getAllComments(client, channel, postId) {
  let allMessages = [];
  let offsetId = 0;
  const limit = 50;
  const batchSize = 5;

  try {
    for (let i = 0; i < batchSize; i++) {
      const messages = await client.getMessages(channel, {
        limit,
        replyTo: postId,
        offsetId,
      });

      console.log(`Отримано ${messages.length} повідомлень у батчі ${i + 1}`);
      if (!messages || messages.length === 0) break;
      allMessages.push(...messages);

      offsetId = messages[messages.length - 1].id;
      await sleep(2000); // Збільшено затримку до 2 секунд
    }
  } catch (error) {
    console.error("Помилка отримання коментарів:", error);
    throw error;
  }

  return allMessages.map((msg) => msg.message).filter(Boolean);
}

async function analyzeCommentsWithRetry(comments) {
  const maxRetries = 5;
  const batchSize = 20; // Обмежуємо до 20 коментарів за батч
  const batches = [];
  for (let i = 0; i < comments.length; i += batchSize) {
    batches.push(comments.slice(i, i + batchSize));
  }

  const results = [];
  for (const batch of batches) {
    let attempts = 0;
    const prompt = `Проаналізуй подані коментарі та розподіли їх за категоріями (5-6 штук). Поверни JSON із масивом об’єктів: { title: "", description: "", percentage: 0 }. Відповідь має бути виключно українською мовою. У полі "description" надавай стислий але максимально детальний опис змісту коментарів. Процентне співвідношення вказуй на основі частки коментарів у кожній категорії від загальної кількості в цьому батчі. Ось коментарі: \n${batch
      .map((c) => `- ${c}`)
      .join("\n")}`;

    while (attempts < maxRetries) {
      try {
        const response = await axios.post(
          "https://api.together.xyz/v1/chat/completions",
          {
            model: "mistralai/Mixtral-8x7B-Instruct-v0.1",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 16000,
            temperature: 0.7,
          },
          {
            headers: {
              Authorization: `Bearer ${TOGETHER_API_KEY}`,
              "Content-Type": "application/json",
            },
            timeout: 180000, // Збільшено до 3 хвилин
          }
        );

        const content = response.data.choices[0].message.content;
        console.log("Отримано відповідь від Together API для батчу:", content);
        const parsed = JSON.parse(content);
        results.push(parsed);
        break; // Успішно, виходимо з циклу спроб
      } catch (error) {
        attempts++;
        const errorDetails = error.response
          ? error.response.data
          : error.message;
        console.error(
          `Помилка аналізу батчу, спроба ${attempts} з ${maxRetries}:`,
          errorDetails
        );
        if (attempts >= maxRetries) {
          throw new Error(`Не вдалося проаналізувати батч: ${errorDetails}`);
        }
        await sleep(2000); // Затримка між повторними спробами
      }
    }
    await sleep(2000); // Затримка між батчами
  }

  // Об'єднання результатів
  return combineResults(results, comments.length);
}

function combineResults(results, totalComments) {
  const categoryMap = new Map();
  results.forEach((batch) => {
    batch.forEach((cat) => {
      const existing = categoryMap.get(cat.title) || {
        count: 0,
        description: cat.description,
      };
      existing.count += (cat.percentage / 100) * batch.length; // Підрахунок кількості коментарів
      categoryMap.set(cat.title, existing);
    });
  });

  return Array.from(categoryMap.entries()).map(
    ([title, { count, description }]) => ({
      title,
      description,
      percentage: Math.round((count / totalComments) * 100),
    })
  );
}

client
  .connect()
  .then(() => {
    process.env.STRING_SESSION = session.save();
    console.log("Клієнт Telegram підключений при старті.");
  })
  .catch((error) =>
    console.error("Помилка підключення клієнта при старті:", error)
  );

bot.start((ctx) =>
  ctx.reply("Вставте посилання на пост (https://t.me/channel/post)")
);

bot.on("text", async (ctx) => {
  console.log("Отримано повідомлення:", ctx.message.text);
  try {
    const { channel, postId } = parseTelegramLink(ctx.message.text);
    console.log("Парсинг успішний:", { channel, postId });
    ctx.reply(`Обробляю: ${channel}/${postId}...`);

    await ensureClientConnected(client);
    console.log("Клієнт готовий, отримую канал...");
    const channelEntity = await client.getEntity(channel);
    console.log("Канал отримано:", channelEntity.title || channel);

    const comments = await getAllComments(client, channelEntity, postId);
    console.log("Отримано коментарів:", comments.length);

    if (comments.length === 0) {
      ctx.reply("Коментарів не знайдено.");
      return;
    }

    ctx.reply(`Знайдено ${comments.length} коментарів. Аналізую...`);
    const analysis = await analyzeCommentsWithRetry(comments);

    if (Array.isArray(analysis)) {
      const response = analysis
        .map((cat) => `*${cat.title}* (${cat.percentage}%)\n${cat.description}`)
        .join("\n\n");
      ctx.replyWithMarkdown(response);
    } else {
      ctx.reply(`Відповідь не у форматі JSON:\n${analysis}`);
    }
  } catch (error) {
    console.error("Помилка в обробці:", error);
    ctx.reply(`Помилка: ${error.message}`);
  }
});

bot
  .launch()
  .then(() => console.log("Бот запущений!"))
  .catch((error) => console.error("Помилка запуску бота:", error));

app.get("/", (req, res) => {
  console.log("Request received from UptimeRobot!");
  res.send("Bot is running!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

process.once("SIGINT", () => {
  bot.stop("SIGINT");
  client.disconnect();
});
process.once("SIGTERM", () => {
  bot.stop("SIGTERM");
  client.disconnect();
});
