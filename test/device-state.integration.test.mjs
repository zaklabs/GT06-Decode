// Tes integrasi pemuatan state device dari database saat start + zona waktu di dashboard web.
// Hanya berjalan bila PGDATABASE berakhiran "_test".
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const skip = process.env.PGPASSWORD && (process.env.PGDATABASE || '').endsWith('_test')
  ? false
  : 'set PG* dengan PGDATABASE berakhiran _test untuk menjalankan tes integrasi';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

describe('state device saat start', { skip }, () => {
  let child; let db; let base; let basic;
  const IMEI = '352099001761481';
  const GPS_AT = '2026-11-15T07:20:35.000Z';

  async function startServer(extraEnv = {}) {
    const tcp = await freePort();
    const web = await freePort();
    base = `http://127.0.0.1:${web}`;
    const pw = crypto.randomBytes(12).toString('hex');
    basic = 'Basic ' + Buffer.from(`admin:${pw}`).toString('base64');
    child = spawn(process.execPath, ['src/server.js'], {
      env: { ...process.env, GT06_PORT: String(tcp), GT06_HOST: '127.0.0.1', WEB_PORT: String(web), WEB_HOST: '127.0.0.1', ADMIN_USER: 'admin', ADMIN_PASSWORD: pw, BACKUP: 'off', GT06_IMEI_ENFORCE: 'off', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server tidak siap')), 20000);
      child.stdout.on('data', (d) => { if (String(d).includes('Dashboard web listening')) { clearTimeout(t); resolve(); } });
      child.on('exit', (c) => reject(new Error(`server keluar (kode ${c})`)));
    });
  }
  async function stopServer() {
    if (!child) return;
    child.removeAllListeners('exit');
    await new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); });
    child = null;
  }
  async function waitFor(fn, ms = 5000) {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error('kondisi tidak terpenuhi tepat waktu');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  before(async () => {
    await startServer(); // hanya untuk menjalankan migrasi
    await stopServer();
    db = new Client();
    await db.connect();
    await db.query('TRUNCATE positions, alarms, devices CASCADE');
    await db.query(
      `INSERT INTO devices (imei, last_latitude, last_longitude, last_speed, last_course, last_position_at, last_seen_at, is_online)
       VALUES ($1, 5.55, 95.32, 12, 90, $2, $2, true), ('352099001761499', NULL, NULL, NULL, NULL, NULL, $2, true)`,
      [IMEI, GPS_AT]
    );
    await startServer({ TIMEZONE: 'Asia/Makassar' });
  });

  after(async () => {
    await stopServer();
    if (db) { await db.query('TRUNCATE positions, alarms, devices CASCADE'); await db.end(); }
  });

  it('posisi terakhir dari database langsung tersedia, status connected=false', async () => {
    const list = await waitFor(async () => {
      const r = await fetch(`${base}/api/devices`, { headers: { Authorization: basic } });
      const j = await r.json();
      return j.length >= 2 ? j : null;
    });
    const d = list.find((x) => x.imei === IMEI);
    assert.equal(d.latitude, 5.55);
    assert.equal(d.longitude, 95.32);
    assert.equal(d.speed, 12);
    assert.equal(d.gpsTimestamp, GPS_AT);
    assert.equal(d.connected, false);
    assert.equal('is_online' in d, false);
    const kosong = list.find((x) => x.imei === '352099001761499');
    assert.equal('latitude' in kosong, false); // belum pernah punya posisi: tidak dikarang
  });

  it('flag is_online basi di database direset saat start', async () => {
    const { rows } = await db.query('SELECT count(*)::int AS n FROM devices WHERE is_online');
    assert.equal(rows[0].n, 0);
  });

  it('dashboard web memakai TIMEZONE dari env', async () => {
    const r = await fetch(`${base}/`, { headers: { Authorization: basic } });
    const html = await r.text();
    assert.match(html, /var TZ = 'Asia\/Makassar'/);
    assert.equal(html.includes('__TIMEZONE__'), false);
    assert.match(html, /Terakhir \(Asia\/Makassar\)/);
  });
});
