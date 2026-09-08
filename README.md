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
│   ├── db.js              # Koneksi PostgreSQL + retensi data otomatis
│   └── healthcheck.js     # Dipakai Docker HEALTHCHECK
├── public/
│   └── index.html         # Halaman dashboard (log terminal + tabel device + tab Akses API)
├── db/
│   └── schema.sql         # Skema tabel `devices`, `positions`, `api_tokens` -- auto-jalan saat container pertama kali dibuat
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
| `RETENTION`  | `90d`       | Retensi data `positions`. Format `<angka>d/w/m/y` (hari/minggu/bulan/tahun), contoh `90d`, `12w`, `3m`, `1y` |
| `BACKUP`     | `monthly`   | Jadwal backup database: `daily` / `weekly` / `monthly` / `off` |
| `BACKUP_KEEP`| `6`         | Jumlah file backup terakhir yang disimpan (lebih lama dari ini otomatis dihapus) |
| `BACKUP_DIR` | `/backups`  | Folder penyimpanan file backup di dalam container (di-mount ke volume `pgbackups`) |

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

## API eksternal (untuk aplikasi lain, mis. gps-dash)

Tab **"Akses API"** di dashboard web dipakai untuk membuat/menghapus token yang mengizinkan aplikasi lain (bukan browser dashboard ini) mengambil data posisi device tanpa perlu koneksi langsung ke database:

- `GET /api/external/devices` — snapshot JSON semua device saat ini
- `GET /api/external/events` — SSE, event `device` dikirim realtime tiap ada posisi/status baru (sama seperti yang dipakai dashboard internal, tapi lewat token)

Keduanya wajib header `Authorization: Bearer <token>`, request tanpa token atau dengan token yang salah/sudah dihapus akan dapat `401`.

Token hanya ditampilkan **sekali** saat dibuat (di dashboard, tab Akses API) — yang disimpan di database cuma hash SHA-256-nya. Kalau token hilang, hapus saja dan buat yang baru; tidak ada cara untuk melihat ulang token yang sama.

> Catatan: endpoint `/api/devices` & `/api/events` (tanpa `/external/`) tetap tanpa token — itu dipakai dashboard browser ini sendiri (lewat `EventSource`, yang tidak bisa kirim header custom), jadi tetap mengandalkan proteksi jaringan/VPN seperti di atas. Endpoint `/api/tokens` (kelola token) juga tanpa token tersendiri — levelnya sama seperti dashboard secara keseluruhan.

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
- **`positions`** — riwayat posisi, append-only. Dipakai untuk gambar rute/playback di peta. Kolom `voltage_level`/`gsm_signal_strength` menyimpan nilai TERAKHIR yang diketahui dari paket Heartbeat (0x13) saat posisi itu dicatat — paket GPS sendiri tidak membawa info ini, jadi bukan pembacaan persis di detik yang sama, cuma nilai terakhir yang tersedia di memori server saat itu (`null` kalau belum pernah ada heartbeat, atau untuk baris lama sebelum kolom ini ditambahkan).

**Retensi otomatis** ([src/db.js](src/db.js)): baris `positions` yang `recorded_at`-nya lebih tua dari `RETENTION` (default `90d`) dihapus otomatis, dicek tiap 24 jam (jalan juga sekali saat server baru start). Format `RETENTION`: angka + satuan `d`/`w`/`m`/`y` (hari/minggu/bulan/tahun) — contoh `90d`, `12w`, `3m`, `1y`. Tabel `devices` tidak kena retensi karena cuma menyimpan state terkini, tidak menumpuk.

**Backup otomatis** ([src/backup.js](src/backup.js)): `pg_dump` terjadwal sesuai `BACKUP` (`daily`/`weekly`/`monthly`/`off`, default `monthly`), dijalankan otomatis setelah jam 03:00 waktu container di hari/minggu/bulan yang belum kebagian backup. File disimpan di volume `pgbackups` (path `/backups` di dalam container) dengan format `gt06-<database>-<timestamp>.dump`, dan hanya `BACKUP_KEEP` file terakhir yang disimpan (default `6`) — lebih lama dari itu otomatis dihapus.

> Catatan: pengecekan jadwal jalan tiap jam (bukan menghitung mundur presis ke tanggal target), jadi kalau server sempat mati pas jadwalnya lewat, backup akan otomatis "menyusul" di jam berikutnya setelah server nyala lagi — tidak akan terlewat begitu saja.

> **Migrasi untuk database yang sudah jalan lama**: `db/schema.sql` cuma otomatis jalan saat volume Postgres pertama kali dibuat. Kalau database Anda sudah ada sebelum kolom `voltage_level`/`gsm_signal_strength` ditambahkan ke tabel `positions`, jalankan manual:
> ```bash
> docker compose exec postgres psql -U gt06 -d gt06 -c "ALTER TABLE positions ADD COLUMN IF NOT EXISTS voltage_level SMALLINT; ALTER TABLE positions ADD COLUMN IF NOT EXISTS gsm_signal_strength SMALLINT;"
> ```

**Penting — dashboard & API TIDAK membaca dari database secara langsung.** Tabel `devices`/`positions` cuma ditulis (fire-and-forget) untuk histori/dashboard eksternal; dashboard web ini dan endpoint `/api/devices`, `/api/events`, `/api/external/*` menampilkan state di **memori proses** yang cuma terisi dari device yang benar-benar konek lewat TCP. Konsekuensinya: setelah restore data (mis. dari server produksi) atau restart server, dashboard akan tampak kosong sampai device asli konek lagi — walau datanya sudah ada di database.

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
