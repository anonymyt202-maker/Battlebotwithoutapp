require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');

const BOT_TOKEN    = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME;
const SECRET_CODE  = 'visibility_off';

if (!BOT_TOKEN || !BOT_USERNAME) {
  console.error('❌ .env: BOT_TOKEN, BOT_USERNAME kerak!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ============================================================
//                      JSON DATABASE
// ============================================================
function loadJSON(f, d) {
  try {
    if (!fs.existsSync(f)) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); return d; }
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) { console.error(`[DB] ${f}:`, e.message); return d; }
}
function saveJSON(f, d) {
  try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }
  catch (e) { console.error(`[DB] save ${f}:`, e.message); }
}

let users      = loadJSON('./users.json',      {});
let channels   = loadJSON('./channels.json',   []);
let tasks      = loadJSON('./tasks.json',      []);
let promocodes = loadJSON('./promocodes.json', {});
let withdraws  = loadJSON('./withdraws.json',  []);
let settings   = loadJSON('./settings.json',   {
  botEnabled: true, refReward: 10, dailyBonus: 5,
  minRefsForBonus: 3, withdrawMin: 15
});
let admins = loadJSON('./admins.json', []);

const saveUsers      = () => saveJSON('./users.json',      users);
const saveChannels   = () => saveJSON('./channels.json',   channels);
const saveTasks      = () => saveJSON('./tasks.json',      tasks);
const savePromocodes = () => saveJSON('./promocodes.json', promocodes);
const saveWithdraws  = () => saveJSON('./withdraws.json',  withdraws);
const saveSettings   = () => saveJSON('./settings.json',   settings);
const saveAdmins     = () => saveJSON('./admins.json',     admins);

// ============================================================
//                       HELPERS
// ============================================================
const isAdmin = (id) => admins.includes(Number(id)) || admins.includes(String(id));

function getUser(ctx) {
  const id    = String(ctx.from.id);
  const uname = ctx.from.username || null;
  if (!users[id]) {
    users[id] = {
      id: ctx.from.id, username: uname,
      stars: 0, refs: 0, referredBy: null,
      banned: false, bonusTime: null,
      totalEarned: 0, totalWithdrawn: 0,
      joinedTasks: [], usedPromos: [],
      joinedAt: Date.now()
    };
    saveUsers();
    notifyAdminsNewUser(ctx.from);
  }
  if (uname && users[id].username !== uname) {
    users[id].username = uname;
    saveUsers();
  }
  return users[id];
}

async function notifyAdminsNewUser(from) {
  const text =
    `🆕 <b>Yangi foydalanuvchi</b>\n\n` +
    `👤 Username: ${from.username ? '@' + from.username : 'Yo\'q'}\n` +
    `🆔 ID: <code>${from.id}</code>`;
  for (const aid of admins) {
    try { await bot.telegram.sendMessage(aid, text, { parse_mode: 'HTML' }); } catch (e) {}
  }
}

function addStars(userId, amount) {
  const id = String(userId);
  if (!users[id]) return;
  users[id].stars       = (users[id].stars       || 0) + amount;
  users[id].totalEarned = (users[id].totalEarned || 0) + amount;
  saveUsers();
}


 
async function checkChannels(userId) {
  if (!channels || channels.length === 0) return true;

  for (const ch of channels) {
    try {
      const member = await bot.telegram.getChatMember(
        ch.username,
        userId
      );

      if (
        member.status === 'left' ||
        member.status === 'kicked'
      ) {
        return false;
      }

    } catch (err) {
      console.log(
        `Channel check error: ${ch.username}`,
        err.description || err.message
      );

      return false;
    }
  }

  return true;
}
function buildChannelButtons(callbackData) {
  const btns = channels.map(ch => [
    Markup.button.url(
      `📢 ${ch.title || ch.username}`,
      `https://t.me/${ch.username.replace('@', '')}`
    )
  ]);
  if (callbackData) btns.push([Markup.button.callback('✅ Tekshirish', callbackData)]);
  return Markup.inlineKeyboard(btns);
}

function findUser(query) {
  const q = query.replace('@', '').toLowerCase().trim();
  if (users[q]) return users[q];
  return Object.values(users).find(u => u.username && u.username.toLowerCase() === q) || null;
}

// ============================================================
//                      STATE MACHINE
// ============================================================
const states     = {};
const setState   = (id, s) => { states[String(id)] = s; };
const getState   = (id)    => states[String(id)] || null;
const clearState = (id)    => { delete states[String(id)]; };

// ============================================================
//                       KEYBOARDS
// ============================================================
const mainMenu = () => Markup.keyboard([
  ['💰 Stars ishlash',    '📋 Vazifalar'],
  ['👥 Referallarim',     '💳 Stars yechish'],
  ['🎁 Promokod',         '🏆 TOP'],
  ['🎁 Kunlik bonus',     '👤 Hisobim'],
  ['📞 Adminga murojaat']
]).resize();

const cancelMenu = () => Markup.keyboard([['❌ Bekor qilish']]).resize();

// ============================================================
//                    BOT ENABLED MIDDLEWARE
// ============================================================
bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  if (!settings.botEnabled && !isAdmin(ctx.from.id)) {
    return ctx.reply('⚠️ Bot texnik ishlarda. Iltimos, keyinroq urinib ko\'ring.');
  }
  return next();
});

