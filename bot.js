require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');

const BOT_TOKEN    = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME;
const SECRET_CMD   = process.env.SECRET_CMD || 'panel777';

if (!BOT_TOKEN || !BOT_USERNAME) {
  console.error('❌ .env: BOT_TOKEN va BOT_USERNAME kerak!');
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
  catch (e) { console.error(`[DB] save:`, e.message); }
}

let users    = loadJSON('./users.json',    {});
let battles  = loadJSON('./battles.json',  {});
let settings = loadJSON('./settings.json', { requiredChannels: [] });
let admins   = loadJSON('./admins.json',   []);

const saveUsers    = () => saveJSON('./users.json',    users);
const saveBattles  = () => saveJSON('./battles.json',  battles);
const saveSettings = () => saveJSON('./settings.json', settings);
const saveAdmins   = () => saveJSON('./admins.json',   admins);

// ============================================================
//                       HELPERS
// ============================================================
const isAdmin = (id) => admins.includes(Number(id)) || admins.includes(String(id));

function getUser(ctx) {
  const id    = String(ctx.from.id);
  const uname = ctx.from.username || null;
  if (!users[id]) {
    users[id] = {
      id: ctx.from.id, username: uname, wins: 0, loses: 0,
      votes: 0, banned: false, createdBattles: 0, joinedBattles: 0
    };
    saveUsers();
  }
  if (uname && users[id].username !== uname) { users[id].username = uname; saveUsers(); }
  return users[id];
}

function getVotes(battle, username) {
  return Object.values(battle.votes).filter(v => v.toLowerCase() === username.toLowerCase()).length;
}

function getBattlesByOwner(ownerId) {
  return Object.values(battles).filter(b => b.owner === ownerId);
}

function findUserByQuery(q) {
  q = q.replace('@', '').toLowerCase().trim();
  if (users[q]) return users[q];
  return Object.values(users).find(u => u.username && u.username.toLowerCase() === q) || null;
}

// ============================================================
//          SUBSCRIPTION CHECKS
// ============================================================

// Bot majburiy kanallarini tekshirish
async function checkRequiredChannels(userId) {
  if (!settings.requiredChannels || settings.requiredChannels.length === 0) return true;
  for (const ch of settings.requiredChannels) {
    try {
      const m = await bot.telegram.getChatMember(ch, userId);
      if (['left', 'kicked'].includes(m.status)) return false;
    } catch (e) {}
  }
  return true;
}

// Battle kanalini tekshirish
async function checkBattleChannel(userId, channel) {
  try {
    const m = await bot.telegram.getChatMember(channel, userId);
    return !['left', 'kicked'].includes(m.status);
  } catch (e) { return true; }
}

// Majburiy kanallar tugmalari
function requiredChannelKeyboard(extra) {
  const btns = (settings.requiredChannels || []).map(ch => [
    Markup.button.url(`📢 ${ch} ga obuna bo'lish`, `https://t.me/${ch.replace('@', '')}`)
  ]);
  if (extra) btns.push([Markup.button.callback('✅ Obunani tekshirish', extra)]);
  return Markup.inlineKeyboard(btns);
}

// ============================================================
//               POST BUILDER
// ============================================================
function buildPost(battle) {
  const sorted = battle.participants
    .map(u => ({ username: u, count: getVotes(battle, u) }))
    .sort((a, b) => b.count - a.count);

  let text = `🏆 <b>BATTLE BOSHLANDI</b>\n\n`;
  text += `❗ <b>Shartlar:</b>\n• Kanalga obuna bo'lish\n• Do'stlarni chaqirish\n\n`;
  text += `🎁 <b>Sovrin:</b>\n${battle.text}\n\n`;
  text += `🎯 <b>Maqsad:</b> ${battle.target} ta ovoz\n\n`;
  text += `📈 <b>Reyting:</b>\n\n`;

  if (sorted.length === 0) {
    text += `Hali ishtirokchilar yo'q\n`;
  } else {
    sorted.forEach((p, i) => {
      const m = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      text += `${m} @${p.username} — ${p.count} 📦\n`;
    });
  }
  return text;
}

// MUHIM: URL da battleId ishlatamiz, channel emas!
// Format: vote-{battleId}-{username}
// battleId alphanumeric (dash yo'q), username faqat harf/raqam/_ (dash yo'q)
// Shuning uchun birinchi dash aniq ajratadi
function buildKeyboard(battle) {
  const sorted = battle.participants
    .map(u => ({ username: u, count: getVotes(battle, u) }))
    .sort((a, b) => b.count - a.count);

  const btns = [];
  sorted.forEach(p => {
    btns.push([Markup.button.url(
      `@${p.username} — ${p.count} 📦`,
      `https://t.me/${BOT_USERNAME}?start=vote-${battle.battleId}-${p.username}`
    )]);
  });

  btns.push([Markup.button.url(
    '🏆 KONKURSGA QO\'SHILISH',
    `https://t.me/${BOT_USERNAME}?start=join-${battle.battleId}`
  )]);
  btns.push([Markup.button.url(
    '📊 NATIJALAR',
    `https://t.me/${BOT_USERNAME}?start=res-${battle.battleId}`
  )]);

  return Markup.inlineKeyboard(btns);
}

async function updatePost(battle) {
  if (!battle.messageId || !battle.channel) return;
  try {
    await bot.telegram.editMessageText(
      battle.channel, battle.messageId, null,
      buildPost(battle),
      { parse_mode: 'HTML', reply_markup: buildKeyboard(battle).reply_markup }
    );
  } catch (e) { console.log('[POST]', e.message); }
}

