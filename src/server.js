'use strict';

const net = require('net');
const { crc16X25 } = require('./crc');
const { splitFrames, decodeFrame, PROTOCOL } = require('./parser');
const { log, updateDevice } = require('./logger');

const PORT = process.env.GT06_PORT ? Number(process.env.GT06_PORT) : 5023;
const HOST = process.env.GT06_HOST || '0.0.0.0';

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

const server = net.createServer((socket) => {
  socket.setKeepAlive(true, 60000);

  let buffer = Buffer.alloc(0);
  let imei = null;
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;

  log('info', `[+] Koneksi baru dari ${remote}`);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    const { frames, rest } = splitFrames(buffer);
    buffer = rest;

    for (const frame of frames) {
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

      handlePacket(socket, remote, packet, (v) => { imei = v; }, () => imei);
    }
  });

  socket.on('close', () => {
    log('info', `[-] Koneksi ditutup: ${remote} (imei: ${imei || 'unknown'})`);
    if (imei) updateDevice(imei, { connected: false });
  });

  socket.on('error', (err) => {
    log('error', `[!] Socket error dari ${remote}: ${err.message}`);
  });
});

function handlePacket(socket, remote, packet, setImei, getImei) {
  const { protocolNumber, protocolHex, serialNumber, data } = packet;

  switch (protocolNumber) {
    case PROTOCOL.LOGIN: {
      setImei(data.imei);
      log('info', `[LOGIN] ${remote} imei=${data.imei} serial=${serialNumber}`);
      updateDevice(data.imei, { ip: remote, connected: true });
      socket.write(buildAck(PROTOCOL.LOGIN, serialNumber));
      break;
    }

    case PROTOCOL.STATUS_HEARTBEAT: {
      log('info', `[HEARTBEAT] ${remote} imei=${getImei()} voltage=${data.voltageLevel} gsm=${data.gsmSignalStrength}`);
      if (getImei()) updateDevice(getImei(), { connected: true, voltageLevel: data.voltageLevel, gsmSignalStrength: data.gsmSignalStrength });
      socket.write(buildAck(PROTOCOL.STATUS_HEARTBEAT, serialNumber));
      break;
    }

    case PROTOCOL.GPS_LBS_1:
    case PROTOCOL.GPS_LBS_2:
    case PROTOCOL.GPS_LBS_STATUS: {
      log('info', `[GPS] ${remote} imei=${getImei()} lat=${data.latitude} lon=${data.longitude} speed=${data.speed}km/h ts=${data.timestamp.toISOString()}`);
      if (getImei()) {
        updateDevice(getImei(), {
          connected: true,
          latitude: data.latitude,
          longitude: data.longitude,
          speed: data.speed,
          course: data.course,
          gpsTimestamp: data.timestamp.toISOString(),
        });
      }
      // Paket GPS umumnya tidak wajib di-ACK, tapi beberapa firmware mengharapkannya.
      break;
    }

    case PROTOCOL.ALARM: {
      log('warn', `[ALARM] ${remote} imei=${getImei()} lat=${data.latitude} lon=${data.longitude}`);
      if (getImei()) updateDevice(getImei(), { connected: true, latitude: data.latitude, longitude: data.longitude, lastAlarm: new Date().toISOString() });
      socket.write(buildAck(PROTOCOL.ALARM, serialNumber));
      break;
    }

    default: {
      log('info', `[${protocolHex}] ${remote} imei=${getImei()} data: ${JSON.stringify(data)}`);
    }
  }
}

server.on('error', (err) => {
  log('error', `[!] Server error: ${err.message}`);
});

server.listen(PORT, HOST, () => {
  log('info', `GT06 TCP server listening on ${HOST}:${PORT}`);
});

require('./web').start();

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
