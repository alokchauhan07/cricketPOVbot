require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { pipeline } = require('stream');
const { promisify } = require('util');
const pump = promisify(pipeline);
const { Telegraf, Markup } = require('telegraf');
const db = require('./db');
const engine = require('./gameEngine');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('Set BOT_TOKEN in environment');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

const lobbies = new Map();
const activeGames = new Map();
const pendingAddAnim = new Map();
const pendingRestore = new Map();

function userObj(from) { return { id: String(from.id), name: `${from.first_name || ''} ${from.last_name || ''}`.trim() || from.username || String(from.id) }; }
function isAdmin(userId) { if (!ADMIN_IDS || ADMIN_IDS.length === 0) return false; return ADMIN_IDS.includes(String(userId)); }

const IMAGE_URL = process.env.MODE_CHOICE_IMAGE_URL || 'https://i.imgur.com/3QZ6K6u.png';

/* /start */
bot.start(async (ctx) => {
  const botUsername = (ctx.botInfo && ctx.botInfo.username) ? `@${ctx.botInfo.username}` : 'this bot';
  const owner = process.env.BOT_OWNER || '';
  const supportUrl = process.env.SUPPORT_URL || '';
  const privateButtons = [];
  if (supportUrl) privateButtons.push(Markup.button.url('Support', supportUrl));
  if (owner) privateButtons.push(Markup.button.url('Owner', `https://t.me/${owner.replace(/^@/, '')}`));
  privateButtons.push(Markup.button.callback('Create New Game', 'create_new_game_quick'));

  if (ctx.chat.type === 'private') {
    const message =
      `Welcome to CricketPCG — a fast, fair and secure Hand-Cricket game for Telegram.\n\n` +
      `What I do:\n` +
      `• Host quick 1v1 matches (Solo lobby → PvP). No AI — real players only.\n` +
      `• Ball-by-ball private-number bowling and group-number batting with animated reveals.\n\n` +
      `Quick commands:\n` +
      `/newgame — Start a mode chooser in a group (use in group chats)\n` +
      `/joingame — Join the most recent lobby in the group\n` +
      `/members — Show players & live scoreboard\n\n` +
      `Admin commands: /addanim, /animlist, /backup, /restore\n\n` +
      `Players must start a private chat with me so I can send bowling prompts.\n` +
      `Enjoy! 🎯`;
    await ctx.reply(message, Markup.inlineKeyboard(privateButtons, { columns: 1 }).resize());
    return;
  }
  const groupMsg =
    `CricketPCG Bot is online — ready to host hand-cricket matches ⚾\n` +
    `Use /newgame in this group to create a new lobby and start playing.\n\n` +
    `Tip: Players should start a private chat with the bot so they can receive bowling prompts.`;
  await ctx.reply(groupMsg);
});

/* /help (professional, combined) */
bot.command('help', async (ctx) => {
  const botUsername = (ctx.botInfo && ctx.botInfo.username) ? `@${ctx.botInfo.username}` : 'this bot';
  const owner = process.env.BOT_OWNER || '';
  const supportUrl = process.env.SUPPORT_URL || '';
  const fromId = String(ctx.from.id);
  const admin = isAdmin(fromId);
  const privateButtons = [];
  if (supportUrl) privateButtons.push(Markup.button.url('Support', supportUrl));
  if (owner) privateButtons.push(Markup.button.url('Owner', `https://t.me/${owner.replace(/^@/, '')}`));
  if (ctx.chat.type === 'private') {
    let fullText = `🏏 CricketPCG — Help & Commands\n\n`;
    fullText += `Player & Lobby commands:\n• /newgame — Start a mode chooser in a group (use in group chat).\n• /joingame — Join the most recent lobby in this group.\n• /members — Show current players and live scoreboard for the active match.\n\n`;
    fullText += `Gameplay (hand-cricket rules):\n• Bowler (private): choose a number 1–6 and send to the bot in private.\n• Batter (group): when prompted, send a number 1–6 in the group.\n• If numbers match → W (wicket). Otherwise batter scores the number sent.\n\n`;
    fullText += `Animations & media:\n• /animlist — List stored animation labels.\n• Admin: /addanim <label> — Upload animation media in private.\n\n`;
    if (admin) fullText += `Admin commands:\n• /addanim <label> — Upload animation\n• /animlist — List animations\n• /backup — Download DB backup\n• /restore — Restore DB from uploaded backup\n\n`;
    fullText += `Notes:\n• Team mode is under maintenance.\n• Admin commands require ADMIN_IDS in .env.\n• Players must start a private chat with the bot.\n`;
    return ctx.reply(fullText, privateButtons.length ? Markup.inlineKeyboard(privateButtons, { columns: 1 }).resize() : undefined);
  }
  const groupText = '🏏 CricketPCG — Quick Help\n\n• Use /newgame to create a Solo lobby. • Use /joingame to join. • For full help message the bot privately and send /help.';
  return ctx.reply(groupText);
});

