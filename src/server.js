'use strict';

const net = require('net');
const { crc16X25 } = require('./crc');
const { splitFrames, decodeFrame, PROTOCOL } = require('./parser');
const { log, updateDevice, getDevice } = require('./logger');
const db = require('./db');
const registry = require('./registry');

const PORT = process.env.GT06_PORT ? Number(process.env.GT06_PORT) : 5023;
const HOST = process.env.GT06_HOST || '0.0.0.0';

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Batas koneksi TCP simultan (device asli biasanya 1 koneksi per unit).
const MAX_CONNECTIONS = envInt('GT06_MAX_CONNECTIONS', 1000);
// Frame GT06 terbesar (0x7979, length 2 byte) +- 64 KB; buffer yang melebihi ini
// pasti bukan data valid -> putus koneksi supaya memori tidak bisa dibanjiri.
const MAX_BUFFER_BYTES = envInt('GT06_MAX_BUFFER_BYTES', 128 * 1024);
// Koneksi yang belum mengirim paket LOGIN dalam waktu ini diputus, supaya slot
// koneksi tidak bisa dihabiskan oleh koneksi kosong/idle. Device GT06 asli
// mengirim LOGIN segera setelah konek.
const LOGIN_TIMEOUT_MS = envInt('GT06_LOGIN_TIMEOUT_MS', 60 * 1000);

/**
 * Membuat paket balasan (ACK) format 0x7878 standar:
 * 78 78 <len> <protocol> <serial 2 byte> <crc 2 byte> 0D 0A
 */
function buildAck(protocolNumber, serialNumber) {
  const body = Buffer.alloc(1 + 2); // protocol + serial
  body[0] = protocolNumber;
  body.writeUInt16BE(serialNumber, 1);

  const lengthByte = body.length + 2; // + crc(2)
  const crcSource = Buffer.concat([Buffer.from([lengthByte]), body]);
  const crc = crc16X25(crcSource);

  const packet = Buffer.alloc(2 + 1 + body.length + 2 + 2);
  let o = 0;
  packet.writeUInt8(0x78, o++); packet.writeUInt8(0x78, o++);
  packet.writeUInt8(lengthByte, o++);
  body.copy(packet, o); o += body.length;
  packet.writeUInt16BE(crc, o); o += 2;
  packet.writeUInt8(0x0d, o++); packet.writeUInt8(0x0a, o++);
  return packet;
}

// IMEI -> kumpulan socket yang sudah LOGIN. Dipakai untuk memutus perangkat yang
// dihapus/dinonaktifkan dari daftar IMEI saat mode "on" (lihat registry.events).
const socketsByImei = new Map();

function trackSocket(imei, socket) {
  if (!socketsByImei.has(imei)) socketsByImei.set(imei, new Set());
  socketsByImei.get(imei).add(socket);
}

function untrackSocket(imei, socket) {
  const set = socketsByImei.get(imei);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) socketsByImei.delete(imei);
}

registry.events.on('changed', () => {
  if (registry.MODE !== 'on') return;
  for (const [imei, set] of socketsByImei) {
    if (registry.statusOf(imei) === 'registered') continue;
    for (const socket of set) {
      log('warn', `[REG] IMEI ${imei} tidak lagi diizinkan, koneksi diputus`);
      socket.destroy();
    }
  }
});

