'use strict';

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

const VALID_SCHEDULES = ['daily', 'weekly', 'monthly', 'off'];

const BACKUP_SCHEDULE = (process.env.BACKUP || 'monthly').toLowerCase();
const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';
const BACKUP_KEEP = process.env.BACKUP_KEEP ? Number(process.env.BACKUP_KEEP) : 6;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // cek tiap 1 jam -- aman dari batas setTimeout 32-bit utk jadwal bulanan
const RUN_AFTER_HOUR = 3; // backup dijalankan setelah jam 03:00 waktu container

const PG_ENV = {
  ...process.env,
  PGHOST: process.env.PGHOST || 'localhost',
  PGPORT: String(process.env.PGPORT || 5432),
  PGDATABASE: process.env.PGDATABASE || 'gt06',
  PGUSER: process.env.PGUSER || 'gt06',
  PGPASSWORD: process.env.PGPASSWORD || '',
};

function pad(n) {
  return String(n).padStart(2, '0');
}

function timestampSuffix(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** Kunci periode: sama artinya "sudah backup di periode ini". */
function periodKey(schedule, date) {
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());

  if (schedule === 'daily') return `${y}-${m}-${d}`;

  if (schedule === 'weekly') {
    const diffToMonday = (date.getDay() + 6) % 7; // 0=Senin
    const monday = new Date(date);
    monday.setDate(date.getDate() - diffToMonday);
    return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
  }

  return `${y}-${m}`; // monthly
}

function listBackupFiles() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.dump'))
    .map((f) => ({ name: f, path: path.join(BACKUP_DIR, f), mtimeMs: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function getLastBackupTime() {
  const files = listBackupFiles();
  return files.length > 0 ? new Date(files[0].mtimeMs) : null;
}

function runBackup() {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const uniqueSuffix = crypto.randomBytes(3).toString('hex');
    const filePath = path.join(BACKUP_DIR, `gt06-${PG_ENV.PGDATABASE}-${timestampSuffix(new Date())}-${uniqueSuffix}.dump`);

    execFile(
      'pg_dump',
      ['-h', PG_ENV.PGHOST, '-p', PG_ENV.PGPORT, '-U', PG_ENV.PGUSER, '-F', 'c', '-f', filePath, PG_ENV.PGDATABASE],
      { env: PG_ENV, timeout: 5 * 60 * 1000 },
      (err) => (err ? reject(err) : resolve(filePath))
    );
  });
}

function pruneOldBackups() {
  const files = listBackupFiles();
  for (const file of files.slice(BACKUP_KEEP)) {
    fs.unlinkSync(file.path);
    log('info', `[BACKUP] Hapus backup lama: ${file.name}`);
  }
}

function checkAndRun() {
  const now = new Date();
  if (now.getHours() < RUN_AFTER_HOUR) return;

  const lastBackup = getLastBackupTime();
  const currentKey = periodKey(BACKUP_SCHEDULE, now);
  const lastKey = lastBackup ? periodKey(BACKUP_SCHEDULE, lastBackup) : null;
  if (currentKey === lastKey) return; // sudah backup di periode berjalan

  log('info', `[BACKUP] Menjalankan backup (${BACKUP_SCHEDULE})...`);
  runBackup()
    .then((filePath) => {
      log('info', `[BACKUP] Berhasil: ${filePath}`);
      pruneOldBackups();
    })
    .catch((err) => log('error', `[BACKUP] Gagal: ${err.message}`));
}

function startBackupSchedule() {
  if (!VALID_SCHEDULES.includes(BACKUP_SCHEDULE)) {
    log('warn', `[BACKUP] Nilai BACKUP="${BACKUP_SCHEDULE}" tidak dikenali (pakai: daily/weekly/monthly/off), backup dinonaktifkan`);
    return;
  }
  if (BACKUP_SCHEDULE === 'off') {
    log('info', '[BACKUP] Backup dinonaktifkan (BACKUP=off)');
    return;
  }

  log('info', `[BACKUP] Jadwal: ${BACKUP_SCHEDULE}, simpan ${BACKUP_KEEP} file terakhir di ${BACKUP_DIR}`);
  checkAndRun(); // langsung cek saat startup, buat jaga-jaga kalau jadwal sempat kelewat pas container mati
  setInterval(checkAndRun, CHECK_INTERVAL_MS).unref();
}

module.exports = { startBackupSchedule, runBackup, pruneOldBackups, periodKey };
