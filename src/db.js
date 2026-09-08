'use strict';

const { Pool } = require('pg');
const { log } = require('./logger');

const UNIT_TO_PG_INTERVAL = { d: 'days', w: 'weeks', m: 'months', y: 'years' };

/** Parse format "90d" / "12w" / "3m" / "1y" jadi interval PostgreSQL, mis. "90 days". */
function parseRetention(value) {
  const match = /^(\d+)\s*(d|w|m|y)$/i.exec(String(value).trim());
  if (!match) {
    log('warn', `[DB] Format RETENTION "${value}" tidak dikenali, pakai default 90d`);
    return '90 days';
  }
  return `${match[1]} ${UNIT_TO_PG_INTERVAL[match[2].toLowerCase()]}`;
}

const RETENTION_INTERVAL = parseRetention(process.env.RETENTION || '90d');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
  database: process.env.PGDATABASE || 'gt06',
  user: process.env.PGUSER || 'gt06',
  password: process.env.PGPASSWORD || '',
});

pool.on('error', (err) => {
  log('error', `[DB] Koneksi pool error: ${err.message}`);
});

async function touchDevice(imei) {
  await pool.query(
    `INSERT INTO devices (imei, last_seen_at, is_online)
     VALUES ($1, now(), true)
     ON CONFLICT (imei) DO UPDATE SET last_seen_at = now(), is_online = true`,
    [imei]
  );
}

async function setDeviceOffline(imei) {
  await pool.query('UPDATE devices SET is_online = false WHERE imei = $1', [imei]);
}

async function recordPosition({ imei, latitude, longitude, speed, course, recordedAt, voltageLevel, gsmSignalStrength }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO devices (imei, last_latitude, last_longitude, last_speed, last_course, last_seen_at, is_online)
       VALUES ($1, $2, $3, $4, $5, now(), true)
       ON CONFLICT (imei) DO UPDATE SET
         last_latitude = EXCLUDED.last_latitude,
         last_longitude = EXCLUDED.last_longitude,
         last_speed = EXCLUDED.last_speed,
         last_course = EXCLUDED.last_course,
         last_seen_at = now(),
         is_online = true`,
      [imei, latitude, longitude, speed, course]
    );
    await client.query(
      `INSERT INTO positions (imei, latitude, longitude, speed, course, voltage_level, gsm_signal_strength, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [imei, latitude, longitude, speed, course, voltageLevel ?? null, gsmSignalStrength ?? null, recordedAt]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Dipakai script reload-devices -- ambil state terakhir semua device dari DB. */
async function getAllDevices() {
  const { rows } = await pool.query(
    `SELECT imei, label, last_latitude AS latitude, last_longitude AS longitude,
            last_speed AS speed, last_course AS course, last_seen_at AS "lastSeen", is_online
     FROM devices`
  );
  return rows;
}

/** Riwayat posisi satu device dalam rentang waktu -- dipakai fitur playback rute. */
async function getPositions({ imei, from, to, limit }) {
  const { rows } = await pool.query(
    `SELECT imei, latitude, longitude, speed, course,
            voltage_level AS "voltageLevel", gsm_signal_strength AS "gsmSignalStrength",
            recorded_at AS "recordedAt"
     FROM positions
     WHERE imei = $1 AND recorded_at >= $2 AND recorded_at <= $3
     ORDER BY recorded_at ASC
     LIMIT $4`,
    [imei, from, to, limit]
  );
  return rows;
}

async function pruneOldPositions() {
  const result = await pool.query(
    `DELETE FROM positions WHERE recorded_at < now() - $1::interval`,
    [RETENTION_INTERVAL]
  );
  return result.rowCount;
}

function startRetentionSchedule() {
  const run = () => {
    pruneOldPositions()
      .then((count) => {
        if (count > 0) log('info', `[DB] Retensi: hapus ${count} baris posisi lebih lama dari ${RETENTION_INTERVAL}`);
      })
      .catch((err) => log('error', `[DB] Gagal jalankan retensi: ${err.message}`));
  };

  log('info', `[DB] Retensi posisi: ${RETENTION_INTERVAL} (cek tiap 24 jam)`);
  run(); // jalankan sekali saat startup, lalu tiap 24 jam
  setInterval(run, 24 * 60 * 60 * 1000).unref();
}

module.exports = {
  pool,
  touchDevice,
  setDeviceOffline,
  recordPosition,
  getAllDevices,
  getPositions,
  pruneOldPositions,
  startRetentionSchedule,
  RETENTION_INTERVAL,
};
