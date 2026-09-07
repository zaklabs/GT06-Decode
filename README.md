# GT06 Decode Server

Server TCP untuk menerima, decode, dan memantau data dari perangkat GPS tracker berprotokol **GT06 (Concox)** — dilengkapi dashboard web live untuk melihat log dan posisi device tanpa perlu buka terminal.

## Fitur

- Server TCP (`net`) yang menerima koneksi dari device GT06, dengan framing stream yang aman terhadap paket TCP yang terpotong/tergabung
- Decode paket: Login (`0x01`), GPS + LBS (`0x12`/`0x18`/`0x22`), Heartbeat/Status (`0x13`), Alarm (`0x16`), LBS multi-base (`0x1A`)
- Verifikasi CRC16/X-25 (CRC-ITU) dan auto-ACK untuk paket Login & Heartbeat
- Dashboard web live (log ala terminal + tabel device) via Server-Sent Events, tanpa dependency eksternal
- Penyimpanan posisi & status device ke **PostgreSQL** (dipakai aplikasi dashboard/peta terpisah), dengan retensi otomatis
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
│   ├── db.js              # Koneksi PostgreSQL + retensi data otomatis
│   └── healthcheck.js     # Dipakai Docker HEALTHCHECK
├── public/
│   └── index.html         # Halaman dashboard (log terminal + tabel device)
├── db/
│   └── schema.sql         # Skema tabel `devices` & `positions`, auto-jalan saat container pertama kali dibuat
├── examples/
│   ├── decode-sample.js    # Contoh decode paket GT06 secara standalone
│   └── simulate-device.js  # Simulator device (kirim data ke server manapun)
├── Dockerfile
├── docker-compose.yml
├── .env.example        # Salin jadi .env, isi PGPASSWORD sebelum docker compose up
└── package.json
```

## Menjalankan dengan Docker (production)

Salin `.env.example` jadi `.env`, isi password database:

```bash
cp .env.example .env
# lalu edit .env, isi PGPASSWORD
```

```bash
docker compose up -d --build
```

Ini akan menjalankan 2 container: `gt06-postgres` (database) dan `gt06-server` (TCP server + dashboard). Skema tabel dibuat otomatis saat pertama kali dijalankan (lewat `db/schema.sql`).

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
| `PGHOST`     | `localhost` | Host PostgreSQL (`postgres` di docker compose) |
| `PGPORT`     | `5432`      | Port PostgreSQL                           |
| `PGDATABASE` | `gt06`      | Nama database                             |
| `PGUSER`     | `gt06`      | User PostgreSQL                           |
| `PGPASSWORD` | *(wajib diisi)* | Password PostgreSQL — isi lewat file `.env`, jangan hardcode |
| `RETENTION_DAYS` | `90`    | Data di tabel `positions` lebih tua dari ini dihapus otomatis tiap hari |

Untuk `docker-compose.yml`, port host bisa diubah lewat env di luar container, contoh:

```bash
GT06_PORT=6023 WEB_PORT=9080 docker compose up -d
```

## Dashboard web

Buka `http://IP_SERVER:8080` di browser untuk melihat:

- **Log live** — setiap koneksi, login, posisi GPS, heartbeat, dan alarm, berwarna sesuai jenisnya, dengan filter dan auto-scroll
- **Tabel device** — IMEI, posisi terakhir (klik untuk buka Google Maps), kecepatan, level baterai, sinyal GSM, status online/offline
- **Tombol "Hapus Log"** — mengosongkan log yang tampil di dashboard (di server, untuk semua orang yang sedang membuka dashboard ini). Ini **hanya membersihkan tampilan log operasional**, bukan menghapus data GPS di database — data historis di tabel `positions` tetap aman.

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

## Database (PostgreSQL)

Setiap event Login/Heartbeat/GPS/Alarm otomatis disimpan ke PostgreSQL lewat [src/db.js](src/db.js) — dipanggil dari [src/server.js](src/server.js), fire-and-forget (kalau database sempat down, ingest GT06 tetap jalan normal, error cuma dicatat di log).

Dua tabel (lihat [db/schema.sql](db/schema.sql)):

- **`devices`** — 1 baris per device, state TERKINI (posisi, kecepatan, status online, terakhir dilihat). Dipakai aplikasi dashboard/peta terpisah untuk render marker.
- **`positions`** — riwayat posisi, append-only. Dipakai untuk gambar rute/playback di peta.

**Retensi otomatis:** baris `positions` yang `recorded_at`-nya lebih tua dari `RETENTION_DAYS` (default 90 hari) dihapus otomatis tiap 24 jam (jalan juga sekali saat server baru start). Tabel `devices` tidak kena retensi karena cuma menyimpan state terkini, tidak menumpuk.

**Backup:** retensi di atas hanya mengatur data *live*. Backup periodik (`pg_dump` terjadwal, disimpan di lokasi terpisah dari server) belum termasuk di setup ini — akan ditambahkan sebagai langkah terpisah.

Contoh cek data langsung dari database:
```bash
docker compose exec postgres psql -U gt06 -d gt06 -c "SELECT * FROM devices;"
docker compose exec postgres psql -U gt06 -d gt06 -c "SELECT * FROM positions ORDER BY id DESC LIMIT 10;"
```

## Catatan pengembangan

- Layout byte Alarm (`0x16`) mengikuti layout GPS standar; posisi byte terminal-info/alarm-type di akhir bisa berbeda tergantung firmware — sesuaikan bila punya sample paket real dari device yang dipakai.