// ============================================================
//               DECLARE WINNER
// ============================================================
async function declareWinner(battle, winnerUsername) {
  battle.active = false;
  saveBattles();

  Object.values(users).forEach(u => {
    if (u.username && battle.participants.some(p => p.toLowerCase() === u.username.toLowerCase())) {
      const isWinner = u.username.toLowerCase() === winnerUsername.toLowerCase();
      if (isWinner) users[String(u.id)].wins = (u.wins || 0) + 1;
      else          users[String(u.id)].loses = (u.loses || 0) + 1;
    }
  });
  saveUsers();

  try {
    await bot.telegram.sendMessage(
      battle.channel,
      `🏆 <b>BATTLE TUGADI</b>\n\n🥇 <b>G'olib:</b> @${winnerUsername}\n\n🎉 <b>Tabriklaymiz!</b>\n🎁 Sovrin: ${battle.text}`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {}

  try {
    await bot.telegram.sendMessage(
      battle.owner,
      `🏆 Battleingiz tugadi!\n\n🥇 G'olib: @${winnerUsername}\n🎁 Sovrin: ${battle.text}`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {}
}

// ============================================================
//               STATE MACHINE
// ============================================================
const states     = {};
const setState   = (id, s) => { states[String(id)] = s; };
const getState   = (id)    => states[String(id)] || null;
const clearState = (id)    => { delete states[String(id)]; };

// ============================================================
//               KEYBOARDS
// ============================================================
const mainMenu  = () => Markup.keyboard([
  ['🏆 Battle yaratish', '📋 Battlelarim'],
  ['📊 Statistika',       'ℹ️ Yordam']
]).resize();

const cancelMenu = () => Markup.keyboard([['❌ Bekor qilish']]).resize();

// ============================================================
//                       /start
// ============================================================
bot.start(async (ctx) => {
  const user    = getUser(ctx);
  if (user.banned) return ctx.reply('🚫 Siz ban qilingansiz.');

  const payload = ctx.startPayload || '';

  // ── vote-{battleId}-{username} ─────────────────────────
  if (payload.startsWith('vote-')) {
    const rest = payload.slice(5);           // {battleId}-{username}
    const idx  = rest.indexOf('-');
    if (idx !== -1) {
      const battleId      = rest.slice(0, idx);
      const targetUsername = rest.slice(idx + 1);
      return handleVote(ctx, battleId, targetUsername);
    }
  }

  // ── join-{battleId} ────────────────────────────────────
  if (payload.startsWith('join-')) {
    return handleJoin(ctx, payload.slice(5));
  }

  // ── res-{battleId} ─────────────────────────────────────
  if (payload.startsWith('res-')) {
    return handleResults(ctx, payload.slice(4));
  }

  // ── Oddiy /start — majburiy kanallarni tekshir ─────────
  const subOk = await checkRequiredChannels(ctx.from.id);
  if (!subOk) {
    return ctx.reply(
      `👋 Salom <b>${ctx.from.first_name}</b>!\n\n` +
      `⚠️ Botdan foydalanish uchun avval quyidagi kanallarga obuna bo'ling:`,
      { parse_mode: 'HTML', ...requiredChannelKeyboard('check_start') }
    );
  }

  await ctx.reply(
    `👋 Salom, <b>${ctx.from.first_name}</b>!\n\n` +
    `🏆 <b>Stars Battle Bot</b>ga xush kelibsiz!\n\n` +
    `Battle yarating va do'stlaringiz bilan raqobatlashing!`,
    { parse_mode: 'HTML', ...mainMenu() }
  );
});

bot.action('check_start', async (ctx) => {
  await ctx.answerCbQuery('Tekshirilmoqda...');
  const ok = await checkRequiredChannels(ctx.from.id);
  if (!ok) {
    return ctx.answerCbQuery('❌ Hali kanallarga obuna bo\'lmadingiz!', true);
  }
  try { await ctx.deleteMessage(); } catch (e) {}
  await ctx.reply(
    `✅ Obuna tasdiqlandi!\n\n👋 <b>${ctx.from.first_name}</b>, xush kelibsiz!`,
    { parse_mode: 'HTML', ...mainMenu() }
  );
});

// ============================================================
//               VOTE HANDLER
// ============================================================
async function handleVote(ctx, battleId, targetUsername) {
  const user = getUser(ctx);
  if (user.banned) return ctx.reply('🚫 Siz ban qilingansiz.');

  const voterUsername = ctx.from.username;
  if (!voterUsername) return ctx.reply('❌ Avval Telegram username o\'rnating.');

  // Battle topish
  const battle = battles[battleId];
  if (!battle) return ctx.reply('❌ Battle topilmadi.');
  if (!battle.active) return ctx.reply('❌ Bu battle tugagan.');

  // O'ziga ovoz bermaslik
  if (voterUsername.toLowerCase() === targetUsername.toLowerCase()) {
    return ctx.reply('❌ O\'zingizga ovoz bera olmaysiz.');
  }

  // Ishtirokchi borligini tekshirish
  const participantExists = battle.participants.some(
    p => p.toLowerCase() === targetUsername.toLowerCase()
  );
  if (!participantExists) {
    return ctx.reply(
      `❌ @${targetUsername} bu battleda ishtirokchi emas.\n\n` +
      `Avval ishtirokchi bo'lish uchun <b>Konkursga qo'shilish</b> tugmasini bosish kerak.`,
      { parse_mode: 'HTML' }
    );
  }

  const voterId = String(ctx.from.id);

  // Oldin ovoz berganligini tekshirish
  if (battle.votes[voterId]) {
    const prev = battle.votes[voterId];
    if (prev.toLowerCase() === targetUsername.toLowerCase()) {
      return ctx.reply(`❌ Siz allaqachon @${targetUsername}ga ovoz bergansiz.`);
    }
    return ctx.reply(`❌ Siz bu battleda allaqachon @${prev}ga ovoz bergansiz.\nBir battleda faqat 1 ta odamga ovoz beriladi.`);
  }

  // ─── 1-QADAM: Bot majburiy kanallarini tekshirish ────────
  const reqOk = await checkRequiredChannels(ctx.from.id);
  if (!reqOk) {
    // callbackData uchun battleId va username saqlash (state orqali)
    setState(ctx.from.id, { pendingVote: { battleId, targetUsername } });
    return ctx.reply(
      `❌ Ovoz berish uchun avval majburiy kanallarga obuna bo'ling:`,
      requiredChannelKeyboard('chk_req_then_vote')
    );
  }

  // ─── 2-QADAM: Battle kanalini tekshirish ─────────────────
  const battleChOk = await checkBattleChannel(ctx.from.id, battle.channel);
  if (!battleChOk) {
    setState(ctx.from.id, { pendingVote: { battleId, targetUsername } });
    return ctx.reply(
      `❌ Ovoz berish uchun avval battle kanali ${battle.channel} ga obuna bo'ling:`,
      Markup.inlineKeyboard([
        [Markup.button.url(
          `📢 ${battle.channel} ga obuna bo'lish`,
          `https://t.me/${battle.channel.replace('@', '')}`
        )],
        [Markup.button.callback('✅ Obunani tekshirish', 'chk_battle_then_vote')]
      ])
    );
  }

  // ─── OVOZ BERISH ──────────────────────────────────────────
  await doVote(ctx, battle, voterId, targetUsername);
}

async function doVote(ctx, battle, voterId, targetUsername) {
  battle.votes[voterId] = targetUsername;
  users[voterId].votes  = (users[voterId].votes || 0) + 1;
  saveBattles();
  saveUsers();
  clearState(ctx.from.id);

  await ctx.reply(
    `✅ @${targetUsername}ga ovoz berdingiz! 📦\n\n` +
    `💡 Havolani do'stlaringizga yuboring, ulardanam ovoz oling!`,
    mainMenu()
  );

  await updatePost(battle);

  const count = getVotes(battle, targetUsername);
  if (count >= battle.target) {
    await declareWinner(battle, targetUsername);
  }
}

// ─── Majburiy kanal tekshirgandan keyin ovoz ──────────────
bot.action('chk_req_then_vote', async (ctx) => {
  await ctx.answerCbQuery('Tekshirilmoqda...');
  const state = getState(ctx.from.id);
  if (!state?.pendingVote) return ctx.reply('❌ Ma\'lumot topilmadi. Qayta bosing.', mainMenu());

  const reqOk = await checkRequiredChannels(ctx.from.id);
  if (!reqOk) return ctx.answerCbQuery('❌ Hali obuna bo\'lmadingiz!', true);

  const { battleId, targetUsername } = state.pendingVote;
  const battle = battles[battleId];
  if (!battle || !battle.active) {
    clearState(ctx.from.id);
    try { await ctx.deleteMessage(); } catch (e) {}
    return ctx.reply('❌ Battle topilmadi yoki tugagan.', mainMenu());
  }

  // Endi battle kanalini tekshir
  const battleChOk = await checkBattleChannel(ctx.from.id, battle.channel);
  if (!battleChOk) {
    try { await ctx.deleteMessage(); } catch (e) {}
    return ctx.reply(
      `❌ Endi battle kanali ${battle.channel} ga obuna bo'ling:`,
      Markup.inlineKeyboard([
        [Markup.button.url(
          `📢 ${battle.channel} ga obuna bo'lish`,
          `https://t.me/${battle.channel.replace('@', '')}`
        )],
        [Markup.button.callback('✅ Obunani tekshirish', 'chk_battle_then_vote')]
      ])
    );
  }

  try { await ctx.deleteMessage(); } catch (e) {}
  const voterId = String(ctx.from.id);
  if (battle.votes[voterId]) {
    clearState(ctx.from.id);
    return ctx.reply(`❌ Siz allaqachon @${battle.votes[voterId]}ga ovoz bergansiz.`, mainMenu());
  }
  await doVote(ctx, battle, voterId, targetUsername);
});

// ─── Battle kanal tekshirgandan keyin ovoz ────────────────
bot.action('chk_battle_then_vote', async (ctx) => {
  await ctx.answerCbQuery('Tekshirilmoqda...');
  const state = getState(ctx.from.id);
  if (!state?.pendingVote) return ctx.reply('❌ Ma\'lumot topilmadi. Qayta bosing.', mainMenu());

  const { battleId, targetUsername } = state.pendingVote;
  const battle = battles[battleId];
  if (!battle || !battle.active) {
    clearState(ctx.from.id);
    try { await ctx.deleteMessage(); } catch (e) {}
    return ctx.reply('❌ Battle topilmadi yoki tugagan.', mainMenu());
  }

  const battleChOk = await checkBattleChannel(ctx.from.id, battle.channel);
  if (!battleChOk) return ctx.answerCbQuery(`❌ Hali ${battle.channel} ga obuna bo'lmadingiz!`, true);

  try { await ctx.deleteMessage(); } catch (e) {}
  const voterId = String(ctx.from.id);
  if (battle.votes[voterId]) {
    clearState(ctx.from.id);
    return ctx.reply(`❌ Siz allaqachon @${battle.votes[voterId]}ga ovoz bergansiz.`, mainMenu());
  }
  await doVote(ctx, battle, voterId, targetUsername);
});

// ============================================================
//               JOIN HANDLER
// ============================================================
async function handleJoin(ctx, battleId) {
  const user     = getUser(ctx);
  if (user.banned) return ctx.reply('🚫 Siz ban qilingansiz.');

  const username = ctx.from.username;
  if (!username) return ctx.reply('❌ Avval Telegram username o\'rnating.');

  const battle = battles[battleId];
  if (!battle) return ctx.reply('❌ Battle topilmadi.');
  if (!battle.active) return ctx.reply('❌ Bu battle tugagan.');

  // Allaqachon ishtirokchimi
  if (battle.participants.some(p => p.toLowerCase() === username.toLowerCase())) {
    const voteLink = `https://t.me/${BOT_USERNAME}?start=vote-${battle.battleId}-${username}`;
    return ctx.reply(
      `✅ Siz allaqachon bu battledasiz!\n\n🔗 Sizning ovoz havolangiz:\n<code>${voteLink}</code>`,
      { parse_mode: 'HTML', disable_web_page_preview: true }
    );
  }

  // ─── 1-QADAM: Majburiy kanallar ──────────────────────────
  const reqOk = await checkRequiredChannels(ctx.from.id);
  if (!reqOk) {
    setState(ctx.from.id, { pendingJoin: battleId });
    return ctx.reply(
      `❌ Battlega qo'shilish uchun avval majburiy kanallarga obuna bo'ling:`,
      requiredChannelKeyboard('chk_req_then_join')
    );
  }

  // ─── 2-QADAM: Battle kanali ───────────────────────────────
  const battleChOk = await checkBattleChannel(ctx.from.id, battle.channel);
  if (!battleChOk) {
    setState(ctx.from.id, { pendingJoin: battleId });
    return ctx.reply(
      `❌ Battlega qo'shilish uchun avval ${battle.channel} ga obuna bo'ling:`,
      Markup.inlineKeyboard([
        [Markup.button.url(
          `📢 ${battle.channel} ga obuna bo'lish`,
          `https://t.me/${battle.channel.replace('@', '')}`
        )],
        [Markup.button.callback('✅ Obunani tekshirish', 'chk_battle_then_join')]
      ])
    );
  }

  await doJoin(ctx, battle, username);
}

async function doJoin(ctx, battle, username) {
  battle.participants.push(username);
  const uid = String(ctx.from.id);
  users[uid].joinedBattles = (users[uid].joinedBattles || 0) + 1;
  saveBattles();
  saveUsers();
  clearState(ctx.from.id);

  const voteLink = `https://t.me/${BOT_USERNAME}?start=vote-${battle.battleId}-${username}`;
  await ctx.reply(
    `✅ Battlega muvaffaqiyatli qo'shildingiz!\n\n` +
    `🔗 <b>Sizning ovoz havolangiz:</b>\n<code>${voteLink}</code>\n\n` +
    `📤 Havolani do'stlaringizga yuboring va ovoz yig'ing! 📦`,
    { parse_mode: 'HTML', disable_web_page_preview: true }
  );

  await updatePost(battle);
}

// ─── Majburiy kanal tekshirgandan keyin join ──────────────
bot.action('chk_req_then_join', async (ctx) => {
  await ctx.answerCbQuery('Tekshirilmoqda...');
  const state = getState(ctx.from.id);
  if (!state?.pendingJoin) return ctx.reply('❌ Ma\'lumot topilmadi.', mainMenu());

  const reqOk = await checkRequiredChannels(ctx.from.id);
  if (!reqOk) return ctx.answerCbQuery('❌ Hali obuna bo\'lmadingiz!', true);

  const battle = battles[state.pendingJoin];
  if (!battle || !battle.active) {
    clearState(ctx.from.id); try { await ctx.deleteMessage(); } catch(e) {}
    return ctx.reply('❌ Battle topilmadi yoki tugagan.', mainMenu());
  }

  const battleChOk = await checkBattleChannel(ctx.from.id, battle.channel);
  if (!battleChOk) {
    try { await ctx.deleteMessage(); } catch(e) {}
    return ctx.reply(
      `❌ Endi ${battle.channel} ga obuna bo'ling:`,
      Markup.inlineKeyboard([
        [Markup.button.url(`📢 ${battle.channel} ga obuna bo'lish`, `https://t.me/${battle.channel.replace('@', '')}`)],
        [Markup.button.callback('✅ Obunani tekshirish', 'chk_battle_then_join')]
      ])
    );
  }

  try { await ctx.deleteMessage(); } catch(e) {}
  const username = ctx.from.username;
  if (!username) return ctx.reply('❌ Username o\'rnating.', mainMenu());
  if (battle.participants.some(p => p.toLowerCase() === username.toLowerCase())) {
    clearState(ctx.from.id);
    return ctx.reply(`✅ Siz allaqachon battledasiz!`, mainMenu());
  }
  await doJoin(ctx, battle, username);
});

// ─── Battle kanal tekshirgandan keyin join ────────────────
bot.action('chk_battle_then_join', async (ctx) => {
  await ctx.answerCbQuery('Tekshirilmoqda...');
  const state = getState(ctx.from.id);
  if (!state?.pendingJoin) return ctx.reply('❌ Ma\'lumot topilmadi.', mainMenu());

  const battle = battles[state.pendingJoin];
  if (!battle || !battle.active) {
    clearState(ctx.from.id); try { await ctx.deleteMessage(); } catch(e) {}
    return ctx.reply('❌ Battle topilmadi yoki tugagan.', mainMenu());
  }

  const battleChOk = await checkBattleChannel(ctx.from.id, battle.channel);
  if (!battleChOk) return ctx.answerCbQuery(`❌ Hali ${battle.channel} ga obuna bo'lmadingiz!`, true);

  try { await ctx.deleteMessage(); } catch(e) {}
  const username = ctx.from.username;
  if (!username) return ctx.reply('❌ Username o\'rnating.', mainMenu());
  if (battle.participants.some(p => p.toLowerCase() === username.toLowerCase())) {
    clearState(ctx.from.id);
    return ctx.reply(`✅ Siz allaqachon battledasiz!`, mainMenu());
  }
  await doJoin(ctx, battle, username);
});

// ============================================================
//               RESULTS HANDLER
// ============================================================
async function handleResults(ctx, battleId) {
  const battle = battles[battleId];
  if (!battle) return ctx.reply('❌ Battle topilmadi.');

  const sorted = battle.participants
    .map(u => ({ username: u, count: getVotes(battle, u) }))
    .sort((a, b) => b.count - a.count);

  let text = `📊 <b>Battle Natijalari</b>\n\n`;
  text += `🎁 Sovrin: ${battle.text}\n`;
  text += `🎯 Maqsad: ${battle.target} ovoz\n`;
  text += `📌 Holat: ${battle.active ? '🟢 Aktiv' : '🔴 Tugagan'}\n\n`;
  text += `📈 <b>Reyting:</b>\n\n`;

  if (sorted.length === 0) text += 'Hali ishtirokchilar yo\'q.';
  else {
    sorted.forEach((p, i) => {
      const m = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      text += `${m} @${p.username} — ${p.count} 📦\n`;
    });
  }
  await ctx.reply(text, { parse_mode: 'HTML' });
}

// ============================================================
//               MAIN MENU HANDLERS
// ============================================================
bot.hears('🏆 Battle yaratish', async (ctx) => {
  const user = getUser(ctx);
  if (user.banned) return ctx.reply('🚫 Ban qilingansiz.');

  const subOk = await checkRequiredChannels(ctx.from.id);
  if (!subOk) return ctx.reply('❌ Avval majburiy kanallarga obuna bo\'ling!', requiredChannelKeyboard());

  setState(ctx.from.id, { step: 'battle_text' });
  await ctx.reply(
    `🏆 <b>Battle yaratish</b>\n\n📝 Sovrin matnini kiriting:\n\nMisol:\n• 🥇 Top 1 ga gift\n• 🎁 100 Stars\n• 🏆 Premium 1 oy`,
    { parse_mode: 'HTML', ...cancelMenu() }
  );
});

bot.hears('📋 Battlelarim', async (ctx) => {
  const user      = getUser(ctx);
  if (user.banned) return ctx.reply('🚫 Ban qilingansiz.');
  const myBattles = getBattlesByOwner(ctx.from.id);
  if (myBattles.length === 0) return ctx.reply('📋 Sizda hali battle yo\'q.', mainMenu());

  const active   = myBattles.filter(b =>  b.active);
  const finished = myBattles.filter(b => !b.active);
  const btns     = [];
  active.forEach(b => {
    const v = Object.keys(b.votes).length;
    btns.push([Markup.button.callback(`🟢 ${b.text.substring(0, 22)} (${v}/${b.target})`, `bm_${b.battleId}`)]);
  });
  finished.slice(0, 5).forEach(b => {
    btns.push([Markup.button.callback(`🔴 ${b.text.substring(0, 22)}`, `bi_${b.battleId}`)]);
  });
  await ctx.reply(
    `📋 <b>Battlelarim</b>\n\n🟢 Aktiv: ${active.length}\n🔴 Tugagan: ${finished.length}`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(btns) }
  );
});

bot.hears('📊 Statistika', async (ctx) => {
  const u = getUser(ctx);
  await ctx.reply(
    `📊 <b>Statistika</b>\n\n🆔 ID: <code>${u.id}</code>\n👤 ${u.username ? '@' + u.username : 'Yo\'q'}\n\n` +
    `🏆 Yaratgan: ${u.createdBattles || 0}\n👥 Qatnashgan: ${u.joinedBattles || 0}\n` +
    `📦 Ovozlar: ${u.votes || 0}\n🥇 G'alabalar: ${u.wins || 0}\n😔 Mag'lubiyatlar: ${u.loses || 0}`,
    { parse_mode: 'HTML' }
  );
});

bot.hears('ℹ️ Yordam', async (ctx) => {
  await ctx.reply(
    `ℹ️ <b>Yordam</b>\n\n` +
    `🏆 Battle yarating → kanalingizga joylaning\n` +
    `👥 Ishtirokchi bo'lish → <i>Konkursga qo'shilish</i> tugmasini bosing\n` +
    `📦 Ovoz berish → ishtirokchi tugmasini bosing\n` +
    `🎯 Kim birinchi maqsadga yetsa — avto g'olib!\n\n` +
    `⚠️ Ovoz berish uchun:\n1. Majburiy kanallarga obuna bo'ling\n2. Battle kanaliga obuna bo'ling`,
    { parse_mode: 'HTML' }
  );
});

bot.hears('❌ Bekor qilish', async (ctx) => {
  clearState(ctx.from.id);
  await ctx.reply('❌ Bekor qilindi.', mainMenu());
});

// ============================================================
//               TEXT STATE MACHINE
// ============================================================
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();

  // ── Secret admin command ─────────────────────────────────
  if (text === `/${SECRET_CMD}`) {
    const total   = Object.keys(users).length;
    const banned  = Object.values(users).filter(u => u.banned).length;
    const allB    = Object.keys(battles).length;
    const activeB = Object.values(battles).filter(b => b.active).length;
    return ctx.reply(
      `⚙️ <b>Admin Panel</b>\n\n👥 Foydalanuvchilar: ${total}\n🚫 Banlangan: ${banned}\n` +
      `🏆 Jami battlelar: ${allB}\n🟢 Aktiv: ${activeB}\n\n` +
      `📢 Majburiy kanallar:\n${(settings.requiredChannels || []).map(c => `• ${c}`).join('\n') || 'Yo\'q'}`,
      { parse_mode: 'HTML', ...adminKeyboard() }
    );
  }

  if (text.startsWith('/')) return;

  const user  = getUser(ctx);
  if (user.banned) return;
  const state = getState(ctx.from.id);
  if (!state) return;

  // ── Battle creation ──────────────────────────────────────
  if (state.step === 'battle_text') {
    setState(ctx.from.id, { ...state, battleText: text, step: 'battle_target' });
    return ctx.reply('✅ Saqlandi!\n\n🎯 Maqsadli ovoz sonini kiriting (masalan: 10, 50, 100):', cancelMenu());
  }

  if (state.step === 'battle_target') {
    const n = parseInt(text);
    if (isNaN(n) || n < 1) return ctx.reply('❌ Musbat son kiriting.');
    setState(ctx.from.id, { ...state, battleTarget: n, step: 'battle_channel' });
    return ctx.reply(
      `✅ Maqsad: ${n} ovoz\n\n📢 Kanal username kiriting:\nMisol: @mystarchannel\n\n⚠️ Bot kanalda admin bo'lishi kerak!`,
      cancelMenu()
    );
  }

  if (state.step === 'battle_channel') {
    let channel = text;
    if (!channel.startsWith('@')) channel = '@' + channel;

    try {
      const me = await ctx.telegram.getChatMember(channel, ctx.botInfo.id);
      if (!['administrator', 'creator'].includes(me.status)) {
        return ctx.reply('❌ Bot kanalda admin emas! Avval botni admin qiling.');
      }
    } catch (e) {
      return ctx.reply(`❌ Kanal topilmadi yoki bot admin emas.\n${e.message}`, cancelMenu());
    }

    const battleId = Math.random().toString(36).substr(2, 8) + Date.now().toString(36);
    const battle = {
      battleId, owner: ctx.from.id, channel,
      text: state.battleText, target: state.battleTarget,
      active: true, participants: [], votes: {},
      messageId: null, createdAt: Date.now()
    };

    battles[battleId] = battle;
    users[String(ctx.from.id)].createdBattles = (users[String(ctx.from.id)].createdBattles || 0) + 1;
    saveBattles(); saveUsers();
    clearState(ctx.from.id);

    try {
      const msg = await ctx.telegram.sendMessage(
        channel, buildPost(battle),
        { parse_mode: 'HTML', reply_markup: buildKeyboard(battle).reply_markup }
      );
      battles[battleId].messageId = msg.message_id;
      saveBattles();
      await ctx.reply(
        `✅ Battle muvaffaqiyatli yaratildi!\n\n🆔 <code>${battleId}</code>\n📢 ${channel}\n🎯 ${state.battleTarget} ovoz`,
        { parse_mode: 'HTML', ...mainMenu() }
      );
    } catch (e) {
      delete battles[battleId]; saveBattles();
      await ctx.reply(`❌ Kanalga post yubora olmadi:\n${e.message}`, mainMenu());
    }
    return;
  }

  // ── Change target ────────────────────────────────────────
  if (state.step === 'change_target') {
    const n = parseInt(text);
    if (isNaN(n) || n < 1) return ctx.reply('❌ To\'g\'ri son kiriting.');
    const battle = battles[state.battleId];
    if (!battle || battle.owner !== ctx.from.id) { clearState(ctx.from.id); return ctx.reply('❌ Battle topilmadi.', mainMenu()); }
    const old = battle.target;
    battle.target = n; saveBattles(); clearState(ctx.from.id);
    await ctx.reply(`✅ Maqsad ${old} → ${n} ga o'zgartirildi!`, mainMenu());
    await updatePost(battle);
    return;
  }

  // ── Admin states ─────────────────────────────────────────
  if (state.step === 'admin_ban')    { const t = findUserByQuery(text); clearState(ctx.from.id); if (!t) return ctx.reply('❌ Topilmadi.'); users[String(t.id)].banned = true;  saveUsers(); return ctx.reply(`🚫 @${t.username || t.id} ban.`,   mainMenu()); }
  if (state.step === 'admin_unban')  { const t = findUserByQuery(text); clearState(ctx.from.id); if (!t) return ctx.reply('❌ Topilmadi.'); users[String(t.id)].banned = false; saveUsers(); return ctx.reply(`✅ @${t.username || t.id} unban.`, mainMenu()); }
  if (state.step === 'admin_add_ch') {
    let ch = text; if (!ch.startsWith('@')) ch = '@' + ch;
    if (!(settings.requiredChannels || []).includes(ch)) {
      settings.requiredChannels = [...(settings.requiredChannels || []), ch];
      saveSettings();
    }
    clearState(ctx.from.id);
    return ctx.reply(`✅ ${ch} majburiy kanallarga qo'shildi.`, mainMenu());
  }
  if (state.step === 'admin_broadcast') return sendBroadcast(ctx, ctx.message.message_id);
});

// ============================================================
//               MEDIA BROADCAST
// ============================================================
bot.on(['photo', 'video', 'animation', 'sticker', 'document', 'voice', 'audio'], async (ctx) => {
  const state = getState(ctx.from.id);
  if (!state || state.step !== 'admin_broadcast') return;
  await sendBroadcast(ctx, ctx.message.message_id);
});

async function sendBroadcast(ctx, messageId) {
  const uids = Object.keys(users);
  let sent = 0, failed = 0;
  await ctx.reply(`📢 Broadcast boshlandi... ${uids.length} ta foydalanuvchi`);
  for (const uid of uids) {
    try { await bot.telegram.copyMessage(uid, ctx.from.id, messageId); sent++; }
    catch (e) { failed++; }
    await new Promise(r => setTimeout(r, 55));
  }
  clearState(ctx.from.id);
  await ctx.reply(`✅ Broadcast tugadi!\n✅ Yuborildi: ${sent}\n❌ Xato: ${failed}`, mainMenu());
}

// ============================================================
//               ADMIN KEYBOARD
// ============================================================
const adminKeyboard = () => Markup.inlineKeyboard([
  [Markup.button.callback('📢 Broadcast',          'adm_bc')],
  [Markup.button.callback('🚫 Ban',                'adm_ban'),       Markup.button.callback('✅ Unban', 'adm_unban')],
  [Markup.button.callback('📊 Statistika',         'adm_stats')],
  [Markup.button.callback('📋 Battlelar',          'adm_battles')],
  [Markup.button.callback('➕ Kanal qo\'shish',    'adm_addch'),     Markup.button.callback('➖ Kanal o\'chirish', 'adm_rmch')]
]);

bot.action('adm_bc', async (ctx) => {
  setState(ctx.from.id, { step: 'admin_broadcast' });
  await ctx.answerCbQuery();
  await ctx.reply('📢 Broadcast xabarini yuboring (matn, rasm, video, gif, stiker...):', cancelMenu());
});

bot.action('adm_ban', async (ctx) => {
  setState(ctx.from.id, { step: 'admin_ban' });
  await ctx.answerCbQuery();
  await ctx.reply('🚫 Ban qilish uchun @username yoki ID:', cancelMenu());
});

bot.action('adm_unban', async (ctx) => {
  setState(ctx.from.id, { step: 'admin_unban' });
  await ctx.answerCbQuery();
  await ctx.reply('✅ Unban uchun @username yoki ID:', cancelMenu());
});

bot.action('adm_stats', async (ctx) => {
  await ctx.answerCbQuery();
  const total   = Object.keys(users).length;
  const banned  = Object.values(users).filter(u => u.banned).length;
  const allB    = Object.keys(battles).length;
  const activeB = Object.values(battles).filter(b => b.active).length;
  const votes   = Object.values(battles).reduce((a, b) => a + Object.keys(b.votes).length, 0);
  await ctx.editMessageText(
    `📊 <b>Statistika</b>\n\n👥 Foydalanuvchilar: ${total}\n🚫 Banlangan: ${banned}\n` +
    `🏆 Jami battlelar: ${allB}\n🟢 Aktiv: ${activeB}\n📦 Jami ovozlar: ${votes}\n\n` +
    `📢 Majburiy kanallar:\n${(settings.requiredChannels || []).map(c => `• ${c}`).join('\n') || 'Yo\'q'}`,
    { parse_mode: 'HTML' }
  );
});

bot.action('adm_battles', async (ctx) => {
  await ctx.answerCbQuery();
  const all = Object.values(battles);
  let text = `📋 <b>Battlelar</b> (${all.length})\n\n`;
  if (all.length === 0) text += 'Yo\'q.';
  else all.slice(0, 20).forEach(b => {
    const v = Object.keys(b.votes).length;
    text += `${b.active ? '🟢' : '🔴'} ${b.text.substring(0, 20)} | ${b.channel} | ${v}/${b.target}\n`;
  });
  await ctx.editMessageText(text, { parse_mode: 'HTML' });
});

bot.action('adm_addch', async (ctx) => {
  setState(ctx.from.id, { step: 'admin_add_ch' });
  await ctx.answerCbQuery();
  await ctx.reply('➕ Kanal username kiriting (@kanal):', cancelMenu());
});

bot.action('adm_rmch', async (ctx) => {
  await ctx.answerCbQuery();
  const chs = settings.requiredChannels || [];
  if (chs.length === 0) return ctx.reply('Majburiy kanallar yo\'q.', mainMenu());
  const btns = chs.map((ch, i) => [Markup.button.callback(`❌ ${ch}`, `rmch_${i}`)]);
  await ctx.editMessageText('O\'chirish uchun kanalni tanlang:', { reply_markup: Markup.inlineKeyboard(btns).reply_markup });
});

bot.action(/^rmch_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const idx = parseInt(ctx.match[1]);
  const chs = settings.requiredChannels || [];
  const ch  = chs[idx];
  settings.requiredChannels = chs.filter((_, i) => i !== idx);
  saveSettings();
  await ctx.editMessageText(`✅ ${ch} o'chirildi.`);
});

