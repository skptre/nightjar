CREATE TABLE schema_version (
  version INTEGER NOT NULL
);

INSERT INTO schema_version (version) VALUES (1);

CREATE TABLE postings_cache (
  id              TEXT PRIMARY KEY,
  data            TEXT NOT NULL,
  description     TEXT,
  first_seen_at   TEXT,
  closed_at       TEXT,
  category        TEXT,
  term            TEXT,
  eligibility     TEXT,
  score           REAL,
  score_breakdown TEXT,
  synced_at       TEXT NOT NULL
);

CREATE TABLE applications (
  posting_id     TEXT PRIMARY KEY,
  status         TEXT NOT NULL DEFAULT 'new',
  applied_at     TEXT,
  deadline       TEXT,
  notes          TEXT,
  next_action    TEXT,
  next_action_at TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX idx_postings_score ON postings_cache(score DESC);
CREATE INDEX idx_postings_category ON postings_cache(category);
CREATE INDEX idx_applications_status ON applications(status);
