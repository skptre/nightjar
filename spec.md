# SPEC — Nightjar

An open internship feed and local desktop tracker.

---

## 1. What this is

Two things, deliberately separated:

1. **A public feed.** A poller runs on GitHub Actions, hits ATS APIs every 15 minutes, and commits normalized US internship, co-op, and explicit new-grad postings to a public repo. Product scope is public and global; no user opinions or personal information enter the poller. Anyone can consume it.

2. **A desktop app.** You download it, set up a local profile (grad date, work auth, target categories), and the app pulls the feed from the public repo. Filtering, scoring, eligibility checking, and application tracking all happen locally. Your data never leaves your machine.

The split is the architecture. Everything upstream of the user is shared and public. Everything downstream is private and local.

### 1.1 Success criteria

- The feed surfaces at least one role before it appears in any community repo (SimplifyJobs, vanshb03).
- The feed covers companies those repos will never list — the 20–500 person companies on Greenhouse/Lever/Ashby.
- Per-application overhead drops to under 5 minutes for standard ATS forms.
- The poller runs unattended indefinitely.

### 1.2 Non-goals

- **Not a job board.** No accounts, no hosted frontend, no API for third parties. The repo is the API.
- **Not an auto-applier.** The extension fills forms on pages the user manually navigated to. It never submits.
- **No LLM-generated content.** No cover letter generation, no auto-answers to application questions.
- **No LinkedIn or Indeed scraping.** ToS prohibition, bot detection, litigation history, near-zero marginal coverage.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    PUBLIC REPO (GitHub)                   │
│                                                          │
│  companies.yaml          .github/workflows/poll.yml      │
│  (the registry)          (cron every 15 min)             │
│       │                        │                         │
│       ▼                        ▼                         │
│  ┌─────────┐            ┌─────────────┐                  │
│  │ Poller  │───fetch───►│ data/       │                  │
│  │ (Python)│            │  feed.json  │  ◄── raw data,   │
│  └─────────┘            │  state.json │      no opinions │
│                         └──────┬──────┘                  │
└────────────────────────────────┼──────────────────────────┘
                                 │
              raw.githubusercontent.com fetch
                                 │
