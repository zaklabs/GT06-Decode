// Tes integrasi: login ulang IMEI yang sama memutus socket lama, dan status offline tidak
// berkedip. Hanya berjalan bila PGDATABASE berakhiran "_test".
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { crc16X25 } = require('../src/crc.js');
const { Client } = require('pg');

const skip = process.env.PGPASSWORD && (process.env.PGDATABASE || '').endsWith('_test')
  ? false
  : 'set PG* dengan PGDATABASE berakhiran _test untuk menjalankan tes integrasi';

const IMEI = '352099001761481';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}
function frame(body) {
  const len = Buffer.from([body.length + 2]);
  const crc = Buffer.alloc(2);
  crc.writeUInt16BE(crc16X25(Buffer.concat([len, body])));
  return Buffer.concat([Buffer.from([0x78, 0x78]), len, body, crc, Buffer.from([0x0d, 0x0a])]);
}
const login = (serial = 1) => frame(Buffer.concat([Buffer.from([0x01]), Buffer.from('0' + IMEI, 'hex'), Buffer.from([0, serial])]));

describe('login ulang dan status offline', { skip }, () => {
  let child; let tcp; let base; let basic; let db;

  const connect = async () => {
    const s = net.connect(tcp, '127.0.0.1');
    s.on('error', () => {});
    s.whenClosed = new Promise((r) => s.once('close', r));
    await new Promise((r) => s.once('connect', r));
    s.write(login());
    await new Promise((r) => s.once('data', r)); // ACK LOGIN
    return s;
  };
  const state = async () => {
    const r = await fetch(`${base}/api/devices`, { headers: { Authorization: basic } });
    return (await r.json()).find((d) => d.imei === IMEI);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const closedWithin = (sock, ms = 3000) => Promise.race([sock.whenClosed, sleep(ms).then(() => { throw new Error('socket lama tidak diputus'); })]);
  async function waitFor(fn, ms = 5000) {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error('kondisi tidak terpenuhi tepat waktu');
      await sleep(50);
    }
  }
  const dbOnline = async () => (await db.query('SELECT is_online FROM devices WHERE imei = $1', [IMEI])).rows[0]?.is_online;

  before(async () => {
    tcp = await freePort();
    const web = await freePort();
    base = `http://127.0.0.1:${web}`;
    const pw = crypto.randomBytes(12).toString('hex');
    basic = 'Basic ' + Buffer.from(`admin:${pw}`).toString('base64');
    child = spawn(process.execPath, ['src/server.js'], {
      env: { ...process.env, GT06_PORT: String(tcp), GT06_HOST: '127.0.0.1', WEB_PORT: String(web), WEB_HOST: '127.0.0.1', ADMIN_USER: 'admin', ADMIN_PASSWORD: pw, BACKUP: 'off', GT06_IMEI_ENFORCE: 'off' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server tidak siap')), 20000);
      child.stdout.on('data', (d) => { if (String(d).includes('listening on 127.0.0.1')) { clearTimeout(t); resolve(); } });
      child.on('exit', (c) => reject(new Error(`server keluar (kode ${c})`)));
    });
    db = new Client();
    await db.connect();
  });

  after(async () => {
    if (child) { child.removeAllListeners('exit'); child.kill('SIGTERM'); }
    if (db) { await db.query('TRUNCATE positions, alarms, devices CASCADE'); await db.end(); }
  });

  it('login ulang memutus socket lama, perangkat tetap online (tidak berkedip)', async () => {
    const a = await connect();
    assert.equal((await waitFor(state)).connected, true);
    const b = await connect();
    await closedWithin(a);
    await sleep(300); // beri waktu handler close socket lama menandai (salah) offline
    assert.equal((await state()).connected, true);
    assert.equal(await dbOnline(), true);
    assert.equal(b.destroyed, false);

    // Socket terakhir ditutup -> baru boleh offline.
    b.destroy();
    await waitFor(async () => (await state()).connected === false);
    await waitFor(async () => (await dbOnline()) === false);
  });

  it('menutup socket lama yang sudah tidak terpakai tidak menandai offline selama socket lain hidup', async () => {
    const a = await connect();
    const b = await connect();
    await closedWithin(a);
    // Socket kedua login lagi (mis. perangkat kembali): socket lama dari b tetap tidak boleh membuat offline.
    const c = await connect();
    await closedWithin(b);
    await sleep(300);
    assert.equal((await state()).connected, true);
    c.destroy();
    await waitFor(async () => (await state()).connected === false);
  });
});