/* /newgame - mode chooser */
bot.command('newgame', async (ctx) => {
  if (ctx.chat.type === 'private') return ctx.reply('Use /newgame in a group chat.');
  await ctx.replyWithPhoto(IMAGE_URL, { caption: 'Choose mode: Solo or Team', ...Markup.inlineKeyboard([[Markup.button.callback('Solo', `choose:solo`)],[Markup.button.callback('Team', `choose:team`) ]]) });
});

/* choose callbacks (Team locked) */
bot.action(/choose:(.+)/, async (ctx) => {
  const mode = ctx.match[1];
  const chatId = String(ctx.chat.id);
  const user = userObj(ctx.from);
  if (mode === 'solo') {
    const { id, state } = engine.createNewGame({ chatId, type: 'solo', creator: user, overs: 1 });
    const now = Date.now();
    db.createGame({ id, type: 'solo', status: 'waiting', player1_id: '', player1_name: '', player2_id: '', player2_name: '', state_json: JSON.stringify(state), created_at: now, updated_at: now });
    activeGames.set(id, state);
    const msg = await ctx.reply(`🎉 Game created! Join the game using /joingame (2 minutes to join) ⏰`, Markup.inlineKeyboard([Markup.button.callback('Join Game', `join:${id}`)]));
    scheduleJoinCountdown(chatId, id, msg.message_id, ctx);
    ctx.answerCbQuery('Solo lobby created');
  } else {
    ctx.answerCbQuery('Team mode is under maintenance', { show_alert: true });
    await ctx.reply('⚠️ Team mode is currently under maintenance. Please use Solo mode for now.');
  }
});

/* scheduleJoinCountdown */
function scheduleJoinCountdown(chatId, gameId, lobbyMessageId, ctx) {
  if (lobbies.has(chatId)) {
    const prev = lobbies.get(chatId);
    clearTimeout(prev.joinTimeout);
    prev.reminders.forEach(t => clearTimeout(t));
  }
  const reminders = [];
  const joinDuration = 2 * 60 * 1000;
  reminders.push(setTimeout(() => ctx.telegram.sendMessage(chatId, '1 minute left only, everyone /joingame fast!!'), 60 * 1000));
  reminders.push(setTimeout(() => ctx.telegram.sendMessage(chatId, '30 seconds left only, everyone /joingame fast!!'), 90 * 1000));
  reminders.push(setTimeout(() => ctx.telegram.sendMessage(chatId, 'Last 10 seconds left only, /joingame !!'), 110 * 1000));
  const joinTimeout = setTimeout(() => {
    const state = activeGames.get(gameId);
    if (!state) { ctx.telegram.sendMessage(chatId, 'Lobby expired.'); lobbies.delete(chatId); return; }
    if (state.players.length < 2) {
      ctx.telegram.sendMessage(chatId, 'Not enough players joined. Lobby closed.');
      db.saveGame({ id: gameId, status: 'finished', player2_id: '', player2_name: '', state_json: JSON.stringify(state), updated_at: Date.now() });
      activeGames.delete(gameId); lobbies.delete(chatId); return;
    }
    engine.startMatch(state);
    db.saveGame({ id: gameId, status: 'playing', player2_id: state.players[1] ? state.players[1].id : '', player2_name: state.players[1] ? state.players[1].name : '', state_json: JSON.stringify(state), updated_at: Date.now() });
    lobbies.delete(chatId);
    ctx.telegram.sendMessage(chatId, `Match starting! Players:\n1) ${state.players[0].name}\n2) ${state.players[1].name}`);
    beginBallCycle(gameId, ctx);
  }, joinDuration);
  lobbies.set(chatId, { gameId, joinTimeout, reminders });
}