┌────────────────────────────────┼──────────────────────────┐
│              LOCAL MACHINE (per user)                      │
│                                ▼                          │
│  ┌──────────────────────────────────────┐                 │
│  │           Desktop App (Tauri)        │                 │
│  │                                      │                 │
│  │  profile.json ──► filter engine      │                 │
│  │                   score engine       │                 │
│  │                   eligibility engine │                 │
│  │                                      │                 │
│  │  SQLite ──► application tracker      │                 │
│  │             pipeline / kanban        │                 │
│  │             notes, deadlines         │                 │
│  └──────────────────────────────────────┘                 │
│                                                           │
│  ┌──────────────────────────────────────┐                 │
│  │      Chrome Extension (MV3)          │                 │
│  │      hotkey-triggered form fill      │                 │
│  └──────────────────────────────────────┘                 │
└───────────────────────────────────────────────────────────┘
```

### 2.1 The rule

**The poller knows nothing about any user.** No profiles, no preferences, no eligibility rules, no scoring. It fetches, applies the public product-scope boundary, normalizes, dedupes, and commits. Every user-specific opinion about what's relevant lives in the app.

Corollary: `feed.json` contains every active posting the poller has seen that is inside Nightjar's public scope: US internships, co-ops, and explicit new-grad programs. The app decides what to show within that shared scope.

### 2.2 Why public

GitHub Actions minutes are unlimited on public repos. On private repos the free tier caps at 2,000 min/month, and every run bills a minimum of one minute. A 15-minute cron is ~2,880 runs/month — a private repo blows the quota in week one.

No personal data is ever committed. `companies.yaml` is company names and ATS slugs. `feed.json` is public job postings. The repo doubles as a portfolio artifact.

### 2.3 Hosting the poller

**GitHub Actions on a cron.** One workflow, one schedule (`3,18,33,48 * * * *` — every 15 min, off-peak). The poller internally checks `last_polled_at` per company against the per-company interval and only fetches what's due on each tick. Most ticks poll a handful of companies and finish in seconds.

Always include `workflow_dispatch:` for manual triggers.

Known limitations:
- Minimum interval is 5 minutes; anything shorter is silently ignored.
- Scheduled runs are delayed 5–30 min, clustering at the top of the hour. Off-peak minutes mitigate this.
- Scheduled workflows auto-disable after 60 days with no repo activity. The poller commits on runs with changes; add a heartbeat commit on quiet days.

**Upgrade path (only if needed): Cloudflare Workers Cron Triggers.** 1-minute granularity, reliable timing, generous free tier. Keep the storage layer behind an interface so the swap is cheap.

---

## 3. Data model

### 3.1 Feed posting

Every source adapter normalizes to this shape. This is the contract between the repo and every consumer.

```jsonc
{
  "id": "a1b2c3d4e5f67890",      // sha256(source:company_slug:source_job_id)[:16]
  "company": "Ramp",
  "company_slug": "ramp",
  "title": "Software Engineering Intern — Summer 2027",  // example; feed is term-agnostic
  "location": "New York, NY",
  "locations": ["New York, NY"],
  "url": "https://boards.greenhouse.io/ramp/jobs/12345",
  "source": "greenhouse",         // greenhouse | lever | ashby | workday | simplify
  "source_job_id": "12345",
  "ats": "greenhouse",
  "posted_at": "2026-09-15T00:00:00Z",
  "first_seen_at": "2026-09-15T08:33:00Z",
  "last_seen_at": "2026-10-01T12:18:00Z",
  "closed_at": null,
  "description_text": "..."       // stripped plaintext, for client-side keyword matching
}
```

No eligibility, no score, no category. Those are computed by the app.

### 3.2 Posting ID

```
id = sha256(f"{source}:{company_slug}:{source_job_id}")[:16]
```

Deterministic and stable across runs. **Never include title, URL, or location** — companies edit those in place and it would produce phantom "new" postings.

### 3.3 Company registry

`companies.yaml` — the actual asset. Anyone can PR new companies.

```yaml
- slug: ramp
  name: Ramp
  tags: [fintech, nyc, startup]
  sources:
    - type: greenhouse
      board_token: ramp
  typical_open: "2026-09"
```

No tiers, no notes, no referral contacts — those are user opinions and belong in the app's local data.

### 3.4 Feed file

`data/feed.json` — an object, not a flat array:

```jsonc
{
  "updated_at": "2026-10-01T12:18:00Z",
  "version": 1,
  "count": 4200,
  "postings": { ... }             // keyed by posting ID for fast lookup
}
```

**Active postings only.** When a posting disappears from the source for two consecutive runs, set `closed_at` and keep it in the feed for 7 days (so apps that poll infrequently see the closure), then drop it. The app caches locally and handles its own history.

### 3.5 Size budget

300 companies × ~100 active postings × ~1KB each ≈ 30MB. That's large for a single JSON file fetched frequently.

Mitigations, in order of when to implement them:
1. **Start with one file.** It works fine until it doesn't. The app caches locally and only fetches when the remote `updated_at` is newer (conditional fetch via `If-Modified-Since` on raw.githubusercontent.com, or a lightweight `data/meta.json` with just the timestamp and hash).
2. **If it gets too large:** split into `feed-index.json` (IDs + timestamps + company + title, ~200 bytes each) and `feed-detail/{id}.json` per posting. The app fetches the index frequently and details on demand. This is the likely endgame but don't build it first.

---

## 4. Repo layout

```
nightjar/
├── spec.md
├── CLAUDE.md
├── companies.yaml
├── Makefile
├── poller/
│   ├── main.py
│   ├── sources/
│   │   ├── base.py           # Source ABC
│   │   ├── greenhouse.py
│   │   ├── lever.py
│   │   ├── ashby.py
│   │   ├── workday.py
│   │   └── simplify.py
│   ├── normalize.py
│   ├── dedupe.py
│   ├── store.py              # storage interface (swap for CF Workers later)
│   └── tests/
│       └── fixtures/         # real captured API responses, committed
├── data/
│   ├── feed.json             # GENERATED — active postings
│   └── state.json            # GENERATED — run metadata, per-source health
├── app/                      # Vite + React + TS → Tauri wrap later
│   └── src/
├── extension/                # Chrome MV3 (Phase 4)
│   ├── manifest.json
│   ├── content/
│   ├── adapters/
│   └── popup/
└── .github/workflows/
    └── poll.yml
