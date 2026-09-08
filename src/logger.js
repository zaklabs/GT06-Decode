'use strict';

const { EventEmitter } = require('events');

const MAX_HISTORY = 500;
const history = [];
const devices = new Map(); // imei -> { imei, ip, lastSeen, ... }

const bus = new EventEmitter();
bus.setMaxListeners(50);

function log(level, message) {
  const entry = { ts: new Date().toISOString(), level, message };
  history.push(entry);
  if (history.length > MAX_HISTORY) history.shift();

  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  consoleFn(message);

  bus.emit('log', entry);
  return entry;
}

function updateDevice(imei, patch) {
  const existing = devices.get(imei) || { imei };
  const updated = { ...existing, ...patch, lastSeen: new Date().toISOString() };
  devices.set(imei, updated);
  bus.emit('device', updated);
  return updated;
}

/**
 * Muat device dari database ke memori TANPA menimpa state live yang sudah ada
 * (kalau device sedang benar-benar konek) dan TANPA menstempel lastSeen jadi
 * "sekarang" -- dipakai buat reload data lama/hasil restore, beda dari
 * updateDevice() yang selalu berarti "baru saja terjadi".
 */
function seedDevice(imei, patch) {
  if (devices.has(imei)) return devices.get(imei);
  const seeded = { imei, connected: false, ...patch };
  devices.set(imei, seeded);
  bus.emit('device', seeded);
  return seeded;
}

function getHistory() {
  return history;
}

function clearHistory() {
  history.length = 0;
  bus.emit('clear');
}

function getDevices() {
  return Array.from(devices.values());
}

function getDevice(imei) {
  return devices.get(imei) || null;
}

module.exports = { bus, log, updateDevice, seedDevice, getHistory, clearHistory, getDevices, getDevice };
