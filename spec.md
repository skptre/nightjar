# SPEC — Nightjar

An open internship feed and local desktop tracker.

---

## 1. What this is

Two things, deliberately separated:

1. **A public feed.** A poller runs on GitHub Actions, hits ATS APIs, and commits normalized US internship, co-op, and new-grad postings to a public repo. Product scope is public; no user opinions or personal information enter the poller. Anyone can consume it.

2. **A desktop app.** You download it, set up a local profile (grad date, work auth, target categories), and the app pulls the feed from the public repo. Filtering, scoring, eligibility checking, and application tracking all happen locally. Your data never leaves your machine.

The split is the architecture. Everything upstream of the user is shared and public. Everything downstream is private and local.

### 1.1 Product vision

Best open, privacy-first internship discovery feed. Not the largest job platform — the cleanest, most focused one. Beat Simplify on workflow, transparency, and UX.

Multi-discipline: not just software engineering. Mechanical, electrical, aerospace, civil, chemical, biomedical engineering, finance, accounting, consulting, research, design, operations, and supply chain. Classification also covers product, IT, marketing, sales, human resources, legal/policy, and healthcare roles; source coverage varies by field.

### 1.2 Success criteria

- The feed surfaces roles before they appear in any community repo (SimplifyJobs, vanshb03).
- The feed covers companies those repos will never list — small and mid-size companies on structured ATS platforms.
- The poller discovers new employer career boards automatically, reducing manual registry curation.
- Per-application overhead drops to under 5 minutes for standard ATS forms.
- The poller runs unattended indefinitely.

### 1.3 Non-goals

- **Not a job board.** No accounts, no hosted frontend, no API for third parties. The repo is the API.
- **Not an auto-applier.** The extension fills forms on pages the user manually navigated to. It never submits.
- **No LLM-generated content.** No cover letter generation, no auto-answers to application questions.
- **No LinkedIn or Indeed scraping.** ToS prohibition, bot detection, litigation history, near-zero marginal coverage.
- **No Handshake scraping.** Private/school-restricted postings. Handshake explicitly prohibits outside collection.
- **No stealth or headless scraping.** Banned. Conflicts with good-citizen principles and turns ordinary upstream changes into adversarial maintenance.

---

## 2. Architecture

### 2.1 System overview

```
┌──────────────────────────────────────────────────────────────────┐
│                      PUBLIC REPO (GitHub)                         │
│                                                                  │
│  companies.yaml             .github/workflows/                   │
│  (the registry)             poll.yml (scheduled polling)         │
│       │                     hot-watch-poll.yml (focused watches)  │
│       ▼                     discover.yml (monthly discovery)     │
│  ┌───────────┐                     │                             │
│  │  Poller   │─── fetch ──────────►│                             │
│  │  (Python) │    normalize        │                             │
│  │           │    scope-filter ────►│                             │
│  │           │    dedupe      ┌────┴────────┐                    │
│  └───────────┘                │ data/       │                    │
│                               │  feed.json  │  ◄── raw data,    │
│  ┌───────────┐                │  state.json │      no opinions   │
│  │ Discovery │── discover ───►└──────┬──────┘                    │
│  │ Pipeline  │                       │                           │
│  └───────────┘                       │                           │
└──────────────────────────────────────┼───────────────────────────┘
                                       │
                    raw.githubusercontent.com fetch
                                       │
┌──────────────────────────────────────┼───────────────────────────┐
│                LOCAL MACHINE (per user)                           │
│                                      ▼                           │
│  ┌────────────────────────────────────────────┐                  │
│  │             Desktop App (Tauri)            │                  │
│  │                                            │                  │
│  │  profile.json ──► filter engine            │                  │
│  │                   classify (multi-label)    │                  │
│  │                   score engine              │                  │
│  │                   eligibility engine         │                  │
│  │                   recalibration (outcomes)   │                  │
│  │                                            │                  │
│  │  SQLite ──► application tracker            │                  │
│  │             pipeline / kanban               │                  │
│  │             notes, deadlines                │                  │
│  │                                            │                  │
│  │  Gmail sync ──► interview/offer detection  │                  │
│  │                 (opt-in, local-only)        │                  │
│  └────────────────────────────────────────────┘                  │
│                                                                  │
│  ┌────────────────────────────────────────────┐                  │
│  │        Chrome Extension (MV3)              │                  │
│  │        hotkey-triggered form fill          │                  │
│  └────────────────────────────────────────────┘                  │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 The rule

**The poller knows nothing about any user.** No profiles, no preferences, no eligibility rules, no scoring. It fetches, applies the public product-scope boundary, normalizes, dedupes, and commits. Every user-specific opinion about what's relevant lives in the app.

Corollary: `feed.json` contains every active posting the poller has seen that is inside Nightjar's public scope: US internships, co-ops, and explicit new-grad programs across all disciplines. The app decides what to show within that shared scope.

### 2.3 Four-layer separation

The poller's responsibilities decompose into four layers:

- **Discovery** answers: "Which public employer boards exist?" Common Crawl ATS-board discovery, redirect-based detection, public directory scanning, and Simplify as one signal among several.
- **Extraction** answers: "What is currently posted on each board?" Direct ATS adapters, first-party career-site adapters, and generic extraction (JSON-LD, sitemaps, RSS).
- **Classification** answers: "Which postings are internships, co-ops, summer analysts, and so on?" The poller's student-role filter captures 30+ role-type patterns beyond just "intern" in titles.
- **Scheduling** answers: "How urgently should each known source be checked right now?" Seasonal patterns, adaptive intervals based on activity, and admin hot-watch overrides for time-sensitive launches.

### 2.4 Why public

GitHub Actions minutes are unlimited on public repos. On private repos the free tier caps at 2,000 min/month, and every run bills a minimum of one minute. A private repo blows the quota quickly with frequent polling.

No personal data is ever committed. `companies.yaml` is company names and ATS slugs. `feed.json` is public job postings. The repo doubles as a portfolio artifact.

### 2.5 Hosting the poller

**GitHub Actions on a cron.** The primary workflow runs on a fixed schedule (every 15 min, off-peak minutes). The poller internally checks `last_polled_at` per company against the per-company interval and only fetches what's due on each tick. Most ticks poll a handful of companies and finish quickly.

Additional workflows:
- **Hot-watch polling** — Runs at a higher frequency (every 5 min), but exits immediately when no active watches exist. Polls only the specific sources under watch.
- **Discovery** — Runs monthly. Queries Common Crawl, verifies discovered boards, updates the candidate catalog. Separate from polling and does not interfere with it.

Always include `workflow_dispatch:` for manual triggers.

Known limitations:
- Minimum interval is 5 minutes; anything shorter is silently ignored.
- Scheduled runs are delayed 5–30 min, clustering at the top of the hour. Off-peak minutes mitigate this.
- Scheduled workflows auto-disable after 60 days with no repo activity. The poller commits on runs with changes; add a heartbeat commit on quiet days.

---

## 3. Data model

### 3.1 Feed posting

Every source adapter normalizes to this shape. This is the contract between the repo and every consumer.

```jsonc
{
  "id": "a1b2c3d4e5f67890",      // sha256(source:company_slug:source_job_id)[:16]
  "company": "Ramp",
  "company_slug": "ramp",
  "title": "Software Engineering Intern — Summer 2027",
  "location": "New York, NY",
  "locations": ["New York, NY"],
  "url": "https://boards.greenhouse.io/ramp/jobs/12345",
  "source": "greenhouse",         // see §5 for valid source types
  "source_job_id": "12345",
  "ats": "greenhouse",
  "posted_at": "2026-09-15T00:00:00Z",
  "first_seen_at": "2026-09-15T08:33:00Z",
  "last_seen_at": "2026-10-01T12:18:00Z",
  "closed_at": null,
  // optional fields, included when non-null:
  "compensation": "$30/hr",
  "merged_from": ["abc123", "def456"],
  "source_metadata": {},
  "description_text": "Public, normalized job description"
}
```

`description_text` is published when an adapter provides it. Job descriptions are public source data; profile matching and eligibility remain local. This avoids relying on cross-origin browser requests that ATS providers may block. A transient source failure never replaces a previously captured description with an empty value.

Acquisition version 4 hydrates up to 200 jobs per poller run, using supported ATS APIs (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Workable) before guarded public-page fallback. Workable requires detail description/requirements/benefits fields; listing teasers are not complete. Attempts are ordered oldest first, reserving a quarter of the batch (at least one slot with nonzero budget) for overdue previously successful documents. Every active job gets a collection outcome, even with zero budget. `state.json.description_attempts` persists source identity, attempt/version, successes, retry schedule and errors. Refresh is due after 72 hours; overdue descriptions waiting for budget are stale. Failures back off exponentially up to 72 hours and preserve prior text; partial refreshes retain previous complete text as stale. Public `description_status` distinguishes available, partial, stale, unavailable and unsupported; absent legacy state is unknown locally. `description_version` tracks acquisition semantics. Identity changes, including corrected registry boards, invalidate retry state. Neither field establishes applicant eligibility. Live completeness measurement remains a release gate.

`source_metadata.ats_identity` retains provider/board/job identity for custom application URLs; `source_compensation` retains provider compensation facts (excluding Ashby fields explicitly marked not for display). The Apply URL remains the original employer/ATS URL. Public HTTPS fallback respects robots.txt, validates bounded redirect destinations, and matches structured JobPosting JSON-LD or microdata to the title and URL. Conflicting documents are declined; significant query parameters remain part of URL identity. Hydrated job data and scoped visible HTML are retained only as partial evidence. Prohibited domains and private URL literals are declined. Robots 404/410 permit collection; authorization, throttling and server failures do not. `source_metadata.description_acquisition` records method, completeness, identity basis and resolved URL where applicable.

Provider detection validates host and job-path boundaries and is shared with Simplify ingestion. Custom Greenhouse `gh_jid` links require retained source identity or one unambiguous curated board for that company; company slugs are never guessed as board tokens. HTML pages without matching structured job data are never certified by stripping the whole page. The isolated backfill tool uses the same registry mapping and reports provider statuses, failure reasons and feed/shard sizes without modifying its input.

Descriptions preserve complete plaintext, paragraphs, headings and bullets; scripts/styles are excluded and there is no silent 5,000-character cutoff. Lever qualification/closing/salary sections, SmartRecruiters section titles, Ashby HTML/plain variants and Workday nested/top-level text are assembled. Dedupe retains richer duplicate evidence. Delivery uses hashed source shards and bounded description bundles (section 3.5). The isolated backfill tool supports bounded `--rounds`, persisted retries and reports all-active-job completeness and pack sizes. Offline fixtures verify contracts; live backfill and completeness measurement remain release gates in `docs/description-engine-validation.md`.

No eligibility, no score, no category. Those are computed by the app.

**Planned data model expansion:** Optional fields for richer classification — `employment_type`, `department`, `workplace_type`, `valid_through`, `updated_at`, `education_requirements`, `experience_requirements`, `occupational_category`, `requisition_id`. All default `None` for backward compatibility. Populated where the ATS provides them.

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
  high_priority: false
  seasonal_pattern: "fall"        # fall | spring | year_round | null
```

