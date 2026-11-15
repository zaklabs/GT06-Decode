-- Migrasi 003: daftar IMEI perangkat yang diizinkan (allowlist).
-- Dibaca saat paket LOGIN GT06 untuk keputusan menerima/menolak perangkat
-- (lihat GT06_IMEI_ENFORCE di README). Data kendaraan lain (plat, dsb.) sengaja
-- TIDAK disimpan di sini; itu milik aplikasi GPS-Dashboard.
CREATE TABLE IF NOT EXISTS registered_devices (
  imei        VARCHAR(20) PRIMARY KEY,
  label       VARCHAR(100) NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