// ============================================================
//                         /start
// ============================================================
// ============================================================
//                         /start
// ============================================================
bot.start(async (ctx) => {
  const user = getUser(ctx);

  if (user.banned) {
    return ctx.reply('🚫 Siz ban qilingansiz.');
  }

  const payload = ctx.startPayload || '';

  // Majburiy obuna tekshiruvi
  const subOk = await checkChannels(ctx.from.id);

  if (!subOk && channels.length > 0) {
    return ctx.reply(
      "📢 Botdan foydalanish uchun avval quyidagi kanallarga obuna bo'ling:",
      buildChannelButtons('checksub')
    );
  }

  // Referal ID
  const refId =
    payload && /^\d+$/.test(payload)
      ? payload
      : null;

  // Referal hisoblash
  if (
    refId &&
    String(refId) !== String(ctx.from.id) &&
    !user.referredBy
  ) {
    await processReferral(ctx.from.id, refId);
  }

  await ctx.reply(
    `👋 Salom, <b>${ctx.from.first_name}</b>!\n\n` +
    `💰 Stars ishlang va mukofot oling!\n` +
    `🔗 Do'stlaringizni chaqiring, referallardan bonus qozoning!`,
    {
      parse_mode: 'HTML',
      ...mainMenu()
    }
  );
});

async function processReferral(newUserId, refId) {
  const uid = String(newUserId);
  const rid = String(refId);

  if (!users[uid]) return;
  if (!users[rid]) return;
  if (users[uid].referredBy) return;
  if (uid === rid) return;

  users[uid].referredBy = Number(refId);
  users[rid].refs = (users[rid].refs || 0) + 1;

  addStars(refId, settings.refReward);

  saveUsers();

  try {
    await bot.telegram.sendMessage(
      refId,
      `🎉 Yangi referal!\n` +
      `👤 ${users[uid].username ? '@' + users[uid].username : 'ID:' + uid} kirdi.\n` +
      `+${settings.refReward} ⭐ Stars!`,
      {
        parse_mode: 'HTML'
      }
    );
  } catch (e) {}
}

// Referal orqali kirganlar uchun
bot.action(/^cref_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery('Tekshirilmoqda...');

  const ok = await checkChannels(ctx.from.id);

  if (!ok) {
    return ctx.answerCbQuery(
      "❌ Avval kanallarga obuna bo'ling!",
      true
    );
  }

  await processReferral(
    ctx.from.id,
    ctx.match[1]
  );

  try {
    await ctx.deleteMessage();
  } catch (e) {}

  await ctx.reply(
    '✅ Obuna tasdiqlandi! Xush kelibsiz!',
    mainMenu()
  );
});

// Oddiy foydalanuvchilar uchun
bot.action('checksub', async (ctx) => {
  await ctx.answerCbQuery('Tekshirilmoqda...');

  const ok = await checkChannels(ctx.from.id);

  if (!ok) {
    return ctx.answerCbQuery(
      "❌ Hali kanallarga obuna bo'lmagansiz!",
      true
    );
  }

  try {
    await ctx.deleteMessage();
  } catch (e) {}

  await ctx.reply(
    '✅ Obuna tasdiqlandi!',
    mainMenu()
  );
});
// ============================================================
//                     MAIN MENU HANDLERS
// ============================================================

bot.hears('💰 Stars ishlash', async (ctx) => {
  const user    = getUser(ctx);
  if (user.banned) return ctx.reply('🚫 Ban qilingansiz.');
  const refLink = `https://t.me/${BOT_USERNAME}?start=${ctx.from.id}`;
  await ctx.reply(
    `💰 <b>Stars ishlash</b>\n\nHar referal uchun: <b>${settings.refReward} ⭐ Stars</b>\n\n` +
    `🔗 <b>Sizning havolangiz:</b>\n<code>${refLink}</code>\n\n` +
    `⚠️ <b>Muhim ogohlantirish</b>\nTo'lovlar faqat MDH mamlakatlaridagi do'stlar uchun amalga oshiriladi.\n` +
    `👎 MDHdan bo'lmagan do'stlar uchun to'lov amalga oshirilmaydi.\n` +
    `👎 Multi-hisoblar uchun ham to'lov amalga oshirilmaydi.\n\n` +
    `✅ <b>Ruxsat etilgan mamlakatlar:</b>\nRossiya, Ukraina, Belarus, Qozog'iston, O'zbekiston, Tojikiston, Qirg'iziston, Turkmaniston, Armaniston, Ozarbayjon, Gruziya, Moldova, Latviya, Litva, Estoniya`,
    {
      parse_mode: 'HTML', disable_web_page_preview: true,
      ...Markup.inlineKeyboard([[Markup.button.url(
        '📤 Do\'stlarga ulashish',
        `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent('Do\'stim, Stars ishlash uchun kir!')}`
      )]])
    }
  );
});

bot.hears('📋 Vazifalar', async (ctx) => {
  const user = getUser(ctx);
  if (user.banned) return ctx.reply('🚫 Ban qilingansiz.');
  const active = tasks.filter(t => t.active);
  if (active.length === 0) return ctx.reply('📋 Hozircha vazifalar yo\'q.', mainMenu());
  for (const task of active) {
    const done = (user.joinedTasks || []).includes(task.id);
    let text = `📋 <b>${task.title}</b>\n💰 Mukofot: ${task.reward} ⭐ Stars`;
    if (done) text += '\n\n✅ Bajarilgan';
    const btns = [];
    if (task.type === 'channel') btns.push([Markup.button.url('📢 Kanalga o\'tish', `https://t.me/${task.link.replace('@', '')}`)]);
    else btns.push([Markup.button.url('🔗 Linkga o\'tish', task.link)]);
    if (!done) btns.push([Markup.button.callback('✅ Bajarildi', `tdone_${task.id}`)]);
    await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(btns) });
  }
});

bot.action(/^tdone_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const user   = getUser(ctx);
  if (user.banned) return;
  const taskId = parseInt(ctx.match[1]);
  const task   = tasks.find(t => t.id === taskId);
  if (!task) return ctx.answerCbQuery('❌ Vazifa topilmadi.', true);
  const uid = String(ctx.from.id);
  if (!users[uid].joinedTasks) users[uid].joinedTasks = [];
  if (users[uid].joinedTasks.includes(taskId)) return ctx.answerCbQuery('✅ Allaqachon bajarilgan.', true);
  users[uid].joinedTasks.push(taskId);
  addStars(ctx.from.id, task.reward);
  saveUsers();
  await ctx.answerCbQuery(`✅ +${task.reward} Stars!`, true);
  try { await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ Bajarilgan', { parse_mode: 'HTML' }); } catch (e) {}
});