No tiers, no notes, no referral contacts — those are user opinions and belong in the app's local data.

The registry started as a hand-curated seed list and was expanded via Simplify bootstrapping. Going forward, Common Crawl discovery and redirect-based detection will grow it automatically, with Simplify as one discovery signal among several rather than the sole source.

### 3.4 Feed file

`data/feed.json` — an object, not a flat array:

```jsonc
{
  "updated_at": "2026-10-01T12:18:00Z",
  "version": 1,
  "count": 2626,
  "postings": { ... }             // keyed by posting ID for fast lookup
}
```

**Active postings only.** When a posting disappears from the source for two consecutive runs, set `closed_at` and keep it in the feed for 7 days (so apps that poll infrequently see the closure), then drop it. The app caches locally and handles its own history.

### 3.5 Size budget

The feed is a single JSON file. As the registry grows, so does the feed.

Mitigations, in order of when to implement them:
1. **Start with one file for small feeds.** The app caches locally and only fetches when the remote hash changes.
2. **Shard at 1,000 postings:** shard by source type (`greenhouse.json`, `lever.json`, etc.). Listings reference description packs via `description_ref` containing document `sha256`, `pack`, `pack_sha256` and original acquisition `status`. Bundles use `details/descriptions-{bucket}.json`, grouped by the first document-hash character: at most 16 generated files. The payload remains `{version: 1, documents: {document_hash: text}}`. Changed bundles are atomically replaced before listing shards are written. After the complete shard/index write, obsolete generated bundles (including legacy hashed filenames) are removed; unrelated files are untouched. Git retains history. The updated app accepts both legacy and fixed references, keys in-flight requests by path plus expected hash, and revalidates HTTP caches. During a deployment mismatch, verification fails without changing local rows or stored sync hashes; a subsequent sync retries. Older app builds must update before consuming the new feed. The app fetches changed shards, verifies pack and document hashes, reuses local text and hydrates all changed postings before classification with bounded pack concurrency. A failed hydration preserves existing local data. Listing-wire `description_status` is `unavailable` while text is external, preventing legacy clients from trusting old cached text as fresh; updated clients restore reference status after verification. The monolithic feed retains inline text for compatibility. This bounds file count, not total bytes: text storage still grows with retained postings. Larger bundles trade some update bandwidth for a simpler bounded file layout.
3. **Git history mitigation:** consider moving feed.json to GitHub Releases as an asset, periodic `git gc`, or a separate `data` branch. Contingency plans — implement only if growth becomes a real problem.

### 3.6 Company identity model

At scale, company identity becomes ambiguous. "JPMorgan," "JPMorgan Chase," and separate Workday sites must be correctly linked — or unrelated subsidiaries correctly kept separate.

ATS domains (boards.greenhouse.io, jobs.lever.co) belong to the ATS provider, not the employer. Identity matching uses employer metadata from the board response, official website links, or reviewed identity records — never the ATS hostname. Fuzzy name similarity proposes matches for human review, never auto-joins.

Canonical employer records track: official name, aliases, known domains, ATS instances, and parent/subsidiary relationships. Conservative bias: uncertain matches flagged for review, never auto-merged.

