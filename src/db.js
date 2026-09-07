'use strict';

const { Pool } = require('pg');
const { log } = require('./logger');

const RETENTION_DAYS = process.env.RETENTION_DAYS ? Number(process.env.RETENTION_DAYS) : 90;

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

async function recordPosition({ imei, latitude, longitude, speed, course, recordedAt }) {
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
      `INSERT INTO positions (imei, latitude, longitude, speed, course, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [imei, latitude, longitude, speed, course, recordedAt]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function pruneOldPositions(retentionDays) {
  const result = await pool.query(
    `DELETE FROM positions WHERE recorded_at < now() - ($1 || ' days')::interval`,
    [retentionDays]
  );
  return result.rowCount;
}

function startRetentionSchedule() {
  const run = () => {
    pruneOldPositions(RETENTION_DAYS)
      .then((count) => {
        if (count > 0) log('info', `[DB] Retensi: hapus ${count} baris posisi lebih dari ${RETENTION_DAYS} hari`);
      })
      .catch((err) => log('error', `[DB] Gagal jalankan retensi: ${err.message}`));
  };

  run(); // jalankan sekali saat startup, lalu tiap 24 jam
  setInterval(run, 24 * 60 * 60 * 1000).unref();
}

module.exports = {
  pool,
  touchDevice,
  setDeviceOffline,
  recordPosition,
  pruneOldPositions,
  startRetentionSchedule,
  RETENTION_DAYS,
};