bot.hears('👥 Referallarim', async (ctx) => {
  const user    = getUser(ctx);
  if (user.banned) return ctx.reply('🚫 Ban qilingansiz.');
  const refLink = `https://t.me/${BOT_USERNAME}?start=${ctx.from.id}`;
  const myRefs  = Object.values(users).filter(u => String(u.referredBy) === String(ctx.from.id));
  let text = `👥 <b>Referallarim</b>\n\n📊 Jami: <b>${user.refs || 0}</b>\n💰 Jami daromad: <b>${(user.refs || 0) * settings.refReward} ⭐</b>\n\n🔗 Havola:\n<code>${refLink}</code>`;
  if (myRefs.length > 0) {
    text += `\n\n<b>So'nggi referallar:</b>\n`;
    myRefs.slice(-10).reverse().forEach((r, i) => {
      text += `${i + 1}. ${r.username ? '@' + r.username : 'ID:' + r.id}\n`;
    });
  }
  await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true });
});

bot.hears('💳 Stars yechish', async (ctx) => {
  const user = getUser(ctx);
  if (user.banned) return ctx.reply('🚫 Ban qilingansiz.');
  setState(ctx.from.id, { step: 'withdraw_amount' });
  await ctx.reply(
    `💳 <b>Stars Yechish</b>\n\n💰 Balansingiz: <b>${user.stars || 0} ⭐</b>\n📊 Minimal: <b>${settings.withdrawMin} ⭐</b>\n\nNechta Stars yechmoqchisiz?`,
    { parse_mode: 'HTML', ...cancelMenu() }
  );
});

bot.hears('🎁 Promokod', async (ctx) => {
  const user = getUser(ctx);
  if (user.banned) return ctx.reply('🚫 Ban qilingansiz.');
  setState(ctx.from.id, { step: 'enter_promo' });
  await ctx.reply('🎁 Promokodni kiriting:', cancelMenu());
});

bot.hears('🏆 TOP', async (ctx) => {
  const sorted = Object.values(users).filter(u => !u.banned).sort((a, b) => (b.refs || 0) - (a.refs || 0)).slice(0, 10);
  let text = `🏆 <b>Top Referallar</b>\n\n`;
  const medals = ['🥇', '🥈', '🥉'];
  sorted.forEach((u, i) => {
    text += `${medals[i] || i + 1 + '.'} ${u.username ? '@' + u.username : 'ID:' + u.id} — ${u.refs || 0} 👥 | ${u.stars || 0} ⭐\n`;
  });
  if (sorted.length === 0) text += 'Hali ma\'lumot yo\'q.';
  await ctx.reply(text, { parse_mode: 'HTML' });
});

bot.hears('🎁 Kunlik bonus', async (ctx) => {
  const user    = getUser(ctx);
  if (user.banned) return ctx.reply('🚫 Ban qilingansiz.');
  const now     = Date.now();
  const diff    = now - (user.bonusTime || 0);
  const oneDay  = 24 * 60 * 60 * 1000;
  if (diff < oneDay) {
    const rem = oneDay - diff;
    const h = Math.floor(rem / 3600000);
    const m = Math.floor((rem % 3600000) / 60000);
    return ctx.reply(`⏳ Bonus allaqachon olindi.\n\nKeyingi bonus: <b>${h} soat ${m} daqiqa</b> keyin.`, { parse_mode: 'HTML' });
  }
  if ((user.refs || 0) >= settings.minRefsForBonus) {
    users[String(ctx.from.id)].bonusTime = now;
    addStars(ctx.from.id, settings.dailyBonus);
    return ctx.reply(`✅ <b>Kunlik bonus olindi!</b>\n+${settings.dailyBonus} ⭐\n💰 Balans: <b>${users[String(ctx.from.id)].stars} ⭐</b>`, { parse_mode: 'HTML' });
  }
  await ctx.reply(
    `🎁 <b>Kunlik Bonus</b>\n\nBonus olish uchun:\n• Kamida <b>${settings.minRefsForBonus}</b> ta referal\n📊 Sizda: <b>${user.refs || 0}</b> ta\n\nYoki bio ga havola qo'ying:`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔗 Bio ga qo\'ydim ✅', 'claim_bio')]]) }
  );
});

bot.action('claim_bio', async (ctx) => {
  await ctx.answerCbQuery();
  const now  = Date.now();
  const diff = now - (users[String(ctx.from.id)]?.bonusTime || 0);
  if (diff < 24 * 60 * 60 * 1000) return ctx.answerCbQuery('❌ Bonus allaqachon olindi.', true);
  users[String(ctx.from.id)].bonusTime = now;
  addStars(ctx.from.id, settings.dailyBonus);
  await ctx.editMessageText(`✅ <b>Bonus olindi!</b>\n+${settings.dailyBonus} ⭐\n💰 Balans: <b>${users[String(ctx.from.id)].stars} ⭐</b>`, { parse_mode: 'HTML' });
});

bot.hears('👤 Hisobim', async (ctx) => {
  const user    = getUser(ctx);
  const refLink = `https://t.me/${BOT_USERNAME}?start=${ctx.from.id}`;
  await ctx.reply(
    `👤 <b>Mening hisobim</b>\n\n` +
    `👤 Username: ${user.username ? '@' + user.username : 'Yo\'q'}\n` +
    `🆔 ID: <code>${user.id}</code>\n\n` +
    `💰 Stars: <b>${user.stars || 0} ⭐</b>\n` +
    `👥 Referallar: <b>${user.refs || 0}</b>\n` +
    `🎁 Bonus: ${user.bonusTime ? '✅ Olindi' : '❌ Olinmagan'}\n` +
    `📈 Toplangan: <b>${user.totalEarned || 0} ⭐</b>\n` +
    `📤 Yechilgan: <b>${user.totalWithdrawn || 0} ⭐</b>\n\n` +
    `🔗 Referal:\n<code>${refLink}</code>`,
    { parse_mode: 'HTML', disable_web_page_preview: true }
  );
});

