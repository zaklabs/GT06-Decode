// Tes integrasi penyimpanan posisi/alarm: urutan waktu, anti-duplikat, validasi fix & jam.
// Hanya berjalan bila PGDATABASE berakhiran "_test" (tabel dikosongkan oleh tes).
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

// Jam perangkat = GMT+7 (lihat parser.js), jadi field jam diisi UTC + 7 jam.
function dateBytes(date) {
  const l = new Date(date.getTime() + 7 * 3600 * 1000);
  return Buffer.from([l.getUTCFullYear() - 2000, l.getUTCMonth() + 1, l.getUTCDate(), l.getUTCHours(), l.getUTCMinutes(), l.getUTCSeconds()]);
}

function gpsCore({ date, lat, lon, speed, fixed = true }) {
  const b = Buffer.alloc(18);
  dateBytes(date).copy(b, 0);
  b[6] = 0xc8;
  b.writeUInt32BE(Math.round(lat * 1800000), 7);
  b.writeUInt32BE(Math.round(lon * 1800000), 11);
  b[15] = speed;
  b.writeUInt16BE((fixed ? 0x1000 : 0) | 0x0400 | 90, 16); // utara, timur, course 90
  return b;
}
const lbs8 = Buffer.from('01fe0a2b8a000385', 'hex');

const login = (serial = 1) => frame(Buffer.concat([Buffer.from([0x01]), Buffer.from('0' + IMEI, 'hex'), Buffer.from([0, serial])]));
const gps = (o, serial = 2) => frame(Buffer.concat([Buffer.from([0x12]), gpsCore(o), lbs8, Buffer.from([0, serial])]));
const alarm = (o, terminalInfo = 0x58, serial = 3) => frame(Buffer.concat([
  Buffer.from([0x16]), gpsCore(o), Buffer.from([9]), lbs8, Buffer.from([terminalInfo, 2, 4, 0, 2]), Buffer.from([0, serial]),
]));

