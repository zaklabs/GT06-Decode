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

// Posisi terakhir di tabel devices hanya diganti kalau jam perangkat titik baru >= jam titik yang
// sudah tersimpan. Titik tersimpan yang dikirim ulang perangkat (jam lama) tidak boleh menimpa
// posisi terbaru; last_seen_at/is_online tetap selalu diperbarui.
const UPSERT_LAST_POSITION = `
  INSERT INTO devices (imei, last_latitude, last_longitude, last_speed, last_course, last_position_at, last_seen_at, is_online)
  VALUES ($1, $2, $3, $4, $5, $6, now(), true)
  ON CONFLICT (imei) DO UPDATE SET
    last_latitude    = CASE WHEN devices.last_position_at IS NULL OR EXCLUDED.last_position_at >= devices.last_position_at THEN EXCLUDED.last_latitude    ELSE devices.last_latitude    END,
    last_longitude   = CASE WHEN devices.last_position_at IS NULL OR EXCLUDED.last_position_at >= devices.last_position_at THEN EXCLUDED.last_longitude   ELSE devices.last_longitude   END,
    last_speed       = CASE WHEN devices.last_position_at IS NULL OR EXCLUDED.last_position_at >= devices.last_position_at THEN EXCLUDED.last_speed       ELSE devices.last_speed       END,
    last_course      = CASE WHEN devices.last_position_at IS NULL OR EXCLUDED.last_position_at >= devices.last_position_at THEN EXCLUDED.last_course      ELSE devices.last_course      END,
    last_position_at = CASE WHEN devices.last_position_at IS NULL OR EXCLUDED.last_position_at >= devices.last_position_at THEN EXCLUDED.last_position_at ELSE devices.last_position_at END,
    last_seen_at = now(),
    is_online = true`;

// Titik dengan (imei, recorded_at) yang sama dilewati diam-diam (kiriman ulang dari perangkat).
const INSERT_POSITION = `
  INSERT INTO positions (imei, latitude, longitude, speed, course, voltage_level, gsm_signal_strength, recorded_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  ON CONFLICT (imei, recorded_at) DO NOTHING`;

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function recordPosition({ imei, latitude, longitude, speed, course, recordedAt, voltageLevel, gsmSignalStrength }) {
  await inTransaction(async (client) => {
    await client.query(UPSERT_LAST_POSITION, [imei, latitude, longitude, speed, course, recordedAt]);
    await client.query(INSERT_POSITION, [imei, latitude, longitude, speed, course, voltageLevel ?? null, gsmSignalStrength ?? null, recordedAt]);
  });
}

/**
 * Alarm (paket 0x16): disimpan di tabel alarms. Bila GPS-nya valid (hasFix), titiknya juga masuk
 * jejak posisi (dilewati jika paket 0x12 untuk detik yang sama sudah ada).
 */
async function recordAlarm({ imei, alarmType, hasFix, latitude, longitude, speed, course, recordedAt, voltageLevel, gsmSignalStrength }) {
  await inTransaction(async (client) => {
    if (hasFix) {
      await client.query(UPSERT_LAST_POSITION, [imei, latitude, longitude, speed, course, recordedAt]);
      await client.query(INSERT_POSITION, [imei, latitude, longitude, speed, course, voltageLevel ?? null, gsmSignalStrength ?? null, recordedAt]);
    } else {
      // Baris devices harus ada untuk foreign key alarms.
      await client.query('INSERT INTO devices (imei, last_seen_at, is_online) VALUES ($1, now(), true) ON CONFLICT (imei) DO UPDATE SET last_seen_at = now(), is_online = true', [imei]);
    }
    await client.query(
      `INSERT INTO alarms (imei, alarm_type, latitude, longitude, speed, course, voltage_level, gsm_signal_strength, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (imei, recorded_at, alarm_type) DO NOTHING`,
      [imei, alarmType, latitude ?? null, longitude ?? null, speed ?? null, course ?? null, voltageLevel ?? null, gsmSignalStrength ?? null, recordedAt]
    );
  });
}

/** Dipakai script reload-devices -- ambil state terakhir semua device dari DB. */
async function getAllDevices() {
  const { rows } = await pool.query(
    `SELECT imei, label, last_latitude AS latitude, last_longitude AS longitude,
            last_speed AS speed, last_course AS course, last_position_at AS "gpsTimestamp",
            last_seen_at AS "lastSeen", is_online
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
  recordAlarm,
  getAllDevices,
  getPositions,
  pruneOldPositions,
  startRetentionSchedule,
  RETENTION_INTERVAL,
};