---

## 4. Repo layout

```
nightjar/
├── spec.md
├── CLAUDE.md
├── companies.yaml
├── polling-overrides.yaml        # hot-watch configuration
├── Makefile
├── poller/
│   ├── main.py
│   ├── models.py
│   ├── filter.py                 # student-role + US-location scope filters
│   ├── sources/
│   │   ├── base.py               # Source ABC
│   │   ├── greenhouse.py
│   │   ├── lever.py
│   │   ├── ashby.py
│   │   ├── workday.py
│   │   ├── smartrecruiters.py
│   │   ├── simplify.py
│   │   └── generic.py            # planned: multi-strategy extraction
│   ├── discovery/                # Common Crawl + board discovery
│   │   ├── common_crawl.py
│   │   ├── models.py
│   │   ├── verify.py
│   │   ├── catalog.py
│   │   ├── identity.py
│   │   ├── redirect_detect.py
│   │   └── directories.py
│   ├── normalize.py
│   ├── dedupe.py
│   ├── registry.py
│   ├── http.py                   # rate-limited client
│   ├── store.py
│   ├── tools/
│   │   ├── hot_watch.py          # admin hot-watch CLI
│   │   ├── benchmark.py          # coverage metrics
│   │   └── discover.py           # bounded discovery workflow CLI
│   └── tests/
│       ├── fixtures/             # real captured API responses, committed
│       └── test_filter.py
├── data/
│   ├── feed.json                 # GENERATED — active postings
│   ├── state.json                # GENERATED — run metadata, per-source health
│   ├── discovered_boards.json    # discovery pipeline output
│   └── company_identities.json   # identities + pending review queue
├── app/                          # Vite + React + TS → Tauri wrap later
│   └── src/
├── extension/                    # Chrome MV3
│   ├── manifest.json
│   ├── content/
│   ├── adapters/
│   └── popup/
└── .github/workflows/
    ├── poll.yml
    ├── hot-watch-poll.yml        # focused 5-min hot watches
    ├── hot-watch-control.yml     # manual enable/disable/status control
    └── discover.yml              # planned: monthly discovery
```

---

## 5. Source adapters

### 5.0 Adapter tiers

Source adapters fall into three tiers based on extraction method:

**Tier A — Direct ATS adapters.** Structured JSON/XML APIs with stable schemas. Greenhouse, Lever, Ashby, Workday, SmartRecruiters, and future families (Recruitee, Personio, BambooHR, Breezy, Workable, JazzHR, Teamtailor, Comeet, Pinpoint). These are the highest-quality sources.

**Tier A — First-party career-site adapters.** Large employers with custom or semi-custom career sites (Google, Microsoft, etc.). Prefer, in order: a documented public API, a stable first-party JSON/XML endpoint used by the public careers page, server-rendered structured HTML/JSON-LD, then the generic adapter. Never use a third-party job-board copy when a usable first-party record exists. Do not create one adapter per company when several employers share the same career platform — promote reusable platform behavior into an ATS-family adapter.

**Tier B — Government/public sector.** Well-documented public APIs like USAJOBS. These massively expand non-tech coverage.

**Tier C — Generic extraction.** Multi-strategy extraction for custom career sites without per-company adapters. Strategies in priority order: robots.txt/sitemap, RSS/Atom, JSON-LD (`@type: JobPosting`), static application state (Next.js hydration), and semantic HTML heuristic (quarantined, low confidence). No JS rendering, no headless browsers, ever.

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
- Populate expanded `RawPosting` fields (`employment_type`, `department`, etc.) wherever the ATS provides them.

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

**Why `limit` is capped at 20:** this is Workday's server-side page size cap, not a choice. Set `limit=100` and Workday returns `{"jobPostings": []}` with no error — byte-identical to end-of-results. A naive loop terminates on page one and silently reports zero jobs.

Gotchas:
- **`limit` must not exceed 20.** Higher values silently return empty arrays.
- **Sleep 1–2s between pages.** Workday throttles fast paging. A failed page must be retried, never treated as end-of-list.
- **Terminate on `offset + limit >= total` OR empty `jobPostings`.** Check both.
- List response gives relative dates (`"Posted 3 Days Ago"`), not timestamps. Rely on `first_seen_at`.
- Full descriptions need a second call per job — only fetch for postings that are new since the last run.
- Akamai bot management in front. Polite, low-volume, single-IP polling is fine. Don't parallelize aggressively.

### 5.5 SmartRecruiters

```
GET https://api.smartrecruiters.com/v1/companies/{company_id}/postings
```

Public JSON API. Returns paginated job postings with `id`, `name` (title), `location`, `department`, `typeOfEmployment`, `experienceLevel`. Pagination via `offset` and `limit`.

### 5.6 Simplify / community repos

Fetch `.github/scripts/listings.json` on the `dev` branch via `raw.githubusercontent.com`. Filter on `active == true` and `is_visible == true`.

This source serves two purposes:
1. Baseline coverage of companies not yet in the registry.
2. **Registry bootstrapping.** Companies appearing here that aren't in `companies.yaml` get written to `data/registry_candidates.json` with their apply URLs. A separate tool (`poller/tools/infer_ats.py`) inspects those URLs, infers the ATS and slug, and emits registry entries for review.

Simplify should no longer be the primary discovery channel. Continue consuming it, but as one signal among several alongside Common Crawl discovery, redirect detection, and community contributions.

### 5.7 USAJOBS (planned)

```
GET https://data.usajobs.gov/api/search
```

Official public API, requires a free API key. Filter on `HiringPath=student` for internships. Covers engineering, science, finance, policy, operations, healthcare, and trades across all federal agencies. Single largest non-tech coverage unlock.

### 5.8 First-party career-site adapters (planned)

Adapters for large employers who publish first on their own custom career sites and may not appear promptly in Simplify or community repos. Google Careers and Microsoft Careers are the first two. Further adapters prioritized by measured internship volume and unique-posting yield, not prestige.

### 5.9 Generic extraction adapter

The `generic` adapter covers public, static career sites that do not justify a dedicated
adapter. Its `board_token` is the full careers-page URL; a hostname/path without a scheme
is normalized to HTTPS. Private, local, credential-bearing, and non-HTTP(S) targets are
rejected before any request.

The adapter is deliberately fail-closed and uses this hierarchy:

1. Fetch and enforce `/robots.txt` using RFC 9309 longest-match semantics. A robots 4xx is
   unavailable and permits access; network/5xx failures are unreachable and disallow access.
2. Follow same-host sitemap indexes and job-specific sitemaps, preserving each job URL's
   `lastmod` as extraction provenance.
3. Parse RSS or Atom feeds advertised in robots/page metadata, then bounded common paths.
4. Parse schema.org `JobPosting` JSON-LD from static pages.
5. Parse JSON-only `__NEXT_DATA__` and `window.__INITIAL_STATE__` hydration payloads.
6. Extract semantic HTML only into a low-confidence, review-required quarantine. These
   candidates never enter `feed.json`.

Only a structurally valid empty feed or an explicitly job-specific empty sitemap may return
`[]`. Unsupported markup, schema drift, CAPTCHA/challenge pages, and robots blocks raise a
source error so prior postings are retained. Every published generic posting records a
high-confidence `extraction_method` in `source_metadata`; niche schema fields and explicit
requisition IDs are also retained there.