/* join handlers */
bot.action(/join:(.+)/, async (ctx) => {
  const gameId = ctx.match[1];
  const user = userObj(ctx.from);
  const state = activeGames.get(gameId);
  if (!state) return ctx.answerCbQuery('Lobby expired or not found');
  if (state.status !== 'waiting') return ctx.answerCbQuery('Game already started');
  const added = engine.addPlayer(state, user);
  if (!added) return ctx.answerCbQuery('You already joined');
  db.saveGame({ id: gameId, status: 'waiting', player2_id: state.players[1] ? state.players[1].id : '', player2_name: state.players[1] ? state.players[1].name : '', state_json: JSON.stringify(state), updated_at: Date.now() });
  const index = state.players.findIndex(p => p.id === user.id);
  await ctx.reply(`🎉 ${user.name}, you've joined the game! (Player ${index + 1}) 👍`);
  ctx.answerCbQuery('Joined');
});

/* /joingame command */
bot.command('joingame', async (ctx) => {
  if (ctx.chat.type === 'private') return ctx.reply('Join commands work in the group chat where the lobby was created.');
  const chatId = String(ctx.chat.id);
  const lobby = lobbies.get(chatId);
  if (!lobby) return ctx.reply('No active lobby in this group right now.');
  const gameId = lobby.gameId;
  const state = activeGames.get(gameId);
  if (!state) return ctx.reply('Lobby expired or not found');
  const user = userObj(ctx.from);
  if (state.players.find(p => p.id === user.id)) return ctx.reply('You already joined the game.');
  engine.addPlayer(state, user);
  db.saveGame({ id: gameId, status: 'waiting', player2_id: state.players[1] ? state.players[1].id : '', player2_name: state.players[1] ? state.players[1].name : '', state_json: JSON.stringify(state), updated_at: Date.now() });
  const idx = state.players.findIndex(p => p.id === user.id);
  await ctx.reply(`🎉 ${user.name}, you've joined the game! (Player ${idx + 1}) 👍`);
});

/* beginBallCycle */
async function beginBallCycle(gameId, ctx) {
  const state = activeGames.get(gameId);
  if (!state) return;
  if (state.status === 'finished') { await endMatch(gameId, ctx); return; }
  state.waitingForBowlerNumber = true;
  db.saveGame({ id: gameId, status: 'playing', player2_id: state.players[1] ? state.players[1].id : '', player2_name: state.players[1] ? state.players[1].name : '', state_json: JSON.stringify(state), updated_at: Date.now() });
  const batting = engine.getCurrentBattingPlayer(state);
  const bowling = engine.getCurrentBowlingPlayer(state);
  await ctx.telegram.sendMessage(state.chatId, `Hey ${batting.name}, now you're batter!\nHey ${bowling.name}, now you're bowling!`);
  try {
    const anim = db.getAnimation('bowling');
    if (anim) { await sendStoredMediaToUser(ctx.telegram, bowling.id, anim); await ctx.telegram.sendMessage(bowling.id, `Current batter: ${batting.name}\nSend your number (1-6). You have 1 min.`, Markup.keyboard([['1','2','3','4','5','6']]).oneTime().resize()); }
    else { await ctx.telegram.sendMessage(bowling.id, `𝗣𝗥𝗘𝗣: Current batter: ${batting.name}\nSend your number (1-6). You have 1 min.`, Markup.keyboard([['1','2','3','4','5','6']]).oneTime().resize()); }
  } catch (e) {
    await ctx.telegram.sendMessage(state.chatId, `Couldn't send PM to ${bowling.name}. Make sure they have started a chat with the bot.`);
  }
}

