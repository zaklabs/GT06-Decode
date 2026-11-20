import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { resolveTimeZone, zonedToUtc, wallClock, DEFAULT_TIMEZONE } = require('../src/timezone');

test('zonedToUtc: Asia/Jakarta = UTC+7, UTC = apa adanya, Asia/Makassar = UTC+8', () => {
  assert.equal(zonedToUtc(2026, 11, 15, 14, 20, 35, 'Asia/Jakarta').toISOString(), '2026-11-15T07:20:35.000Z');
  assert.equal(zonedToUtc(2026, 11, 15, 14, 20, 35, 'UTC').toISOString(), '2026-11-15T14:20:35.000Z');
  assert.equal(zonedToUtc(2026, 11, 15, 14, 20, 35, 'Asia/Makassar').toISOString(), '2026-11-15T06:20:35.000Z');
});

test('zonedToUtc: rollover tanggal saat jam lokal < offset', () => {
  assert.equal(zonedToUtc(2026, 1, 1, 3, 0, 0, 'Asia/Jakarta').toISOString(), '2025-12-31T20:00:00.000Z');
});

test('zonedToUtc: zona ber-DST memakai offset yang benar (musim panas vs dingin)', () => {
  assert.equal(zonedToUtc(2026, 7, 1, 12, 0, 0, 'America/New_York').toISOString(), '2026-07-01T16:00:00.000Z'); // UTC-4
  assert.equal(zonedToUtc(2026, 1, 1, 12, 0, 0, 'America/New_York').toISOString(), '2026-01-01T17:00:00.000Z'); // UTC-5
});

test('wallClock adalah kebalikan zonedToUtc', () => {
  const d = new Date('2026-11-15T07:20:35Z');
  assert.deepEqual(wallClock(d, 'Asia/Jakarta'), [2026, 11, 15, 14, 20, 35]);
  assert.equal(zonedToUtc(...wallClock(d, 'Asia/Jakarta'), 'Asia/Jakarta').getTime(), d.getTime());
});

test('resolveTimeZone: kosong -> default Asia/Jakarta, salah ditolak', () => {
  assert.equal(DEFAULT_TIMEZONE, 'Asia/Jakarta');
  assert.equal(resolveTimeZone(undefined), 'Asia/Jakarta');
  assert.equal(resolveTimeZone('  '), 'Asia/Jakarta');
  assert.equal(resolveTimeZone('UTC'), 'UTC');
  assert.throws(() => resolveTimeZone('Mars/Olympus'), /TIMEZONE/);
});

test('server menolak start dengan TIMEZONE salah, dan parser mengikuti TIMEZONE', () => {
  const run = (tz, code) => execFileSync(process.execPath, ['-e', code], {
    env: { PATH: process.env.PATH, ...(tz ? { TIMEZONE: tz } : {}) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const probe = `
    const { decodeFrame } = require('./src/parser');
    const { crc16X25 } = require('./src/crc');
    const body = Buffer.alloc(1 + 18 + 2); body[0] = 0x12;
    Buffer.from([26, 11, 15, 14, 20, 35]).copy(body, 1); body[7] = 0xc8; body.writeUInt16BE(0x1400, 18);
    const len = Buffer.from([body.length + 2]); const crc = Buffer.alloc(2);
    crc.writeUInt16BE(crc16X25(Buffer.concat([len, body])));
    const f = Buffer.concat([Buffer.from([0x78, 0x78]), len, body, crc, Buffer.from([13, 10])]);
    console.log(decodeFrame(f).data.timestamp.toISOString());`;
  assert.equal(run(undefined, probe), '2026-11-15T07:20:35.000Z'); // default Asia/Jakarta
  assert.equal(run('UTC', probe), '2026-11-15T14:20:35.000Z');
  assert.equal(run('Asia/Makassar', probe), '2026-11-15T06:20:35.000Z');
  assert.throws(() => run('Mars/Olympus', probe), /TIMEZONE/);
});
