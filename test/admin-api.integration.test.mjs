// Tes integrasi API admin + penegakan daftar IMEI.
// Menjalankan src/server.js sungguhan terhadap PostgreSQL. KARENA tabel dikosongkan, tes ini
// hanya berjalan bila PGDATABASE berakhiran "_test" (pengaman agar tidak menyentuh data asli).
//   contoh: PGHOST=... PGUSER=gt06 PGPASSWORD=... PGDATABASE=gt06_test npm test
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { crc16X25 } = require('../src/crc.js');
const { Client } = require('pg');

const dbName = process.env.PGDATABASE || '';
const skip = process.env.PGPASSWORD && dbName.endsWith('_test')
  ? false
  : 'set PG* dengan PGDATABASE berakhiran _test untuk menjalankan tes integrasi';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Paket LOGIN GT06 valid (CRC benar) untuk IMEI 15 digit. */
function loginPacket(imei, serial = 1) {
  const info = Buffer.from('0' + imei, 'hex'); // 8 byte BCD
  const body = Buffer.concat([Buffer.from([0x01]), info, Buffer.from([serial >> 8, serial & 255])]);
  const len = body.length + 2;
  const crc = crc16X25(Buffer.concat([Buffer.from([len]), body]));
  return Buffer.concat([Buffer.from([0x78, 0x78, len]), body, Buffer.from([crc >> 8, crc & 255, 0x0d, 0x0a])]);
}

/** Konek + LOGIN. ack = Buffer bila server membalas, null bila koneksi ditutup tanpa balasan. */
function tcpLogin(port, imei) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(loginPacket(imei)));
    let ack = null;
    const closed = new Promise((res) => socket.once('close', res));
    socket.on('error', () => {});
    socket.once('data', (d) => { ack = d; resolve({ ack, socket, closed }); });
    socket.once('close', () => { if (!ack) resolve({ ack: null, socket, closed }); });
    setTimeout(() => resolve({ ack, socket, closed }), 3000).unref();
  });
}

