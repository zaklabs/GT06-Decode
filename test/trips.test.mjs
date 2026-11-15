import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { computeTrips, currentStatus, haversineMeters } = require('../src/trips');

const T0 = Date.UTC(2026, 10, 15, 7, 0, 0);
const M_PER_DEG_LAT = 111194.9; // R = 6371 km

// Bergerak lurus ke utara, 10 m/s (36 km/jam), titik tiap 5 detik, ditutup satu titik speed 0
// seperti perangkat asli. Mengembalikan titik-titik + waktu berikutnya.
function drive(startMs, seconds, { lat0 = 0.5, speed = 36 } = {}) {
  const rows = [];
  let lat = lat0;
  let t = startMs;
  for (let s = 0; s <= seconds; s += 5) {
    rows.push({ recordedAt: new Date(t), latitude: lat, longitude: 100, speed });
    lat += (10 * 5) / M_PER_DEG_LAT;
    t += 5000;
  }
  rows.push({ recordedAt: new Date(t), latitude: lat, longitude: 100, speed: 0 });
  return rows;
}

test('haversine: 1 derajat lintang ~ 111,2 km', () => {
  assert.ok(Math.abs(haversineMeters(0, 100, 1, 100) - 111195) < 50);
});

test('satu perjalanan: jarak, durasi, kecepatan', () => {
  const { trips, stops, summary } = computeTrips(drive(T0, 300));
  assert.equal(trips.length, 1);
  assert.equal(stops.length, 0);
  assert.ok(Math.abs(trips[0].distanceMeters - 3050) < 30, `jarak ${trips[0].distanceMeters}`); // 61 hop x 50 m
  assert.equal(trips[0].durationSeconds, 305);
  assert.equal(trips[0].maxSpeedKmh, 36);
  assert.equal(summary.drivingSeconds, 305);
  assert.equal(summary.tripCount, 1);
});

test('dua perjalanan dipisah diam 10 menit menjadi dua trip dan satu perhentian', () => {
  const a = drive(T0, 120);
  const b = drive(T0 + 20 * 60000, 120, { lat0: 0.6 });
  const { trips, stops, summary } = computeTrips([...b, ...a]); // urutan input diacak
  assert.equal(trips.length, 2);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].start, trips[0].end);
  assert.equal(stops[0].end, trips[1].start);
  assert.equal(summary.stoppedSeconds, stops[0].durationSeconds);
  assert.equal(summary.distanceMeters, trips[0].distanceMeters + trips[1].distanceMeters);
});

test('jeda pendek (60 detik, mis. lampu merah) tidak memecah perjalanan', () => {
  const a = drive(T0, 120);
  const b = drive(T0 + 125 * 1000 + 60000, 120, { lat0: 0.5 + 130 / M_PER_DEG_LAT });
  assert.equal(computeTrips([...a, ...b]).trips.length, 1);
});

test('jitter GPS saat parkir (speed 0, koordinat bergeser) tidak jadi perjalanan maupun jarak', () => {
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push({ recordedAt: new Date(T0 + i * 5000), latitude: 0.5 + (i % 2) * 0.00005, longitude: 100, speed: 0 });
  assert.equal(computeTrips(rows).trips.length, 0);
  // jitter setelah titik penutup tidak menambah jarak
  const withJitter = [...drive(T0, 120), ...rows.map((r, i) => ({ ...r, recordedAt: new Date(T0 + 200000 + i * 5000) }))];
  const base = computeTrips(drive(T0, 120)).summary.distanceMeters;
  assert.equal(computeTrips(withJitter).summary.distanceMeters, base);
});

test('lompatan GPS yang mustahil (glitch) tidak menambah jarak', () => {
  const rows = drive(T0, 60);
  const normal = computeTrips(rows).summary.distanceMeters;
  rows.splice(5, 0, { recordedAt: new Date(rows[4].recordedAt.getTime() + 1000), latitude: 5, longitude: 105, speed: 30 });
  const glitched = computeTrips(rows).summary.distanceMeters;
  assert.ok(glitched <= normal + 5 && glitched > normal - 150, `normal ${normal}, glitch ${glitched}`);
});

test('data kosong dan baris rusak tidak membuat error', () => {
  assert.deepEqual(computeTrips([]).summary, { tripCount: 0, distanceMeters: 0, drivingSeconds: 0, stoppedSeconds: 0, maxSpeedKmh: 0, avgSpeedKmh: 0 });
  assert.equal(computeTrips([{ recordedAt: 'bukan tanggal', latitude: 'x', longitude: null, speed: 1 }]).trips.length, 0);
});

test('status saat ini: moving bila titik terakhir baru dan bergerak, stopped bila sudah diam', () => {
  const rows = drive(T0, 100).slice(0, -1); // tanpa titik penutup
  const { trips } = computeTrips(rows);
  const lastT = rows[rows.length - 1].recordedAt.getTime();
  assert.equal(currentStatus(rows, trips, lastT + 5000).state, 'moving');
  assert.equal(currentStatus(rows, trips, lastT + 120000).state, 'stopped');
  assert.equal(currentStatus([], [], lastT).state, 'unknown');
});
