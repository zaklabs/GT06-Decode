# GT06 Decode Server

Server TCP untuk menerima, decode, dan memantau data dari perangkat GPS tracker berprotokol **GT06 (Concox)** — dilengkapi dashboard web live untuk melihat log dan posisi device tanpa perlu buka terminal.

## Fitur

- Server TCP (`net`) yang menerima koneksi dari device GT06, dengan framing stream yang aman terhadap paket TCP yang terpotong/tergabung
- Decode paket: Login (`0x01`), GPS + LBS (`0x12`/`0x18`/`0x22`), Heartbeat/Status (`0x13`), Alarm (`0x16`), LBS multi-base (`0x1A`)
- Verifikasi CRC16/X-25 (CRC-ITU) dan auto-ACK untuk paket Login & Heartbeat
- Dashboard web live (log ala terminal + tabel device) via Server-Sent Events, tanpa dependency eksternal
- Siap dijalankan lewat Docker & Docker Compose untuk production

## Struktur proyek

```
.
├── src/
│   ├── crc.js          # CRC16/X-25 (CRC-ITU) untuk GT06
│   ├── parser.js        # Framing stream TCP + decode isi paket per protokol
│   ├── server.js         # TCP server, auto-ACK, tracking device
│   ├── logger.js         # Histori log + event bus untuk dashboard
│   ├── web.js             # HTTP server + SSE untuk dashboard
│   └── healthcheck.js     # Dipakai Docker HEALTHCHECK
├── public/
│   └── index.html         # Halaman dashboard (log terminal + tabel device)
├── examples/
│   └── decode-sample.js   # Contoh decode paket GT06 secara standalone
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## Menjalankan dengan Docker (production)

```bash
docker compose up -d --build
```

- Port device GT06: `5023` (TCP)
- Port dashboard web: `8080` (HTTP)

Cek status & log:

```bash
docker compose ps
docker compose logs -f gt06-server
```

Hentikan:

```bash
docker compose down
```

## Menjalankan tanpa Docker (development)

Butuh Node.js 18+ (direkomendasikan 22 LTS, sesuai `Dockerfile`).

```bash
npm start
```

Contoh decode paket standalone (tanpa perlu server/koneksi apapun):

```bash
npm run example
```

## Konfigurasi (environment variable)

| Variabel     | Default     | Keterangan                              |
|--------------|-------------|------------------------------------------|
| `GT06_PORT`  | `5023`      | Port TCP untuk koneksi device GT06        |
| `GT06_HOST`  | `0.0.0.0`   | Interface bind server TCP                 |
| `WEB_PORT`   | `8080`      | Port HTTP untuk dashboard                 |
| `WEB_HOST`   | `0.0.0.0`   | Interface bind dashboard web              |

Untuk `docker-compose.yml`, port host bisa diubah lewat env di luar container, contoh:

```bash
GT06_PORT=6023 WEB_PORT=9080 docker compose up -d
```

## Dashboard web

Buka `http://IP_SERVER:8080` di browser untuk melihat:

- **Log live** — setiap koneksi, login, posisi GPS, heartbeat, dan alarm, berwarna sesuai jenisnya, dengan filter dan auto-scroll
- **Tabel device** — IMEI, posisi terakhir (klik untuk buka Google Maps), kecepatan, level baterai, sinyal GSM, status online/offline

> ⚠️ **Dashboard belum ada autentikasi.** Untuk production, taruh di belakang reverse proxy (nginx/Caddy) dengan basic auth, atau batasi akses port `8080` hanya dari jaringan internal/VPN — jangan expose langsung ke publik karena menampilkan IMEI dan lokasi real-time semua device.

## Konfigurasi perangkat GT06 (SMS command)

Device dikonfigurasi lewat SMS ke nomor SIM yang terpasang di dalamnya (password default pabrik biasanya `123456`, cek stiker/manual bawaan bila berbeda).

**Set APN Telkomsel:**
```
APN,123456,internet#
```

**Arahkan device ke server ini:**
```
SERVER,123456,0,IP_ATAU_DOMAIN_SERVER,5023,0#
```
Ganti `IP_ATAU_DOMAIN_SERVER` dengan IP publik/domain server production, dan pastikan port `5023` terbuka di firewall (device yang konek keluar ke server).

**Interval kirim posisi (contoh 30 detik):**
```
TIMER,123456,30#
```

Setelah dikonfigurasi, pantau `docker compose logs -f` atau dashboard web — urutan normal: `[+] Koneksi baru` → `[LOGIN]` → `[GPS]` berkala.

## Catatan pengembangan

- Layout byte Alarm (`0x16`) mengikuti layout GPS standar; posisi byte terminal-info/alarm-type di akhir bisa berbeda tergantung firmware — sesuaikan bila punya sample paket real dari device yang dipakai.
- Belum ada penyimpanan ke database — tambahkan hook di `handlePacket()` pada [src/server.js](src/server.js) sesuai kebutuhan (mis. insert ke DB setiap event GPS).
