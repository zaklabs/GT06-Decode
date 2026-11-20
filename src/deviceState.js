'use strict';

const { log, seedDevice } = require('./logger');

const toIso = (v) => (v ? new Date(v).toISOString() : undefined);

/** Baris devices (db.getAllDevices) -> state memori. Field kosong dibuang; is_online tidak ikut. */
function rowToState(row) {
  const state = {
    label: row.label || undefined,
    latitude: row.latitude,
    longitude: row.longitude,
    speed: row.speed,
    course: row.course,
    gpsTimestamp: toIso(row.gpsTimestamp),
    lastSeen: toIso(row.lastSeen),
  };
  for (const k of Object.keys(state)) if (state[k] === undefined || state[k] === null) delete state[k];
  return state;
}

/**
 * Muat state semua device dari database ke memori saat server start, supaya posisi terakhir
 * langsung tersedia di /api/devices dan /api/external/devices tanpa menunggu paket GPS berikutnya.
 * Device yang dimuat berstatus connected:false (belum ada socket); yang sudah live tidak ditimpa
 * (seedDevice). Posisi di memori mengikuti last_position_at, sama seperti guard di database.
 */
async function loadDevicesFromDb(db) {
  // Server baru start: tidak mungkin ada socket hidup, jadi flag online lama di DB basi.
  await db.setAllDevicesOffline();
  const rows = await db.getAllDevices();
  for (const row of rows) seedDevice(row.imei, rowToState(row));
  log('info', `[i] ${rows.length} device dimuat dari database ke memori`);
  return rows.length;
}

/** Coba sampai berhasil (database bisa belum siap saat start); tidak pernah melempar. */
function startLoadDevices(db, retryMs = 30000) {
  const attempt = () => {
    loadDevicesFromDb(db).catch((err) => {
      log('warn', `[DB] Gagal memuat device dari database, coba lagi ${retryMs / 1000} detik: ${err.message}`);
      setTimeout(attempt, retryMs).unref();
    });
  };
  attempt();
}

module.exports = { rowToState, loadDevicesFromDb, startLoadDevices };