```

---

## 5. Source adapters

All adapters implement:

```python
class Source(ABC):
    @abstractmethod
    def fetch(self, company: Company, cfg: dict) -> list[RawPosting]: ...
    @abstractmethod
    def normalize(self, raw: RawPosting, company: Company) -> Posting: ...
```

**Rules for every adapter:**

- Honest `User-Agent` with a contact email. Never spoof a browser.
- Rate limit per-host: 1 second minimum between requests, with jitter.
- Exponential backoff on 429/5xx. Cap at 3 retries.
- **A source failing must never look like "zero jobs."** Distinguish `[]` (fetched fine, no jobs) from an exception. On failure, keep the previous postings for that company and mark the source unhealthy in `state.json`.
- Every response used to build a fixture gets committed to `poller/tests/fixtures/`.

### 5.1 Greenhouse

```
GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true
```

No auth. Returns `{"jobs": [...]}`. Fields: `id`, `title`, `location.name`, `absolute_url`, `updated_at`, `content` (HTML-entity-encoded when `content=true` — unescape before text extraction).

### 5.2 Lever

```
GET https://api.lever.co/v0/postings/{slug}?mode=json
```

No auth. JSON array. Fields: `id`, `text` (title), `categories.location`, `hostedUrl`, `applyUrl`, `createdAt` (**epoch milliseconds** — convert), `descriptionPlain`.

EU boards: `api.eu.lever.co`. Support `eu: true` per company in the registry.

### 5.3 Ashby

```
GET https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true
```

No auth. Often exposes structured compensation — include it in `description_text`.

### 5.4 Workday

```
POST https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
Content-Type: application/json

{"appliedFacets": {}, "limit": 20, "offset": 0, "searchText": ""}
```

Both `tenant` and `site` are visible in the public careers URL. Store the full base URL in the registry.

**Why `limit` is capped at 20:** this is Workday's server-side page size cap, not a choice. You get every posting by paginating (`offset=0`, `offset=20`, `offset=40`… until `offset + limit >= total`). The danger is how it fails: set `limit=100` and Workday returns `{"jobPostings": []}` with no error — byte-identical to end-of-results. A naive loop terminates on page one and silently reports zero jobs.

Gotchas:
- **`limit` must not exceed 20.** Higher values silently return empty arrays.
- **Sleep 1–2s between pages.** Workday throttles fast paging. A failed page must be retried, never treated as end-of-list.
- **Terminate on `offset + limit >= total` OR empty `jobPostings`.** Check both.
- List response gives relative dates (`"Posted 3 Days Ago"`), not timestamps. Rely on `first_seen_at`.
- Full descriptions need a second call per job — only fetch for postings that are new since the last run.
- Akamai bot management in front. Polite, low-volume, single-IP polling is fine. Don't parallelize aggressively.

### 5.5 Simplify / community repos

Fetch `.github/scripts/listings.json` on the `dev` branch via `raw.githubusercontent.com`. Filter on `active == true` and `is_visible == true`.

This source serves two purposes:
1. Baseline coverage of companies not yet in the registry.
2. **Registry bootstrapping.** Companies appearing here that aren't in `companies.yaml` get written to `data/registry_candidates.json` with their apply URLs. A separate tool (`poller/tools/infer_ats.py`) inspects those URLs, infers the ATS and slug, and emits registry entries for review. This is how the registry grows from ~30 to 300+.

### 5.6 Explicitly not implemented

LinkedIn, Indeed. Do not add even if asked.

---

## 6. Pipeline

### 6.1 Run sequence

```
load registry
  → check which companies are due (last_polled_at + interval)
  → for each due (company, source): fetch  [parallel across companies, rate-limited per host]
  → normalize to Posting
  → apply public feed scope (student-role title + explicitly US location)
  → cross-source dedupe (§6.3)
  → diff against previous feed (§6.2)
  → write feed.json + state.json
  → commit + push (only if feed changed)
