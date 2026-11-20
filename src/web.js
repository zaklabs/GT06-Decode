'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { log, clearHistory, getDevices, seedDevice } = require('./logger');
const {
  IMEI_RE, sendJson, sendServerError, readJsonBody, getBearerToken, isCrossSiteWrite, streamEvents,
} = require('./httpUtil');
const tokens = require('./tokens');
const db = require('./db');
const auth = require('./auth');
const adminApi = require('./adminApi');
const trips = require('./trips');
const registry = require('./registry');
const { TIMEZONE } = require('./timezone');

const WEB_PORT = process.env.WEB_PORT ? Number(process.env.WEB_PORT) : 8080;
const WEB_HOST = process.env.WEB_HOST || '0.0.0.0';

const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');

const MAX_POSITIONS_LIMIT = 20000;
const DEFAULT_POSITIONS_LIMIT = 5000;

// Ringkasan perjalanan: rentang maksimal dan batas titik yang dibaca per permintaan.
const MAX_TRIPS_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_TRIPS_POINTS = 100000;
const TRIP_STOP_SECONDS = clampInt(process.env.GT06_TRIP_STOP_SECONDS, 30, 3600, trips.DEFAULTS.stopSeconds);
const TRIP_MIN_SPEED_KMH = clampInt(process.env.GT06_TRIP_MIN_SPEED_KMH, 1, 30, trips.DEFAULTS.minSpeedKmh);

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Parse tanggal query string; null kalau tidak valid. */
function parseDateParam(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Route yang wajib Basic Auth admin (dashboard internal, manajemen token, endpoint internal). */
function isAdminRoute(pathname) {
  return (
    pathname === '/' ||
    pathname === '/index.html' ||
    pathname === '/api/logs' ||
    pathname === '/api/devices' ||
    pathname === '/api/events' ||
    pathname === '/api/tokens' ||
    pathname.startsWith('/api/tokens/') ||
    pathname.startsWith('/api/internal/')
  );
}

function handleAdmin(req, res, pathname) {
  if (req.method === 'DELETE' && pathname === '/api/logs') {
    clearHistory();
    log('info', '[i] Log dashboard direset lewat web UI');
    res.writeHead(204).end();
    return;
  }

  // Muat ulang state device dari database ke memori -- dipakai lewat
  // `npm run reload-devices` setelah restore data, supaya dashboard & API
  // eksternal langsung menampilkan device yang ada di DB tanpa menunggu
  // device live reconnect. Tidak menimpa device yang sedang benar-benar
  // konek (lihat seedDevice() di logger.js).
  if (req.method === 'POST' && pathname === '/api/internal/reload-devices') {
    db.getAllDevices()
      .then((rows) => {
        for (const row of rows) seedDevice(row.imei, row);
        log('info', `[i] Reload manual: ${rows.length} device dimuat ulang dari database ke memori`);
        sendJson(res, 200, { reloaded: rows.length });
      })
      .catch((err) => sendServerError(res, 'Gagal reload device', err));
    return;
  }

  // --- Manajemen token, dipakai tab "Akses API" di dashboard (wajib Basic Auth admin).
  if (pathname === '/api/tokens' && req.method === 'GET') {
    tokens
      .listTokens()
      .then((list) => sendJson(res, 200, list))
      .catch((err) => sendServerError(res, 'Gagal ambil daftar token', err));
    return;
  }

  if (pathname === '/api/tokens' && req.method === 'POST') {
    readJsonBody(req)
      .then(
        (body) => {
          const label = String((body && body.label) || '').trim();
          if (!label) return sendJson(res, 400, { error: 'label wajib diisi' });
          if (label.length > 100) return sendJson(res, 400, { error: 'label maksimal 100 karakter' });
          return tokens
            .createToken(label)
            .then((created) => {
              log('info', `[i] Token API dibuat: "${label}" (${created.token_prefix}...)`);
              sendJson(res, 201, created);
            })
            .catch((err) => sendServerError(res, 'Gagal membuat token', err));
        },
        () => sendJson(res, 400, { error: 'Body JSON tidak valid' })
      );
    return;
  }

  const tokenDeleteMatch = /^\/api\/tokens\/(\d+)$/.exec(pathname);
  if (tokenDeleteMatch && req.method === 'DELETE') {
    tokens
      .deleteToken(Number(tokenDeleteMatch[1]))
      .then((found) => {
        if (!found) return sendJson(res, 404, { error: 'Token tidak ditemukan' });
        log('info', `[i] Token API id=${tokenDeleteMatch[1]} dihapus`);
        res.writeHead(204).end();
      })
      .catch((err) => sendServerError(res, 'Gagal menghapus token', err));
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    fs.readFile(INDEX_HTML_PATH, (err, content) => {
      if (err) {
        res.writeHead(500).end('Gagal memuat dashboard');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      // TIMEZONE sudah divalidasi (nama IANA) saat start, aman disisipkan ke HTML/JS.
      res.end(content.toString('utf8').split('__TIMEZONE__').join(TIMEZONE));
    });
    return;
  }

  // Dipakai dashboard internal (browser). EventSource tidak bisa kirim header
  // custom, tapi Basic Auth dari browser tetap ikut otomatis untuk same-origin.
  if (pathname === '/api/devices') {
    sendJson(res, 200, getDevices());
    return;
  }

  if (pathname === '/api/events') {
    streamEvents(req, res);
    return;
  }

  res.writeHead(404).end('Not found');
}

function handlePositions(res, url) {
  const imei = url.searchParams.get('imei');
  if (!imei) return sendJson(res, 400, { error: 'Parameter imei wajib diisi' });
  if (!IMEI_RE.test(imei)) return sendJson(res, 400, { error: 'Parameter imei tidak valid' });

  const fromRaw = url.searchParams.get('from');
  const toRaw = url.searchParams.get('to');
  const from = fromRaw ? parseDateParam(fromRaw) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const to = toRaw ? parseDateParam(toRaw) : new Date();
  if (!from) return sendJson(res, 400, { error: 'Parameter from bukan tanggal yang valid' });
  if (!to) return sendJson(res, 400, { error: 'Parameter to bukan tanggal yang valid' });

  // Kompatibel dengan perilaku lama: limit kosong/0/bukan angka -> default.
  const limitNum = Number(url.searchParams.get('limit')) || DEFAULT_POSITIONS_LIMIT;
  if (limitNum < 1) return sendJson(res, 400, { error: 'Parameter limit harus bilangan positif' });
  const limit = Math.min(Math.floor(limitNum), MAX_POSITIONS_LIMIT);

  // String from/to asli tetap diteruskan ke PostgreSQL apa adanya (seperti sebelumnya)
  // supaya interpretasi zona waktu untuk input tanpa offset tidak berubah.
  db.getPositions({ imei, from: fromRaw || from.toISOString(), to: toRaw || to.toISOString(), limit })
    .then((rows) => sendJson(res, 200, rows))
    .catch((err) => {
      // 22007 invalid_datetime_format, 22008 datetime_field_overflow -- input klien, bukan error server
      if (err && (err.code === '22007' || err.code === '22008')) {
        return sendJson(res, 400, { error: 'Parameter from/to bukan tanggal yang valid' });
      }
      return sendServerError(res, 'Gagal ambil riwayat posisi', err);
    });
}

/** Ringkasan perjalanan, perhentian, jarak, dan jam tempuh satu device (dihitung dari tabel positions). */
function handleTrips(res, url) {
  const imei = url.searchParams.get('imei');
  if (!imei) return sendJson(res, 400, { error: 'Parameter imei wajib diisi' });
  if (!IMEI_RE.test(imei)) return sendJson(res, 400, { error: 'Parameter imei tidak valid' });

  const fromRaw = url.searchParams.get('from');
  const toRaw = url.searchParams.get('to');
  const from = fromRaw ? parseDateParam(fromRaw) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const to = toRaw ? parseDateParam(toRaw) : new Date();
  if (!from) return sendJson(res, 400, { error: 'Parameter from bukan tanggal yang valid' });
  if (!to) return sendJson(res, 400, { error: 'Parameter to bukan tanggal yang valid' });
  if (to < from) return sendJson(res, 400, { error: 'Parameter to harus setelah from' });
  if (to - from > MAX_TRIPS_RANGE_MS) return sendJson(res, 400, { error: 'Rentang waktu maksimal 31 hari' });

  const stopRaw = url.searchParams.get('stop_seconds');
  const stopSeconds = stopRaw === null ? TRIP_STOP_SECONDS : clampInt(stopRaw, 30, 3600, null);
  if (stopSeconds === null) return sendJson(res, 400, { error: 'Parameter stop_seconds harus bilangan bulat 30-3600' });

  db.getPositions({ imei, from: from.toISOString(), to: to.toISOString(), limit: MAX_TRIPS_POINTS })
    .then((rows) => {
      const options = { stopSeconds, minSpeedKmh: TRIP_MIN_SPEED_KMH };
      const result = trips.computeTrips(rows, options);
      sendJson(res, 200, {
        imei,
        from: from.toISOString(),
        to: to.toISOString(),
        params: options,
        ...result,
        status: trips.currentStatus(rows, result.trips, Date.now(), options),
        truncated: rows.length >= MAX_TRIPS_POINTS,
      });
    })
    .catch((err) => sendServerError(res, 'Gagal hitung ringkasan perjalanan', err));
}

// Tambahan field untuk konsumen eksternal (additive): registered (ada di daftar IMEI dan aktif)
// dan label (dari daftar IMEI, atau null), supaya aplikasi lain tidak perlu token admin untuk itu.
const withRegistry = (device) => ({ ...device, ...registry.describe(device.imei) });

function handleExternal(req, res, url, pathname) {
  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return;
  }
  tokens
    .verifyToken(getBearerToken(req))
    .then((verified) => {
      // Hanya token ber-scope "external"; token "admin" (untuk /api/admin/*) tidak berlaku di sini.
      if (!verified || verified.scope !== 'external') return sendJson(res, 401, { error: 'Token tidak valid atau hilang' });

      if (pathname === '/api/external/devices') return sendJson(res, 200, getDevices().map(withRegistry));
      if (pathname === '/api/external/events') return streamEvents(req, res, { includeLogs: false, decorate: withRegistry });
      if (pathname === '/api/external/trips') return handleTrips(res, url);
      // Riwayat posisi (histori) per device -- dipakai fitur playback rute.
      return handlePositions(res, url);
    })
    .catch((err) => sendServerError(res, 'Gagal verifikasi token', err));
}

function start() {
  const warning = auth.configWarning();
  if (warning) log('warn', warning);

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://internal');
    } catch (err) {
      res.writeHead(400).end('Bad request');
      return;
    }
    const pathname = url.pathname;

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');

    // --- API eksternal (mis. GPS-Dashboard) -- wajib Bearer token, dibuat/dihapus lewat tab "Akses API".
    if (
      pathname === '/api/external/devices' ||
      pathname === '/api/external/events' ||
      pathname === '/api/external/positions' ||
      pathname === '/api/external/trips'
    ) {
      handleExternal(req, res, url, pathname);
      return;
    }

    // --- API admin untuk aplikasi lain (GPS-Dashboard): Basic Auth admin atau token scope "admin".
    if (pathname.startsWith('/api/admin/')) {
      adminApi.handle(req, res, url, pathname).catch((err) => sendServerError(res, 'API admin', err));
      return;
    }

    // --- Dashboard internal, manajemen token & endpoint internal -- wajib Basic Auth admin.
    if (isAdminRoute(pathname)) {
      if (!auth.requireAdmin(req, res)) return;
      if (isCrossSiteWrite(req)) {
        sendJson(res, 403, { error: 'Origin permintaan tidak diizinkan' });
        return;
      }
      handleAdmin(req, res, pathname);
      return;
    }

    res.writeHead(404).end('Not found');
  });

  server.listen(WEB_PORT, WEB_HOST, () => {
    log('info', `Dashboard web listening on ${WEB_HOST}:${WEB_PORT}`);
  });

  return server;
}

module.exports = { start };