Generic extraction uses the shared honest Nightjar HTTP client (one-second per-host delay,
jitter, and bounded retry), enforces robots before every requested page and redirect target,
refuses cross-host sitemap/redirect traversal, caps work at 100 requested pages per
company/run, and performs no JavaScript rendering or browser automation. Sitemap `lastmod`
is recorded but page-level 304 skipping is not enabled: the current adapter contract cannot
safely carry unchanged page postings into a partial snapshot, and treating those pages as
absent would create false closures.

Scrapling was evaluated and is not a dependency. Its current parser-only package does not
replace the small standard-format parsers needed here, while its fetcher/browser extras are
centered on capabilities Nightjar explicitly bans (browser execution, impersonation, and
anti-bot bypass). The adapter therefore uses `httpx` through the shared client plus standard
library HTML, JSON, and bounded XML parsing.

### 5.10 Explicitly not implemented

LinkedIn, Indeed, Handshake. Do not add even if asked.

---

## 6. Pipeline

### 6.1 Run sequence

```
load registry
  → check which companies are due (last_polled_at + interval)
  → for each due (company, source): fetch  [parallel across companies, rate-limited per host]
  → normalize to Posting
  → filter: student/intern roles (§6.5)
  → filter: US locations (§6.5)
  → cross-source dedupe (§6.3)
  → diff against previous feed (§6.2)
  → write feed.json + state.json
  → commit + push (only if feed changed)
```

### 6.2 Diffing

Compare current posting-ID set against `state.json`'s previous set.

- **New**: in current, not in previous.
- **Disappeared**: in previous, not in current → set `closed_at` only after absent for **two consecutive runs** (flapping guard against transient API failures).
- **First fetch**: suppress the "new" flag for a company's first successful fetch (`bootstrapped: true` in state). Otherwise adding a company generates hundreds of phantom new postings.
- **Scope migration**: when the public feed-scope policy changes, postings that no longer satisfy it are removed from feed/history state immediately. They do not pass through the two-miss or seven-day closure retention path, which is reserved for upstream disappearance of otherwise in-scope jobs.

### 6.3 Cross-source dedupe

The same role arrives from Simplify and from the company's Greenhouse board. Merge them.

**Current match logic:** normalized company + fuzzy title match (token-sort ratio ≥ 95) + overlapping location.

**Planned provenance-first upgrade:** layered match hierarchy — same ATS instance + source_job_id (definite), same canonical apply URL (strong), same company + requisition ID (strong), fuzzy title + location + compatible posting date within 30 days (probable). Provider-specific URL canonicalization rules. Full provenance audit trail preserved on merged postings.

Prefer the **direct ATS record** as canonical — its URL is the real apply link. Keep the earliest `first_seen_at`. Record all source IDs in `merged_from`.

**Be conservative.** A duplicate in the feed is a minor annoyance. A false merge hides a role forever.

### 6.4 Poll intervals

Intervals are targets; the cron interval (15 min) is the hard floor. The poller checks `last_polled_at` each tick and only fetches what's due.

- **Default:** every 6 hours.
- **Companies tagged `high_priority` in registry:** every 30 minutes.
- **Ramp window:** if `now` is within ±14 days of a company's `typical_open`, poll on every tick.

Anyone can set `high_priority: true` on a company in the registry via PR.

**Implemented scheduling controls:**
- **Seasonal polling:** `fall` is in season July–November; `spring` is in season December–April; `year_round` and `null` always use ordinary scheduling. High-priority sources fall back from 30 minutes to the six-hour default off-season. The six-hour ceiling preserves the detection-latency target. Unknown companies remain untagged and therefore never get slowed by an unsupported guess.
- **Admin hot-watch mode:** `polling-overrides.yaml` contains public, auditable source watches with a required reason, five-minute managed minimum, and mandatory expiry of at most seven days. `poller.tools.hot_watch` validates a recent successful bootstrapped baseline before enabling a watch. The focused workflow polls only due watched sources and shares the normal poller's concurrency group, retention rules, rate limits, request budgets, and failure semantics. Three consecutive failures mark the watch unhealthy. An optional local foreground mode has a two-minute minimum and never writes feed/state.

- **Adaptive polling:** Data-driven scheduling based on per-source activity metrics tracked in `state.json`. Each source records `last_change_at`, `change_frequency` (EMA, alpha=0.2), `consecutive_unchanged`, `estimated_poll_cost` (EMA), `activity_poll_count`, and `last_content_hash` (SHA-256 of sorted posting content tuples `id|title|url|location`, detecting both ID changes and in-place edits to title/URL/location). After 48+ polls (~12 days at default interval), sources are classified into tiers: **Hot** (consecutive_unchanged < 2, 15 min), **Active** (< 10, 2 hours), **Quiet** (≥ 10, 6 hours). Override priority: ramp window > off-season cap (6h) > adaptive tier (capped to 30 min for high_priority sources) > default (6h). Cost-aware scheduling defers quiet sources when cumulative estimated cost exceeds 80% of run budget; hot, active, high-priority, hot-watched, and starving sources (not polled in 48+ hours) are never deferred. HTTP conditional headers (If-None-Match/If-Modified-Since) are sent automatically when cache entries exist; 304 responses are handled transparently with retry for adapters that don't opt into explicit conditional mode.

### 6.5 Feed scope filters

The poller applies two product-scope filters. These are public feed boundaries, not user preferences.

**Role scope** (`poller/filter.py: filter_student_roles`): Word-boundary-aware regex matching against title and description. Captures 30+ role-type patterns:
- Core: intern, internship, co-op, cooperative education, student trainee
- Seasonal programs: summer analyst, winter analyst, summer associate, spring week, insight programme
- Academic/research: REU, student researcher, undergraduate researcher, lab assistant, research intern
- UK/international: industrial placement, year in industry, sandwich year, work placement
- Early career: apprentice (tech/engineering context), externship, graduate trainee, fellowship (employment-like), practicum
- Adjacent (classified separately): new grad, new graduate, entry level, early career, campus hire

Broad labels like `entry level` and `early career` are insufficient by themselves — they must co-occur with other student-role signals.

**Geography scope** (`poller/filter.py: filter_us_locations`): A posting must expose an explicit US signal in its location data (United States, US, USA, a US state name, or a US state abbreviation). Empty/unknown locations, unrestricted "Remote," and opaque identifiers are excluded from the initial US-only feed rather than guessed to be domestic. Source adapters preserve country data whenever it is available.

**No user scope:** degree, graduation date, work authorization, sponsorship, category, company tier, and personal relevance remain app-side.

No scoring and no notifications occur in the poller. Public source data in, scope-limited normalized data out.

---

## 7. Discovery pipeline

### 7.1 Common Crawl board discovery

Discovers career boards at web scale without crawling the web ourselves. The initial production slice queries the latest Common Crawl CDX index discovered dynamically through the official `collinfo.json` endpoint. It queries only `boards.greenhouse.io/*`, `jobs.lever.co/*`, and `jobs.ashbyhq.com/*`. Workday and SmartRecruiters URLs can be recognized from redirect and Simplify inputs, but are deliberately excluded from the initial Common Crawl query set until the first live slice is measured.