describe('API admin + daftar IMEI', { skip }, () => {
  const adminPassword = crypto.randomBytes(12).toString('hex');
  const basic = 'Basic ' + Buffer.from(`admin:${adminPassword}`).toString('base64');
  let child; let web; let tcp; let base; let adminToken; let extToken; let adminTokenId; let extTokenId;
  const IMEI = '352099001761481';
  const IMEI_OTHER = '490154203237518';

  const call = (path, { method = 'GET', auth, body, headers = {} } = {}) => fetch(base + path, {
    method,
    headers: { ...(auth ? { Authorization: auth } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const asAdminToken = (path, opts = {}) => call(path, { ...opts, auth: `Bearer ${adminToken}` });

  before(async () => {
    [web, tcp] = [await freePort(), await freePort()];
    base = `http://127.0.0.1:${web}`;
    child = spawn(process.execPath, ['src/server.js'], {
      env: {
        ...process.env, GT06_PORT: String(tcp), GT06_HOST: '127.0.0.1', WEB_PORT: String(web), WEB_HOST: '127.0.0.1',
        ADMIN_USER: 'admin', ADMIN_PASSWORD: adminPassword, BACKUP: 'off', GT06_IMEI_ENFORCE: 'on',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server tidak siap dalam 20 detik')), 20000);
      child.stdout.on('data', (d) => { if (String(d).includes('Dashboard web listening')) { clearTimeout(t); resolve(); } });
      child.on('exit', (code) => reject(new Error(`server keluar lebih awal (kode ${code})`)));
    });
    // bersihkan sisa data tes sebelumnya (tabel sudah dibuat oleh migrasi saat start)
    const db = new Client();
    await db.connect();
    await db.query('TRUNCATE registered_devices, positions, devices CASCADE');
    await db.query('DELETE FROM api_tokens');
    await db.end();
  });

  after(async () => {
    if (child) { child.removeAllListeners('exit'); child.kill('SIGTERM'); }
    const db = new Client();
    await db.connect();
    await db.query('TRUNCATE registered_devices, positions, devices CASCADE');
    await db.query('DELETE FROM api_tokens');
    await db.end();
  });

  it('menolak tanpa kredensial (401 + tantangan Basic), Basic salah, dan Bearer palsu', async () => {
    let r = await call('/api/admin/info');
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate') || '', /^Basic/);
    r = await call('/api/admin/info', { auth: 'Basic ' + Buffer.from('admin:salah').toString('base64') });
    assert.equal(r.status, 401);
    r = await call('/api/admin/info', { auth: 'Bearer gt06_palsu' });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('www-authenticate'), null);
  });

  it('menolak tulis lintas-situs dengan Basic (CSRF) tetapi menerima Origin yang sama', async () => {
    let r = await call('/api/admin/tokens', { method: 'POST', auth: basic, body: { label: 'x' }, headers: { Origin: 'http://evil.example' } });
    assert.equal(r.status, 403);
    r = await call('/api/admin/tokens', { method: 'POST', auth: basic, body: { label: 'samaorigin' }, headers: { Origin: base } });
    assert.equal(r.status, 201);
    const created = await r.json();
    assert.equal((await call(`/api/admin/tokens/${created.id}`, { method: 'DELETE', auth: basic })).status, 204);
  });

  it('Basic membuat token admin dan token eksternal; token mentah hanya muncul saat dibuat', async () => {
    let r = await call('/api/admin/tokens', { method: 'POST', auth: basic, body: { label: 'gps-dashboard admin', scope: 'admin' } });
    assert.equal(r.status, 201);
    let t = await r.json();
    assert.match(t.token, /^gt06_[0-9a-f]{48}$/);
    assert.equal(t.scope, 'admin');
    [adminToken, adminTokenId] = [t.token, t.id];

    r = await call('/api/admin/tokens', { method: 'POST', auth: basic, body: { label: 'gps-dashboard ext' } });
    t = await r.json();
    assert.equal(t.scope, 'external');
    [extToken, extTokenId] = [t.token, t.id];

    const list = await (await call('/api/admin/tokens', { auth: basic })).json();
    assert.ok(list.length >= 2);
    assert.ok(list.every((x) => x.token === undefined && /^gt06_/.test(x.tokenPrefix)), 'daftar tidak boleh memuat token mentah');
  });

  it('validasi pembuatan token: label wajib, scope harus dikenal, body harus objek', async () => {
    assert.equal((await call('/api/admin/tokens', { method: 'POST', auth: basic, body: { label: '  ' } })).status, 400);
    assert.equal((await call('/api/admin/tokens', { method: 'POST', auth: basic, body: { label: 'a', scope: 'root' } })).status, 400);
    assert.equal((await call('/api/admin/tokens', { method: 'POST', auth: basic, body: { label: 'x'.repeat(101) } })).status, 400);
    const r = await fetch(`${base}/api/admin/tokens`, { method: 'POST', headers: { Authorization: basic, 'Content-Type': 'application/json' }, body: '[1]' });
    assert.equal(r.status, 400);
  });

  it('token admin: boleh baca info & kelola token eksternal, TIDAK boleh membuat/menghapus token admin', async () => {
    const info = await (await asAdminToken('/api/admin/info')).json();
    assert.equal(info.imeiEnforce, 'on');

    assert.equal((await asAdminToken('/api/admin/tokens', { method: 'POST', body: { label: 'eskalasi', scope: 'admin' } })).status, 403);
    const r = await asAdminToken('/api/admin/tokens', { method: 'POST', body: { label: 'ext dari admin token' } });
    assert.equal(r.status, 201);
    const created = await r.json();
    assert.equal((await asAdminToken(`/api/admin/tokens/${created.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await asAdminToken(`/api/admin/tokens/${adminTokenId}`, { method: 'DELETE' })).status, 403);
    assert.equal((await asAdminToken('/api/admin/tokens/999999', { method: 'DELETE' })).status, 404);
    assert.equal((await asAdminToken('/api/admin/tokens/99999999999999999999', { method: 'DELETE' })).status, 404);
  });

  it('scope dipisah: token eksternal tidak bisa ke /api/admin, token admin tidak bisa ke /api/external', async () => {
    assert.equal((await call('/api/admin/info', { auth: `Bearer ${extToken}` })).status, 401);
    assert.equal((await call('/api/external/devices', { auth: `Bearer ${adminToken}` })).status, 401);
    assert.equal((await call('/api/external/devices', { auth: `Bearer ${extToken}` })).status, 200);
  });

  it('endpoint tak dikenal -> 404 JSON, metode salah -> 405', async () => {
    assert.equal((await asAdminToken('/api/admin/tidak-ada')).status, 404);
    assert.equal((await asAdminToken('/api/admin/info', { method: 'DELETE' })).status, 405);
  });

  it('registry: validasi input (termasuk upaya SQL injection) -> 400', async () => {
    const bad = ['', 'abc def', "1'; DROP TABLE registered_devices;--", '1'.repeat(21), null, 123];
    for (const imei of bad) {
      const r = await asAdminToken('/api/admin/registry', { method: 'POST', body: { imei, label: 'x' } });
      assert.equal(r.status, 400, `imei ${JSON.stringify(imei)}`);
    }
    assert.equal((await asAdminToken('/api/admin/registry', { method: 'POST', body: { imei: IMEI, label: '' } })).status, 400);
    assert.equal((await asAdminToken('/api/admin/registry/%E0%A4%A', { method: 'DELETE' })).status, 400); // % rusak
    // tabel masih utuh
    assert.equal((await asAdminToken('/api/admin/registry')).status, 200);
  });

  it('registry: tambah, duplikat 409, ubah, tidak ditemukan 404', async () => {
    let r = await asAdminToken('/api/admin/registry', { method: 'POST', body: { imei: IMEI, label: ' Truk 01 ' } });
    assert.equal(r.status, 201);
    const row = await r.json();
    assert.deepEqual([row.imei, row.label, row.enabled], [IMEI, 'Truk 01', true]);

    assert.equal((await asAdminToken('/api/admin/registry', { method: 'POST', body: { imei: IMEI, label: 'lagi' } })).status, 409);

    r = await asAdminToken(`/api/admin/registry/${IMEI}`, { method: 'PATCH', body: { label: 'Truk 01 (baru)' } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).label, 'Truk 01 (baru)');

    assert.equal((await asAdminToken(`/api/admin/registry/${IMEI}`, { method: 'PATCH', body: { enabled: 'ya' } })).status, 400);
    assert.equal((await asAdminToken(`/api/admin/registry/${IMEI}`, { method: 'PATCH', body: {} })).status, 400);
    assert.equal((await asAdminToken(`/api/admin/registry/${IMEI_OTHER}`, { method: 'PATCH', body: { label: 'x' } })).status, 404);

    const list = await (await asAdminToken('/api/admin/registry')).json();
    assert.deepEqual(list.map((x) => x.imei), [IMEI]);
  });

  it('mode on: perangkat terdaftar diterima (ACK), yang tidak terdaftar ditolak tanpa balasan', async () => {
    const ok = await tcpLogin(tcp, IMEI);
    assert.ok(ok.ack, 'perangkat terdaftar harus mendapat ACK');
    assert.deepEqual([...ok.ack.subarray(0, 4)], [0x78, 0x78, 0x05, 0x01]);
    ok.socket.destroy();

    const rejected = await tcpLogin(tcp, IMEI_OTHER);
    assert.equal(rejected.ack, null, 'perangkat tidak terdaftar tidak boleh mendapat ACK');
    rejected.socket.destroy();
  });

  it('mode on: menonaktifkan perangkat yang sedang terhubung langsung memutus koneksinya', async () => {
    const live = await tcpLogin(tcp, IMEI);
    assert.ok(live.ack);
    const devices = await (await asAdminToken('/api/admin/devices')).json();
    assert.equal(devices.find((d) => d.imei === IMEI).registration, 'registered');

    const closedInTime = Promise.race([live.closed.then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
    assert.equal((await asAdminToken(`/api/admin/registry/${IMEI}`, { method: 'PATCH', body: { enabled: false } })).status, 200);
    assert.equal(await closedInTime, true, 'koneksi harus diputus setelah dinonaktifkan');

    const again = await tcpLogin(tcp, IMEI);
    assert.equal(again.ack, null, 'perangkat nonaktif tidak boleh login');
    again.socket.destroy();
  });

  it('import-seen mendaftarkan perangkat yang pernah terlihat; hapus -> 204 lalu 404', async () => {
    let r = await asAdminToken('/api/admin/registry/import-seen', { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(typeof (await r.json()).imported, 'number');
    assert.equal((await asAdminToken(`/api/admin/registry/${IMEI}`, { method: 'DELETE' })).status, 204);
    assert.equal((await asAdminToken(`/api/admin/registry/${IMEI}`, { method: 'DELETE' })).status, 404);
  });

  it('token yang dihapus langsung tidak berlaku', async () => {
    assert.equal((await call(`/api/admin/tokens/${extTokenId}`, { method: 'DELETE', auth: basic })).status, 204);
    assert.equal((await call('/api/external/devices', { auth: `Bearer ${extToken}` })).status, 401);
    assert.equal((await call(`/api/admin/tokens/${adminTokenId}`, { method: 'DELETE', auth: basic })).status, 204);
    assert.equal((await asAdminToken('/api/admin/info')).status, 401);
  });
});
