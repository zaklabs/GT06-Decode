'use strict';

/**
 * CRC16/X-25 (a.k.a. CRC-ITU) dipakai oleh protokol GT06.
 * poly=0x8408 (refleksi dari 0x1021), init=0xFFFF, xorout=0xFFFF, refin/refout=true.
 * Dihitung mulai dari byte Length sampai Serial Number (tidak termasuk Start Bit & CRC itu sendiri).
 */
function crc16X25(buffer) {
  let crc = 0xffff;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 0x0001) {
        crc = (crc >> 1) ^ 0x8408;
      } else {
        crc = crc >> 1;
      }
    }
  }
  return (~crc) & 0xffff;
}

module.exports = { crc16X25 };
