'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { bus, log, getHistory, getDevices } = require('./logger');

const WEB_PORT = process.env.WEB_PORT ? Number(process.env.WEB_PORT) : 8080;
const WEB_HOST = process.env.WEB_HOST || '0.0.0.0';

const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');

function start() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }

    if (req.url === '/' || req.url === '/index.html') {
      fs.readFile(INDEX_HTML_PATH, (err, content) => {
        if (err) {
          res.writeHead(500).end('Gagal memuat dashboard');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      });
      return;
    }

    if (req.url === '/api/devices') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(getDevices()));
      return;
    }

    if (req.url === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('\n');

      // kirim histori log & device yang sudah ada supaya tab baru langsung terisi
      for (const entry of getHistory()) {
        res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
      }
      for (const device of getDevices()) {
        res.write(`event: device\ndata: ${JSON.stringify(device)}\n\n`);
      }

      const onLog = (entry) => res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
      const onDevice = (device) => res.write(`event: device\ndata: ${JSON.stringify(device)}\n\n`);

      bus.on('log', onLog);
      bus.on('device', onDevice);

      const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);

      req.on('close', () => {
        clearInterval(keepAlive);
        bus.off('log', onLog);
        bus.off('device', onDevice);
      });
      return;
    }

    res.writeHead(404).end('Not found');
  });

  server.listen(WEB_PORT, WEB_HOST, () => {
    log('info', `Dashboard web listening on ${WEB_HOST}:${WEB_PORT}`);
  });

  return server;
}

module.exports = { start };