The slice enforces a maximum of 500 candidates for verification, samples all three ATS families fairly when one family fills the budget, canonicalizes tenants before verification, and deduplicates against `companies.yaml`. It records candidate count, duplicate rate, verification success rate, active-board yield, and query count. Common Crawl is a discovery source, not a freshness feed; only the latest index is queried. Widen the pattern list only after a live run validates the complete discovery-to-promotion loop.

### 7.2 Supplementary discovery

- **Redirect-based ATS detection:** Fetch `/careers` or `/jobs` on known public employer domains, respect `robots.txt`, follow at most three redirects, and match the final URL against ATS patterns. Local, private, link-local, credential-bearing, and non-HTTP targets are rejected before requests.
- **Public directory scanning:** Accept explicit employer website fields from structured sources such as SEC EDGAR company data, university career-center feeds, and federal agency datasets. HTML directory scraping is out of scope. Directory provenance is preserved alongside redirect provenance.
- **Simplify and community repos:** Continue as one discovery signal. Every direct application URL that maps to a supported ATS type → registry candidate.

### 7.3 Verification and catalog

Discovered boards are verified live — hit the public endpoint, confirm it returns valid job data, record job count and estimated poll cost. Verified candidates with supported ATS type auto-generate registry entries for review. Workday candidates flagged for manual review due to high polling cost.

Output: `data/discovered_boards.json` — candidates with provenance, verification status, and discovery source tracking.

A terminal 404/410 marks a candidate dead. Transient failures and schema drift remain pending and never become a successful empty board. Workday candidates always remain `review_required`, with estimated page cost calculated using the hard 20-item page limit.

### 7.4 Company identity and promotion

`data/company_identities.json` stores reviewed canonical names, aliases, official employer domains, ATS instances, and parent/subsidiary relationships. Identity matching auto-links only an exact ATS instance or a reviewed employer-domain match. Hosted ATS domains are never treated as employer domains. Fuzzy name similarity produces a review proposal and never auto-merges companies; parent and subsidiary records remain distinct.

Verified supported boards generate entries in `data/registry_candidates.json` for human review. This generated file remains Git-ignored and is uploaded by the monthly workflow as a 30-day review artifact; the durable catalog and identity-review queue are committed. Discovery never edits `companies.yaml` directly. The monthly `discover.yml` workflow shares the poller concurrency group with `cancel-in-progress: false`, so discovery catalog writes cannot race normal feed/state writes.

---

## 8. Desktop app

### 8.1 Purpose

Triage and tracking. Answers: "what should I look at right now" and "where is every application I've submitted."

### 8.2 Profile

Optional and stored locally, never transmitted. First launch presents a choice between browsing jobs immediately and personalizing results. Browsing never requires a profile or account. Graduation date is the single education-timing input in the MVP; the redundant class-year question is not shown.

