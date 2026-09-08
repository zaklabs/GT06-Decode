-- Skema database GT06 Decode.
-- File ini otomatis dijalankan oleh image resmi PostgreSQL saat container pertama kali
-- dibuat (lewat /docker-entrypoint-initdb.d/), jadi tidak perlu migrasi manual.

CREATE TABLE IF NOT EXISTS devices (
  imei            VARCHAR(20) PRIMARY KEY,
  label           VARCHAR(100),
  last_latitude   DOUBLE PRECISION,
  last_longitude  DOUBLE PRECISION,
  last_speed      SMALLINT,
  last_course     SMALLINT,
  last_seen_at    TIMESTAMPTZ,
  is_online       BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS positions (
  id                    BIGSERIAL PRIMARY KEY,
  imei                  VARCHAR(20) NOT NULL REFERENCES devices(imei),
  latitude              DOUBLE PRECISION NOT NULL,
  longitude             DOUBLE PRECISION NOT NULL,
  speed                 SMALLINT,
  course                SMALLINT,
  -- voltage_level/gsm_signal_strength: nilai TERAKHIR yang diketahui dari paket
  -- Heartbeat (0x13) saat posisi ini dicatat -- paket GPS sendiri tidak membawa
  -- info ini, jadi bukan pembacaan persis di detik yang sama, cuma nilai terakhir
  -- yang tersedia di memori server saat itu (lihat src/server.js).
  voltage_level         SMALLINT,
  gsm_signal_strength   SMALLINT,
  recorded_at           TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dipakai untuk query riwayat rute per device serta proses retensi (hapus data > 3 bulan)
CREATE INDEX IF NOT EXISTS idx_positions_imei_recorded_at ON positions (imei, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_positions_recorded_at ON positions (recorded_at);

-- =========================================================
-- Token akses API untuk aplikasi eksternal (mis. gps-dash)
-- =========================================================
-- Dikelola lewat tab "Akses API" di dashboard web (buat/hapus token).
-- Menggantikan pendekatan koneksi database langsung / view -- aplikasi
-- eksternal ambil data lewat /api/external/devices & /api/external/events
-- (lihat src/web.js), bukan lewat query SQL ke database ini.
--
-- token_hash: SHA-256 dari token asli -- token plaintext hanya ditampilkan
-- sekali saat dibuat, tidak pernah disimpan.
CREATE TABLE IF NOT EXISTS api_tokens (
  id            SERIAL PRIMARY KEY,
  label         VARCHAR(100) NOT NULL,
  token_hash    CHAR(64) NOT NULL UNIQUE,
  token_prefix  VARCHAR(16) NOT NULL,   -- buat ditampilkan di daftar, tidak cukup buat menebak token
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);
