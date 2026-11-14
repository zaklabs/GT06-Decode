'use strict';

/**
 * Basic Auth untuk dashboard internal, manajemen token, dan endpoint internal.
 *
 * Kredensial diambil dari env ADMIN_USER (default "admin") dan ADMIN_PASSWORD
 * (WAJIB, tidak ada default). Kalau ADMIN_PASSWORD kosong, semua route admin
 * dinonaktifkan (503) -- ingest TCP GT06 dan API eksternal ber-token tetap jalan.
 *
 * Basic Auth dipilih karena browser otomatis mengirim ulang kredensialnya untuk
 * request same-origin, termasuk EventSource('/api/events') yang tidak bisa
 * mengirim header custom.
 */

const crypto = require('crypto');

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const MIN_PASSWORD_LENGTH = 12;

const REALM = 'GT06 Decode Admin';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

/** Bandingkan string secara constant-time (hash dulu supaya panjang buffer selalu sama). */
function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function isEnabled() {
  return ADMIN_PASSWORD.length > 0;
}

/** Pesan peringatan konfigurasi untuk dicatat saat start, atau null kalau aman. */
function configWarning() {
  if (!isEnabled()) {
    return '[!] ADMIN_PASSWORD belum diset -- dashboard web, manajemen token & endpoint internal DINONAKTIFKAN (503). Ingest GT06 & /api/external/* tetap jalan.';
  }
  if (ADMIN_PASSWORD.length < MIN_PASSWORD_LENGTH) {
    return `[!] ADMIN_PASSWORD lebih pendek dari ${MIN_PASSWORD_LENGTH} karakter -- sebaiknya ganti dengan password yang lebih kuat.`;
  }
  return null;
}

function parseBasicAuth(header) {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header || '');
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep === -1) return null;
  return { user: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
}

function checkCredentials(req) {
  const creds = parseBasicAuth(req.headers.authorization);
  if (!creds) return false;
  // evaluasi keduanya (tanpa short-circuit) supaya waktu respon tidak membocorkan mana yang salah
  const userOk = safeEqual(creds.user, ADMIN_USER);
  const passOk = safeEqual(creds.password, ADMIN_PASSWORD);
  return userOk && passOk;
}

/**
 * true kalau request boleh lanjut. Kalau tidak, respon 401/503 sudah dikirim.
 */
function requireAdmin(req, res) {
  if (!isEnabled()) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Akses admin dinonaktifkan: ADMIN_PASSWORD belum diset di server' }));
    return false;
  }
  if (checkCredentials(req)) return true;
  res.writeHead(401, {
    'Content-Type': 'application/json; charset=utf-8',
    'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
  });
  res.end(JSON.stringify({ error: 'Autentikasi admin diperlukan' }));
  return false;
}

module.exports = { requireAdmin, isEnabled, configWarning, safeEqual, parseBasicAuth };
