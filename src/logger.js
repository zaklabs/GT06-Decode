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

function getHistory() {
  return history;
}

function getDevices() {
  return Array.from(devices.values());
}

module.exports = { bus, log, updateDevice, getHistory, getDevices };
