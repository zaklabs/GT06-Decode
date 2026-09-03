'use strict';

const { crc16X25 } = require('../src/crc');
const { splitFrames, decodeFrame } = require('../src/parser');

/**
 * Helper untuk membangun frame 0x7878 yang valid (dipakai hanya untuk contoh/testing).
 * body = protocolNumber(1) + information(N) + serial(2)
 */
function buildFrame(protocolNumber, information, serialNumber) {
  const body = Buffer.concat([
    Buffer.from([protocolNumber]),
    information,
    Buffer.from([(serialNumber >> 8) & 0xff, serialNumber & 0xff]),
  ]);
  const lengthByte = body.length + 2; // + crc(2)
  const crcSource = Buffer.concat([Buffer.from([lengthByte]), body]);
  const crc = crc16X25(crcSource);

  return Buffer.concat([
    Buffer.from([0x78, 0x78, lengthByte]),
    body,
    Buffer.from([(crc >> 8) & 0xff, crc & 0xff]),
    Buffer.from([0x0d, 0x0a]),
  ]);
}

function decodeAndPrint(label, frame) {
  console.log(`\n=== ${label} ===`);
  console.log('raw hex:', frame.toString('hex'));

  const { frames } = splitFrames(frame);
  for (const f of frames) {
    const decoded = decodeFrame(f);
    console.log(JSON.stringify(decoded, (k, v) => (Buffer.isBuffer(v) ? v.toString('hex') : v), 2));
  }
}

// ===== Contoh 1: paket LOGIN =====
// IMEI 15 digit -> 8 byte BCD (16 nibble, nibble pertama 0)
const imei = '086471001218789'; // contoh IMEI
const imeiBcdHex = ('0' + imei).length % 2 === 0 ? '0' + imei : imei;
const terminalId = Buffer.from(imeiBcdHex.padStart(16, '0'), 'hex');
const typeIdentCode = Buffer.from([0x00, 0x01]);
const loginInfo = Buffer.concat([terminalId, typeIdentCode]);
const loginFrame = buildFrame(0x01, loginInfo, 1);

decodeAndPrint('Login Packet', loginFrame);

// ===== Contoh 2: paket GPS + LBS (protokol 0x12) =====
const dateTime = Buffer.from([24, 1, 15, 10, 30, 0]); // 2024-01-15 10:30:00
const gpsInfoByte = Buffer.from([0xc0 | 9]); // 9 satelit terkunci
const latitude = 5.548333; // Banda Aceh, contoh
const longitude = 95.323753;
const latRaw = Math.round(latitude * 30000 * 60);
const lonRaw = Math.round(longitude * 30000 * 60);
const latLonBuf = Buffer.alloc(8);
latLonBuf.writeUInt32BE(latRaw, 0);
latLonBuf.writeUInt32BE(lonRaw, 4);
const speed = Buffer.from([40]); // 40 km/h
const courseStatus = Buffer.alloc(2);
courseStatus.writeUInt16BE(0x8000 | 90); // GPS fixed, course 90 derajat, N/E
const lbs = Buffer.alloc(8);
lbs.writeUInt16BE(510, 0); // MCC Indonesia
lbs.writeUInt8(10, 2); // MNC
lbs.writeUInt16BE(1234, 3); // LAC
lbs.writeUIntBE(56789, 5, 3); // Cell ID

const gpsInfo = Buffer.concat([dateTime, gpsInfoByte, latLonBuf, speed, courseStatus, lbs]);
const gpsFrame = buildFrame(0x12, gpsInfo, 2);

decodeAndPrint('GPS + LBS Packet', gpsFrame);

// ===== Contoh 3: heartbeat/status (protokol 0x13) =====
const statusInfo = Buffer.from([0xc6, 4, 3]); // terminal info, voltage 4/6, sinyal 3/4
const statusFrame = buildFrame(0x13, statusInfo, 3);

decodeAndPrint('Status/Heartbeat Packet', statusFrame);

// ===== Contoh 4: simulasi stream TCP (2 paket sekaligus + potongan) =====
const combined = Buffer.concat([loginFrame, gpsFrame]);
decodeAndPrint('Simulasi 2 paket dalam 1 chunk TCP', combined);
