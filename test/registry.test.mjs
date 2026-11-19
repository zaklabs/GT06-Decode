import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const registry = require('../src/registry.js');

test('parseImei: menerima angka/heksadesimal, memangkas spasi, menurunkan huruf', () => {
  assert.deepEqual(registry.parseImei(' 352099001761481 '), { value: '352099001761481' });
  assert.deepEqual(registry.parseImei('ABCDEF0123'), { value: 'abcdef0123' });
});

test('parseImei: menolak kosong, bukan string, terlalu panjang, dan karakter berbahaya', () => {
  for (const bad of ['', '   ', null, undefined, 123, {}, ['1'], '1'.repeat(21), "1'; DROP TABLE devices;--", '12 34', '../etc', 'zzz']) {
    assert.ok(registry.parseImei(bad).error, `seharusnya ditolak: ${JSON.stringify(bad)}`);
  }
});

test('parseLabel: wajib, dipangkas, maksimal 100 karakter', () => {
  assert.deepEqual(registry.parseLabel('  Truk 01 '), { value: 'Truk 01' });
  assert.ok(registry.parseLabel('').error);
  assert.ok(registry.parseLabel('   ').error);
  assert.ok(registry.parseLabel(5).error);
  assert.ok(registry.parseLabel('x'.repeat(101)).error);
  assert.deepEqual(registry.parseLabel('x'.repeat(100)), { value: 'x'.repeat(100) });
});

test('evaluateLogin: IMEI tidak valid selalu ditolak apa pun modenya', () => {
  for (const bad of ['', null, undefined, 'xyz', 'a'.repeat(21)]) {
    const verdict = registry.evaluateLogin(bad);
    assert.equal(verdict.allow, false);
    assert.equal(verdict.status, 'invalid');
  }
});

test('evaluateLogin: sebelum cache termuat statusnya "unknown" (mode on menolak, log/off menerima)', () => {
  const verdict = registry.evaluateLogin('352099001761481');
  assert.equal(verdict.status, 'unknown');
  assert.equal(verdict.allow, registry.MODE !== 'on');
});

test('describe: sebelum cache termuat registered=false dan label=null', () => {
  assert.deepEqual(registry.describe('352099001761481'), { registered: false, label: null });
});