```jsonc
{
  "degree_type": "bachelors",
  "graduation": "2029-05",
  "grad_window": ["2028-12", "2029-06"],
  "current_class_year": "unknown",
  "work_auth": "f1_opt_cpt",
  "requires_sponsorship": true,
  "target_categories": ["swe", "mechE", "aero"],
  "locations": ["US"],
  "excluded_companies": [],
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

`current_class_year`, tiers, contacts, and exclusions remain in the stored shape for backwards compatibility. They are not collected or exposed by the MVP interface; loaded profiles normalize class year to `unknown` so an invisible legacy answer cannot affect eligibility. Any future company-management experience requires a new product/design decision.

### 8.3 Filter engine (runs locally)

**Term classification.** Extract from title + description: `Summer 2027`, `Fall 2026`, `New Grad`, etc. Postings with no explicit term are flagged `inferred` based on open date and title keywords.

**Role and field classification.** The app classifies two independent dimensions:

- `category` and `category_tags`: the work performed (software, mechanical engineering, aerospace engineering, quantitative research/trading, etc.). A role tag is never added merely because its industry appears in the title or description.
- `domain_tags`: the field served (aerospace, quantitative finance, finance/banking, robotics, semiconductors, healthcare/life sciences, energy, automotive). These describe posting context, never inferred from a hardcoded company list.

The feed exposes separate **Roles** and **Fields** controls. Multiple selections within a dimension are alternatives (OR); the dimensions must both match (AND). Empty means unrestricted for that dimension. SWE alone includes avionics and quantitative software; SWE + Aerospace field selects aerospace software; Aerospace Engineering alone excludes software roles; Quant field alone includes quantitative research/trading and software. No pair is blacklisted: unusual combinations such as FPGA hardware in quantitative finance require evidence for both dimensions. Profile target categories remain role preferences; feed field selections are temporary refinements. All role options remain available regardless of profile.

Roles:
- Engineering/technology: `swe`, `data-ml`, `hardware`, `mechE`, `ECE`, `aero`, `civil`, `chemE`, `bioE`, `it`
- Business: `quant` (research/trading), `finance`, `accounting`, `consulting`, `product`, `marketing`, `sales`, `people`, `legal`
- Other: `research`, `design`, `operations`, `supply-chain`, `healthcare`, `other`

Classification is deterministic, offline and app-local. Current classifier version is 5. Explicit title evidence controls work tags; structured occupational text, responsibility sentences, department, then source categories provide fallbacks. Parenthetical specialties are preserved. Compound phrases own their matched spans, so generic substrings do not create extra professions. A known specialized title's role tags are not expanded by description keyword lists; generic research titles may specialize from explicit duties. Qualifications, collaboration and recruiting prose cannot add duties. Explicit employer self-description can establish an industry field with employer evidence, never an employee role; customer/partner prose does not establish employer industry. Evidence includes the rule, source and original text. Confidence describes role evidence strength (`high` title, `medium` duties/structured occupation/department, `low` source fallback, `unknown` unresolved), not a calibrated probability. Contradictory and unmapped source labels are retained as audit warnings.

`other` means insufficient evidence or an unsupported occupation, not a deleted posting. Source labels are supplemental evidence; recognized source labels cannot override explicit work evidence. The public feed is never modified by classification. `role-rules.json` owns role vocabulary; `rules.json` owns source aliases plus term/eligibility rules. Field rules are separate from role vocabulary. No runtime model, external classification service, or user data transmission is introduced.

The local cache stores the full versioned result in `role_classification` plus `classification_version`; legacy category columns remain for display/scoring compatibility. On launch, outdated cached classifications (including closed/tracked rows) are recomputed offline, preserving application state and notes. Re-running the current version does not rewrite classified rows. Bump `CLASSIFICATION_VERSION` whenever classification semantics or vocabulary change after release.

`cd app && npm run audit:classification` audits the local public snapshot without network access. It reports the feed hash, denominator, per-source counts, unresolved/source-fallback rates, conflicts and a review queue. Unknown-rate reduction is not an accuracy metric. `role-corpus.test.ts` supplies reviewed title and boilerplate regression cases; `role-engine.test.ts` and the rendered feed tests enforce evidence and filter semantics. Larger independently labeled evaluation sets are needed before claiming production precision/recall.

`npm run audit:details -- <feed>` reviews acquired descriptions offline, reporting engine versions, original-offset checks, sections, pay and requirement evidence, and role classifications with/without descriptions. Employer recruiting prose is not a candidate duty even inside Job Description; generic activity words alone do not establish occupations. Hardware-in-the-loop context does not add a Hardware role to an explicitly software title. Details version 3 recognizes employer heading variants, separates mandatory/preferred sentences in mixed paragraphs with original offsets, and handles repeated-unit pay ranges while keeping currencies/periods/components separate. Current validation and remaining evaluation gates are recorded in `docs/description-engine-validation.md`.

**Approved replacement: requirements and evidence (September 6, 2026).**

The active delivery plan is [docs/expansion.md](docs/expansion.md). Collection and local
evidence extraction are implemented. The September 8 MVP UI request authorizes rendering
the existing detail contracts while live source validation continues separately. Missing
and partial descriptions must remain explicit; the UI does not certify collection coverage.
The approved behavior supersedes broad exclusions and visible verdicts:

- Clicking a list posting expands original responsibility/required/preferred passages,
  with full-description access and an Apply button linking to the employer/ATS. Source
  labels, provenance, retrieval times, and authorization verdict badges are not displayed.
- Display relevant authorization passages for users with authorization concerns. If no
  passage exists, omit the section and keep the job. Failed retrieval is separately tracked
  internally and cannot establish an employer policy or exclude a posting.
- Default authorization exclusions require explicit mandatory wording that demonstrably
  conflicts with the user's situation, including exceptions. `No sponsorship` alone is
  not a blanket F-1 rejection. Preserve evidence and access to excluded/saved postings.
- Explicit mandatory graduation-window mismatches remain in the filtered list after
  ordinary results, with `Outside grad window`. Preserve the selected sort within groups.
  Preferred/ambiguous/missing windows or imprecise profiles cause no demotion. Enrollment,
  returning to school, degree, and graduation dates are separate facts.
- Every row has consistent advertised-pay placement/formatting. `Pay not listed` requires
  acquired evidence; `Pay unavailable` represents unavailable details. Preserve currency,
  period, conditions, and tiers; no silent estimates or annualization.
- Timing appears only when decision-relevant. Resume-based fit is a later separate feature.

**Runtime requirements compatibility storage.**

```jsonc
{
  "verdict": "ineligible | unclear",
  "reasons": ["Candidates must be a U.S. citizen."],
  "flags": [{"type": "explicit_authorization_conflict", "matched_sentence": "Candidates must be a U.S. citizen.", "pattern": "verified_description_requirement"}]
}
```

Only explicit current acquired authorization conflicts produce `ineligible` in runtime
classification/scoring/notifications. Kept jobs remain neutral (`unclear` in the legacy
storage shape) without flags or an eligibility claim. Graduation mismatch is stored
separately and never lowers the authorization score. Legacy direct eligibility helpers
remain for compatibility tests, but the classifier no longer calls them. The current UI
still needs its final badge/ordering migration; these stored terms are not the target UX.

Schema version 8 adds `job_details_cache(posting_id, context_key, details_json,
assessment_json)`. Details retain the normalized source document, exact-offset passages,
structured/text pay, acquisition state and graduation windows. Assessment is local and
profile-specific. Content/status/pay/profile/extractor changes rebuild details and
invalidate classification/score, preserving applications and notes. Optional local
`authorization_path` (`cpt`, `opt`, `stem_opt`) refines explicitly known training status;
combined F-1 profiles do not assume which path applies. No private input leaves the app.

### 8.4 Scoring (runs locally)

The local engine retains its transparent weighted score. **For you** sorts by this score with freshness as a tie-breaker; **All jobs** sorts by `first_seen_at` descending.

| Signal | Weight |
|---|---|
| User's company tier (1/2/3) | high |
| Freshness (steep decay) | high |
| Category match (any tag overlap) | high |
| Eligibility verdict | very high (`ineligible` floors the score) |

Four signals. Resist adding more. Company tiers and score breakdowns are not exposed in the current MVP UI pending a deliberate redesign.

### 8.5 Data flow

App polls the public feed on launch, on window focus, and periodically. Development uses Vite's local `/data` route; production browser and Tauri builds fetch `data/` from the repository's public `raw.githubusercontent.com` URL. Requests use bounded retries and timeouts. The app caches locally and remains fully functional offline. A failed background refresh does not replace usable jobs with a disruptive cache warning; an actionable error is shown only when no jobs have ever loaded.

On each sync:
1. Fetch feed. If `updated_at` hasn't changed, skip.
2. Diff against local cache. Identify new postings.
3. Run filter + eligibility + scoring against the user's profile.
4. Surface new eligible postings via system notification (OS-native).
5. Store the feed in local SQLite alongside application state.

### 8.6 Application tracker (SQLite, local)

```sql
CREATE TABLE postings_cache (
  id             TEXT PRIMARY KEY,   -- from feed
  data           TEXT NOT NULL,      -- full posting JSON
  first_seen_at  TIMESTAMP,
  closed_at      TIMESTAMP,
  -- local computed fields, refreshed on sync
  category       TEXT,               -- primary_category
  category_tags  TEXT,               -- JSON array of work roles
  role_classification TEXT,            -- complete local evidence + domain tags
  classification_version INTEGER,
  eligibility    TEXT,               -- JSON
  score          REAL,
  description    TEXT,
  description_attempted_at TIMESTAMP,
  description_error TEXT
);

CREATE TABLE applications (
  posting_id     TEXT PRIMARY KEY,
  status         TEXT NOT NULL,      -- new | saved | applied | oa | phone | onsite | offer | rejected | ghosted | skipped
  applied_at     TIMESTAMP,
  deadline       TIMESTAMP,
  notes          TEXT,
  next_action    TEXT,
  next_action_at TIMESTAMP,
  outcome        TEXT,               -- interview | offer | rejection | ghosted | withdrawn
  outcome_at     TIMESTAMP,
  interview_rounds INTEGER DEFAULT 0,
  outcome_notes  TEXT,
  created_at     TIMESTAMP NOT NULL,
  updated_at     TIMESTAMP NOT NULL
);

CREATE TABLE application_outcome_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  posting_id       TEXT NOT NULL,
  outcome          TEXT NOT NULL,     -- interview | offer | rejection | ghosted | withdrawn
  occurred_at      TIMESTAMP NOT NULL,
  interview_rounds INTEGER DEFAULT 0,
  notes            TEXT,
  FOREIGN KEY (posting_id) REFERENCES applications(posting_id)
);

