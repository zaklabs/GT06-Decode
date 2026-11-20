'use strict';

/**
 * Zona waktu sistem, diatur lewat variabel lingkungan TIMEZONE (nama IANA, mis. Asia/Jakarta).
 *
 * Yang TIDAK berubah: penyimpanan di database dan semua JSON API tetap UTC (ISO 8601 berakhiran Z).
 * Yang mengikuti TIMEZONE:
 *  - jam di paket GPS perangkat (perangkat armada mengirim jam LOKAL, bukan UTC) -> dikonversi ke UTC;
 *  - tampilan waktu di dashboard web internal;
 *  - jam proses Node (nama file backup, jadwal backup).
 */

const DEFAULT_TIMEZONE = 'Asia/Jakarta';

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Baca TIMEZONE; kosong -> default. Nilai salah ditolak keras supaya jam tidak bergeser diam-diam. */
function resolveTimeZone(value) {
  const tz = String(value || '').trim() || DEFAULT_TIMEZONE;
  if (!isValidTimeZone(tz)) {
    throw new Error(`TIMEZONE "${tz}" bukan nama zona IANA yang valid (contoh: Asia/Jakarta, UTC)`);
  }
  return tz;
}

const formatters = new Map();
function formatterFor(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Selisih (ms) zona tz terhadap UTC pada instan `utcMs`: jam lokal - jam UTC. */
function offsetMs(utcMs, tz) {
  const p = {};
  for (const { type, value } of formatterFor(tz).formatToParts(new Date(utcMs))) p[type] = Number(value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Ubah jam dinding (tahun, bulan 1-12, ...) di zona tz menjadi Date UTC. Aman untuk zona ber-DST:
 * jam yang ambigu/tidak ada dipetakan secara deterministik oleh dua kali koreksi offset.
 */
function zonedToUtc(year, month, day, hour, minute, second, tz) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  let utc = wall - offsetMs(wall, tz);
  utc = wall - offsetMs(utc, tz);
  return new Date(utc);
}

/** Kebalikan zonedToUtc: jam dinding Date `date` di zona tz -> [tahun, bulan 1-12, hari, jam, menit, detik]. */
function wallClock(date, tz) {
  const p = {};
  for (const { type, value } of formatterFor(tz).formatToParts(date)) p[type] = Number(value);
  return [p.year, p.month, p.day, p.hour, p.minute, p.second];
}

const TIMEZONE = resolveTimeZone(process.env.TIMEZONE);
// Samakan jam proses (nama file backup, jadwal) dengan zona yang dipilih.
process.env.TZ = TIMEZONE;

module.exports = { TIMEZONE, DEFAULT_TIMEZONE, resolveTimeZone, isValidTimeZone, zonedToUtc, wallClock };
