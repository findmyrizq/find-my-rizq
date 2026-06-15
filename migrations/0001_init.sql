-- Find My Rizq — D1 schema
-- Run with: npx wrangler d1 execute find-my-rizq --file=./migrations/0001_init.sql

CREATE TABLE IF NOT EXISTS jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  dedup_key     TEXT NOT NULL UNIQUE,         -- source:external_id
  source        TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  title         TEXT NOT NULL,
  company       TEXT,
  description   TEXT,
  location      TEXT,
  country       TEXT,
  salary        TEXT,                          -- display string
  salary_min    REAL,
  salary_max    REAL,
  currency      TEXT,
  job_type      TEXT,                          -- Full Time / Part Time / Contract / ...
  category      TEXT,                          -- canonical category
  tags          TEXT,                          -- JSON array string
  remote        INTEGER NOT NULL DEFAULT 0,    -- 0/1
  lat           REAL,
  lng           REAL,
  apply_url     TEXT NOT NULL,
  posted_at     INTEGER,                       -- unix seconds
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'live',  -- live / expired
  clicks        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_jobs_status     ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_category   ON jobs(category);
CREATE INDEX IF NOT EXISTS idx_jobs_type       ON jobs(job_type);
CREATE INDEX IF NOT EXISTS idx_jobs_remote     ON jobs(remote);
CREATE INDEX IF NOT EXISTS idx_jobs_posted     ON jobs(posted_at);
CREATE INDEX IF NOT EXISTS idx_jobs_last_seen  ON jobs(last_seen);

-- Lightweight full-text-ish search helper column kept in sync by the worker.
CREATE INDEX IF NOT EXISTS idx_jobs_title      ON jobs(title);

-- Daily click aggregates for revenue reporting.
CREATE TABLE IF NOT EXISTS click_stats (
  day     TEXT NOT NULL,                       -- YYYY-MM-DD
  source  TEXT NOT NULL,
  clicks  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source)
);

-- Geocode cache so each location string is only looked up once.
CREATE TABLE IF NOT EXISTS geocache (
  q    TEXT PRIMARY KEY,                        -- lowercased location string
  lat  REAL,
  lng  REAL,
  ok   INTEGER NOT NULL DEFAULT 1               -- 0 = known-failed lookup
);

-- Run metadata for the admin/status view.
CREATE TABLE IF NOT EXISTS runs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at    INTEGER NOT NULL,
  fetched   INTEGER NOT NULL DEFAULT 0,
  inserted  INTEGER NOT NULL DEFAULT 0,
  updated   INTEGER NOT NULL DEFAULT 0,
  excluded  INTEGER NOT NULL DEFAULT 0,
  expired   INTEGER NOT NULL DEFAULT 0,
  errors    TEXT
);

-- User-submitted jobs awaiting manual approval.
CREATE TABLE IF NOT EXISTS submissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  company       TEXT NOT NULL,
  description   TEXT NOT NULL,
  location      TEXT,
  salary        TEXT,
  job_type      TEXT,
  category      TEXT,
  remote        INTEGER NOT NULL DEFAULT 0,
  apply_url     TEXT NOT NULL,
  contact_email TEXT,
  submitter_ip  TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending / approved / rejected
  created_at    INTEGER NOT NULL,
  reviewed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sub_status ON submissions(status);

-- Community-reported workplace prayer rooms (the honest, permitted data source).
CREATE TABLE IF NOT EXISTS prayer_rooms (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company       TEXT NOT NULL,            -- normalised lowercase company name
  has_room      INTEGER NOT NULL,         -- 1 yes / 0 no
  detail        TEXT,                     -- optional note (e.g. "3rd floor, wudu nearby")
  reporter_ip   TEXT,
  status        TEXT NOT NULL DEFAULT 'approved', -- approved/pending (auto-approve aggregated count)
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pr_company ON prayer_rooms(company);
