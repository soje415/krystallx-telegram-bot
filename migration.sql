-- KrystallX Shield — CEWN Tables
-- Run against: user-owned Supabase project (cdnjxxghqqgyqqjbmhbx)
-- Apply via: Supabase dashboard → SQL editor, or supabase db push

-- ── Civilian reporters registry ───────────────────────────────────
CREATE TABLE IF NOT EXISTS civilian_reporters (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id_hash  text        UNIQUE NOT NULL,
  tier                   text        NOT NULL DEFAULT 'ANONYMOUS',
  lga                    text,
  community              text,
  verified               boolean     NOT NULL DEFAULT false,
  report_count           integer     NOT NULL DEFAULT 0,
  accuracy_score         float       NOT NULL DEFAULT 0.5,
  onboarded_at           timestamptz NOT NULL DEFAULT now()
);

-- ── HUMINT reports from civilians ─────────────────────────────────
CREATE TABLE IF NOT EXISTS humint_reports (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id         uuid        REFERENCES civilian_reporters(id),
  raw_text            text,
  voice_note_url      text,
  location_text       text,
  coordinates         point,
  lga_tagged          text,
  threat_category     text        NOT NULL DEFAULT 'GENERAL',
  credibility_score   float       NOT NULL DEFAULT 0.5,
  corroboration_count integer     NOT NULL DEFAULT 0,
  status              text        NOT NULL DEFAULT 'PENDING',
  received_at         timestamptz NOT NULL DEFAULT now()
);

-- Index for 2-hour corroboration window query
CREATE INDEX IF NOT EXISTS humint_reports_lga_received
  ON humint_reports (lga_tagged, received_at DESC);

-- ── dispatch_log — add columns if table already exists ────────────
-- Run only if dispatch_log exists but is missing these columns.
-- Safe to run — uses IF NOT EXISTS / DO NOTHING pattern via separate statements.
ALTER TABLE IF EXISTS dispatch_log
  ADD COLUMN IF NOT EXISTS notes text;
