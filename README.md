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
│   ├── web.js             # HTTP server + SSE untuk dashboard + API eksternal
│   ├── tokens.js          # Buat/verifikasi/hapus token API eksternal
│   ├── auth.js            # Basic Auth admin (dashboard, token, endpoint internal)
│   ├── db.js              # Koneksi PostgreSQL + retensi data otomatis
│   └── healthcheck.js     # Dipakai Docker HEALTHCHECK
├── public/
│   └── index.html         # Halaman dashboard (log terminal + tabel device + tab Akses API)
├── db/
│   └── migrations/        # Migrasi SQL bernomor (001-baseline, 002-token-scope, 003-registered-devices) -- dijalankan otomatis oleh src/migrate.js saat server start
├── examples/
│   ├── decode-sample.js    # Contoh decode paket GT06 secara standalone
│   └── simulate-device.js  # Simulator device (kirim data ke server manapun)
├── Dockerfile
├── docker-compose.yml
├── .env.example        # Salin jadi .env, isi PGPASSWORD & ADMIN_PASSWORD sebelum docker compose up
└── package.json
```

## Menjalankan dengan Docker (production)

Salin `.env.example` jadi `.env`, isi password database dan password admin dashboard:

```bash
cp .env.example .env
# lalu edit .env, isi PGPASSWORD dan ADMIN_PASSWORD (mis. hasil `openssl rand -base64 24`)
```

```bash
docker compose up -d --build
```

Ini akan menjalankan 2 container: `gt06-postgres` (database) dan `gt06-server` (TCP server + dashboard). Skema tabel dibuat dan diperbarui otomatis oleh server saat start (lewat `db/migrations/`), baik untuk database baru maupun yang sudah berjalan.

- Port device GT06: `5023` (TCP) — dipublish ke semua interface host (device konek dari luar)
- Port dashboard web + API: `8080` di dalam container, dipublish ke host sebagai `127.0.0.1:8083` (default — hanya bisa diakses dari server itu sendiri; lihat [Keamanan](#keamanan))

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

Butuh Node.js 26 (LTS), sesuai `Dockerfile` dan `engines` di `package.json`, serta PostgreSQL untuk fitur penyimpanan/API token (tanpa PostgreSQL, server tetap jalan dan UI bisa dibuka, tetapi penyimpanan posisi, tab Akses API, dan riwayat posisi akan error di log).

```bash
npm start
```

Contoh decode paket standalone (tanpa perlu server/koneksi apapun):

```bash
npm run example
```

Tes otomatis (`node:test`):

```bash
npm test                                   # tes unit; tes integrasi dilewati otomatis
# tes integrasi butuh PostgreSQL KHUSUS TES -- tabelnya dikosongkan! Hanya jalan jika PGDATABASE berakhiran _test
PGHOST=... PGUSER=gt06 PGPASSWORD=... PGDATABASE=gt06_test npm test
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
| `RETENTION`  | `90d`       | Retensi data `positions`. Format `<angka>d/w/m/y` (hari/minggu/bulan/tahun), contoh `90d`, `12w`, `3m`, `1y` |
| `BACKUP`     | `monthly`   | Jadwal backup database: `daily` / `weekly` / `monthly` / `off` |
| `BACKUP_KEEP`| `6`         | Jumlah file backup terakhir yang disimpan (lebih lama dari ini otomatis dihapus) |
| `BACKUP_DIR` | `/backups`  | Folder penyimpanan file backup di dalam container (di-mount ke volume `pgbackups`) |
| `ADMIN_USER` | `admin`     | Username Basic Auth dashboard/manajemen token/endpoint internal |
| `ADMIN_PASSWORD` | *(wajib diisi, tanpa default)* | Password Basic Auth admin. Kalau kosong, dashboard & manajemen token dinonaktifkan (`503`); ingest & `/api/external/*` tetap jalan |
| `WEB_BIND`   | `127.0.0.1` | (docker compose saja) interface host tempat port web dipublish. `0.0.0.0` = semua interface |
| `GT06_MAX_CONNECTIONS` | `1000` | Batas koneksi TCP GT06 simultan |
| `GT06_IMEI_ENFORCE` | `log` | Daftar IMEI yang diizinkan: `off` (tidak diperiksa), `log` (semua diterima, yang belum terdaftar dicatat di log), `on` (hanya IMEI terdaftar & aktif yang diterima; lainnya diputus). Lihat [Daftar IMEI](#daftar-imei-dan-api-admin) |
| `GT06_MAX_BUFFER_BYTES` | `131072` | Batas sisa buffer per socket TCP (jaring pengaman) |
| `GT06_TRIP_STOP_SECONDS` | `180` | Diam selama ini (detik, 30-3600) memisahkan dua perjalanan di `/api/external/trips`. Bisa ditimpa per permintaan dengan `stop_seconds` |
| `GT06_TRIP_MIN_SPEED_KMH` | `3` | Kecepatan di bawah ini (km/jam, 1-30) dianggap diam |
| `GT06_LOGIN_TIMEOUT_MS` | `60000` | Koneksi TCP yang tidak mengirim paket LOGIN dalam waktu ini diputus |

Untuk `docker-compose.yml`, port host bisa diubah lewat env di luar container, contoh:

```bash
GT06_PORT=6023 WEB_PORT=9080 docker compose up -d
WEB_BIND=0.0.0.0 docker compose up -d   # publish port web ke semua interface (hati-hati, lihat Keamanan)
```

## Dashboard web

Buka `http://127.0.0.1:8083` di server (atau lewat SSH tunnel: `ssh -L 8083:127.0.0.1:8083 user@server`, lalu buka `http://localhost:8083` di laptop). Browser akan meminta login Basic Auth — isi `ADMIN_USER`/`ADMIN_PASSWORD`. Dashboard menampilkan:

- **Log live** — setiap koneksi, login, posisi GPS, heartbeat, dan alarm, berwarna sesuai jenisnya, dengan filter dan auto-scroll
- **Tabel device** — IMEI, posisi terakhir (klik untuk buka Google Maps), kecepatan, level baterai, sinyal GSM, status online/offline
- **Tombol "Hapus Log"** — mengosongkan log yang tampil di dashboard (di server, untuk semua orang yang sedang membuka dashboard ini). Ini **hanya membersihkan tampilan log operasional**, bukan menghapus data GPS di database — data historis di tabel `positions` tetap aman.

> Dashboard ini adalah alat **operasional/admin** (log mentah, IMEI, IP device, kelola token). Dashboard untuk pengguna akhir (login, peran) ditangani aplikasi terpisah **GPS-Dashboard** lewat API eksternal di bawah.

## API eksternal (untuk aplikasi lain, mis. GPS-Dashboard)

Tab **"Akses API"** di dashboard web dipakai untuk membuat/menghapus token yang mengizinkan aplikasi lain (bukan browser dashboard ini) mengambil data posisi device tanpa perlu koneksi langsung ke database:

- `GET /api/external/devices` — snapshot JSON semua device saat ini
- `GET /api/external/events` — SSE, event `device` dikirim realtime tiap ada posisi/status baru. Hanya event `device` yang dikirim (log operasional dashboard internal tidak ikut).
- `GET /api/external/positions?imei=&from=&to=&limit=` — riwayat posisi satu device (default 24 jam terakhir, `limit` default 5000, maks 20000). `imei` wajib (hex/digit, maks 20 karakter); `from`/`to` harus tanggal valid (disarankan ISO 8601 dengan zona waktu, mis. `2026-01-01T00:00:00+07:00`). Parameter tidak valid → `400`.
- `GET /api/external/trips?imei=&from=&to=&stop_seconds=` — ringkasan perjalanan satu device, dihitung dari riwayat posisi: `summary` (`tripCount`, `distanceMeters` = total tempuh, `drivingSeconds` = jam tempuh, `stoppedSeconds`, `maxSpeedKmh`, `avgSpeedKmh`), daftar `trips` (awal/akhir, durasi, jarak, kecepatan, posisi awal/akhir), daftar `stops` (perhentian di antara dua perjalanan), dan `status` (`moving`/`stopped`/`unknown` + `since`). Default 24 jam terakhir, rentang maksimal 31 hari. Perjalanan baru dimulai saat kendaraan bergerak (>= `GT06_TRIP_MIN_SPEED_KMH`) dan berakhir setelah diam >= `stop_seconds`. Hari kalender WIB ditentukan pemanggil lewat `from`/`to` (mis. `2026-11-15T00:00:00+07:00` s.d. `2026-11-16T00:00:00+07:00`). `truncated: true` bila data melebihi 100.000 titik.

Semuanya wajib header `Authorization: Bearer <token>`, request tanpa token atau dengan token yang salah/sudah dihapus akan dapat `401`.

Token hanya ditampilkan **sekali** saat dibuat (di dashboard, tab Akses API) — yang disimpan di database cuma hash SHA-256-nya. Kalau token hilang, hapus saja dan buat yang baru; tidak ada cara untuk melihat ulang token yang sama.

Error server (mis. database bermasalah) dibalas `500` dengan pesan generik; detailnya hanya dicatat di log server.

Contoh dari GPS-Dashboard (sisi server, token disimpan di env server — jangan dikirim ke browser):

```bash
curl -H "Authorization: Bearer $GT06_API_TOKEN" http://gt06-server:8080/api/external/devices
```

> Endpoint `/api/devices`, `/api/events`, `/api/logs`, `/api/tokens*`, dan `/api/internal/*` (tanpa `/external/`) khusus dashboard internal & admin — wajib Basic Auth `ADMIN_USER`/`ADMIN_PASSWORD`, bukan Bearer token. `EventSource` di browser tidak bisa kirim header custom, tapi kredensial Basic Auth yang sudah dimasukkan otomatis ikut terkirim untuk request same-origin.

## Daftar IMEI dan API admin

Daftar IMEI perangkat yang diizinkan disimpan di tabel `registered_devices` dan dikelola lewat **API admin** (`/api/admin/*`), yang dipanggil dari sisi server oleh aplikasi lain seperti GPS-Dashboard. Kontrak lengkap: [docs/admin-api.md](docs/admin-api.md).

- Autentikasi: Basic Auth `ADMIN_USER`/`ADMIN_PASSWORD`, atau token Bearer ber-**scope `admin`**. Tanpa `ADMIN_PASSWORD` seluruh API ini nonaktif (`503`).
- Token punya dua scope: `external` (`/api/external/*`, perilaku lama) dan `admin` (`/api/admin/*`). Keduanya tidak saling berlaku. Token `admin` hanya bisa dibuat dengan Basic Auth, dan token `admin` tidak bisa membuat/menghapus token `admin` lain.
- Mulai dari `GT06_IMEI_ENFORCE=log` (default): semua perangkat tetap diterima dan IMEI yang belum terdaftar muncul sebagai peringatan `[REG]` di log. Setelah semua perangkat aktif terdaftar (`POST /api/admin/registry/import-seen` mendaftarkan semua yang pernah terlihat), ganti ke `on`.
- Di mode `on`, perangkat yang dihapus/dinonaktifkan dari daftar langsung diputus. Jika database belum siap, mode `on` menolak LOGIN sampai daftar termuat (perangkat akan mencoba konek ulang).
- LOGIN dengan IMEI kosong atau bukan heksadesimal selalu ditolak, apa pun modenya.

Membuat token admin pertama (sekali, oleh pemilik server; simpan hasilnya di env server aplikasi pemanggil, jangan ke browser):

```bash
curl -u "$ADMIN_USER:$ADMIN_PASSWORD" -H 'Content-Type: application/json' \
  -d '{"label":"gps-dashboard admin","scope":"admin"}' \
  http://127.0.0.1:8083/api/admin/tokens
```

## Keamanan

- **Basic Auth admin**: dashboard (`/`), `/api/devices`, `/api/events`, `/api/logs`, `/api/tokens*`, `/api/internal/*` wajib `ADMIN_USER`/`ADMIN_PASSWORD` (dibandingkan constant-time). Tidak ada password default; tanpa `ADMIN_PASSWORD` semua route itu membalas `503`.
- **Basic Auth tidak mengenkripsi kredensial** — jangan akses dashboard lewat HTTP polos di jaringan publik. Pakai SSH tunnel, VPN, atau reverse proxy HTTPS (Caddy/nginx) di depan port web.
- **Port web default hanya `127.0.0.1`** di host (`WEB_BIND`). Port TCP GT06 (`5023`) tetap publik karena device konek dari internet.
- **GPS-Dashboard** sebaiknya berjalan di jaringan Docker yang sama dan memanggil `http://gt06-server:8080/api/external/...` dari sisi server dengan Bearer token — tidak perlu membuka port web ke publik. Contoh menyambungkan ke network compose ini: tambahkan network eksternal `<folder>_default` (mis. `gt06-decode_default`; cek dengan `docker network ls`) ke service GPS-Dashboard.
- **Token API** hanya disimpan sebagai hash SHA-256. Buat satu token per aplikasi/lingkungan agar bisa dicabut terpisah.
- **Jangan commit dump/backup database** (`*.dump` sudah di-ignore) — isinya IMEI dan riwayat lokasi.
- TCP GT06 dibatasi `GT06_MAX_CONNECTIONS`, `GT06_MAX_BUFFER_BYTES`, dan `GT06_LOGIN_TIMEOUT_MS`.
- Permintaan yang mengubah data (POST/PATCH/DELETE) ke route admin dengan Basic Auth ditolak (`403`) bila header `Origin`-nya bukan host yang sama (proteksi CSRF). Klien tanpa `Origin` (curl, server lain) tidak terpengaruh.

### Migrasi server produksi yang sudah berjalan

1. Tambahkan ke `.env` produksi: `ADMIN_PASSWORD=<password acak yang kuat>` (opsional `ADMIN_USER`). Tanpa ini dashboard & tab Akses API akan membalas `503` setelah update.
2. Port web kini default hanya di `127.0.0.1:8083`. Kalau ada yang selama ini mengakses `http://IP_SERVER:8083` langsung (mis. GPS-Dashboard di host lain), pilih salah satu: sambungkan ke jaringan Docker, pasang reverse proxy HTTPS, atau set `WEB_BIND=0.0.0.0` secara sadar (+ firewall).
3. `docker compose up -d --build`.
4. **Rotasi semua token API**: sebelum versi ini `/api/tokens` bisa dipanggil tanpa autentikasi, jadi token bisa saja dibuat pihak lain. Buka tab Akses API, hapus semua token lama (perhatikan label/`last_used_at` yang tidak dikenal), buat token baru, dan perbarui di GPS-Dashboard.
5. Konsumen `/api/external/events` kini hanya menerima event `device` (sebelumnya juga `log`/`clear`). Kalau ada konsumen yang bergantung pada event `log`, sesuaikan.
6. `npm run reload-devices` di dalam container otomatis memakai `ADMIN_USER`/`ADMIN_PASSWORD` dari env container.
7. **Update yang menambah daftar IMEI & API admin:** `docker compose up -d --build` lalu server menjalankan migrasi 001-003 sendiri saat start (data lama aman; token lama otomatis berscope `external`). Mode awal `GT06_IMEI_ENFORCE=log` tidak menolak perangkat mana pun. Mount `db/schema.sql` ke container Postgres dihapus dari `docker-compose.yml`, karena skema kini dikelola migrasi.
8. **Update posisi terakhir, alarm, dan perjalanan:** migrasi `004` berjalan otomatis saat start. **Migrasi ini menghapus baris `positions` yang duplikat** (`imei` dan `recorded_at` sama; yang `id`-nya terkecil dipertahankan) sebelum memasang `UNIQUE`. Buat backup dulu (`docker compose exec gt06-postgres pg_dump ...` atau backup bulanan bawaan). Setelah itu: posisi terakhir tidak lagi tertimpa titik lama, titik tanpa fix GPS atau berjam lebih dari 10 menit di masa depan tidak disimpan, alarm masuk tabel `alarms`, dan `/api/external/trips` tersedia (tambahan, tidak mengubah endpoint lama). `npm test` kini menjalankan file tes berurutan karena tes integrasi berbagi satu database.

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

Tabel utama (lihat [db/migrations/](db/migrations/); tabel `api_tokens` dan `registered_devices` dijelaskan di bagian API):

- **`devices`** — 1 baris per device, state TERKINI (posisi, kecepatan, status online, terakhir dilihat). Dipakai aplikasi dashboard/peta terpisah untuk render marker.
- **`positions`** — riwayat posisi, append-only. Dipakai untuk gambar rute/playback di peta. Kolom `voltage_level`/`gsm_signal_strength` menyimpan nilai TERAKHIR yang diketahui dari paket Heartbeat (0x13) saat posisi itu dicatat — paket GPS sendiri tidak membawa info ini, jadi bukan pembacaan persis di detik yang sama, cuma nilai terakhir yang tersedia di memori server saat itu (`null` kalau belum pernah ada heartbeat, atau untuk baris lama sebelum kolom ini ditambahkan).

**Retensi otomatis** ([src/db.js](src/db.js)): baris `positions` yang `recorded_at`-nya lebih tua dari `RETENTION` (default `90d`) dihapus otomatis, dicek tiap 24 jam (jalan juga sekali saat server baru start). Format `RETENTION`: angka + satuan `d`/`w`/`m`/`y` (hari/minggu/bulan/tahun) — contoh `90d`, `12w`, `3m`, `1y`. Tabel `devices` tidak kena retensi karena cuma menyimpan state terkini, tidak menumpuk.

**Backup otomatis** ([src/backup.js](src/backup.js)): `pg_dump` terjadwal sesuai `BACKUP` (`daily`/`weekly`/`monthly`/`off`, default `monthly`), dijalankan otomatis setelah jam 03:00 waktu container di hari/minggu/bulan yang belum kebagian backup. File disimpan di volume `pgbackups` (path `/backups` di dalam container) dengan format `gt06-<database>-<timestamp>.dump`, dan hanya `BACKUP_KEEP` file terakhir yang disimpan (default `6`) — lebih lama dari itu otomatis dihapus.

> Catatan: pengecekan jadwal jalan tiap jam (bukan menghitung mundur presis ke tanggal target), jadi kalau server sempat mati pas jadwalnya lewat, backup akan otomatis "menyusul" di jam berikutnya setelah server nyala lagi — tidak akan terlewat begitu saja.

> **Migrasi skema**: dikelola otomatis oleh [src/migrate.js](src/migrate.js). Saat server start, berkas `db/migrations/NNN-*.sql` yang belum tercatat di tabel `schema_migrations` dijalankan berurutan (satu transaksi per berkas, dengan advisory lock). Tidak perlu `ALTER` manual lagi. Jika database belum siap saat start, migrasi dicoba ulang tiap 30 detik tanpa menghentikan penerimaan TCP. Untuk menambah perubahan skema, buat berkas baru dengan nomor berikutnya dan tulis secara idempoten (`IF NOT EXISTS`).

**Penting — dashboard & API TIDAK membaca dari database secara langsung.** Tabel `devices`/`positions` cuma ditulis (fire-and-forget) untuk histori/dashboard eksternal; dashboard web ini dan endpoint `/api/devices`, `/api/events`, `/api/external/devices`, `/api/external/events` menampilkan state di **memori proses** yang cuma terisi dari device yang benar-benar konek lewat TCP. Konsekuensinya: setelah restore data (mis. dari server produksi) atau restart server, dashboard akan tampak kosong sampai device asli konek lagi — walau datanya sudah ada di database.

Kalau perlu langsung menampilkan data yang ada di database (tanpa menunggu device live), jalankan:

```bash
docker compose exec gt06-server npm run reload-devices
```

Ini memuat state terakhir tiap device dari tabel `devices` ke memori (ditandai offline/`connected: false` karena bukan sesi live), tanpa menimpa device yang sedang benar-benar konek. Lihat [scripts/reload-devices.js](scripts/reload-devices.js).

Contoh cek data & backup langsung dari container:
```bash
# Lihat isi tabel
docker compose exec postgres psql -U gt06 -d gt06 -c "SELECT * FROM devices;"
docker compose exec postgres psql -U gt06 -d gt06 -c "SELECT * FROM positions ORDER BY id DESC LIMIT 10;"

# Lihat file backup yang tersimpan
docker compose exec gt06-server ls -la /backups

# Restore manual dari file backup (dijalankan dari container gt06-server,
# karena situ tempat file /backups & pg_restore ter-mount, terhubung ke postgres lewat jaringan)
docker compose exec gt06-server pg_restore -h postgres -U gt06 -d gt06 --clean --if-exists /backups/NAMA_FILE.dump
```

## Catatan pengembangan

- Layout byte Alarm (`0x16`) mengikuti layout GPS standar; posisi byte terminal-info/alarm-type di akhir bisa berbeda tergantung firmware — sesuaikan bila punya sample paket real dari device yang dipakai.
- **Field jam di paket GPS/LBS device armada ini adalah jam LOKAL (Asia/Jakarta, GMT+7), bukan UTC** seperti asumsi standar kebanyakan implementasi GT06 — lihat `DEVICE_TZ_OFFSET_HOURS` di [src/parser.js](src/parser.js). Kalau nanti ada device dari vendor/konfigurasi lain yang justru kirim UTC asli, field ini perlu disesuaikan per-device (saat ini hardcode berlaku untuk semua device).