```

One non-personal filter is allowed here: the public feed's product scope.

- **Role scope:** internships, co-ops, common internship-equivalent titles such as summer analyst/associate, and explicit new-grad programs. Broad labels such as `entry level` and `early career` are insufficient by themselves.
- **Geography scope:** a posting must expose an explicit US signal in its normalized location (United States/US/USA, a US state name, or a US state abbreviation). Bare `Remote`, missing, opaque, or unrecognized locations are excluded until an adapter can establish that they are US roles.
- **No user scope:** degree, graduation date, work authorization, sponsorship, category, company tier, and personal relevance remain app-side.

No scoring and no notifications occur in the poller. Public source data in, scope-limited normalized data out.

### 6.2 Diffing

Compare current posting-ID set against `state.json`'s previous set.

- **New**: in current, not in previous.
- **Disappeared**: in previous, not in current → set `closed_at` only after absent for **two consecutive runs** (flapping guard against transient API failures).
- **First fetch**: suppress the "new" flag for a company's first successful fetch (`bootstrapped: true` in state). Otherwise adding a company generates hundreds of phantom new postings.
- **Scope migration**: when the public feed-scope policy changes, postings that no longer satisfy it are removed from feed/history state immediately. They do not pass through the two-miss or seven-day closure retention path, which is reserved for upstream disappearance of otherwise in-scope jobs.

### 6.3 Cross-source dedupe

The same role arrives from Simplify and from the company's Greenhouse board. Merge them.

Match: normalized company + fuzzy title match (token-set ratio ≥ 90) + overlapping location.

Prefer the **direct ATS record** as canonical — its URL is the real apply link. Keep the earliest `first_seen_at`. Record all source IDs in `merged_from`.

**Be conservative.** A duplicate in the feed is a minor annoyance. A false merge hides a role forever.

### 6.4 Poll intervals

Intervals are targets; the cron interval (15 min) is the hard floor. The poller checks `last_polled_at` each tick and only fetches what's due.

- **Default:** every 6 hours.
- **Companies tagged `high_priority` in registry:** every 30 minutes.
- **Ramp window:** if `now` is within ±14 days of a company's `typical_open`, poll on every tick.

Anyone can set `high_priority: true` on a company in the registry via PR.

---

## 7. Desktop app

### 7.1 Purpose

Triage and tracking. Answers: "what should I look at right now" and "where is every application I've submitted."

### 7.2 Profile

Created on first launch, stored locally, never transmitted.

```jsonc
{
  "graduation": "2029-05",
  "grad_window": ["2028-12", "2029-06"],
  "current_class_year": "rising junior",
  "work_auth": "f1_opt_cpt",
  "requires_sponsorship": true,
  "target_categories": ["swe", "quant", "ml", "hardware"],
  "locations": ["US"],
  "excluded_companies": [],
  // user-local annotations
  "tiers": {                    // company_slug → 1 | 2 | 3
    "citadel": 1,
    "jane-street": 1,
    "ramp": 2
  },
  "contacts": {                 // company_slug → note
    "ramp": "Warm intro via X"
  }
}
```

Tiers, contacts, and notes are personal opinions. They stay here, not in the shared registry.

### 7.3 Filter engine (runs locally)

**Term classification.** Extract from title + description: `Summer 2027`, `Fall 2026`, `New Grad`, etc. Postings with no explicit term are flagged `inferred` based on open date and title keywords.

**Category classification.** `swe | quant | ml | hardware | other`. Keyword rules on title first, description second. Rules in a local config file, not buried in code.

**Eligibility.**

```jsonc
{
  "verdict": "eligible | ineligible | unclear",
  "reasons": ["matched: 'must not require sponsorship'"],
  "flags": ["no_sponsorship"]
}
```

Rules:
- **Graduation window.** Parse stated windows from the description. If the user's date falls outside → `ineligible`.
- **Work authorization.** Detect: "U.S. citizen", "US Person", "permanent resident", "security clearance", "ITAR", "unable to sponsor", "no visa sponsorship". → `ineligible`.
- **Class year.** "rising senior only", "PhD required", etc. → `ineligible` or `unclear`.
- **Location.** Non-US → `ineligible` (configurable).

**Default is `unclear`, never `ineligible`.** Silently hiding a real opportunity is the worst failure. Every `ineligible` verdict must cite a matched sentence from the posting. `ineligible` postings are collapsed in the UI behind a toggle, never deleted.

### 7.4 Scoring (runs locally)

Transparent weighted sum. The score must be explainable in the UI.

| Signal | Weight |
|---|---|
| User's company tier (1/2/3) | high |
| Freshness (steep decay) | high |
| Category match | high |
| Eligibility verdict | very high (`ineligible` floors the score) |

Four signals. Resist adding more — every term makes the score harder to explain, and the explanation is the point.

### 7.5 Data flow

App polls `raw.githubusercontent.com/...nightjar.../data/feed.json` on launch, on window focus, and every 5 minutes. Caches locally. Fully functional offline from cache.

On each sync:
1. Fetch feed. If `updated_at` hasn't changed, skip.
2. Diff against local cache. Identify new postings.
3. Run filter + eligibility + scoring against the user's profile.
4. Surface new eligible postings via system notification (OS-native, not Discord).
5. Store the feed in local SQLite alongside application state.

### 7.6 Application tracker (SQLite, local)

```sql
CREATE TABLE postings_cache (
  id             TEXT PRIMARY KEY,   -- from feed
  data           TEXT NOT NULL,      -- full posting JSON
  first_seen_at  TIMESTAMP,
  closed_at      TIMESTAMP,
  -- local computed fields, refreshed on sync
  category       TEXT,
  eligibility    TEXT,               -- JSON
  score          REAL
);

