'use strict';

/**
 * Muat ulang state device dari database ke memori server yang sedang jalan --
 * dipakai setelah restore data (mis. dari server produksi) supaya dashboard
 * & API eksternal (dipakai gps-dash) langsung menampilkan device yang ada di
 * database, tanpa perlu menunggu device live reconnect atau restart server.
 *
 * Jalankan dari dalam container (paling gampang, WEB_PORT internal sudah pas):
 *   docker compose exec gt06-server npm run reload-devices
 *
 * Atau dari luar Docker, arahkan ke port yang di-publish ke host:
 *   WEB_URL=http://localhost:8083/api/internal/reload-devices node scripts/reload-devices.js
 */

const http = require('http');
const https = require('https');

const target = new URL(process.env.WEB_URL || `http://localhost:${process.env.WEB_PORT || 8080}/api/internal/reload-devices`);
const client = target.protocol === 'https:' ? https : http;

const req = client.request(target, { method: 'POST' }, (res) => {
  let data = '';
  res.on('data', (chunk) => (data += chunk));
  res.on('end', () => {
    if (res.statusCode !== 200) {
      console.error(`Gagal reload (status ${res.statusCode}): ${data}`);
      process.exitCode = 1;
      return;
    }
    const body = JSON.parse(data);
    console.log(`Berhasil: ${body.reloaded} device dimuat ulang dari database ke memori.`);
  });
});

req.on('error', (err) => {
  console.error('Gagal menghubungi server:', err.message);
  process.exitCode = 1;
});

req.end();
