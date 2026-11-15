-- Migrasi 004: urutan waktu posisi terakhir, anti-duplikat riwayat, dan tabel alarm.
--
-- 1) devices.last_position_at: jam (dari perangkat) posisi yang tersimpan di last_*.
--    Dipakai supaya titik tersimpan yang dikirim ulang perangkat (jam lama) tidak
--    menimpa posisi terbaru.
-- 2) UNIQUE (imei, recorded_at) di positions: titik yang sama tidak tersimpan dua kali.
--    Baris duplikat yang SUDAH ada dihapus (yang id-nya terkecil dipertahankan).
-- 3) alarms: alarm (paket 0x16) disimpan terpisah dari jejak posisi, lengkap dengan jenisnya.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_position_at TIMESTAMPTZ;

UPDATE devices d
SET last_position_at = p.latest
FROM (SELECT imei, max(recorded_at) AS latest FROM positions GROUP BY imei) p
WHERE p.imei = d.imei AND d.last_position_at IS NULL;

DELETE FROM positions a
USING positions b
WHERE a.imei = b.imei AND a.recorded_at = b.recorded_at AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_positions_imei_recorded_at ON positions (imei, recorded_at);

CREATE TABLE IF NOT EXISTS alarms (
  id                    BIGSERIAL PRIMARY KEY,
  imei                  VARCHAR(20) NOT NULL REFERENCES devices(imei),
  alarm_type            VARCHAR(20) NOT NULL,
  latitude              DOUBLE PRECISION,
  longitude             DOUBLE PRECISION,
  speed                 SMALLINT,
  course                SMALLINT,
  voltage_level         SMALLINT,
  gsm_signal_strength   SMALLINT,
  recorded_at           TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (imei, recorded_at, alarm_type)
);

CREATE INDEX IF NOT EXISTS idx_alarms_imei_recorded_at ON alarms (imei, recorded_at DESC);