bot.hears('📞 Adminga murojaat', async (ctx) => {
  const user = getUser(ctx);
  if (user.banned) return ctx.reply('🚫 Ban qilingansiz.');
  setState(ctx.from.id, { step: 'contact_admin' });
  await ctx.reply('📝 Xabaringizni yozing:', cancelMenu());
});

bot.hears('❌ Bekor qilish', async (ctx) => {
  clearState(ctx.from.id);
  await ctx.reply('❌ Bekor qilindi.', mainMenu());
});

// ============================================================
//                     TEXT STATE MACHINE
// ============================================================
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();

  if (text === '/admin') {
    if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Ruxsat yo\'q.');
    return showAdminPanel(ctx);
  }

  if (text === '/badmin') {
    setState(ctx.from.id, { step: 'enter_secret_code' });
    return ctx.reply('🔐 Maxfiy kodni kiriting:', cancelMenu());
  }

  if (text.startsWith('/')) return;

  const user  = getUser(ctx);
  const state = getState(ctx.from.id);
  if (!state) return;

  // Secret code
  if (state.step === 'enter_secret_code') {
    clearState(ctx.from.id);
    if (text !== SECRET_CODE) return ctx.reply('❌ Noto\'g\'ri kod.', mainMenu());
    if (!admins.includes(ctx.from.id)) { admins.push(ctx.from.id); saveAdmins(); }
    return ctx.reply('✅ Admin bo\'ldingiz!\n\n⚙️ Admin panel: /admin', mainMenu());
  }

  // Withdraw
  if (state.step === 'withdraw_amount') {
    const amount = parseInt(text);
    if (isNaN(amount) || amount < 1) return ctx.reply('❌ To\'g\'ri miqdor kiriting.');
    const uid = String(ctx.from.id);
    if ((users[uid].stars || 0) < amount) return ctx.reply(`❌ Yetarli Stars yo\'q. Balans: ${users[uid].stars || 0} ⭐`);
    if (amount < settings.withdrawMin) return ctx.reply(`❌ Minimal yechish: ${settings.withdrawMin} ⭐`);
    const wId = Date.now().toString();
    withdraws.push({ id: wId, userId: ctx.from.id, username: ctx.from.username || null, amount, status: 'pending', createdAt: Date.now() });
    saveWithdraws();
    clearState(ctx.from.id);
    const notif =
      `📤 <b>Yangi yechish so'rovi</b>\n\n` +
      `👤 User: ${ctx.from.username ? '@' + ctx.from.username : 'Yo\'q'}\n` +
      `🆔 ID: <code>${ctx.from.id}</code>\n💰 Miqdor: <b>${amount} ⭐ Stars</b>`;
    for (const aid of admins) {
      try {
        await bot.telegram.sendMessage(aid, notif, {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([[
            Markup.button.callback('✅ Tasdiqlash', `wrok_${wId}`),
            Markup.button.callback('❌ Bekor', `wrno_${wId}`)
          ]]).reply_markup
        });
      } catch (e) {}
    }
    await ctx.reply('✅ Yechish so\'rovi yuborildi! Admin tez orada ko\'rib chiqadi.', mainMenu());
    return;
  }

  // Promo
  if (state.step === 'enter_promo') {
    const code  = text.toUpperCase();
    const promo = promocodes[code];
    clearState(ctx.from.id);
    if (!promo) return ctx.reply('❌ Noto\'g\'ri promokod.', mainMenu());
    if (promo.usedUsers.length >= promo.maxUses) return ctx.reply('❌ Promokod limiti tugagan.', mainMenu());
    if (promo.usedUsers.includes(ctx.from.id)) return ctx.reply('❌ Siz bu promokodni allaqachon ishlatgansiz.', mainMenu());
    promo.usedUsers.push(ctx.from.id);
    savePromocodes();
    addStars(ctx.from.id, promo.reward);
    return ctx.reply(`✅ Promokod qabul qilindi!\n+${promo.reward} ⭐\n💰 Balans: ${users[String(ctx.from.id)].stars} ⭐`, mainMenu());
  }

  // Contact admin
  if (state.step === 'contact_admin') {
    clearState(ctx.from.id);
    const msgText =
      `📩 <b>Foydalanuvchidan xabar</b>\n\n` +
      `👤 ${ctx.from.username ? '@' + ctx.from.username : 'Yo\'q'}\n` +
      `🆔 ID: <code>${ctx.from.id}</code>\n\n💬 Xabar:\n${text}`;
    for (const aid of admins) {
      try {
        await bot.telegram.sendMessage(aid, msgText, {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([[Markup.button.callback('💬 Javob berish', `rplyto_${ctx.from.id}`)]]).reply_markup
        });
      } catch (e) {}
    }
    return ctx.reply('✅ Xabaringiz adminlarga yuborildi!', mainMenu());
  }

  // Admin reply
  if (state.step === 'admin_reply') {
    const targetId = state.targetId;
    clearState(ctx.from.id);
    try {
      await bot.telegram.sendMessage(targetId, `📩 <b>Admin javobi:</b>\n\n${text}`, { parse_mode: 'HTML' });
      return ctx.reply('✅ Javob yuborildi.', mainMenu());
    } catch (e) {
      return ctx.reply('❌ Foydalanuvchiga xabar yuborib bo\'lmadi.', mainMenu());
    }
  }

  // ── ADMIN ONLY STATES ──────────────────────────────────────
  if (!isAdmin(ctx.from.id)) return;

  if (state.step === 'broadcast_content') {
    const lines    = text.split('\n');
    const btnLines = [];
    const txtLines = [];
    for (const line of lines) {
      if (line.includes('|') && line.includes('http')) btnLines.push(line.trim());
      else txtLines.push(line);
    }
    const msgText    = txtLines.join('\n').trim();
    const inlineBtns = btnLines.map(bl => { const p = bl.split('|'); return [Markup.button.url(p[0].trim(), p[1].trim())]; });
    setState(ctx.from.id, { step: 'broadcast_confirm', msgText, inlineBtns, isMedia: false });
    let preview = `📢 <b>Preview:</b>\n\n${msgText}`;
    if (btnLines.length > 0) preview += `\n\n🔘 ${btnLines.length} ta tugma`;
    return ctx.reply(preview, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('✅ Yuborish', 'bcsend'), Markup.button.callback('❌ Bekor', 'bccancel')]])
    });
  }

  if (state.step === 'ban_user')          { const t = findUser(text); clearState(ctx.from.id); if (!t) return ctx.reply('❌ Topilmadi.', mainMenu()); users[String(t.id)].banned = true;  saveUsers(); return ctx.reply(`🚫 @${t.username || t.id} ban qilindi.`,   mainMenu()); }
  if (state.step === 'unban_user')        { const t = findUser(text); clearState(ctx.from.id); if (!t) return ctx.reply('❌ Topilmadi.', mainMenu()); users[String(t.id)].banned = false; saveUsers(); return ctx.reply(`✅ @${t.username || t.id} unban qilindi.`, mainMenu()); }

  if (state.step === 'add_stars_user')    { const t = findUser(text); if (!t) { clearState(ctx.from.id); return ctx.reply('❌ Topilmadi.', mainMenu()); } setState(ctx.from.id, { step: 'add_stars_amount', targetId: t.id }); return ctx.reply(`👤 ${t.username || t.id}\nNecha Stars?`, cancelMenu()); }
  if (state.step === 'add_stars_amount')  { const v = parseInt(text); if (isNaN(v)) return ctx.reply('❌ Son.'); addStars(state.targetId, v); clearState(ctx.from.id); try { await bot.telegram.sendMessage(state.targetId, `✅ +${v} ⭐ Stars qo'shildi!`); } catch(e){} return ctx.reply(`✅ +${v} Stars.`, mainMenu()); }
  if (state.step === 'remove_stars_user') { const t = findUser(text); if (!t) { clearState(ctx.from.id); return ctx.reply('❌ Topilmadi.', mainMenu()); } setState(ctx.from.id, { step: 'remove_stars_amount', targetId: t.id }); return ctx.reply(`👤 ${t.username || t.id}\nNecha Stars ayirish?`, cancelMenu()); }
  if (state.step === 'remove_stars_amount') { const v = parseInt(text); if (isNaN(v)) return ctx.reply('❌ Son.'); const uid = String(state.targetId); users[uid].stars = Math.max(0, (users[uid].stars||0) - v); saveUsers(); clearState(ctx.from.id); try { await bot.telegram.sendMessage(state.targetId, `❌ -${v} ⭐ Stars ayirildi.`); } catch(e){} return ctx.reply(`✅ -${v} Stars.`, mainMenu()); }

  if (state.step === 'add_channel') {
    let ch = text; if (!ch.startsWith('@')) ch = '@' + ch;
    try {
      const info = await ctx.telegram.getChat(ch);
      channels.push({ username: ch, title: info.title || ch });
      saveChannels(); clearState(ctx.from.id);
      return ctx.reply(`✅ ${ch} qo'shildi.`, mainMenu());
    } catch (e) { return ctx.reply(`❌ Kanal topilmadi: ${e.message}`, cancelMenu()); }
  }

  if (state.step === 'add_task_title')  { setState(ctx.from.id, { ...state, title: text, step: 'add_task_link'   }); return ctx.reply('🔗 Link kiriting:', cancelMenu()); }
  if (state.step === 'add_task_link')   { setState(ctx.from.id, { ...state, link:  text, step: 'add_task_reward' }); return ctx.reply('💰 Mukofot (Stars):', cancelMenu()); }
  if (state.step === 'add_task_reward') { const r = parseInt(text); if (isNaN(r)) return ctx.reply('❌ Son.'); const task = { id: Date.now(), type: state.taskType, title: state.title, link: state.link, reward: r, active: true }; tasks.push(task); saveTasks(); clearState(ctx.from.id); return ctx.reply(`✅ Vazifa qo'shildi!\n📋 ${task.title}\n💰 ${r} ⭐`, mainMenu()); }

  if (state.step === 'promo_code')   { setState(ctx.from.id, { ...state, code: text.toUpperCase(), step: 'promo_reward' }); return ctx.reply('💰 Mukofot:', cancelMenu()); }
  if (state.step === 'promo_reward') { const r = parseInt(text); if (isNaN(r)) return ctx.reply('❌ Son.'); setState(ctx.from.id, { ...state, reward: r, step: 'promo_max' }); return ctx.reply('🔢 Max aktivatsiya:', cancelMenu()); }
  if (state.step === 'promo_max')    { const m = parseInt(text); if (isNaN(m)) return ctx.reply('❌ Son.'); promocodes[state.code] = { code: state.code, reward: state.reward, maxUses: m, usedUsers: [] }; savePromocodes(); clearState(ctx.from.id); return ctx.reply(`✅ Promokod yaratildi!\n🎁 Kod: <code>${state.code}</code>\n💰 ${state.reward} ⭐\n🔢 Limit: ${m}`, { parse_mode: 'HTML', ...mainMenu() }); }

  if (state.step === 'set_bonus')      { const v = parseInt(text); if (isNaN(v)) return ctx.reply('❌ Son.'); settings.dailyBonus      = v; saveSettings(); clearState(ctx.from.id); return ctx.reply(`✅ Kunlik bonus: ${v} ⭐`,       mainMenu()); }
  if (state.step === 'set_min_refs')   { const v = parseInt(text); if (isNaN(v)) return ctx.reply('❌ Son.'); settings.minRefsForBonus  = v; saveSettings(); clearState(ctx.from.id); return ctx.reply(`✅ Min referallar: ${v}`,         mainMenu()); }
  if (state.step === 'set_ref_reward') { const v = parseInt(text); if (isNaN(v)) return ctx.reply('❌ Son.'); settings.refReward        = v; saveSettings(); clearState(ctx.from.id); return ctx.reply(`✅ Referal mukofoti: ${v} ⭐`,    mainMenu()); }
  if (state.step === 'set_wd_min')     { const v = parseInt(text); if (isNaN(v)) return ctx.reply('❌ Son.'); settings.withdrawMin      = v; saveSettings(); clearState(ctx.from.id); return ctx.reply(`✅ Minimal yechish: ${v} ⭐`,     mainMenu()); }
});