/* send stored media helper */
async function sendStoredMediaToUser(telegram, userId, animRow) {
  const fileId = animRow.file_id;
  const t = animRow.file_type;
  if (t === 'photo') await telegram.sendPhoto(userId, fileId);
  else if (t === 'animation') await telegram.sendAnimation(userId, fileId);
  else if (t === 'video') await telegram.sendVideo(userId, fileId);
  else await telegram.sendDocument(userId, fileId);
}

/* /members command */
bot.command('members', async (ctx) => {
  if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
    const chatId = String(ctx.chat.id);
    let candidateGame = null;
    for (const [gameId, state] of activeGames.entries()) if (String(state.chatId) === chatId) { candidateGame = { gameId, state }; break; }
    if (!candidateGame) return ctx.reply('No active match in this group right now.');
    const { state } = candidateGame;
    const listText = engine.getPlayersScoreList(state);
    const scorecard = engine.getScorecardText(state);
    return ctx.reply(`Players & stats:\n${listText}\n\n${scorecard}`);
  }
  if (ctx.chat.type === 'private') {
    const myId = String(ctx.from.id);
    let candidateGame = null;
    for (const [gameId, state] of activeGames.entries()) if (state.players.find(p => String(p.id) === myId)) { candidateGame = { gameId, state }; break; }
    if (!candidateGame) return ctx.reply('You are not currently playing in any active match.');
    const { state } = candidateGame;
    const listText = engine.getPlayersScoreList(state);
    const scorecard = engine.getScorecardText(state);
    return ctx.reply(`Players & stats (your match):\n${listText}\n\n${scorecard}`);
  }
  return ctx.reply('This command works in group or private chat.');
});

/* Admin animation commands */
bot.command('addanim', async (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('Use this command in private (admins only).');
  const fromId = String(ctx.from.id);
  if (!isAdmin(fromId)) return ctx.reply('You are not authorized.');
  const parts = ctx.message.text.split(' ').slice(1);
  const label = parts[0];
  if (!label) return ctx.reply('Usage: /addanim <label>');
  pendingAddAnim.set(fromId, label);
  return ctx.reply(`Upload the media now to save as "${label}". Send /canceladd to cancel.`);
});
bot.command('canceladd', (ctx) => { const fromId = String(ctx.from.id); if (pendingAddAnim.has(fromId)) { pendingAddAnim.delete(fromId); return ctx.reply('Pending upload canceled.'); } return ctx.reply('No pending upload.'); });
bot.command('animlist', (ctx) => { const rows = db.listAnimations(); if (!rows || rows.length === 0) return ctx.reply('No animations stored.'); const lines = rows.map(r => `• ${r.label} (${r.file_type})`); return ctx.reply(`Stored animations:\n${lines.join('\n')}`); });

/* Backup & Restore (gzip) */
bot.command('backup', async (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('Run /backup in a private chat (admin only).');
  const fromId = String(ctx.from.id); if (!isAdmin(fromId)) return ctx.reply('Not authorized.');
  const dbPath = db.DB_PATH; if (!fs.existsSync(dbPath)) return ctx.reply('No DB file found.');
  const tmpDir = path.join(__dirname, '..', 'data', 'tmp'); if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-'); const gzName = `backup-${timestamp}.db.gz`; const gzPath = path.join(tmpDir, gzName);
  try { const source = fs.createReadStream(dbPath); const dest = fs.createWriteStream(gzPath); const gzip = zlib.createGzip(); await pump(source, gzip, dest); await ctx.replyWithDocument({ source: fs.createReadStream(gzPath), filename: gzName }, { caption: `Database backup` }); try { fs.unlinkSync(gzPath); } catch (e) {} }
  catch (err) { console.error('Backup error:', err); return ctx.reply('Failed to create/send backup.'); }
});

