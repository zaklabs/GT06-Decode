'use strict';

// Dipakai oleh Docker HEALTHCHECK. Server GT06 murni TCP (bukan HTTP),
// jadi cek kesehatan cukup dengan membuka koneksi TCP singkat ke port sendiri.
const net = require('net');

const PORT = process.env.GT06_PORT ? Number(process.env.GT06_PORT) : 5023;

const socket = net.createConnection({ host: '127.0.0.1', port: PORT }, () => {
  socket.end();
  process.exit(0);
});

socket.setTimeout(3000);

socket.on('timeout', () => {
  socket.destroy();
  process.exit(1);
});

socket.on('error', () => {
  process.exit(1);
});
