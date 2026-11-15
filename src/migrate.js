'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('./db');
const { log } = require('./logger');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
// Kunci advisory lock agar dua instance yang start bersamaan tidak saling menimpa migrasi.
const LOCK_KEY = 80600601;
const RETRY_MS = 30 * 1000;

/** Jalankan semua migrasi yang belum tercatat (urut nama file). Mengembalikan jumlah yang diterapkan. */
async function runMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+-.+\.sql$/.test(f)).sort();

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name        TEXT PRIMARY KEY,
         applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    );
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));

    let applied = 0;
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migrasi ${file} gagal: ${err.message}`);
      }
      applied++;
      log('info', `[DB] Migrasi diterapkan: ${file}`);
    }
    return applied;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    } catch (err) {
      // koneksi sudah putus -> lock otomatis lepas
    }
    client.release();
  }
}

let migrated = false;

function isMigrated() {
  return migrated;
}

/**
 * Jalankan migrasi; kalau database belum siap, ulangi tiap 30 detik tanpa menghentikan
 * server (penerimaan TCP GT06 tidak boleh bergantung pada database yang sedang bangun).
 * Promise selesai saat migrasi pertama kali berhasil.
 */
function runWithRetry() {
  return new Promise((resolve) => {
    const attempt = () => {
      runMigrations()
        .then((applied) => {
          migrated = true;
          log('info', `[DB] Skema database siap (${applied} migrasi baru).`);
          resolve(applied);
        })
        .catch((err) => {
          log('error', `[DB] Migrasi belum berhasil, coba lagi ${RETRY_MS / 1000} detik: ${err.message}`);
          setTimeout(attempt, RETRY_MS).unref();
        });
    };
    attempt();
  });
}

module.exports = { runMigrations, runWithRetry, isMigrated };
