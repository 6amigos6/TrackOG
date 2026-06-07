/**
 * ============================================================
 *  TrackDown — Konfiqurasiya Sistemi
 *
 *  Token prioriteti  : bot.js → .env (BOT_TOKEN / BOT) → xəta
 *  Domain prioriteti : bot.js → .env (HOST_URL) → platform
 *                      env dəyişəni → request-dən avtomatik
 *
 *  Dəstəklənən platformalar:
 *    Railway, Render, Heroku, Fly.io, Replit, VPS / cPanel
 * ============================================================
 */

require('dotenv').config();

// ── bot.js-i yüklə ─────────────────────────────────────────
let botJs = { token: '', domain: '' };
try { botJs = require('./bot.js'); } catch (_) {}

// ── Token ──────────────────────────────────────────────────
const rawBotJsToken = (botJs.token  || '').trim();
const rawEnvToken   = (
  process.env.BOT_TOKEN ||
  process.env.BOT       ||
  process.env.bot       || ''
).trim();

const TOKEN = rawBotJsToken || rawEnvToken;

if (!TOKEN) {
  console.error('\n❌  Telegram bot tokeni tapılmadı!');
  console.error('    ▸ bot.js  → token: "TOKENINIZ"');
  console.error('    ▸ .env    → BOT_TOKEN=TOKENINIZ\n');
  process.exit(1);
}

// ── Domain normallaşdırıcısı ───────────────────────────────
function normalizeDomain(raw) {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;
  // Protokol yox → https əlavə et
  if (!s.startsWith('http://') && !s.startsWith('https://')) {
    s = 'https://' + s;
  }
  // Sonundakı slash sil
  s = s.replace(/\/+$/, '');
  // Sadə format yoxlaması
  try { new URL(s); } catch (_) { return null; }
  return s;
}

// ── Platform env dəyişənlərindən domain tap ────────────────
function detectPlatformDomain() {
  // Railway
  if (process.env.RAILWAY_PUBLIC_DOMAIN)
    return normalizeDomain(process.env.RAILWAY_PUBLIC_DOMAIN);

  // Render
  if (process.env.RENDER_EXTERNAL_URL)
    return normalizeDomain(process.env.RENDER_EXTERNAL_URL);

  // Heroku
  if (process.env.HEROKU_APP_DEFAULT_DOMAIN_NAME)
    return normalizeDomain(process.env.HEROKU_APP_DEFAULT_DOMAIN_NAME);

  // Fly.io
  if (process.env.FLY_APP_NAME)
    return normalizeDomain(`${process.env.FLY_APP_NAME}.fly.dev`);

  // Replit
  if (process.env.REPLIT_DOMAINS)
    return normalizeDomain(process.env.REPLIT_DOMAINS.split(',')[0].trim());

  // Ümumi HOST_URL env dəyişəni
  if (process.env.HOST_URL)
    return normalizeDomain(process.env.HOST_URL);

  return null;
}

// ── STATIC_HOST qur ────────────────────────────────────────
const botJsDomain = normalizeDomain(botJs.domain || '');
const STATIC_HOST = botJsDomain || detectPlatformDomain();

// ── Port ───────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3000;

// ── Log ────────────────────────────────────────────────────
const tokenSrc = rawBotJsToken ? 'bot.js' : '.env';
const domainSrc = botJsDomain
  ? 'bot.js'
  : (detectPlatformDomain() ? 'platform env' : 'avtomatik (request)');

console.log('─────────────────────────────────────');
console.log(`  Token    : ${tokenSrc}`);
console.log(`  Domain   : ${STATIC_HOST ? STATIC_HOST + '  [' + domainSrc + ']' : 'Müəyyən edilməyib → request-dən tapılacaq'}`);
console.log(`  Port     : ${PORT}`);
console.log('─────────────────────────────────────');

module.exports = { TOKEN, STATIC_HOST, PORT };
