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
  id              BIGSERIAL PRIMARY KEY,
  imei            VARCHAR(20) NOT NULL REFERENCES devices(imei),
  latitude        DOUBLE PRECISION NOT NULL,
  longitude       DOUBLE PRECISION NOT NULL,
  speed           SMALLINT,
  course          SMALLINT,
  recorded_at     TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dipakai untuk query riwayat rute per device serta proses retensi (hapus data > 3 bulan)
CREATE INDEX IF NOT EXISTS idx_positions_imei_recorded_at ON positions (imei, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_positions_recorded_at ON positions (recorded_at);
