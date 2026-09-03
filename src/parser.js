'use strict';

const { crc16X25 } = require('./crc');

const START_NORMAL = Buffer.from([0x78, 0x78]);
const START_EXTENDED = Buffer.from([0x79, 0x79]);
const STOP = Buffer.from([0x0d, 0x0a]);

const PROTOCOL = {
  LOGIN: 0x01,
  GPS_LBS_1: 0x12,
  GPS_LBS_2: 0x22, // varian dengan status tambahan
  STATUS_HEARTBEAT: 0x13,
  ALARM: 0x16,
  LBS_MULTIBASE: 0x1a,
  GPS_LBS_STATUS: 0x18, // GPS + LBS + status (beberapa firmware)
  TIME_REQUEST: 0x8a,
  COMMAND_RESPONSE: 0x15,
  ONLINE_COMMAND: 0x80,
};

/**
 * Memecah stream buffer TCP menjadi frame-frame GT06 yang utuh.
 * Mengembalikan { frames: Buffer[], rest: Buffer } — sisa bytes yang belum lengkap
 * dikembalikan agar disambung dengan data berikutnya (penting krn TCP bisa memecah paket).
 */
function splitFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset < buffer.length) {
    const startIdx = findStart(buffer, offset);
    if (startIdx === -1) {
      return { frames, rest: Buffer.alloc(0) };
    }
    if (startIdx > offset) {
      // buang byte sampah sebelum start bit
      offset = startIdx;
    }

    const isExtended = buffer[offset] === 0x79 && buffer[offset + 1] === 0x79;
    const lenFieldSize = isExtended ? 2 : 1;
    const headerSize = 2 + lenFieldSize;

    if (buffer.length < offset + headerSize) {
      return { frames, rest: buffer.slice(offset) }; // belum cukup untuk baca length
    }

    const contentLen = isExtended
      ? buffer.readUInt16BE(offset + 2)
      : buffer.readUInt8(offset + 2);

    // contentLen = protocol(1) + info + serial(2) + crc(2)
    const frameLen = headerSize + contentLen + 2; // + stop bit (2 byte)

    if (buffer.length < offset + frameLen) {
      return { frames, rest: buffer.slice(offset) }; // frame belum lengkap, tunggu data lagi
    }

    const frame = buffer.slice(offset, offset + frameLen);

    if (frame[frameLen - 2] !== STOP[0] || frame[frameLen - 1] !== STOP[1]) {
      // stop bit tidak cocok -> data korup, geser 1 byte dan cari start berikutnya
      offset += 2;
      continue;
    }

    frames.push(frame);
    offset += frameLen;
  }

  return { frames, rest: Buffer.alloc(0) };
}