const server = net.createServer((socket) => {
  socket.setKeepAlive(true, 60000);

  let buffer = Buffer.alloc(0);
  let imei = null;
  let hasData = false; // pembeda koneksi device asli vs probe kosong (mis. Docker healthcheck)
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;

  const loginTimer = setTimeout(() => {
    if (!imei) {
      if (hasData) log('warn', `[!] ${remote} tidak mengirim LOGIN dalam ${LOGIN_TIMEOUT_MS} ms, koneksi diputus`);
      socket.destroy();
    }
  }, LOGIN_TIMEOUT_MS);
  loginTimer.unref();

  socket.on('data', (chunk) => {
    if (!hasData) {
      hasData = true;
      log('info', `[+] Koneksi baru dari ${remote}`);
    }

    buffer = Buffer.concat([buffer, chunk]);

    const { frames, rest } = splitFrames(buffer);
    buffer = rest;
    if (buffer.length > MAX_BUFFER_BYTES) {
      // Jaring pengaman: sisa frame belum lengkap seharusnya tidak pernah > ~64 KB.
      log('warn', `[!] Sisa buffer dari ${remote} melebihi ${MAX_BUFFER_BYTES} byte, koneksi diputus`);
      buffer = Buffer.alloc(0);
      socket.destroy();
      return;
    }

    for (const frame of frames) {
      if (socket.destroyed) break;
      let packet;
      try {
        packet = decodeFrame(frame);
      } catch (err) {
        log('error', `[!] Gagal decode frame dari ${remote}: ${err.message} ${frame.toString('hex')}`);
        continue;
      }

      if (!packet.crcValid) {
        log('warn', `[!] CRC tidak valid dari ${remote}, frame diabaikan: ${frame.toString('hex')}`);
        continue;
      }

      handlePacket(socket, remote, packet, (v) => {
        if (imei && imei !== v) untrackSocket(imei, socket);
        imei = v;
        trackSocket(v, socket);
      }, () => imei);
    }
  });

  socket.on('close', () => {
    clearTimeout(loginTimer);
    if (hasData) {
      log('info', `[-] Koneksi ditutup: ${remote} (imei: ${imei || 'unknown'})`);
      if (imei) {
        untrackSocket(imei, socket);
        updateDevice(imei, { connected: false });
        db.setDeviceOffline(imei).catch((err) => log('error', `[DB] Gagal update status offline ${imei}: ${err.message}`));
      }
    }
  });

  socket.on('error', (err) => {
    log('error', `[!] Socket error dari ${remote}: ${err.message}`);
  });
});

// Paket GPS dari socket publik tidak dipercaya: tanpa fix GPS (lat/lon tidak berarti) atau dengan jam
// perangkat di masa depan (jam salah) tidak boleh masuk jejak maupun posisi terakhir.
const MAX_FUTURE_MS = 10 * 60 * 1000;

/** Mengembalikan alasan penolakan, atau null jika paket layak disimpan sebagai posisi. */
function checkFix(data) {
  if (!data.gpsFixed) return 'tanpa fix GPS';
  const t = data.timestamp instanceof Date ? data.timestamp.getTime() : NaN;
  if (Number.isNaN(t)) return 'jam tidak valid';
  if (t > Date.now() + MAX_FUTURE_MS) return 'jam perangkat di masa depan';
  return null;
}

function safeIso(date) {
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : 'invalid';
}

/** Titik tersimpan yang dikirim ulang perangkat (jam lebih lama) tidak boleh menimpa posisi terbaru. */
function isNewerThanKnown(imei, timestamp) {
  const known = getDevice(imei);
  if (!known || !known.gpsTimestamp) return true;
  return timestamp.getTime() >= new Date(known.gpsTimestamp).getTime();
}

function positionPatch(data) {
  return {
    latitude: data.latitude,
    longitude: data.longitude,
    speed: data.speed,
    course: data.course,
    gpsTimestamp: data.timestamp.toISOString(),
  };
}

