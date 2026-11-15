-- Migrasi 002: cakupan (scope) token API.
--   external : dipakai aplikasi lain untuk /api/external/* (perilaku token yang sudah ada)
--   admin    : dipakai GPS-Dashboard (sisi server) untuk /api/admin/*
-- Token yang sudah ada otomatis berscope 'external', jadi tidak ada perubahan perilaku.
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS scope VARCHAR(16) NOT NULL DEFAULT 'external';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_tokens_scope_check') THEN
    ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_scope_check CHECK (scope IN ('external', 'admin'));
  END IF;
END $$;