CREATE TABLE applications (
  posting_id     TEXT PRIMARY KEY,
  status         TEXT NOT NULL,      -- new | saved | applied | oa | phone | onsite | offer | rejected | ghosted | skipped
  applied_at     TIMESTAMP,
  deadline       TIMESTAMP,
  notes          TEXT,
  next_action    TEXT,
  next_action_at TIMESTAMP,
  created_at     TIMESTAMP NOT NULL,
  updated_at     TIMESTAMP NOT NULL
);
```

`ghosted` is auto-set: `applied` with no status change for 45 days.

### 7.7 Views

**Feed** — ranked list of new/unactioned postings. Filters: term, category, eligibility, tier, age, source. Row actions: `Save`, `Skip`, `Open`, `Mark applied`.

**Pipeline** — kanban by status. Drag to change status.

**Calendar** — deadlines and known program open dates.

**Companies** — browse the registry, set local tiers, add contacts and notes.

### 7.8 UI principles

- Default view is "things I haven't decided on yet," not "all postings."
- Every eligibility verdict is clickable → shows the matched sentence.
- Keyboard-first: `j`/`k` move, `s` save, `x` skip, `o` open, `/` search.
- No destructive action without undo.

### 7.9 Notifications

OS-native system notifications on new eligible postings. Volume cap: max 15 notifications per sync. If exceeded, send one summary notification and let the feed view carry the detail.

### 7.10 Build approach

**Vite + React + TypeScript first.** Get it working in a browser with `npm run dev`. Wrap in Tauri only after the triage UX works. Tauri wraps a web frontend, so nothing is wasted — but the Rust toolchain and native build config add a day of setup that doesn't help until the views are done.

Tauri earns its place for: a launchable desktop app, OS-native notifications, and keychain access (§8.6).

---

## 8. Chrome extension (Phase 4)

### 8.1 Design decision

The extension fills forms on pages the user manually navigated to, on an explicit hotkey. It never navigates, never submits, never runs headless.

### 8.2 Structure

Manifest V3. Activate on `Ctrl/Cmd+Shift+F` via `chrome.commands`, never on page load.

### 8.3 Field matching

Two layers:
1. **Generic heuristic:** `autocomplete` attr → `name`/`id` → `<label>` text → `aria-label` → `placeholder`.
2. **Per-ATS adapters** for Greenhouse, Lever, Ashby, Workday.

After setting `input.value`, dispatch `new Event('input', {bubbles: true})` and `new Event('change', {bubbles: true})`. Focus before setting — framework-driven forms commit on blur.

Visually mark filled fields with a subtle outline.

### 8.4 Resume upload

1. User uploads the resume once through the extension's options page.
2. Store base64 in `chrome.storage.local`.
3. On fill: decode to `Blob` → construct `File` → build `DataTransfer` → assign to `input.files` → dispatch `change`.
4. If the form validates `isTrusted` or uses a custom drop-zone: detect and tell the user explicitly.

### 8.5 Custom questions

No generation. Snippet library keyed by theme ("why this company", "biggest challenge", "leadership"), surfaced in a side panel for copy-paste-and-edit.

### 8.6 Workday accounts

Workday requires a separate account per tenant. The signup + profile re-entry is where most time goes. Prioritize the Workday signup autofill over application form fill.

Credentials stored in the OS keychain via the Tauri app, never in extension storage unencrypted.

---

## 9. Privacy

- The public repo contains zero personal data. `feed.json` is public job postings. `companies.yaml` is company names and ATS slugs.
- User profiles, application state, resumes, and credentials live on the user's machine only.
- The app fetches from a public GitHub URL. It sends no data anywhere.
- No telemetry, no analytics, no accounts.

---

## 10. Build phases

### Phase 1 — Poller core (target: 2 days)

Greenhouse + Lever + Ashby adapters. Registry with ~30 companies. Normalization, ID generation, JSON store, diffing. GitHub Actions cron.

**Acceptance:**
- `python -m poller.main --once` runs clean against the real registry.
- Second run with no upstream changes produces **zero** diffs in `feed.json`.
- A deliberately broken source does not zero out that company's postings and marks it unhealthy.
- Full test suite passes offline against fixtures.

### Phase 2 — App core (target: 3–4 days)

Vite + React + TS. Profile setup. Feed sync from GitHub. Filter engine, eligibility engine, scoring. Feed view with filters and keyboard nav. SQLite application tracker. Pipeline kanban.

**Acceptance:**
- App renders and filters the real `feed.json`.
- Eligibility rules pass a fixture suite of ≥30 real postings with hand-labeled expected verdicts, including ≥5 adversarial sponsorship sentences.
- Status changes persist across app restarts.
- Full triage of a 50-posting feed without touching the mouse.

### Phase 2.5 — Registry expansion (ongoing)

Run the Simplify bootstrapper. Grow the registry to 300+ companies. Add `typical_open` where known. This produces most of the project's actual value.

### Phase 3 — Tauri wrap + polish (target: 2 days)

Wrap in Tauri. OS-native notifications. System tray. Calendar view. Auto-launch on login.

### Phase 4 — Extension (target: 3–4 days, after applying to ~15 roles manually)

Build adapters against forms actually encountered. Do not start before real usage.

**Acceptance:**
- Fills a real Greenhouse form to ≥80% of fields on hotkey.
- Resume attaches on Greenhouse, Lever, Ashby.
- Failure to attach produces a visible error.

### Phase 5 — Workday depth (optional)

Workday source adapter + tenant account autofill.

---

## 11. Testing

- **Unit**: every adapter's `normalize` against committed fixtures. Every eligibility rule against labeled sentences.
- **Golden-file**: full pipeline against a fixture registry produces a byte-stable `feed.json`.
- **No network in the default test run.** `make test` must pass offline.

Property: running the pipeline twice on identical input produces zero diffs.

---

## 12. Open decisions

1. **Graduation date** — spec assumes May 2029, window Dec 2028 – Jun 2029. Confirm.
2. **Notification channel** — spec assumes OS-native. Confirm, or add Discord webhook from the app.
3. **Seed company list** — ~30 companies, hand-written, needed before Phase 1.
4. **Term filtering in the app** — default to showing all terms, or only the user's selected target terms?
5. **Ineligible postings in the app** — collapsed-but-visible (spec's assumption) or fully hidden behind a filter?

---

## 13. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Eligibility false positive hides an opportunity | High | Default `unclear`; never delete; always cite matched sentence |
| Unstable posting IDs → feed churn → phantom new postings | High | Deterministic IDs (§3.2); zero-diff test (§11) |
| Silent source failure looks like "no jobs" | High | Failure ≠ empty (§5); unhealthy flag in state.json |
| feed.json grows too large | Medium | Strict US student-role scope + active-only/7-day closed retention (§3.4); index/detail split as upgrade path (§3.5) |
| Registry never grows past seed 30 | **Highest** | Phase 2.5 is not optional; bootstrapper (§5.5) |
| Project becomes a substitute for applying | **Highest** | Phase 1+2 ship in one week or cut the project |