function handlePacket(socket, remote, packet, setImei, getImei) {
  const { protocolNumber, protocolHex, serialNumber, data } = packet;

  switch (protocolNumber) {
    case PROTOCOL.LOGIN: {
      const verdict = registry.evaluateLogin(data.imei);
      if (!verdict.allow) {
        log('warn', `[REG] LOGIN ditolak dari ${remote} imei=${JSON.stringify(data.imei)} status=${verdict.status}`);
        socket.destroy();
        break;
      }
      setImei(data.imei);
      log('info', `[LOGIN] ${remote} imei=${data.imei} serial=${serialNumber}`);
      updateDevice(data.imei, { ip: remote, connected: true });
      db.touchDevice(data.imei).catch((err) => log('error', `[DB] Gagal simpan login ${data.imei}: ${err.message}`));
      socket.write(buildAck(PROTOCOL.LOGIN, serialNumber));
      break;
    }

    case PROTOCOL.STATUS_HEARTBEAT: {
      log('info', `[HEARTBEAT] ${remote} imei=${getImei()} voltage=${data.voltageLevel} gsm=${data.gsmSignalStrength}`);
      if (getImei()) {
        updateDevice(getImei(), { connected: true, voltageLevel: data.voltageLevel, gsmSignalStrength: data.gsmSignalStrength });
        db.touchDevice(getImei()).catch((err) => log('error', `[DB] Gagal simpan heartbeat ${getImei()}: ${err.message}`));
      }
      socket.write(buildAck(PROTOCOL.STATUS_HEARTBEAT, serialNumber));
      break;
    }

    case PROTOCOL.GPS_LBS_1:
    case PROTOCOL.GPS_LBS_2:
    case PROTOCOL.GPS_LBS_STATUS: {
      const verdict = checkFix(data);
      log('info', `[GPS] ${remote} imei=${getImei()} lat=${data.latitude} lon=${data.longitude} speed=${data.speed}km/h ts=${safeIso(data.timestamp)}${verdict ? ` (${verdict}, tidak disimpan)` : ''}`);
      if (getImei()) {
        if (verdict) {
          updateDevice(getImei(), { connected: true });
        } else {
          updateDevice(getImei(), { connected: true, ...(isNewerThanKnown(getImei(), data.timestamp) ? positionPatch(data) : {}) });
          // Paket GPS tidak membawa voltage/gsm -- ambil nilai terakhir yang diketahui
          // dari heartbeat (kalau belum pernah ada heartbeat, tersimpan null).
          const known = getDevice(getImei());
          db.recordPosition({
            imei: getImei(),
            latitude: data.latitude,
            longitude: data.longitude,
            speed: data.speed,
            course: data.course,
            voltageLevel: known ? known.voltageLevel : null,
            gsmSignalStrength: known ? known.gsmSignalStrength : null,
            recordedAt: data.timestamp,
          }).catch((err) => log('error', `[DB] Gagal simpan posisi ${getImei()}: ${err.message}`));
        }
      }
      // Paket GPS umumnya tidak wajib di-ACK, tapi beberapa firmware mengharapkannya.
      break;
    }

    case PROTOCOL.ALARM: {
      const verdict = checkFix(data);
      log('warn', `[ALARM] ${remote} imei=${getImei()} jenis=${data.alarmType || '?'} lat=${data.latitude} lon=${data.longitude}${verdict ? ` (${verdict})` : ''}`);
      if (getImei()) {
        const known = getDevice(getImei());
        const patch = { connected: true, lastAlarm: new Date().toISOString(), lastAlarmType: data.alarmType || null };
        if (!verdict && isNewerThanKnown(getImei(), data.timestamp)) Object.assign(patch, positionPatch(data));
        updateDevice(getImei(), patch);
        db.recordAlarm({
          imei: getImei(),
          alarmType: data.alarmType || 'unknown',
          hasFix: !verdict,
          latitude: verdict ? null : data.latitude,
          longitude: verdict ? null : data.longitude,
          speed: data.speed,
          course: data.course,
          voltageLevel: data.voltageLevel ?? (known ? known.voltageLevel : null),
          gsmSignalStrength: data.gsmSignalStrength ?? (known ? known.gsmSignalStrength : null),
          // Alarm tanpa fix GPS tidak punya jam yang bisa dipercaya -> pakai jam server.
          recordedAt: verdict ? new Date() : data.timestamp,
        }).catch((err) => log('error', `[DB] Gagal simpan alarm ${getImei()}: ${err.message}`));
      }
      socket.write(buildAck(PROTOCOL.ALARM, serialNumber));
      break;
    }

    default: {
      log('info', `[${protocolHex}] ${remote} imei=${getImei()} data: ${JSON.stringify(data)}`);
    }
  }
}

server.maxConnections = MAX_CONNECTIONS;

server.on('drop', (data) => {
  log('warn', `[!] Koneksi dari ${data && data.remoteAddress} ditolak: batas ${MAX_CONNECTIONS} koneksi tercapai`);
});

server.on('error', (err) => {
  log('error', `[!] Server error: ${err.message}`);
});

const migrate = require('./migrate');

async function main() {
  // Beri migrasi kesempatan selesai dulu (maks 15 detik) supaya API tidak menyentuh skema
  // lama, tetapi jangan menahan penerimaan TCP kalau database sedang tidak siap -- migrasi
  // terus dicoba ulang di latar belakang (lihat src/migrate.js).
  let timer;
  await Promise.race([
    migrate.runWithRetry(),
    new Promise((resolve) => { timer = setTimeout(resolve, 15000); }),
  ]);
  clearTimeout(timer);

  server.listen(PORT, HOST, () => {
    log('info', `GT06 TCP server listening on ${HOST}:${PORT}`);
  });

  require('./web').start();
  registry.start();
  db.startRetentionSchedule();
  require('./backup').startBackupSchedule();
}

main();

function shutdown(signal) {
  log('info', `[i] Menerima ${signal}, menutup server...`);
  server.close(() => {
    log('info', '[i] Server ditutup, keluar.');
    process.exit(0);
  });
  // paksa keluar jika masih ada koneksi yang menggantung setelah 10 detik
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { server, buildAck };
