const { Telegraf, Markup } = require("telegraf");
const db = require("./db");

const bot = new Telegraf("8605221845:AAGKaFbvYn6MvGX0y0J_YiVvL2elvI8TuSY");
const ADMIN_ID = 5423314276;

// Register user
bot.start((ctx) => {
  const id = ctx.from.id;

  db.query(
    "INSERT IGNORE INTO users (telegram_id) VALUES (?)",
    [id]
  );

  ctx.reply("Welcome! Use /deposit 100");
});

// Deposit request
bot.command("deposit", (ctx) => {
  const amount = ctx.message.text.split(" ")[1];
  const userId = ctx.from.id;

  bot.telegram.sendMessage(
    ADMIN_ID,
    `Deposit\nUser: ${userId}\nAmount: ${amount}`,
    Markup.inlineKeyboard([
      Markup.button.callback("Approve", `ok_${userId}_${amount}`),
      Markup.button.callback("Reject", `no_${userId}`)
    ])
  );

  ctx.reply("Request sent to admin");
});

// Approve
bot.action(/ok_(.+)_(.+)/, (ctx) => {
  const userId = ctx.match[1];
  const amount = parseInt(ctx.match[2]);

  db.query(
    "UPDATE users SET balance = balance + ? WHERE telegram_id = ?",
    [amount, userId]
  );

  bot.telegram.sendMessage(userId, `✅ +${amount} coins`);
  ctx.editMessageText("Approved");
});

bot.launch();