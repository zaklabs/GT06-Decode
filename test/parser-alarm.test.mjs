import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
process.env.TIMEZONE = 'Asia/Jakarta'; // frame uji berisi jam GMT+7; jangan ikut env pengembang
const { decodeFrame } = require('../src/parser');
const { crc16X25 } = require('../src/crc');

// Frame sintetis dengan layout yang sama dengan paket 0x16 perangkat asli (koordinat diganti).
function buildAlarm({ lat = 0.5, lon = 100.25, terminalInfo = 0x58, voltage = 2 } = {}) {
  const body = Buffer.alloc(1 + 18 + 9 + 5 + 2);
  let o = 0;
  body[o++] = 0x16;
  Buffer.from([26, 11, 15, 14, 20, 35]).copy(body, o); o += 6; // 14:20:35 jam lokal GMT+7
  body[o++] = 0xc8;
  body.writeUInt32BE(Math.round(lat * 1800000), o); o += 4;
  body.writeUInt32BE(Math.round(lon * 1800000), o); o += 4;
  body[o++] = 27;
  body.writeUInt16BE(0x14b2, o); o += 2; // fix, utara, timur, course 178
  body[o++] = 9;
  body.writeUInt16BE(510, o); o += 2;
  body[o++] = 10;
  body.writeUInt16BE(11146, o); o += 2;
  body.writeUIntBE(901, o, 3); o += 3;
  body[o++] = terminalInfo; body[o++] = voltage; body[o++] = 4;
  body.writeUInt16BE(2, o); o += 2;
  body.writeUInt16BE(0xef, o); // serial
  const len = Buffer.from([body.length + 2]);
  const crc = Buffer.alloc(2);
  crc.writeUInt16BE(crc16X25(Buffer.concat([len, body])));
  return Buffer.concat([Buffer.from([0x78, 0x78]), len, body, crc, Buffer.from([0x0d, 0x0a])]);
}

test('alarm 0x16: GPS, LBS, status, dan jenis alarm terbaca benar', () => {
  const p = decodeFrame(buildAlarm());
  assert.equal(p.crcValid, true);
  assert.equal(p.serialNumber, 0xef);
  const d = p.data;
  assert.equal(d.timestamp.toISOString(), '2026-11-15T07:20:35.000Z');
  assert.equal(d.latitude, 0.5);
  assert.equal(d.longitude, 100.25);
  assert.equal(d.speed, 27);
  assert.equal(d.course, 178);
  assert.deepEqual(d.lbs, { mcc: 510, mnc: 10, lac: 11146, cellId: 901 });
  assert.equal(d.voltageLevel, 2);
  assert.equal(d.gsmSignalStrength, 4);
  assert.equal(d.alarmType, 'low_battery');
});

test('alarm 0x16: bentuk LBS tak dikenal tidak ditebak dan tidak crash', () => {
  const f = buildAlarm();
  f[3 + 1 + 18] = 7; // LBS length bukan 9 (byte ke-19 setelah protocol)
  const p = decodeFrame(f);
  assert.ok(p.data.rawTail);
  assert.equal(p.data.lbs, undefined);
});

test('alarm 0x16 terpotong melempar error yang bisa ditangkap server', () => {
  const f = Buffer.from('78780a16010203040506ef0000a0000d0a', 'hex');
  assert.throws(() => decodeFrame(f), RangeError);
});
