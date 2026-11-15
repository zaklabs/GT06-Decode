'use strict';

/**
 * Daftar IMEI perangkat yang diizinkan (allowlist) + keputusan saat paket LOGIN.
 *
 * Mode lewat env GT06_IMEI_ENFORCE:
 *   off : tidak memeriksa daftar
 *   log : (default) semua perangkat tetap diterima; yang belum terdaftar/nonaktif dicatat di log
 *   on  : hanya perangkat terdaftar & aktif yang diterima; lainnya diputus
 *
 * Daftar disalin ke memori (cache) supaya keputusan LOGIN tidak memukul database; cache
 * diperbarui tiap 60 detik dan segera setelah ada perubahan lewat API admin.
 */

const { EventEmitter } = require('events');
const { pool } = require('./db');
const { log } = require('./logger');
const { IMEI_RE } = require('./httpUtil');

const MODES = ['off', 'log', 'on'];
const REFRESH_MS = 60 * 1000;
const WARN_EVERY_MS = 10 * 60 * 1000;
const MAX_WARN_ENTRIES = 5000;

function parseMode(value) {
  const raw = value === undefined || value === '' ? 'log' : String(value).trim().toLowerCase();
  if (MODES.includes(raw)) return raw;
  log('warn', `[REG] GT06_IMEI_ENFORCE="${value}" tidak dikenali (pakai off/log/on), memakai "log"`);
  return 'log';
}

const MODE = parseMode(process.env.GT06_IMEI_ENFORCE);

// ---------- validasi input (dipakai API admin) ----------

/** @returns {{value: string}|{error: string}} */
function parseImei(input) {
  const value = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (!IMEI_RE.test(value)) return { error: 'IMEI tidak valid (hanya angka/heksadesimal, maksimal 20 karakter)' };
  return { value };
}

/** @returns {{value: string}|{error: string}} */
function parseLabel(input) {
  const value = typeof input === 'string' ? input.trim() : '';
  if (!value) return { error: 'label wajib diisi' };
  if (value.length > 100) return { error: 'label maksimal 100 karakter' };
  return { value };
}

// ---------- cache ----------

const cache = new Map(); // imei -> enabled (boolean)
let cacheLoaded = false;
const events = new EventEmitter(); // 'changed' setiap cache diperbarui

async function refreshCache() {
  const { rows } = await pool.query('SELECT imei, enabled FROM registered_devices');
  cache.clear();
  for (const row of rows) cache.set(row.imei, row.enabled);
  cacheLoaded = true;
  events.emit('changed');
}

/** 'registered' | 'disabled' | 'unregistered' | 'unknown' (cache belum pernah termuat). */
function statusOf(imei) {
  if (!cacheLoaded) return 'unknown';
  if (!cache.has(imei)) return 'unregistered';
  return cache.get(imei) ? 'registered' : 'disabled';
}

function start() {
  const run = () => refreshCache().catch((err) => log('error', `[REG] Gagal memuat daftar IMEI: ${err.message}`));
  log('info', `[REG] Penegakan daftar IMEI: mode "${MODE}"`);
  run();
  setInterval(run, REFRESH_MS).unref();
}

// ---------- keputusan LOGIN ----------

const lastWarn = new Map(); // imei -> timestamp, supaya log tidak dibanjiri

function warnThrottled(imei, text) {
  const now = Date.now();
  if (now - (lastWarn.get(imei) || 0) < WARN_EVERY_MS) return;
  if (lastWarn.size >= MAX_WARN_ENTRIES) lastWarn.clear();
  lastWarn.set(imei, now);
  log('warn', text);
}

/**
 * Putuskan apakah LOGIN dari `imei` diterima.
 * IMEI yang bukan heksadesimal/kosong selalu ditolak (bukan paket device sungguhan).
 * @returns {{allow: boolean, status: string}}
 */
function evaluateLogin(imei) {
  if (typeof imei !== 'string' || !IMEI_RE.test(imei)) return { allow: false, status: 'invalid' };
  if (MODE === 'off') return { allow: true, status: statusOf(imei) };

  const status = statusOf(imei);
  if (status === 'registered') return { allow: true, status };

  if (MODE === 'log') {
    warnThrottled(imei, `[REG] IMEI ${imei} status "${status}" (mode log: tetap diterima)`);
    return { allow: true, status };
  }
  return { allow: false, status }; // mode on
}

// ---------- CRUD (dipakai API admin) ----------

function afterMutation() {
  return refreshCache().catch((err) => log('error', `[REG] Gagal menyegarkan cache setelah perubahan: ${err.message}`));
}

async function list() {
  const { rows } = await pool.query(
    `SELECT imei, label, enabled, created_at AS "createdAt", updated_at AS "updatedAt"
     FROM registered_devices ORDER BY created_at DESC, imei`
  );
  return rows;
}

/** Baris baru, atau null kalau IMEI sudah terdaftar. */
async function create(imei, label) {
  const { rows } = await pool.query(
    `INSERT INTO registered_devices (imei, label) VALUES ($1, $2)
     ON CONFLICT (imei) DO NOTHING
     RETURNING imei, label, enabled, created_at AS "createdAt", updated_at AS "updatedAt"`,
    [imei, label]
  );
  await afterMutation();
  return rows[0] || null;
}

/** Baris yang diperbarui, atau null kalau IMEI tidak ada. `patch` boleh berisi label dan/atau enabled. */
async function update(imei, patch) {
  const { rows } = await pool.query(
    `UPDATE registered_devices
     SET label = COALESCE($2, label), enabled = COALESCE($3, enabled), updated_at = now()
     WHERE imei = $1
     RETURNING imei, label, enabled, created_at AS "createdAt", updated_at AS "updatedAt"`,
    [imei, patch.label === undefined ? null : patch.label, patch.enabled === undefined ? null : patch.enabled]
  );
  await afterMutation();
  return rows[0] || null;
}

async function remove(imei) {
  const { rowCount } = await pool.query('DELETE FROM registered_devices WHERE imei = $1', [imei]);
  await afterMutation();
  return rowCount > 0;
}

/** Daftarkan semua IMEI yang pernah terlihat (tabel devices) dan belum terdaftar. Mengembalikan jumlahnya. */
async function importSeen() {
  const { rowCount } = await pool.query(
    `INSERT INTO registered_devices (imei, label)
     SELECT imei, 'Belum diberi label' FROM devices WHERE imei ~ '^[0-9a-f]{1,20}$'
     ON CONFLICT (imei) DO NOTHING`
  );
  await afterMutation();
  return rowCount;
}

function stats() {
  return { mode: MODE, loaded: cacheLoaded, count: cache.size };
}

module.exports = {
  MODE, events, start, statusOf, evaluateLogin, parseImei, parseLabel,
  list, create, update, remove, importSeen, stats,
};
