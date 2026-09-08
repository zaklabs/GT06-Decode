'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { bus, log, getHistory, clearHistory, getDevices, seedDevice } = require('./logger');
const tokens = require('./tokens');
const db = require('./db');

const WEB_PORT = process.env.WEB_PORT ? Number(process.env.WEB_PORT) : 8080;
const WEB_HOST = process.env.WEB_HOST || '0.0.0.0';

const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy(new Error('Body terlalu besar'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function getBearerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return match ? match[1].trim() : null;
}

/** Stream event `log`/`device`/`clear` sebagai SSE ke `res` (dipakai dashboard internal maupun API eksternal). */
function streamEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');

  // kirim histori log & device yang sudah ada supaya tab/consumer baru langsung terisi
  for (const entry of getHistory()) {
    res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
  }
  for (const device of getDevices()) {
    res.write(`event: device\ndata: ${JSON.stringify(device)}\n\n`);
  }

  const onLog = (entry) => res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
  const onDevice = (device) => res.write(`event: device\ndata: ${JSON.stringify(device)}\n\n`);
  const onClear = () => res.write('event: clear\ndata: {}\n\n');

  bus.on('log', onLog);
  bus.on('device', onDevice);
  bus.on('clear', onClear);

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    bus.off('log', onLog);
    bus.off('device', onDevice);
    bus.off('clear', onClear);
  });
}

function start() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://internal');
    const pathname = url.pathname;

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
        .catch((err) => sendJson(res, 500, { error: err.message }));
      return;
    }

    // --- Manajemen token, dipakai tab "Akses API" di dashboard.
    // Tidak butuh Bearer token sendiri -- level trust-nya sama dengan
    // dashboard secara keseluruhan (lihat catatan keamanan di README).
    if (pathname === '/api/tokens' && req.method === 'GET') {
      tokens
        .listTokens()
        .then((list) => sendJson(res, 200, list))
        .catch((err) => sendJson(res, 500, { error: err.message }));
      return;
    }

    if (pathname === '/api/tokens' && req.method === 'POST') {
      readJsonBody(req)
        .then((body) => {
          const label = String(body.label || '').trim();
          if (!label) return sendJson(res, 400, { error: 'label wajib diisi' });
          return tokens.createToken(label).then((created) => sendJson(res, 201, created));
        })
        .catch((err) => sendJson(res, 400, { error: err.message }));
      return;
    }

    const tokenDeleteMatch = /^\/api\/tokens\/(\d+)$/.exec(pathname);
    if (tokenDeleteMatch && req.method === 'DELETE') {
      tokens
        .deleteToken(Number(tokenDeleteMatch[1]))
        .then((found) => (found ? res.writeHead(204).end() : sendJson(res, 404, { error: 'Token tidak ditemukan' })))
        .catch((err) => sendJson(res, 500, { error: err.message }));
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
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      });
      return;
    }

    // --- Dipakai dashboard internal (browser, EventSource tanpa header) --
    // tetap tanpa token, dilindungi lewat jaringan/VPN sesuai README.
    if (pathname === '/api/devices') {
      sendJson(res, 200, getDevices());
      return;
    }

    if (pathname === '/api/events') {
      streamEvents(req, res);
      return;
    }

    // --- API eksternal (mis. gps-dash) -- wajib token, dibuat/dihapus lewat tab "Akses API".
    if (
      pathname === '/api/external/devices' ||
      pathname === '/api/external/events' ||
      pathname === '/api/external/positions'
    ) {
      const token = getBearerToken(req);
      tokens
        .verifyToken(token)
        .then((valid) => {
          if (!valid) return sendJson(res, 401, { error: 'Token tidak valid atau hilang' });

          if (pathname === '/api/external/devices') {
            sendJson(res, 200, getDevices());
            return;
          }
          if (pathname === '/api/external/events') {
            streamEvents(req, res);
            return;
          }

          // Riwayat posisi (histori) per device -- dipakai fitur playback rute.
          const imei = url.searchParams.get('imei');
          if (!imei) return sendJson(res, 400, { error: 'Parameter imei wajib diisi' });

          const from = url.searchParams.get('from') || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const to = url.searchParams.get('to') || new Date().toISOString();
          const limit = Math.min(Number(url.searchParams.get('limit')) || 5000, 20000);

          db.getPositions({ imei, from, to, limit })
            .then((rows) => sendJson(res, 200, rows))
            .catch((err) => sendJson(res, 500, { error: err.message }));
        })
        .catch((err) => sendJson(res, 500, { error: err.message }));
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