CREATE TABLE recalibration_suggestion_actions (
  suggestion_id TEXT PRIMARY KEY,
  status        TEXT NOT NULL,        -- applied | dismissed
  acted_at      TIMESTAMP NOT NULL
);
```

`ghosted` is auto-set: `applied` with no status change for 45 days.

The columns on `applications` hold the latest outcome summary for fast display. `application_outcome_events` is the immutable local history, so a later rejection or offer does not erase an earlier interview. Status changes, outcome summaries, and events are written atomically.

### 8.7 Outcome-based recalibration

Outcome-based recalibration remains a deferred, opt-in capability. It is not a primary-navigation tab in the MVP. If reintroduced, it must be descriptive rather than causal, show sample sizes and cautious framing, and avoid presenting rejection/interview-rate metrics by default.

Never silently change scoring. Suggestions expose explicit **Apply** and **Dismiss** actions. Applying a suggestion updates only the existing category, tier, or freshness signal and recomputes cached scores; the choice is stored locally. Outcome history, suggestion decisions, and all dashboard calculations remain on-device and are never transmitted.

Any future stats dashboard is opt-in and local-only; it is not part of the default MVP experience.

### 8.8 Gmail sync (planned, Tauri-only)

Detect interview invitations and offer signals from inbox. Gmail OAuth with `gmail.readonly` scope (read-only, never sends email). Only scan emails from domains matching companies in the applications table.

Auto-suggest, not auto-update — surface as dismissable suggestions ("Email from stripe.com — looks like an interview invite. Update status?"). Never silently change application status.

Privacy guarantees: email content never leaves the local machine. No email body text stored — only email IDs for dedup, signal type, and matched company. User can disconnect at any time with full data deletion.

### 8.9 Views

**Home** (`/`) — upcoming tracker deadlines/next steps, saved-role shortcuts and bundled updates from watched companies. Quiet days have an actionable empty state. Company watches work without a profile and stay local. Counts and activities use actual records, never sample activity.

**Jobs** (`/jobs`) — current, non-dismissed public postings, with search and separate Role/Field filters (OR within each axis, AND across axes). Guest users receive role classification without a personal profile or eligibility assessment. Selected rows open a detail pane on wide screens and a reading view on mobile. Source excerpts, complete descriptions, pay when present, and partial/stale/missing states are supported. Apply opens the employer page; only explicit Mark applied records submission. Saving again cannot reset application history. New arrivals wait behind a quiet Show control, while existing description evidence refreshes. Manual tracker records do not enter the public job catalog.

**Tracker** (`/applications`, legacy `/pipeline` redirects here) — an editable table of company/role, stage, applied date, next step and due date. All/Saved/In progress/Archived views, search, company/due sorting, notes, manual URL entries and CSV export are implemented. Mobile rows expose dates/next steps when expanded. Public posting closure remains separate from application status. Three modest milestone counts show Applied, Interviews and Offers; interview/offer history survives subsequent status changes. Historical assessments are not yet counted because the existing event schema does not retain that milestone. Public feed updates never close manually entered local records solely because they are absent upstream.

Calendar, Companies, and Insights are not MVP routes or primary navigation. Their underlying local data code may remain dormant until product/design decisions justify a new experience.

### 8.10 UI principles

- First-time visitors can browse Jobs immediately or opt into personalization. Returning users resume Home, Jobs or Tracker at their last destination.
- Browsing does not require onboarding, a profile, or an account.
- Three primary destinations: Home, Jobs and Tracker. Settings is a utility destination. Browser navigation is at the top, Tauri navigation at the side, and narrow-screen navigation at the bottom.
- Default presentation is warm charcoal with restrained borders, readable secondary text and a pale chartreuse primary action. Light and System themes are supported; appearance and tracker density persist locally.
- Settings exposes preferences, appearance, alerts and data export/deletion. Polling intervals, feed URLs and persistent sync labels are not product controls. Meaningful failures explain their consequence; successful background work stays invisible.
- Filters open on demand and close on outside click, an explicit close action, or Escape.
- During the requirements migration, remove eligibility verdict badges. Expanded postings
  show original requirement passages, without generated authorization verdicts.
- Keyboard-first: `j`/`k` or arrows move through Jobs, `s` saves, `x` skips untracked jobs, `o`/`a` open the employer page, `/` focuses search and Escape closes details/filters. Detail controls keep their normal keyboard behavior. Outcome dialogs contain keyboard focus and return it on close.
- No destructive action without undo.

### 8.11 Company logos

The current MVP uses neutral company initials with no third-party image requests. The logo service below is a future integration, not an implemented dependency.

Display company logos alongside postings in jobs and application-tracker views. Logos are fetched app-side at render time — never stored in feed.json or the repo.

**Source:** Logo.dev API — `https://img.logo.dev/{domain}?token={key}&size=128&format=png`. Free tier: 500K requests/month, requires "Logos provided by Logo.dev" attribution link. Returns actual company logos (not favicons), supports PNG/WebP/JPG, 32–512px, light/dark mode. Free API key via logo.dev/signup, no credit card.

**Domain resolution:** Derive the company domain from the posting URL or board token. For hosted ATS boards (boards.greenhouse.io, jobs.lever.co), extract the employer domain from `companies.yaml` or the company identity model. Add an optional `domain` field to the company registry entry for explicit overrides.

**Caching:** Cache fetched logos in local SQLite as blobs keyed by domain. Favicons rarely change — cache indefinitely, refresh on manual trigger or monthly. Cache miss renders a placeholder initial (first letter of company name on a colored background derived from the slug hash).

**Constraints:**
- App fetches logos lazily on first render, not eagerly on sync.
- No logo data in feed.json, state.json, or the repo. App-side only.
- Placeholder fallback must always work — never show a broken image.
- Google Favicon API is a read-only public endpoint; no personal data is sent.

### 8.12 Notifications

Home accumulates watched-company updates quietly. Following a company does not grant notification permission. A dismissible Home invitation leads to Settings, where the user explicitly enables available system notifications. The MVP sends at most one bundled watched-company notice per update, only while the app is running in the background and permission is granted. Already-notified job IDs are retained locally to prevent repeat batches. Notifications never request permission automatically or fail a job update if delivery fails. Notifications while the app is fully closed, quiet-hour scheduling and saved-search alerts remain later work. The architectural maximum of 15 notices per sync remains a ceiling, not a target.

### 8.13 Build approach

**Vite + React + TypeScript first.** Get it working in a browser with `npm run dev`. Wrap in Tauri only after the triage UX works. Tauri wraps a web frontend, so nothing is wasted — but the Rust toolchain and native build config add a day of setup that doesn't help until the views are done.

Tauri earns its place for: a launchable desktop app, OS-native notifications, keychain access, and Gmail OAuth.

---

## 9. Chrome extension

### 9.1 Design decision

The extension fills forms on pages the user manually navigated to, on an explicit hotkey. It never navigates, never submits, never runs headless.

### 9.2 Structure

Manifest V3. Activate on `Ctrl/Cmd+Shift+F` via `chrome.commands`, never on page load.

### 9.3 Field matching

Two layers:
1. **Generic heuristic:** `autocomplete` attr → `name`/`id` → `<label>` text → `aria-label` → `placeholder`.
2. **Per-ATS adapters** for Greenhouse, Lever, Ashby, Workday.

After setting `input.value`, dispatch `new Event('input', {bubbles: true})` and `new Event('change', {bubbles: true})`. Focus before setting — framework-driven forms commit on blur.

Visually mark filled fields with a subtle outline.

### 9.4 Resume upload

1. User uploads the resume once through the extension's options page.
2. Store base64 in `chrome.storage.local`.
3. On fill: decode to `Blob` → construct `File` → build `DataTransfer` → assign to `input.files` → dispatch `change`.
4. If the form validates `isTrusted` or uses a custom drop-zone: detect and tell the user explicitly.