// ============================================================
//               BATTLE MANAGEMENT CALLBACKS
// ============================================================
bot.action(/^bm_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const battle = battles[ctx.match[1]];
  if (!battle || battle.owner !== ctx.from.id) return;
  const v = Object.keys(battle.votes).length;
  await ctx.editMessageText(
    `📋 <b>Battle Boshqaruvi</b>\n\n🎁 ${battle.text}\n🎯 Maqsad: ${battle.target}\n` +
    `👥 Ishtirokchilar: ${battle.participants.length}\n📦 Ovozlar: ${v}\n📢 ${battle.channel}\n` +
    `📌 ${battle.active ? '🟢 Aktiv' : '🔴 Tugagan'}`,
    {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('📊 Natijalar',             `bi_${battle.battleId}`)],
        [Markup.button.callback('🎯 Maqsadni o\'zgartirish',`bc_${battle.battleId}`)],
        [Markup.button.callback('⛔ Battle stop',           `bs_${battle.battleId}`)],
        [Markup.button.callback('🔄 Yangilash',             `bm_${battle.battleId}`)],
        [Markup.button.callback('◀️ Orqaga',               'back_battles')]
      ]).reply_markup
    }
  );
});

bot.action(/^bi_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const battle = battles[ctx.match[1]];
  if (!battle) return;
  const sorted = battle.participants
    .map(u => ({ username: u, count: getVotes(battle, u) }))
    .sort((a, b) => b.count - a.count);
  let text = `📊 <b>Natijalar</b>\n\n🎁 ${battle.text}\n🎯 Maqsad: ${battle.target}\n\n📈 <b>Reyting:</b>\n\n`;
  if (sorted.length === 0) text += 'Hali ishtirokchilar yo\'q.';
  else sorted.forEach((p, i) => { const m = i===0?'🥇':i===1?'🥈':i===2?'🥉':`${i+1}.`; text += `${m} @${p.username} — ${p.count} 📦\n`; });
  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('◀️ Orqaga', `bm_${battle.battleId}`)]]).reply_markup
  });
});

