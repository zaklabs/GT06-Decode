'use strict';

const { bus, log, getHistory, getDevices } = require('./logger');

const IMEI_RE = /^[0-9a-f]{1,20}$/i; // sesuai kolom VARCHAR(20); IMEI GT06 di-decode dari BCD/hex

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** Catat detail error di log server, kirim pesan generik ke klien (jangan bocorkan err.message DB). */
function sendServerError(res, context, err) {
  log('error', `[WEB] ${context}: ${err && err.message}`);
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, 500, { error: 'Terjadi kesalahan internal server' });
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

/**
 * true kalau request mengubah data (bukan GET/HEAD/OPTIONS) dan header Origin-nya
 * menunjuk ke host lain. Browser selalu mengirim Origin pada POST lintas-situs, jadi
 * ini menutup CSRF terhadap kredensial Basic Auth yang dikirim otomatis oleh browser.
 * Klien non-browser (curl, server lain) tidak mengirim Origin dan tidak terpengaruh.
 */
function isCrossSiteWrite(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return false;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch (err) {
    return true;
  }
}

/**
 * Stream event SSE ke `res`. Dashboard internal menerima `log`/`device`/`clear`;
 * API eksternal (`includeLogs: false`) hanya menerima `device` -- log operasional
 * (IP device, error DB, dsb.) tidak dibagikan ke aplikasi lain.
 */
function streamEvents(req, res, { includeLogs = true, decorate = (d) => d } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');

  // kirim histori log & device yang sudah ada supaya tab/consumer baru langsung terisi
  if (includeLogs) {
    for (const entry of getHistory()) {
      res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
    }
  }
  for (const device of getDevices()) {
    res.write(`event: device\ndata: ${JSON.stringify(decorate(device))}\n\n`);
  }

  const onLog = (entry) => res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
  const onDevice = (device) => res.write(`event: device\ndata: ${JSON.stringify(decorate(device))}\n\n`);
  const onClear = () => res.write('event: clear\ndata: {}\n\n');

  if (includeLogs) {
    bus.on('log', onLog);
    bus.on('clear', onClear);
  }
  bus.on('device', onDevice);

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    bus.off('log', onLog);
    bus.off('device', onDevice);
    bus.off('clear', onClear);
  });
}

module.exports = { IMEI_RE, sendJson, sendServerError, readJsonBody, getBearerToken, isCrossSiteWrite, streamEvents };