### 9.5 Custom questions

No generation. Snippet library keyed by theme ("why this company", "biggest challenge", "leadership"), surfaced in a side panel for copy-paste-and-edit.

### 9.6 Workday accounts

Workday requires a separate account per tenant. The signup + profile re-entry is where most time goes. Prioritize the Workday signup autofill over application form fill.

Credentials stored in the OS keychain via the Tauri app, never in extension storage unencrypted.

---

## 10. Privacy

- The public repo contains zero personal data. `feed.json` is public job postings. `companies.yaml` is company names and ATS slugs.
- User profiles, application state, resumes, and credentials live on the user's machine only.
- The app fetches from a public GitHub URL. It sends no data anywhere.
- Gmail sync (when implemented) runs entirely locally — email content never leaves the machine.
- No telemetry, no analytics, no accounts.

---

## 11. Build phases

### Phase 1 — Poller core ✓

Greenhouse + Lever + Ashby + Workday + SmartRecruiters adapters. Normalization, ID generation, JSON store, diffing. GitHub Actions cron. Student-role and US-location feed scope filters.

### Phase 2 — App core (in progress)

Vite + React + TS. Profile setup. Feed sync from GitHub. Filter engine, eligibility engine, scoring. Feed view with filters and keyboard nav. SQLite application tracker. Pipeline kanban.

### Phase 2.5 — Registry expansion ✓

Simplify bootstrapper built and run. Registry grown past seed list across 6 ATS families. `typical_open` populated where known. Ongoing — new companies added via PRs and bootstrapper re-runs.

### Phase 3 — Tauri wrap + polish

Wrap in Tauri. OS-native notifications. System tray. Calendar view. Auto-launch on login.

### Phase 4 — Expansion

The largest phase, split into three independent sub-phases. Full plan in `.claude/plans/expansion-phase.md`.

**Phase 4A — Coverage infrastructure:**
- Infrastructure foundations: data model expansion, HTTP conditional caching, coverage benchmark
- First-party career-site adapters (Google, Microsoft, and others prioritized by measured yield)
- Admin hot-watch mode for time-sensitive launches
- Common Crawl board discovery pipeline + company identity resolution
- New ATS family adapters (USAJOBS + adapters selected from discovery results)
- Generic extraction adapter (JSON-LD, sitemaps, RSS — high-confidence methods first)
- Provenance-first dedupe upgrade
- Seasonal polling

**Phase 4B — Classification and app taxonomy:**
- Multi-label category taxonomy expansion (mechE, ECE, aero, finance, etc.)
- Adaptive polling (data-driven scheduling after enough activity data)
- Additional adapters based on measured coverage gaps

**Phase 4C — Outcome intelligence:**
- Outcome-based recalibration (descriptive insights, app-side)
- Gmail sync for interview/offer detection (app-side, Tauri-only)
- Feed sharding by ATS/source type at 1,000 postings (implemented after the measured feed exceeded the flat-feed budget)

### Phase 5 — Extension

Build adapters against forms actually encountered. Do not start before real usage.

---

## 12. Testing

- **Unit**: every adapter's `normalize` against committed fixtures. Every filter pattern against labeled test cases. Every eligibility rule against labeled sentences.
- **Golden-file**: full pipeline against a fixture registry produces a byte-stable `feed.json`.
- **No network in the default test run.** `make test` must pass offline.
- **Filter tests**: student-role filter catches all 30+ role-type patterns. US-location filter requires an explicit US signal and drops ambiguous or non-US locations.

Property: running the pipeline twice on identical input produces zero diffs.

---

## 13. Open decisions

1. **Graduation date** — spec assumes May 2029, window Dec 2028 – Jun 2029. Confirm.
2. **Term filtering in the app** — default to showing all terms, or only the user's selected target terms?
3. **Resolved September 6: requirement conflicts** — hide only explicit, evidenced authorization conflicts from default results, with inspection available; demote definite mandatory graduation-window mismatches. See `docs/expansion.md`. No general eligibility badge.
4. **Data model expansion fields** — Option A (first-class `Posting` fields for key fields like `employment_type`, `department`) vs Option B (pack everything into `source_metadata`), or hybrid.
5. **Generic adapter dependency** — Scrapling for sitemap spiders, RSS parsing, and cached dev responses? Only non-stealth features permitted. Or stick with raw httpx + stdlib.

---

## 14. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Eligibility false positive hides an opportunity | High | Default `unclear`; never delete; always cite matched sentence |
| Unstable posting IDs → feed churn → phantom new postings | High | Deterministic IDs (§3.2); zero-diff test (§12) |
| Silent source failure looks like "no jobs" | High | Failure ≠ empty (§5); unhealthy flag in state.json |
| feed.json grows too large | Medium | Strict US student-role scope + active-only/7-day closed retention (§3.4); source-type sharding at 1,000 postings (§3.5) |
| False merge in dedupe hides a real role | High | Conservative bias; provenance-first upgrade adds req ID + URL match layers before fuzzy |
| Discovery floods registry with low-value sources | Medium | Verification pipeline, Workday manual review gate, measured unique-posting yield threshold |
| Generic extraction produces unstable IDs or false postings | Medium | HTML heuristic results quarantined with `review_required`; high-confidence methods (JSON-LD, RSS) only auto-published |
| Seasonal polling under-polls off-season boards | Medium | Off-season cap still maintains detection latency; unknown season always polls at default intervals |
| Hot-watch overloads a single host | Low | Per-host rate limits, request budgets, mandatory expiry, three-failure circuit breaker |
| Gmail sync privacy perception | Medium | Read-only scope, local-only processing, no email body stored, explicit opt-in, instant disconnect |
| Project becomes a substitute for applying | **Highest** | Core app ships fast; extension follows real usage |

### Graduation-based browsing default (September 8, 2026)

For you hides identified new-graduate/entry-level postings when the user's graduation
is later than the current calendar year plus one (2029: hidden in 2026; 2027: shown).
This is a local browsing preference, not an eligibility verdict. Explicit internships,
co-ops and seasonal analyst/associate student programs remain visible despite broad
cached new-grad labels. Unknown postings stay visible. All jobs and guest browsing
remain unrestricted; saved applications are unaffected. Editing graduation immediately
updates the default results. Explicit opportunity preferences can replace this MVP rule later.


### Description acquisition v5 (September 8, 2026)

Use source job identity plus conservative title normalization, never arbitrary
prefix matching. Finance program titles such as Summer Analyst remain valid names.
iCIMS uses employer-scoped requisition IDs; Oracle public candidate details preserve
all external description fields. Rippling and TikTok/ByteDance embedded page data,
and explicitly advertised Workable Markdown, supply partial evidence without running
JavaScript. JazzHR canonical vanity pages require a checked identical job path.
Backfill checkpoints completed batches and stages descriptions without replacing
poller history. Classifier v6 recognizes specific mechanical modeling duties while
preserving role/field separation. USAJOBS Full responses retain all supported long
text fields; summaries alone remain partial. See docs/description-release-v5.md for
measured results and remaining launch gates; 100% coverage is not claimed.