// ============================================================
//                   MEDIA BROADCAST HANDLER
// ============================================================
bot.on(['photo', 'video', 'animation', 'document', 'sticker'], async (ctx) => {
  const state = getState(ctx.from.id);
  if (!state || state.step !== 'broadcast_media') return;
  setState(ctx.from.id, { step: 'broadcast_confirm', isMedia: true, msgId: ctx.message.message_id, fromId: ctx.from.id });
  await ctx.reply('Xabar tayyor. Yuborishni tasdiqlaysizmi?',
    Markup.inlineKeyboard([[Markup.button.callback('✅ Yuborish', 'bcsend'), Markup.button.callback('❌ Bekor', 'bccancel')]])
  );
});

// ============================================================
//                   WITHDRAW CALLBACKS
// ============================================================
bot.action(/^wrok_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const wr = withdraws.find(w => w.id === ctx.match[1]);
  if (!wr) return ctx.editMessageText('❌ So\'rov topilmadi.');
  if (wr.status !== 'pending') return ctx.editMessageText('ℹ️ Allaqachon ko\'rib chiqilgan.');
  const uid = String(wr.userId);
  if ((users[uid]?.stars || 0) < wr.amount) return ctx.editMessageText(`❌ Yetarli stars yo'q. Balans: ${users[uid]?.stars || 0}`);
  users[uid].stars         = (users[uid].stars         || 0) - wr.amount;
  users[uid].totalWithdrawn = (users[uid].totalWithdrawn || 0) + wr.amount;
  wr.status = 'approved'; wr.approvedAt = Date.now();
  saveUsers(); saveWithdraws();
  try { await bot.telegram.sendMessage(wr.userId, `✅ <b>Yechish tasdiqlandi!</b>\n💰 ${wr.amount} ⭐ muvaffaqiyatli yechildi.`, { parse_mode: 'HTML' }); } catch (e) {}
  await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ <b>TASDIQLANDI</b>', { parse_mode: 'HTML' });
});