bot.command('restore', async (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('Run /restore in a private chat (admin only).');
  const fromId = String(ctx.from.id); if (!isAdmin(fromId)) return ctx.reply('Not authorized.');
  pendingRestore.set(fromId, true); return ctx.reply('Please upload the backup file as a document (.db or .db.gz). Send /cancelrestore to cancel.');
});
bot.command('cancelrestore', (ctx) => { const fromId = String(ctx.from.id); if (pendingRestore.has(fromId)) { pendingRestore.delete(fromId); return ctx.reply('Restore cancelled.'); } return ctx.reply('No pending restore.'); });

/* Helper to download file */
function downloadFileToPath(fileUrl, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(fileUrl, (res) => {
      if (res.statusCode !== 200) { file.close(); fs.unlink(destPath, () => {}); return reject(new Error(`Failed to download file: ${res.statusCode}`)); }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => { file.close(); fs.unlink(destPath, () => {}); reject(err); });
  });
}

/* Main message handler (handles private admin uploads & bowler numbers, group batter numbers) */
bot.on('message', async (ctx) => {
  if (ctx.chat.type === 'private') {
    const fromId = String(ctx.from.id);
    if (pendingRestore.has(fromId) && ctx.message.document) {
      try {
        await ctx.reply('Backup file received. Downloading and validating...');
        const fileId = ctx.message.document.file_id;
        const fileLink = await ctx.telegram.getFileLink(fileId);
        const tmpDir = path.join(__dirname, '..', 'data', 'tmp'); if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        const uploadedName = ctx.message.document.file_name || `upload-${Date.now()}`;
        const tmpPath = path.join(tmpDir, `restore-upload-${Date.now()}-${uploadedName}`);
        await downloadFileToPath(fileLink.href, tmpPath);
        const tmpDbPath = path.join(tmpDir, `restore-db-${Date.now()}.db`);
        const isGz = uploadedName.toLowerCase().endsWith('.gz') || ctx.message.document.mime_type === 'application/gzip';
        if (isGz) { const gunzip = zlib.createGunzip(); const source = fs.createReadStream(tmpPath); const dest = fs.createWriteStream(tmpDbPath); await pump(source, gunzip, dest); fs.unlinkSync(tmpPath); }
        else { fs.copyFileSync(tmpPath, tmpDbPath); fs.unlinkSync(tmpPath); }
        const fd = fs.openSync(tmpDbPath, 'r'); const headerBuf = Buffer.alloc(16); fs.readSync(fd, headerBuf, 0, 16, 0); fs.closeSync(fd);
        const header = headerBuf.toString('utf8');
        if (!header.startsWith('SQLite format 3')) { fs.unlinkSync(tmpDbPath); pendingRestore.delete(fromId); return ctx.reply('Uploaded file is not a valid SQLite DB. Restore cancelled.'); }
        try { db._close(); } catch (e) {}
        const dbPath = db.DB_PATH; const bakPath = `${dbPath}.bak-${Date.now()}`; try { if (fs.existsSync(dbPath)) fs.renameSync(dbPath, bakPath); } catch (e) { console.warn('Could not rename existing DB; proceeding anyway:', e); }
        fs.copyFileSync(tmpDbPath, dbPath); fs.unlinkSync(tmpDbPath);
        try { db.reload(); } catch (e) {
          console.error('DB reload failed:', e);
          if (fs.existsSync(bakPath)) { try { fs.copyFileSync(bakPath, dbPath); db.reload(); } catch (err) { console.error('Failed to recover DB after reload error:', err); } }
          pendingRestore.delete(fromId);
          return ctx.reply('Restore failed while reloading DB: ' + (e.message || e.toString()));
        }
        activeGames.clear();
        try {
          const rows = db.listActiveGames();
          for (const r of rows) {
            try { const state = JSON.parse(r.state_json); activeGames.set(r.id, state); } catch (e) { console.warn('Failed to parse state_json for game', r.id, e); }
          }
        } catch (e) { console.warn('Failed to rebuild activeGames from DB:', e); }
        pendingRestore.delete(fromId);
        await ctx.reply('Restore complete and applied in-process. Active matches were reloaded from the database (where possible).');
      } catch (err) { console.error('Restore error:', err); pendingRestore.delete(fromId); return ctx.reply('Restore failed: ' + (err.message || 'unknown error')); }
      return;
    }

    if (pendingAddAnim.has(fromId)) {
      const label = pendingAddAnim.get(fromId);
      let file_id = null; let file_type = null; let file_unique_id = null;
      if (ctx.message.photo && Array.isArray(ctx.message.photo)) { const photos = ctx.message.photo; const best = photos[photos.length - 1]; file_id = best.file_id; file_unique_id = best.file_unique_id; file_type = 'photo'; }
      else if (ctx.message.animation) { file_id = ctx.message.animation.file_id; file_unique_id = ctx.message.animation.file_unique_id; file_type = 'animation'; }
      else if (ctx.message.video) { file_id = ctx.message.video.file_id; file_unique_id = ctx.message.video.file_unique_id; file_type = 'video'; }
      else if (ctx.message.document) { file_id = ctx.message.document.file_id; file_unique_id = ctx.message.document.file_unique_id; file_type = 'document'; }
      else { return ctx.reply('Please send a supported media type: photo, animation (gif), video, or document.'); }
      db.saveAnimation({ label, file_id, file_type, file_unique_id, added_by: fromId });
      pendingAddAnim.delete(fromId);
      return ctx.reply(`Saved animation for label "${label}". Use /animlist to confirm.`);
    }

    const text = (ctx.message.text || '').trim();
    const num = parseInt(text, 10);
    if (!Number.isInteger(num)) return;
    for (const [gameId, state] of activeGames.entries()) {
      if (state.status !== 'in_progress') continue;
      const bowler = engine.getCurrentBowlingPlayer(state);
      if (bowler && String(bowler.id) === String(ctx.from.id) && state.waitingForBowlerNumber) {
        const res = engine.submitBowlerNumber(state, ctx.from.id, num);
        if (!res.ok) { await ctx.reply(res.msg || 'Could not accept number'); }
        else { await ctx.reply('Number received. Waiting for batter in group...'); db.saveGame({ id: gameId, status: 'playing', player2_id: state.players[1] ? state.players[1].id : '', player2_name: state.players[1] ? state.players[1].name : '', state_json: JSON.stringify(state), updated_at: Date.now() }); const batting = engine.getCurrentBattingPlayer(state); await ctx.telegram.sendMessage(state.chatId, `Now Batter: ${batting.name} can send number (1-6)!!`); }
        return;
      }
    }
    return ctx.reply('No active ball waiting for your input (or you are not the current bowler).');
  }

  if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
    const text = (ctx.message.text || '').trim();
    const num = parseInt(text, 10);
    if (!Number.isInteger(num)) return;
    const chatId = String(ctx.chat.id);
    let candidateGame = null;
    for (const [gameId, state] of activeGames.entries()) if (String(state.chatId) === chatId && state.waitingForBatterNumber) { candidateGame = { gameId, state }; break; }
    if (!candidateGame) return;
    const { gameId, state } = candidateGame;
    const batter = engine.getCurrentBattingPlayer(state);
    if (!batter || String(batter.id) !== String(ctx.from.id)) return ctx.reply('Only the current batter can send the number now.');
    const res = engine.submitBatterNumber(state, ctx.from.id, num);
    if (!res.ok) return ctx.reply(res.msg || 'Could not accept your number');
    await ctx.reply('⚡');
    setTimeout(async () => {
      const outcomeLabel = res.outcome === 'W' ? 'W' : String(res.runs);
      const animRow = db.getAnimation(outcomeLabel);
      if (animRow) await sendStoredMediaToUser(ctx.telegram, state.chatId, animRow);
      else {
        const reveal = res.outcome === 'W' ? 'WICKET! 🟥' : `RUNS: ${res.runs} 🟩`;
        await ctx.reply(`Shot result: ${reveal}`);
      }
      try { const membersText = engine.getPlayersScoreList(state); const scorecard = engine.getScorecardText(state); await ctx.reply(`Live scoreboard:\n${membersText}\n\n${scorecard}`); } catch (e) {}
      db.saveGame({ id: gameId, status: state.status === 'finished' ? 'finished' : 'playing', player2_id: state.players[1] ? state.players[1].id : '', player2_name: state.players[1] ? state.players[1].name : '', state_json: JSON.stringify(state), updated_at: Date.now() });
      if (state.status === 'innings_complete') { state.status = 'in_progress'; state.waitingForBowlerNumber = true; await ctx.telegram.sendMessage(state.chatId, `Innings 1 complete. Starting Innings 2!`); beginBallCycle(gameId, ctx); }
      else if (state.status === 'finished') await endMatch(gameId, ctx);
      else {
        state.waitingForBowlerNumber = true;
        const nextBowler = engine.getCurrentBowlingPlayer(state);
        const nextBatter = engine.getCurrentBattingPlayer(state);
        const bowlingAnim = db.getAnimation('bowling');
        try { if (bowlingAnim) { await sendStoredMediaToUser(ctx.telegram, nextBowler.id, bowlingAnim); await ctx.telegram.sendMessage(nextBowler.id, `Current batter: ${nextBatter.name}\nSend your number (1-6). You have 1 min.`, Markup.keyboard([['1','2','3','4','5','6']]).oneTime().resize()); } else { await ctx.telegram.sendMessage(nextBowler.id, `Current batter: ${nextBatter.name}\nSend your number (1-6). You have 1 min.`, Markup.keyboard([['1','2','3','4','5','6']]).oneTime().resize()); } }
        catch (e) { await ctx.telegram.sendMessage(state.chatId, `Couldn't send PM to ${nextBowler.name}. Make sure they have started a chat with the bot.`); }
      }
    }, 1000);
  }
});

/* endMatch */
async function endMatch(gameId, ctx) {
  const state = activeGames.get(gameId);
  if (!state) return;
  db.saveGame({ id: gameId, status: 'finished', player2_id: state.players[1] ? state.players[1].id : '', player2_name: state.players[1] ? state.players[1].name : '', state_json: JSON.stringify(state), updated_at: Date.now() });
  const s1 = state.innings[1].score; const s2 = state.innings[2].score;
  let result = `Final Score — ${state.players[0].name}: ${s1} | ${state.players[1].name}: ${s2}\n`;
  if (s1 > s2) result += `${state.players[0].name} wins! 🎉\n`; else if (s2 > s1) result += `${state.players[1].name} wins! 🎉\n`; else result += `It's a tie! 🤝\n`;
  const membersText = engine.getPlayersScoreList(state); result += `\nPlayers stats:\n${membersText}\n`;
  const motm = engine.computeMOTM(state);
  if (motm) result += `\nMan of the Match: ${motm.name} — ${motm.runs} runs, ${motm.balls} balls, ${motm.wickets} wickets 🎖️`;
  await ctx.telegram.sendMessage(state.chatId, result);
  activeGames.delete(gameId);
}

bot.launch().then(() => console.log('Bot started'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));