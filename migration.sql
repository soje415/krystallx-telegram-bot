-- KrystallX Shield — Full Schema
-- Project: cdnjxxghqqgyqqjbmhbx
-- Run via: Supabase dashboard → SQL editor
-- All statements use IF NOT EXISTS / IF EXISTS — safe to re-run.

-- ── Conversation state (DB-backed, survives bot restarts) ─────────
CREATE TABLE IF NOT EXISTS bot_conv_state (
  chat_id    text        PRIMARY KEY,
  step       text        NOT NULL DEFAULT 'START',
  data       jsonb       NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

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

CREATE INDEX IF NOT EXISTS humint_reports_lga_received
  ON humint_reports (lga_tagged, received_at DESC);

-- ── Military commanders / HUMINT sources ─────────────────────────
-- Rows inserted manually or via admin panel. Bot reads this table only.
CREATE TABLE IF NOT EXISTS humint_sources (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id text        UNIQUE NOT NULL,
  display_name     text        NOT NULL,
  rank             text,
  unit             text,
  email            text,
  active           boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ── Field requests — real-time C2 feed ───────────────────────────
CREATE TABLE IF NOT EXISTS field_requests (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id      text        NOT NULL,
  source_name    text,
  unit           text,
  channel        text        NOT NULL DEFAULT 'TELEGRAM',
  transcript     text,
  status         text        NOT NULL DEFAULT 'PROCESSING',
  is_sos         boolean     NOT NULL DEFAULT false,
  risk_level     text        NOT NULL DEFAULT 'MODERATE',
  intent         text,
  summary        text,
  modules_queued text[],
  log_id         uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS field_requests_status_created
  ON field_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS field_requests_sos
  ON field_requests (is_sos, created_at DESC) WHERE is_sos = true;

-- ── Commander query / audit log ───────────────────────────────────
CREATE TABLE IF NOT EXISTS commander_query_log (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id      text        NOT NULL,
  source_name    text,
  channel        text        NOT NULL DEFAULT 'TELEGRAM',
  audio_file_id  text,
  status         text        NOT NULL DEFAULT 'PROCESSING',
  transcript     text,
  intent         text,
  sitrep_summary text,
  risk_level     text,
  error_detail   text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ── Raw intelligence — unified feed for SOCMINT + HUMINT fusion ───
CREATE TABLE IF NOT EXISTS raw_intelligence (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source           text,
  source_id        text,
  source_name      text,
  unit             text,
  channel          text,
  transcript       text,
  entities         jsonb,
  ref_number       text,
  threat_level     text,
  confidence       float,
  field_request_id uuid,
  ai_summary       text,
  threat_score     integer,
  lga_tagged       text,
  keywords         text[],
  payload          jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS raw_intelligence_lga_created
  ON raw_intelligence (lga_tagged, created_at DESC);

CREATE INDEX IF NOT EXISTS raw_intelligence_source_created
  ON raw_intelligence (source, created_at DESC);

-- ── Dispatch log — TIC events ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS dispatch_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  status       text        NOT NULL DEFAULT 'PENDING',
  commander_id uuid,
  coordinates  point,
  triggered_at timestamptz,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Add notes column if table pre-existed without it
ALTER TABLE dispatch_log ADD COLUMN IF NOT EXISTS notes text;