bot.action(/^wrno_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const wr = withdraws.find(w => w.id === ctx.match[1]);
  if (!wr) return ctx.editMessageText('❌ So\'rov topilmadi.');
  if (wr.status !== 'pending') return ctx.editMessageText('ℹ️ Allaqachon ko\'rib chiqilgan.');
  wr.status = 'rejected'; wr.rejectedAt = Date.now();
  saveWithdraws();
  try { await bot.telegram.sendMessage(wr.userId, `❌ <b>Yechish bekor qilindi.</b>\nSabab uchun adminga murojaat qiling.`, { parse_mode: 'HTML' }); } catch (e) {}
  await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n❌ <b>BEKOR QILINDI</b>', { parse_mode: 'HTML' });
});

// ============================================================
//                   ADMIN REPLY CALLBACK
// ============================================================
bot.action(/^rplyto_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌ Ruxsat yo\'q.');
  await ctx.answerCbQuery();
  setState(ctx.from.id, { step: 'admin_reply', targetId: parseInt(ctx.match[1]) });
  await ctx.reply(`💬 ID: ${ctx.match[1]} ga javob yozing:`, cancelMenu());
});

// ============================================================
//                  BROADCAST CALLBACKS
// ============================================================
bot.action('bcsend', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const state = getState(ctx.from.id);
  if (!state) return;
  clearState(ctx.from.id);
  const uids = Object.keys(users);
  let sent = 0, failed = 0;
  await ctx.editMessageText(`📢 Broadcast boshlandi... ${uids.length} ta foydalanuvchi`);
  for (const uid of uids) {
    try {
      if (state.isMedia) await bot.telegram.copyMessage(uid, state.fromId, state.msgId);
      else {
        const kbd = state.inlineBtns && state.inlineBtns.length > 0 ? Markup.inlineKeyboard(state.inlineBtns).reply_markup : undefined;
        await bot.telegram.sendMessage(uid, state.msgText, { parse_mode: 'HTML', reply_markup: kbd });
      }
      sent++;
    } catch (e) { failed++; }
    await new Promise(r => setTimeout(r, 55));
  }
  await ctx.reply(`✅ Broadcast tugadi!\n✅ Yuborildi: ${sent}\n❌ Xato: ${failed}`, mainMenu());
});

bot.action('bccancel', async (ctx) => {
  clearState(ctx.from.id);
  await ctx.answerCbQuery('❌ Bekor.');
  await ctx.editMessageText('❌ Broadcast bekor qilindi.');
});

