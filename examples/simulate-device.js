'use strict';

/**
 * Simulator device GT06 — mengirim paket Login lalu GPS berkala ke server manapun.
 * Berguna untuk menguji server (lokal, Docker, atau production) tanpa perangkat fisik.
 *
 * Contoh pakai:
 *   node examples/simulate-device.js --host 203.0.113.10 --port 5023
 *   node examples/simulate-device.js --host 203.0.113.10 --imei 351234567890123 --interval 5
 *
 * Opsi:
 *   --host      IP/domain server tujuan (default: 127.0.0.1)
 *   --port      Port TCP GT06 server (default: 5023)
 *   --imei      IMEI 15 digit yang disimulasikan (default: 086471001218789)
 *   --interval  Jeda pengiriman posisi GPS dalam detik (default: 10)
 *   --lat       Latitude awal (default: 5.548333 -- Banda Aceh)
 *   --lon       Longitude awal (default: 95.323753 -- Banda Aceh)
 */

const net = require('net');
const { crc16X25 } = require('../src/crc');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[key] = value;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const HOST = args.host || process.env.GT06_TARGET_HOST || '127.0.0.1';
const PORT = Number(args.port || process.env.GT06_TARGET_PORT || 5023);
const IMEI = String(args.imei || '086471001218789').padStart(15, '0');
const INTERVAL_SEC = Number(args.interval || 10);
let latitude = Number(args.lat || 5.548333);
let longitude = Number(args.lon || 95.323753);

let serial = 0;
function nextSerial() {
  serial = (serial + 1) % 0xffff;
  return serial;
}

function buildFrame(protocolNumber, information) {
  const body = Buffer.concat([
    Buffer.from([protocolNumber]),
    information,
    Buffer.from([(nextSerial() >> 8) & 0xff, serial & 0xff]),
  ]);
  const lengthByte = body.length + 2;
  const crcSource = Buffer.concat([Buffer.from([lengthByte]), body]);
  const crc = crc16X25(crcSource);

  return Buffer.concat([
    Buffer.from([0x78, 0x78, lengthByte]),
    body,
    Buffer.from([(crc >> 8) & 0xff, crc & 0xff]),
    Buffer.from([0x0d, 0x0a]),
  ]);
}

function buildLoginFrame(imei) {
  const terminalId = Buffer.from(imei.padStart(16, '0'), 'hex'); // 15 digit IMEI -> 8 byte BCD
  const typeIdentCode = Buffer.from([0x00, 0x01]);
  return buildFrame(0x01, Buffer.concat([terminalId, typeIdentCode]));
}

function buildGpsFrame(lat, lon, speedKmh) {
  const now = new Date();
  const dateTime = Buffer.from([
    now.getUTCFullYear() - 2000,
    now.getUTCMonth() + 1,
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
  ]);
  const gpsInfoByte = Buffer.from([0xc0 | 9]); // 9 satelit terkunci
  const latRaw = Math.round(Math.abs(lat) * 30000 * 60);
  const lonRaw = Math.round(Math.abs(lon) * 30000 * 60);
  const latLonBuf = Buffer.alloc(8);
  latLonBuf.writeUInt32BE(latRaw, 0);
  latLonBuf.writeUInt32BE(lonRaw, 4);
  const speedBuf = Buffer.from([Math.min(255, Math.round(speedKmh))]);
  const courseStatus = Buffer.alloc(2);
  let statusBits = 0x1000; // GPS fixed (bit12)
  if (lat >= 0) statusBits |= 0x0400; // utara (bit10 set = utara, clear = selatan)
  if (lon < 0) statusBits |= 0x0800; // barat (bit11)
  courseStatus.writeUInt16BE(statusBits | 90); // course 90 derajat

  const gpsInfo = Buffer.concat([dateTime, gpsInfoByte, latLonBuf, speedBuf, courseStatus]);
  return buildFrame(0x12, gpsInfo);
}

console.log(`[sim] Menghubungkan ke ${HOST}:${PORT} sebagai IMEI ${IMEI} ...`);

const socket = net.createConnection({ host: HOST, port: PORT }, () => {
  console.log('[sim] Terhubung, mengirim paket Login...');
  socket.write(buildLoginFrame(IMEI));
});

let heartbeatTimer = null;

socket.on('data', (data) => {
  console.log('[sim] Balasan server:', data.toString('hex'));

  const protocolNumber = data[3];
  if (protocolNumber === 0x01 && !heartbeatTimer) {
    console.log(`[sim] Login diterima (ACK). Mulai kirim posisi GPS tiap ${INTERVAL_SEC} detik. Tekan Ctrl+C untuk berhenti.`);
    sendGps();
    heartbeatTimer = setInterval(sendGps, INTERVAL_SEC * 1000);
  }
});

function sendGps() {
  // gerak kecil ke timur tiap kirim, biar keliatan bergerak di peta dashboard
  longitude += 0.0002;
  const speed = 20 + Math.round(Math.random() * 40);
  const frame = buildGpsFrame(latitude, longitude, speed);
  socket.write(frame);
  console.log(`[sim] Kirim GPS: lat=${latitude.toFixed(6)} lon=${longitude.toFixed(6)} speed=${speed}km/h`);
}

socket.on('error', (err) => {
  console.error('[sim] Error koneksi:', err.message);
  process.exit(1);
});

socket.on('close', () => {
  console.log('[sim] Koneksi ditutup.');
  if (heartbeatTimer) clearInterval(heartbeatTimer);
});

process.on('SIGINT', () => {
  console.log('\n[sim] Berhenti, menutup koneksi...');
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  socket.end();
  process.exit(0);
});