bot.action(/^bc_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const battle = battles[ctx.match[1]];
  if (!battle || battle.owner !== ctx.from.id) return;
  setState(ctx.from.id, { step: 'change_target', battleId: battle.battleId });
  await ctx.reply(`🎯 Yangi maqsad sonini kiriting (hozir: ${battle.target}):`, cancelMenu());
});

bot.action(/^bs_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('⛔ To\'xtatildi.');
  const battle = battles[ctx.match[1]];
  if (!battle || battle.owner !== ctx.from.id) return;
  battle.active = false; saveBattles();
  try { await bot.telegram.sendMessage(battle.channel, `⛔ <b>Battle to'xtatildi</b>\n\n🎁 Sovrin: ${battle.text}`, { parse_mode: 'HTML' }); } catch(e) {}
  await ctx.editMessageText('⛔ Battle to\'xtatildi.', {
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('◀️ Orqaga', 'back_battles')]]).reply_markup
  });
});

bot.action('back_battles', async (ctx) => {
  await ctx.answerCbQuery();
  const myBattles = getBattlesByOwner(ctx.from.id);
  const active    = myBattles.filter(b =>  b.active);
  const finished  = myBattles.filter(b => !b.active);
  const btns      = [];
  active.forEach(b => { const v = Object.keys(b.votes).length; btns.push([Markup.button.callback(`🟢 ${b.text.substring(0,22)} (${v}/${b.target})`, `bm_${b.battleId}`)]); });
  finished.slice(0,5).forEach(b => { btns.push([Markup.button.callback(`🔴 ${b.text.substring(0,22)}`, `bi_${b.battleId}`)]); });
  await ctx.editMessageText(
    `📋 <b>Battlelarim</b>\n\n🟢 Aktiv: ${active.length}\n🔴 Tugagan: ${finished.length}`,
    { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard(btns).reply_markup }
  );
});

// ============================================================
//               ERROR HANDLER
// ============================================================
bot.catch((err, ctx) => {
  console.error('[ERROR]', err.message || err);
  try {
    if (ctx.callbackQuery) ctx.answerCbQuery('❌ Xato.').catch(() => {});
    else ctx.reply('❌ Xato yuz berdi.').catch(() => {});
  } catch (_) {}
});

// ============================================================
//                    LAUNCH
// ============================================================
bot.launch({ allowedUpdates: ['message', 'callback_query'] })
  .then(() => {
    console.log(`✅ Stars Battle Bot ishga tushdi! @${BOT_USERNAME}`);
    console.log(`🔑 Admin panel: /${SECRET_CMD}`);
  })
  .catch(err => { console.error('❌ Xato:', err.message); process.exit(1); });

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