// ============================================================
//                      ADMIN PANEL
// ============================================================
async function showAdminPanel(ctx) {
  const totalUsers = Object.keys(users).length;
  const banned     = Object.values(users).filter(u => u.banned).length;
  const totalStars = Object.values(users).reduce((a, u) => a + (u.stars || 0), 0);
  const pendingWds = withdraws.filter(w => w.status === 'pending').length;

  await ctx.reply(
    `⚙️ <b>Admin Panel</b>\n\n` +
    `👥 Foydalanuvchilar: ${totalUsers}\n🚫 Banlangan: ${banned}\n` +
    `⭐ Jami Stars: ${totalStars}\n📤 Kutilayotgan: ${pendingWds}\n\n` +
    `🤖 Bot: ${settings.botEnabled ? '🟢 Yoqiq' : '🔴 O\'chiq'}\n` +
    `🎁 Kunlik bonus: ${settings.dailyBonus} ⭐\n` +
    `👥 Referal mukofoti: ${settings.refReward} ⭐\n` +
    `📊 Min ref (bonus): ${settings.minRefsForBonus}\n` +
    `💳 Minimal yechish: ${settings.withdrawMin} ⭐`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(settings.botEnabled ? '🔴 Botni o\'chirish' : '🟢 Botni yoqish', 'adm_toggle')],
        [Markup.button.callback('📢 Broadcast (matn)',  'adm_bc_text'),  Markup.button.callback('📢 Broadcast (media)', 'adm_bc_media')],
        [Markup.button.callback('🚫 Ban user',          'adm_ban'),       Markup.button.callback('✅ Unban user',         'adm_unban')],
        [Markup.button.callback('➕ Stars qo\'shish',   'adm_addstars'),  Markup.button.callback('➖ Stars ayirish',      'adm_rmstars')],
        [Markup.button.callback('📢 Kanal qo\'shish',  'adm_addch'),     Markup.button.callback('❌ Kanal o\'chirish',   'adm_rmch')],
        [Markup.button.callback('📋 Vazifa qo\'shish', 'adm_addtask'),   Markup.button.callback('🗑 Vazifa o\'chirish',  'adm_rmtask')],
        [Markup.button.callback('🎁 Promokod yaratish','adm_addpromo'),  Markup.button.callback('🗑 Promokod o\'chirish','adm_rmpromo')],
        [Markup.button.callback('🎁 Bonus sozlash',    'adm_bonus'),     Markup.button.callback('👥 Referal mukofoti',  'adm_refset')],
        [Markup.button.callback('📤 Yechishlar',       'adm_wds'),       Markup.button.callback('📊 Statistika',        'adm_stats')]
      ])
    }
  );
}

bot.action('adm_toggle', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  settings.botEnabled = !settings.botEnabled; saveSettings();
  await ctx.reply(`Bot ${settings.botEnabled ? '🟢 Yoqildi' : '🔴 O\'chirildi'}`, mainMenu());
});

bot.action('adm_bc_text', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  setState(ctx.from.id, { step: 'broadcast_content' });
  await ctx.reply('📢 Xabarni yozing.\n\nInline tugma uchun:\n<code>Tugma nomi | https://link</code>', { parse_mode: 'HTML', ...cancelMenu() });
});

bot.action('adm_bc_media', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  setState(ctx.from.id, { step: 'broadcast_media' });
  await ctx.reply('📢 Rasm, video, gif yoki stiker yuboring:', cancelMenu());
});

bot.action('adm_ban',       async (ctx) => { if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌'); await ctx.answerCbQuery(); setState(ctx.from.id, { step: 'ban_user'          }); await ctx.reply('🚫 @username yoki ID:', cancelMenu()); });
bot.action('adm_unban',     async (ctx) => { if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌'); await ctx.answerCbQuery(); setState(ctx.from.id, { step: 'unban_user'        }); await ctx.reply('✅ @username yoki ID:', cancelMenu()); });
bot.action('adm_addstars',  async (ctx) => { if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌'); await ctx.answerCbQuery(); setState(ctx.from.id, { step: 'add_stars_user'    }); await ctx.reply('➕ @username yoki ID:', cancelMenu()); });
bot.action('adm_rmstars',   async (ctx) => { if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌'); await ctx.answerCbQuery(); setState(ctx.from.id, { step: 'remove_stars_user' }); await ctx.reply('➖ @username yoki ID:', cancelMenu()); });
bot.action('adm_addch',     async (ctx) => { if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌'); await ctx.answerCbQuery(); setState(ctx.from.id, { step: 'add_channel'       }); await ctx.reply('📢 Kanal @username:\n⚠️ Bot kanalda admin bo\'lishi kerak!', cancelMenu()); });

bot.action('adm_rmch', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  if (channels.length === 0) return ctx.reply('Kanallar yo\'q.', mainMenu());
  await ctx.reply('O\'chirish:', Markup.inlineKeyboard(channels.map((ch, i) => [Markup.button.callback(`❌ ${ch.title || ch.username}`, `rmch_${i}`)])));
});

bot.action(/^rmch_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌');
  const idx = parseInt(ctx.match[1]); const ch = channels[idx];
  channels.splice(idx, 1); saveChannels();
  await ctx.answerCbQuery('✅ O\'chirildi.');
  await ctx.editMessageText(`✅ ${ch?.title || ch?.username} o'chirildi.`);
});

bot.action('adm_addtask', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  await ctx.reply('📋 Vazifa turi:', Markup.inlineKeyboard([
    [Markup.button.callback('📢 Kanalga obuna', 'ttype_channel')],
    [Markup.button.callback('🔗 Link vazifa',   'ttype_link')]
  ]));
});

bot.action(/^ttype_(channel|link)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  setState(ctx.from.id, { step: 'add_task_title', taskType: ctx.match[1] });
  await ctx.reply('📝 Vazifa nomini kiriting:', cancelMenu());
});

bot.action('adm_rmtask', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  if (tasks.length === 0) return ctx.reply('Vazifalar yo\'q.', mainMenu());
  await ctx.reply('O\'chirish:', Markup.inlineKeyboard(tasks.map((t, i) => [Markup.button.callback(`🗑 ${t.title}`, `rmtask_${i}`)])));
});

bot.action(/^rmtask_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌');
  const idx = parseInt(ctx.match[1]); const t = tasks[idx];
  tasks.splice(idx, 1); saveTasks();
  await ctx.answerCbQuery('✅ O\'chirildi.');
  await ctx.editMessageText(`🗑 "${t?.title}" o'chirildi.`);
});

bot.action('adm_addpromo', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  setState(ctx.from.id, { step: 'promo_code' });
  await ctx.reply('🎁 Promokod nomi (masalan: PROMO100):', cancelMenu());
});