function findStart(buffer, from) {
  for (let i = from; i < buffer.length - 1; i++) {
    if (
      (buffer[i] === START_NORMAL[0] && buffer[i + 1] === START_NORMAL[1]) ||
      (buffer[i] === START_EXTENDED[0] && buffer[i + 1] === START_EXTENDED[1])
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Decode satu frame GT06 yang sudah lengkap (termasuk start & stop bit).
 */
function decodeFrame(frame) {
  const isExtended = frame[0] === 0x79 && frame[1] === 0x79;
  const lenFieldSize = isExtended ? 2 : 1;
  const headerSize = 2 + lenFieldSize;

  const contentLen = isExtended
    ? frame.readUInt16BE(2)
    : frame.readUInt8(2);

  const protocolNumber = frame[headerSize];
  const infoStart = headerSize + 1;
  const infoEnd = frame.length - 2 - 2 - 2; // - stop(2) - crc(2) - serial(2)
  const information = frame.slice(infoStart, infoEnd);

  const serialNumber = frame.readUInt16BE(frame.length - 6);
  const crcReceived = frame.readUInt16BE(frame.length - 4);

  const crcPayload = frame.slice(headerSize - lenFieldSize, frame.length - 4);
  const crcCalculated = crc16X25(crcPayload);
  const crcValid = crcReceived === crcCalculated;

  const decoded = {
    raw: frame,
    isExtended,
    protocolNumber,
    protocolHex: '0x' + protocolNumber.toString(16).padStart(2, '0'),
    serialNumber,
    crcValid,
    data: decodeContent(protocolNumber, information),
  };

  return decoded;
}

function decodeContent(protocolNumber, content) {
  switch (protocolNumber) {
    case PROTOCOL.LOGIN:
      return decodeLogin(content);
    case PROTOCOL.GPS_LBS_1:
    case PROTOCOL.GPS_LBS_2:
    case PROTOCOL.GPS_LBS_STATUS:
      return decodeGpsLbs(content);
    case PROTOCOL.STATUS_HEARTBEAT:
      return decodeStatus(content);
    case PROTOCOL.ALARM:
      return decodeAlarm(content);
    case PROTOCOL.LBS_MULTIBASE:
      return decodeLbsMultibase(content);
    default:
      return { raw: content.toString('hex') };
  }
}

function decodeLogin(content) {
  const terminalId = content.slice(0, 8).toString('hex').replace(/^0/, '');
  const result = { imei: terminalId };
  if (content.length >= 10) {
    result.typeIdentificationCode = content.readUInt16BE(8).toString(16);
  }
  if (content.length >= 12) {
    result.timeZoneLanguage = content.readUInt16BE(10);
  }
  return result;
}

function decodeDateTime(content, offset) {
  const year = 2000 + content[offset];
  const month = content[offset + 1];
  const day = content[offset + 2];
  const hour = content[offset + 3];
  const minute = content[offset + 4];
  const second = content[offset + 5];
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

function decodeGpsLbs(content) {
  let offset = 0;
  const timestamp = decodeDateTime(content, offset);
  offset += 6;

  const gpsInfoByte = content[offset];
  const satellites = gpsInfoByte & 0x0f;
  offset += 1;

  const latRaw = content.readUInt32BE(offset);
  offset += 4;
  const lonRaw = content.readUInt32BE(offset);
  offset += 4;

  const speed = content[offset]; // km/h
  offset += 1;

  const courseStatus = content.readUInt16BE(offset);
  offset += 2;

  const gpsFixed = !!(courseStatus & 0x8000);
  const isSouth = !!(courseStatus & 0x0800);
  const isWest = !!(courseStatus & 0x0400);
  const realtimeGps = !!(courseStatus & 0x0200);
  const course = courseStatus & 0x01ff;

  let latitude = latRaw / 30000 / 60;
  let longitude = lonRaw / 30000 / 60;
  if (isSouth) latitude = -latitude;
  if (isWest) longitude = -longitude;

  const result = {
    timestamp,
    satellites,
    latitude: Number(latitude.toFixed(6)),
    longitude: Number(longitude.toFixed(6)),
    speed,
    course,
    gpsFixed,
    realtimeGps,
  };

  // Sisa data opsional: LBS (MCC/MNC/LAC/CellId), umum di 0x12/0x18/0x22
  if (content.length - offset >= 8) {
    result.lbs = decodeLbsBlock(content, offset);
  }

  return result;
}

function decodeLbsBlock(content, offset) {
  const mcc = content.readUInt16BE(offset);
  offset += 2;
  const mnc = content[offset];
  offset += 1;
  const lac = content.readUInt16BE(offset);
  offset += 2;
  const cellId = content.readUIntBE(offset, 3);
  offset += 3;
  return { mcc, mnc, lac, cellId };
}

function decodeLbsMultibase(content) {
  const timestamp = decodeDateTime(content, 0);
  let offset = 6;
  const mcc = content.readUInt16BE(offset); offset += 2;
  const mnc = content[offset]; offset += 1;
  return { timestamp, mcc, mnc, raw: content.slice(offset).toString('hex') };
}

function decodeStatus(content) {
  const terminalInfoByte = content[0];
  const result = {
    terminalInfo: {
      oilElectricityConnected: !!(terminalInfoByte & 0x80),
      gpsTracking: !!(terminalInfoByte & 0x40),
      alarmBits: (terminalInfoByte >> 3) & 0x07,
      charging: !!(terminalInfoByte & 0x04),
      accHigh: !!(terminalInfoByte & 0x02),
      defenseActivated: !!(terminalInfoByte & 0x01),
    },
  };
  if (content.length >= 2) result.voltageLevel = content[1]; // 0-6
  if (content.length >= 3) result.gsmSignalStrength = content[2]; // 0-4
  if (content.length >= 5) result.alarmLanguage = content.readUInt16BE(3);
  return result;
}

function decodeAlarm(content) {
  const gps = decodeGpsLbs(content);
  // byte terminal info + alarm/language umumnya di akhir; posisi persis tergantung firmware,
  // jadi kita sertakan sisa mentahnya juga untuk jaga-jaga.
  return gps;
}

module.exports = {
  PROTOCOL,
  splitFrames,
  decodeFrame,
  decodeContent,
};
