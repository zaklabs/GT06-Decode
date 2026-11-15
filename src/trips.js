'use strict';

/**
 * Menurunkan perjalanan (trip), perhentian, total jarak, dan jam tempuh dari jejak posisi.
 * Fungsi murni: tidak menyentuh database/jaringan, jadi mudah diuji.
 *
 * Perilaku perangkat yang mendasari aturan ini (diamati dari capture perangkat asli, 2026-11-15):
 *  - bergerak: satu titik tiap ~5 detik
 *  - berhenti: satu titik terakhir berkecepatan 0, lalu perangkat diam (tidak mengirim apa-apa)
 * Jadi "berhenti" = tidak ada gerakan selama >= stopSeconds, termasuk diamnya paket.
 */

const DEFAULTS = {
  // Diam selama ini (detik) memisahkan dua perjalanan. Lebih pendek dari ini dianggap
  // masih satu perjalanan (lampu merah, macet, sinyal GPS hilang sebentar).
  stopSeconds: 180,
  // Kecepatan (km/jam) di bawah ini dianggap diam. Meredam kecepatan semu dari GPS.
  minSpeedKmh: 3,
  // Perjalanan lebih pendek dari ini (meter) dibuang sebagai noise GPS.
  minTripMeters: 50,
  // Lompatan antar dua titik yang menyiratkan kecepatan di atas ini dianggap glitch GPS.
  maxPlausibleKmh: 250,
};

const EARTH_RADIUS_M = 6371000;

function haversineMeters(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

function toPoint(row) {
  return {
    t: new Date(row.recordedAt).getTime(),
    lat: Number(row.latitude),
    lon: Number(row.longitude),
    speed: Number(row.speed) || 0,
  };
}

/**
 * @param rows   [{ recordedAt, latitude, longitude, speed }] -- urutan bebas, diurutkan di sini.
 * @param options override DEFAULTS
 * @returns {{ trips, stops, summary }}
 */
function computeTrips(rows, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const stopMs = o.stopSeconds * 1000;
  const points = rows.map(toPoint)
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .sort((a, b) => a.t - b.t);

  const raw = [];
  let cur = null; // { points: [...], lastMoving: index terakhir yang bergerak }

  for (const p of points) {
    const moving = p.speed >= o.minSpeedKmh;
    if (!cur) {
      if (moving) cur = { points: [p], lastMoving: 0 };
      continue;
    }
    // Sudah diam terlalu lama sejak gerakan terakhir -> perjalanan sebelumnya selesai.
    if (p.t - cur.points[cur.lastMoving].t > stopMs) {
      raw.push(cur);
      cur = moving ? { points: [p], lastMoving: 0 } : null;
      continue;
    }
    if (moving) {
      cur.points.push(p);
      cur.lastMoving = cur.points.length - 1;
    } else if (cur.lastMoving === cur.points.length - 1) {
      // Titik diam pertama setelah bergerak = paket "berhenti" dari perangkat; ikut sebagai titik
      // penutup. Titik diam berikutnya (jitter saat parkir) diabaikan.
      cur.points.push(p);
    }
  }
  if (cur) raw.push(cur);

  const trips = [];
  for (const r of raw) {
    // Titik diam yang menempel di tengah perjalanan (mis. lampu merah) tetap dipakai; yang di ujung
    // setelah titik bergerak terakhir hanya satu titik penutup.
    const pts = r.points;
    let distance = 0;
    let maxSpeed = 0;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].speed > maxSpeed) maxSpeed = pts[i].speed;
      if (i === 0) continue;
      const a = pts[i - 1];
      const b = pts[i];
      if (a.speed < o.minSpeedKmh && b.speed < o.minSpeedKmh) continue; // jitter saat diam
      const d = haversineMeters(a.lat, a.lon, b.lat, b.lon);
      const dtH = (b.t - a.t) / 3600000;
      if (dtH > 0 && d / 1000 / dtH > o.maxPlausibleKmh) continue; // glitch GPS
      distance += d;
    }
    const first = pts[0];
    const end = pts[pts.length - 1];
    if (distance < o.minTripMeters) continue;
    const durationSeconds = Math.round((end.t - first.t) / 1000);
    trips.push({
      start: new Date(first.t).toISOString(),
      end: new Date(end.t).toISOString(),
      durationSeconds,
      distanceMeters: Math.round(distance),
      maxSpeedKmh: maxSpeed,
      avgSpeedKmh: durationSeconds > 0 ? Math.round((distance / durationSeconds) * 3.6 * 10) / 10 : 0,
      startPosition: { latitude: first.lat, longitude: first.lon },
      endPosition: { latitude: end.lat, longitude: end.lon },
    });
  }

  const stops = [];
  for (let i = 0; i < trips.length - 1; i++) {
    const from = new Date(trips[i].end).getTime();
    const to = new Date(trips[i + 1].start).getTime();
    stops.push({
      start: trips[i].end,
      end: trips[i + 1].start,
      durationSeconds: Math.round((to - from) / 1000),
      latitude: trips[i].endPosition.latitude,
      longitude: trips[i].endPosition.longitude,
    });
  }

  const distanceMeters = trips.reduce((s, t) => s + t.distanceMeters, 0);
  const drivingSeconds = trips.reduce((s, t) => s + t.durationSeconds, 0);
  const summary = {
    tripCount: trips.length,
    distanceMeters,
    drivingSeconds,
    stoppedSeconds: stops.reduce((s, t) => s + t.durationSeconds, 0),
    maxSpeedKmh: trips.reduce((m, t) => Math.max(m, t.maxSpeedKmh), 0),
    avgSpeedKmh: drivingSeconds > 0 ? Math.round((distanceMeters / drivingSeconds) * 3.6 * 10) / 10 : 0,
  };

  return { trips, stops, summary };
}

/**
 * Status saat ini dari titik terakhir: "moving" bila titik terakhir baru (<= liveSeconds) dan
 * bergerak; "stopped" bila tidak; "unknown" bila tidak ada data.
 * `since` = kapan status itu mulai (awal perjalanan terakhir bila moving, akhirnya bila stopped).
 */
function currentStatus(rows, trips, now = Date.now(), options = {}) {
  const o = { ...DEFAULTS, liveSeconds: 30, ...options };
  if (!rows.length) return { state: 'unknown', since: null, lastPositionAt: null };
  const last = rows.map(toPoint).reduce((a, b) => (b.t > a.t ? b : a));
  const lastTrip = trips[trips.length - 1] || null;
  const live = now - last.t <= o.liveSeconds * 1000;
  if (live && last.speed >= o.minSpeedKmh) {
    return { state: 'moving', since: lastTrip ? lastTrip.start : new Date(last.t).toISOString(), lastPositionAt: new Date(last.t).toISOString() };
  }
  return { state: 'stopped', since: lastTrip ? lastTrip.end : new Date(last.t).toISOString(), lastPositionAt: new Date(last.t).toISOString() };
}

module.exports = { computeTrips, currentStatus, haversineMeters, DEFAULTS };