bot.action('adm_rmpromo', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const codes = Object.keys(promocodes);
  if (codes.length === 0) return ctx.reply('Promokodlar yo\'q.', mainMenu());
  await ctx.reply('O\'chirish:', Markup.inlineKeyboard(codes.map(c => [Markup.button.callback(`🗑 ${c} (${promocodes[c].usedUsers.length}/${promocodes[c].maxUses})`, `rmpromo_${c}`)])));
});

bot.action(/^rmpromo_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌');
  const code = ctx.match[1]; delete promocodes[code]; savePromocodes();
  await ctx.answerCbQuery('✅ O\'chirildi.');
  await ctx.editMessageText(`🗑 "${code}" o'chirildi.`);
});

bot.action('adm_bonus', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  await ctx.reply(
    `🎁 Bonus: ${settings.dailyBonus} ⭐ | Min refs: ${settings.minRefsForBonus}`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🎁 Bonus miqdori', 'set_bonus_a')],
      [Markup.button.callback('👥 Min referallar', 'set_minref_a')]
    ])
  );
});

bot.action('set_bonus_a',  async (ctx) => { if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌'); await ctx.answerCbQuery(); setState(ctx.from.id, { step: 'set_bonus'    }); await ctx.reply(`Yangi kunlik bonus (hozir: ${settings.dailyBonus} ⭐):`, cancelMenu()); });
bot.action('set_minref_a', async (ctx) => { if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌'); await ctx.answerCbQuery(); setState(ctx.from.id, { step: 'set_min_refs' }); await ctx.reply(`Min referallar (hozir: ${settings.minRefsForBonus}):`,       cancelMenu()); });

bot.action('adm_refset', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  await ctx.reply(
    `👥 Referal: ${settings.refReward} ⭐ | Min yechish: ${settings.withdrawMin} ⭐`,
    Markup.inlineKeyboard([
      [Markup.button.callback('💰 Referal mukofoti', 'set_ref_a')],
      [Markup.button.callback('💳 Minimal yechish',  'set_wd_a')]
    ])
  );
});

bot.action('set_ref_a', async (ctx) => { if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌'); await ctx.answerCbQuery(); setState(ctx.from.id, { step: 'set_ref_reward' }); await ctx.reply(`Yangi referal mukofoti (hozir: ${settings.refReward} ⭐):`,    cancelMenu()); });
bot.action('set_wd_a',  async (ctx) => { if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌'); await ctx.answerCbQuery(); setState(ctx.from.id, { step: 'set_wd_min'     }); await ctx.reply(`Yangi minimal yechish (hozir: ${settings.withdrawMin} ⭐):`, cancelMenu()); });

bot.action('adm_wds', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const pending = withdraws.filter(w => w.status === 'pending');
  if (pending.length === 0) return ctx.reply('📤 Kutilayotgan yechishlar yo\'q.', mainMenu());
  for (const wr of pending.slice(0, 10)) {
    await bot.telegram.sendMessage(ctx.from.id,
      `📤 <b>Yechish so'rovi</b>\n\n👤 ${wr.username ? '@' + wr.username : wr.userId}\n🆔 <code>${wr.userId}</code>\n💰 ${wr.amount} ⭐`,
      { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('✅ Tasdiqlash', `wrok_${wr.id}`), Markup.button.callback('❌ Bekor', `wrno_${wr.id}`)]]).reply_markup }
    );
  }
});

bot.action('adm_stats', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const totalUsers     = Object.keys(users).length;
  const totalStars     = Object.values(users).reduce((a, u) => a + (u.stars || 0), 0);
  const totalEarned    = Object.values(users).reduce((a, u) => a + (u.totalEarned || 0), 0);
  const totalWithdrawn = Object.values(users).reduce((a, u) => a + (u.totalWithdrawn || 0), 0);
  const totalRefs      = Object.values(users).reduce((a, u) => a + (u.refs || 0), 0);
  await ctx.editMessageText(
    `📊 <b>Bot Statistikasi</b>\n\n` +
    `👥 Foydalanuvchilar: ${totalUsers}\n` +
    `🚫 Banlangan: ${Object.values(users).filter(u => u.banned).length}\n` +
    `👥 Jami referallar: ${totalRefs}\n\n` +
    `⭐ Joriy Stars: ${totalStars}\n` +
    `📈 Jami berilgan: ${totalEarned}\n` +
    `📤 Jami yechilgan: ${totalWithdrawn}\n\n` +
    `📤 Kutilayotgan: ${withdraws.filter(w => w.status === 'pending').length}\n` +
    `✅ Tasdiqlangan: ${withdraws.filter(w => w.status === 'approved').length}\n\n` +
    `📋 Vazifalar: ${tasks.length}\n` +
    `🎁 Promokodlar: ${Object.keys(promocodes).length}\n` +
    `📢 Kanallar: ${channels.length}\n` +
    `👑 Adminlar: ${admins.length}`,
    { parse_mode: 'HTML' }
  );
});

// ============================================================
//                      ERROR HANDLER
// ============================================================
bot.catch((err, ctx) => {
  console.error('[ERROR]', err.message || err);
  try {
    if (ctx.callbackQuery) ctx.answerCbQuery('❌ Xato.').catch(() => {});
    else ctx.reply('❌ Xato yuz berdi.').catch(() => {});
  } catch (_) {}
});

// ============================================================
//                          LAUNCH
// ============================================================
bot.launch({ allowedUpdates: ['message', 'callback_query'] })
  .then(() => {
    console.log('✅ Stars Referral Bot ishga tushdi!');
    console.log('🔐 Admin bo\'lish uchun: /badmin → kod: visibility_off');
    console.log('⚙️  Admin panel: /admin');
  })
  .catch(err => { console.error('❌ Bot xato:', err.message); process.exit(1); });

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