describe('penyimpanan posisi dan alarm', { skip }, () => {
  let child; let tcp; let socket; let db; let base_url; let basic; let extToken;
  const base = new Date(Math.floor((Date.now() - 3600 * 1000) / 1000) * 1000); // presisi detik seperti paket perangkat
  const at = (min) => new Date(base.getTime() + min * 60000);

  const send = (buf) => new Promise((r) => socket.write(buf, r));
  const q = async (sql, params) => (await db.query(sql, params)).rows;
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
    tcp = await freePort();
    const web = await freePort();
    base_url = `http://127.0.0.1:${web}`;
    const adminPassword = crypto.randomBytes(12).toString('hex');
    basic = 'Basic ' + Buffer.from(`admin:${adminPassword}`).toString('base64');
    child = spawn(process.execPath, ['src/server.js'], {
      env: { ...process.env, GT06_PORT: String(tcp), GT06_HOST: '127.0.0.1', WEB_PORT: String(web), WEB_HOST: '127.0.0.1', ADMIN_USER: 'admin', ADMIN_PASSWORD: adminPassword, BACKUP: 'off', GT06_IMEI_ENFORCE: 'off' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server tidak siap')), 20000);
      child.stdout.on('data', (d) => { if (String(d).includes('listening on 127.0.0.1')) { clearTimeout(t); resolve(); } });
      child.on('exit', (c) => reject(new Error(`server keluar (kode ${c})`)));
    });
    db = new Client();
    await db.connect();
    await db.query('TRUNCATE positions, alarms, devices CASCADE');
    await db.query('DELETE FROM api_tokens');
    const created = await fetch(`${base_url}/api/admin/tokens`, {
      method: 'POST', headers: { Authorization: basic, 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'tes trips' }),
    });
    extToken = (await created.json()).token;
    socket = net.connect(tcp, '127.0.0.1');
    socket.on('error', () => {});
    await send(login());
    await new Promise((r) => socket.once('data', r)); // ACK LOGIN
  });

  after(async () => {
    if (socket) socket.destroy();
    if (child) { child.removeAllListeners('exit'); child.kill('SIGTERM'); }
    if (db) { await db.query('TRUNCATE positions, alarms, devices CASCADE'); await db.query('DELETE FROM api_tokens'); await db.end(); }
  });

  it('titik lama yang dikirim belakangan tidak menimpa posisi terakhir, tapi tetap masuk jejak', async () => {
    await send(gps({ date: at(10), lat: 0.5, lon: 100.5, speed: 20 }));
    await waitFor(async () => (await q('SELECT 1 FROM positions')).length === 1);
    await send(gps({ date: at(0), lat: 0.1, lon: 100.1, speed: 5 })); // 10 menit lebih lama
    await waitFor(async () => (await q('SELECT 1 FROM positions')).length === 2);
    const [d] = await q('SELECT last_latitude, last_speed, last_position_at FROM devices WHERE imei = $1', [IMEI]);
    assert.ok(Math.abs(d.last_latitude - 0.5) < 1e-5, 'posisi terakhir harus tetap yang terbaru');
    assert.equal(d.last_speed, 20);
    assert.equal(d.last_position_at.getTime(), at(10).getTime());
  });

  it('kiriman ulang titik yang sama tidak membuat baris ganda', async () => {
    const p = gps({ date: at(20), lat: 0.6, lon: 100.6, speed: 30 });
    await send(p); await send(p); await send(p);
    await waitFor(async () => (await q('SELECT 1 FROM positions WHERE recorded_at = $1', [at(20)])).length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await q('SELECT 1 FROM positions WHERE recorded_at = $1', [at(20)])).length, 1);
  });

  it('titik tanpa fix GPS dan jam di masa depan tidak disimpan', async () => {
    const before = (await q('SELECT 1 FROM positions')).length;
    await send(gps({ date: at(30), lat: 0, lon: 0, speed: 0, fixed: false }));
    await send(gps({ date: new Date(Date.now() + 3600 * 1000), lat: 0.7, lon: 100.7, speed: 10 }));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await q('SELECT 1 FROM positions')).length, before);
  });

  it('alarm tersimpan di tabel alarms dengan jenisnya; titiknya tidak menggandakan paket 0x12 sedetik yang sama', async () => {
    const o = { date: at(20), lat: 0.6, lon: 100.6, speed: 30 }; // jam sama dengan titik 0x12 di atas
    await send(alarm(o));
    await send(alarm(o)); // kiriman ulang alarm
    await waitFor(async () => (await q('SELECT 1 FROM alarms')).length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    const alarms = await q('SELECT alarm_type, voltage_level FROM alarms');
    assert.equal(alarms.length, 1);
    assert.equal(alarms[0].alarm_type, 'low_battery');
    assert.equal(alarms[0].voltage_level, 2);
    assert.equal((await q('SELECT 1 FROM positions WHERE recorded_at = $1', [at(20)])).length, 1);
  });

  it('alarm tanpa fix GPS tetap tersimpan (tanpa koordinat)', async () => {
    await send(alarm({ date: at(40), lat: 0, lon: 0, speed: 0, fixed: false }, 0x50));
    const row = await waitFor(async () => (await q("SELECT * FROM alarms WHERE alarm_type = 'unknown_2' OR latitude IS NULL"))[0]);
    assert.equal(row.latitude, null);
  });

  describe('GET /api/external/trips', () => {
    const M = 111194.9;
    const trips = (qs, token = extToken) => fetch(`${base_url}/api/external/trips?${qs}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const win = () => `imei=${IMEI}&from=${encodeURIComponent(at(-130).toISOString())}&to=${encodeURIComponent(at(-60).toISOString())}`;

    it('mengirim dua perjalanan lewat TCP lalu API menghitung jarak, jam tempuh, dan perhentian', async () => {
      // Perjalanan 1: 60 dtk @36 km/jam lurus ke utara + titik penutup speed 0. Perjalanan 2: 20 menit kemudian.
      for (const startMin of [-120, -100]) {
        let lat = 0.2;
        const t0 = at(startMin).getTime();
        for (let i = 0; i <= 12; i++) {
          await send(gps({ date: new Date(t0 + i * 5000), lat, lon: 100.2, speed: i === 12 ? 0 : 36 }));
          lat += 50 / M;
        }
      }
      await waitFor(async () => (await q('SELECT 1 FROM positions WHERE recorded_at < $1', [at(-90)])).length === 26);
      const r = await trips(win());
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(j.summary.tripCount, 2);
      assert.equal(j.stops.length, 1);
      assert.ok(Math.abs(j.summary.distanceMeters - 1200) < 20, `jarak ${j.summary.distanceMeters}`); // 2 x 12 hop x 50 m
      assert.equal(j.summary.drivingSeconds, 120);
      assert.equal(j.summary.maxSpeedKmh, 36);
      assert.equal(j.status.state, 'stopped');
      assert.equal(j.truncated, false);
      assert.equal(j.stops[0].durationSeconds, 20 * 60 - 60);
    });

    it('menolak tanpa token, token palsu, dan token admin', async () => {
      assert.equal((await trips(win(), null)).status, 401);
      assert.equal((await trips(win(), 'gt06_palsu')).status, 401);
      const r = await fetch(`${base_url}/api/admin/tokens`, {
        method: 'POST', headers: { Authorization: basic, 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'adm', scope: 'admin' }),
      });
      assert.equal((await trips(win(), (await r.json()).token)).status, 401);
    });

    it('validasi parameter: imei, tanggal, rentang, stop_seconds; hanya GET', async () => {
      const f = encodeURIComponent(at(-130).toISOString());
      assert.equal((await trips('')).status, 400);
      assert.equal((await trips("imei=1';DROP TABLE positions;--")).status, 400);
      assert.equal((await trips(`imei=${IMEI}&from=bukan-tanggal`)).status, 400);
      assert.equal((await trips(`imei=${IMEI}&from=${f}&to=${encodeURIComponent(at(-200).toISOString())}`)).status, 400);
      assert.equal((await trips(`imei=${IMEI}&from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z`)).status, 400);
      assert.equal((await trips(`${win()}&stop_seconds=5`)).status, 400);
      assert.equal((await trips(`${win()}&stop_seconds=abc`)).status, 400);
      assert.equal((await trips(`${win()}&stop_seconds=600`)).status, 200);
      const r = await fetch(`${base_url}/api/external/trips?${win()}`, { method: 'POST', headers: { Authorization: `Bearer ${extToken}` } });
      assert.equal(r.status, 405);
    });

    it('stop_seconds besar menggabungkan dua perjalanan menjadi satu', async () => {
      const j = await (await trips(`${win()}&stop_seconds=3600`)).json();
      assert.equal(j.summary.tripCount, 1);
    });

    it('perangkat tanpa data mengembalikan ringkasan kosong, bukan error', async () => {
      const j = await (await trips(`imei=490154203237518&from=${encodeURIComponent(at(-130).toISOString())}&to=${encodeURIComponent(at(-60).toISOString())}`)).json();
      assert.equal(j.summary.tripCount, 0);
      assert.equal(j.status.state, 'unknown');
    });
  });
});
