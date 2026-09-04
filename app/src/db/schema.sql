CREATE TABLE schema_version (
  version INTEGER NOT NULL
);

INSERT INTO schema_version (version) VALUES (5);

CREATE TABLE postings_cache (
  id              TEXT PRIMARY KEY,
  data            TEXT NOT NULL,
  description     TEXT,
  first_seen_at   TEXT,
  closed_at       TEXT,
  category        TEXT,
  category_tags   TEXT,
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
  outcome        TEXT,
  outcome_at     TEXT,
  interview_rounds INTEGER NOT NULL DEFAULT 0,
  outcome_notes  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE application_outcome_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  posting_id       TEXT NOT NULL,
  outcome          TEXT NOT NULL CHECK (
    outcome IN ('interview', 'offer', 'rejection', 'ghosted', 'withdrawn')
  ),
  occurred_at      TEXT NOT NULL,
  interview_rounds INTEGER NOT NULL DEFAULT 0,
  notes            TEXT,
  FOREIGN KEY (posting_id) REFERENCES applications(posting_id)
);

CREATE TABLE recalibration_suggestion_actions (
  suggestion_id TEXT PRIMARY KEY,
  status        TEXT NOT NULL CHECK (status IN ('applied', 'dismissed')),
  acted_at      TEXT NOT NULL
);

CREATE INDEX idx_postings_score ON postings_cache(score DESC);
CREATE INDEX idx_postings_category ON postings_cache(category);
CREATE INDEX idx_applications_status ON applications(status);
CREATE INDEX idx_outcome_events_posting ON application_outcome_events(posting_id, occurred_at);

CREATE TABLE companies_meta (
  slug         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  typical_open TEXT
);

CREATE TABLE gmail_suggestions (
  id            TEXT PRIMARY KEY,
  email_id      TEXT NOT NULL,
  signal_type   TEXT NOT NULL CHECK (
    signal_type IN ('interview', 'offer', 'rejection', 'assessment')
  ),
  company_slug  TEXT NOT NULL,
  company_name  TEXT NOT NULL,
  posting_id    TEXT NOT NULL,
  sender_domain TEXT NOT NULL,
  subject       TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'accepted', 'dismissed')
  ),
  created_at    TEXT NOT NULL,
  FOREIGN KEY (posting_id) REFERENCES applications(posting_id)
);

CREATE UNIQUE INDEX idx_gmail_suggestions_email ON gmail_suggestions(email_id);
CREATE INDEX idx_gmail_suggestions_status ON gmail_suggestions(status);
CREATE INDEX idx_gmail_suggestions_posting ON gmail_suggestions(posting_id);
