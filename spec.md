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

Multi-discipline: not just software engineering. Mechanical, electrical, aerospace, civil, chemical, biomedical engineering, finance, accounting, consulting, research, design, operations, and supply chain. Non-engineering fields (law, policy, marketing, healthcare) deferred until demand warrants.

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
  "source_metadata": {}
}
```

`description_text` is captured internally for filtering and classification but intentionally omitted from `to_dict()` serialization — it would bloat `feed.json` without benefiting consumers, since the app can fetch full descriptions from the source URL.

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
  seasonal_pattern: "fall"        # planned: fall | spring | year_round | null
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
1. **Start with one file.** It works fine until it doesn't. The app caches locally and only fetches when the remote `updated_at` is newer (conditional fetch via a lightweight `data/meta.json` with just the timestamp and hash).
2. **If it gets too large:** shard by source type (`greenhouse.json`, `lever.json`, etc.) — each adapter writes its own shard, and the app fetches only changed shards by comparing per-shard hashes. Implementation is measurement-triggered, not automatic.
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
│   ├── discovery/                # planned: Common Crawl + board discovery
│   │   ├── common_crawl.py
│   │   ├── verify.py
│   │   ├── catalog.py
│   │   └── identity.py
│   ├── normalize.py
│   ├── dedupe.py
│   ├── registry.py
│   ├── http.py                   # rate-limited client
│   ├── store.py
│   ├── tools/
│   │   ├── hot_watch.py          # planned: admin hot-watch CLI
│   │   └── benchmark.py          # planned: coverage metrics
│   └── tests/
│       ├── fixtures/             # real captured API responses, committed
│       └── test_filter.py
├── data/
│   ├── feed.json                 # GENERATED — active postings
│   ├── state.json                # GENERATED — run metadata, per-source health
│   └── discovered_boards.json    # planned: discovery pipeline output
├── app/                          # Vite + React + TS → Tauri wrap later
│   └── src/
├── extension/                    # Chrome MV3
│   ├── manifest.json
│   ├── content/
│   ├── adapters/
│   └── popup/
└── .github/workflows/
    ├── poll.yml
    ├── hot-watch-poll.yml        # planned: focused 5-min hot watches
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

### 5.9 Generic extraction adapter (planned)

Multi-strategy extraction for custom career sites. Extraction hierarchy (try in order):
1. `robots.txt` — respect all rules, extract sitemap URLs
2. Sitemap indexes — find job-specific sitemaps, use `lastmod` for conditional fetching
3. RSS/Atom feeds — check for alternate feed links, common paths (`/careers/feed`, `/jobs/rss`)
4. Embedded JSON-LD with `@type: JobPosting` — extract per schema.org spec
5. Static application state — Next.js `__NEXT_DATA__` or similar hydration globals
6. Semantic HTML heuristic — last resort, low confidence, results quarantined with `review_required: true`
7. Declare unsupported — mark and re-evaluate monthly

No JS rendering. No headless browsers. Static HTML only. CAPTCHA or anti-bot challenge → skip and mark as blocked.

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

**Planned extensions:**
- **Seasonal polling:** Companies tagged with `seasonal_pattern` (fall, spring, year_round) poll less frequently off-season — capped to still maintain detection latency guarantees. Unknown-season companies always poll at default intervals (conservative — don't accidentally under-poll).
- **Adaptive polling:** Replace subjective `high_priority` boolean with data-driven scheduling based on observed change frequency. Hot (changed recently) → short interval. Active → moderate. Quiet → longer. Requires several weeks of activity data before switching.
- **Admin hot-watch mode:** Temporary override for known launch windows. Auditable YAML config with mandatory expiry. Polls only selected sources at managed intervals. Optional local foreground mode for one-day launch tests where GitHub schedule jitter is too slow. Hot-watch is an operations control, not user-specific scoring.

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

**Geography scope** (`poller/filter.py: filter_us_locations`): A posting must expose an explicit US signal in its location data (United States, US, USA, a US state name, or a US state abbreviation). Conservative approach: keep postings with empty/unknown locations, bare "Remote," or opaque identifiers (e.g., Workday location IDs that can't be parsed). Drop only postings with explicitly non-US locations.

**No user scope:** degree, graduation date, work authorization, sponsorship, category, company tier, and personal relevance remain app-side.

No scoring and no notifications occur in the poller. Public source data in, scope-limited normalized data out.

---

## 7. Discovery pipeline (planned)

### 7.1 Common Crawl board discovery

Discovers career boards at web scale without crawling the web ourselves. Query Common Crawl's URL index for known ATS URL patterns (boards.greenhouse.io, jobs.lever.co, myworkdayjobs.com, etc.). Extract board URLs, tenant identifiers, and ATS family. Dedupe against existing registry.

Start with a bounded vertical slice (a few proven ATS patterns), measure candidate count and verification success rate, then widen. Per-run candidate budget to prevent runaway verification costs. Use latest CC index only.

### 7.2 Supplementary discovery

- **Redirect-based ATS detection:** Fetch `/careers` or `/jobs` on known employer domains, follow redirects, match final URL against ATS patterns.
- **Public directory scanning:** SEC EDGAR company filings, university career center employer lists, federal agency websites. Use structured data feeds where available, not web scraping.
- **Simplify and community repos:** Continue as one discovery signal. Every direct application URL that maps to a supported ATS type → registry candidate.

### 7.3 Verification and catalog

Discovered boards are verified live — hit the public endpoint, confirm it returns valid job data, record job count and estimated poll cost. Verified candidates with supported ATS type auto-generate registry entries for review. Workday candidates flagged for manual review due to high polling cost.

Output: `data/discovered_boards.json` — candidates with provenance, verification status, and discovery source tracking.

---

## 8. Desktop app

### 8.1 Purpose

Triage and tracking. Answers: "what should I look at right now" and "where is every application I've submitted."

### 8.2 Profile

Created on first launch, stored locally, never transmitted.

```jsonc
{
  "graduation": "2029-05",
  "grad_window": ["2028-12", "2029-06"],
  "current_class_year": "rising junior",
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

Tiers, contacts, and notes are personal opinions. They stay here, not in the shared registry.

### 8.3 Filter engine (runs locally)

**Term classification.** Extract from title + description: `Summer 2027`, `Fall 2026`, `New Grad`, etc. Postings with no explicit term are flagged `inferred` based on open date and title keywords.

**Category classification.** Multi-label classification — many internships span fields (robotics = mechanical + electrical + software). Each posting gets a `primary_category` for display plus a `category_tags` array for all applicable disciplines (max 3 tags). Matching and filtering operate on `category_tags` (any match counts).

Categories:
- Engineering: `swe`, `data-ml`, `quant`, `hardware`, `mechE`, `ECE`, `aero`, `civil`, `chemE`, `bioE`
- Business: `finance`, `accounting`, `consulting`
- Other: `research`, `design`, `operations`, `supply-chain`, `other`

Title match beats description match for `primary_category`. More specific category beats less specific. Cross-discipline postings are visible to users in any matching discipline.

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

### 8.4 Scoring (runs locally)

Transparent weighted sum. The score must be explainable in the UI.

| Signal | Weight |
|---|---|
| User's company tier (1/2/3) | high |
| Freshness (steep decay) | high |
| Category match (any tag overlap) | high |
| Eligibility verdict | very high (`ineligible` floors the score) |

Four signals. Resist adding more — every term makes the score harder to explain, and the explanation is the point.

### 8.5 Data flow

App polls the public feed on launch, on window focus, and periodically. Caches locally. Fully functional offline from cache.

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
  category_tags  TEXT,               -- JSON array
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
  outcome        TEXT,               -- interview | offer | rejection | ghosted | withdrawn
  outcome_at     TIMESTAMP,
  interview_rounds INTEGER DEFAULT 0,
  outcome_notes  TEXT,
  created_at     TIMESTAMP NOT NULL,
  updated_at     TIMESTAMP NOT NULL
);
```

`ghosted` is auto-set: `applied` with no status change for 45 days.

### 8.7 Outcome-based recalibration (planned)

Track what worked. After enough recorded outcomes, analyze patterns: category success rate, tier correlation, company responsiveness, time-of-application signal. Show suggestions in an "Insights" panel — descriptive, not causal. Always include sample sizes and cautious framing. Never silently change scoring weights. User explicitly applies or dismisses suggestions.

Stats dashboard: applications sent, interview rate, offer rate, response time, breakdowns by category and tier. All data local — never transmitted.

### 8.8 Gmail sync (planned, Tauri-only)

Detect interview invitations and offer signals from inbox. Gmail OAuth with `gmail.readonly` scope (read-only, never sends email). Only scan emails from domains matching companies in the applications table.

Auto-suggest, not auto-update — surface as dismissable suggestions ("Email from stripe.com — looks like an interview invite. Update status?"). Never silently change application status.

Privacy guarantees: email content never leaves the local machine. No email body text stored — only email IDs for dedup, signal type, and matched company. User can disconnect at any time with full data deletion.

### 8.9 Views

**Feed** — ranked list of new/unactioned postings. Filters: term, category, eligibility, tier, age, source. Row actions: `Save`, `Skip`, `Open`, `Mark applied`.

**Pipeline** — kanban by status. Drag to change status.

**Calendar** — deadlines and known program open dates.

**Companies** — browse the registry, set local tiers, add contacts and notes.

### 8.10 UI principles

- Default view is "things I haven't decided on yet," not "all postings."
- Every eligibility verdict is clickable → shows the matched sentence.
- Keyboard-first: `j`/`k` move, `s` save, `x` skip, `o` open, `/` search.
- No destructive action without undo.

### 8.11 Notifications

OS-native system notifications on new eligible postings. Volume cap: max 15 notifications per sync. If exceeded, send one summary notification and let the feed view carry the detail.

### 8.12 Build approach

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
- Feed sharding (only if measurements justify it)

### Phase 5 — Extension

Build adapters against forms actually encountered. Do not start before real usage.

---

## 12. Testing

- **Unit**: every adapter's `normalize` against committed fixtures. Every filter pattern against labeled test cases. Every eligibility rule against labeled sentences.
- **Golden-file**: full pipeline against a fixture registry produces a byte-stable `feed.json`.
- **No network in the default test run.** `make test` must pass offline.
- **Filter tests**: student-role filter catches all 30+ role-type patterns. US-location filter keeps ambiguous locations, drops explicit non-US.

Property: running the pipeline twice on identical input produces zero diffs.

---

## 13. Open decisions

1. **Graduation date** — spec assumes May 2029, window Dec 2028 – Jun 2029. Confirm.
2. **Term filtering in the app** — default to showing all terms, or only the user's selected target terms?
3. **Ineligible postings in the app** — collapsed-but-visible (spec's assumption) or fully hidden behind a filter?
4. **Data model expansion fields** — Option A (first-class `Posting` fields for key fields like `employment_type`, `department`) vs Option B (pack everything into `source_metadata`), or hybrid.
5. **Feed sharding strategy** — by source type (simpler, uneven shards) vs by company slug (more even, cross-shard dedupe complexity). Measurement-triggered — no decision until feed size warrants it.
6. **Generic adapter dependency** — Scrapling for sitemap spiders, RSS parsing, and cached dev responses? Only non-stealth features permitted. Or stick with raw httpx + stdlib.

---

## 14. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Eligibility false positive hides an opportunity | High | Default `unclear`; never delete; always cite matched sentence |
| Unstable posting IDs → feed churn → phantom new postings | High | Deterministic IDs (§3.2); zero-diff test (§12) |
| Silent source failure looks like "no jobs" | High | Failure ≠ empty (§5); unhealthy flag in state.json |
| feed.json grows too large | Medium | Strict US student-role scope + active-only/7-day closed retention (§3.4); sharding as measurement-triggered upgrade (§3.5) |
| False merge in dedupe hides a real role | High | Conservative bias; provenance-first upgrade adds req ID + URL match layers before fuzzy |
| Discovery floods registry with low-value sources | Medium | Verification pipeline, Workday manual review gate, measured unique-posting yield threshold |
| Generic extraction produces unstable IDs or false postings | Medium | HTML heuristic results quarantined with `review_required`; high-confidence methods (JSON-LD, RSS) only auto-published |
| Seasonal polling under-polls off-season boards | Medium | Off-season cap still maintains detection latency; unknown season always polls at default intervals |
| Hot-watch overloads a single host | Low | Per-host rate limits, request budgets, mandatory expiry, three-failure circuit breaker |
| Gmail sync privacy perception | Medium | Read-only scope, local-only processing, no email body stored, explicit opt-in, instant disconnect |
| Project becomes a substitute for applying | **Highest** | Core app ships fast; extension follows real usage |
