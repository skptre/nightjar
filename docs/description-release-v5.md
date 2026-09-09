# Description release checkpoint — September 8, 2026

This supersedes the September 7 network-blocked checkpoint. Live requests work in
this session. The goal is correct source text delivered to the app, with complete,
partial, stale and unavailable states kept distinct. Company additions remain
Claude's work; the measurement cohort is the existing 4,305 active postings.

## Implemented and verified

- Acquisition version 5 replaces arbitrary title prefixes with explicit token
  normalization and seniority checks. Intern/internship and engineer/engineering
  are accepted variations. Intern/Internal Auditor, Engineer II/III, C++/C#,
  Summer Analyst/Associate and conflicting supplied years are rejected. Finance
  titles need no `intern` keyword to retrieve descriptions.
- iCIMS URL matching uses the same employer host and requisition ID, ignoring
  cosmetic slugs and known mobile presentation flags. Other query identity remains.
  Recognized embedded detail frames require the same employer host and requisition;
  both live Joby internships now yield complete descriptions.
- JazzHR vanity domains require an explicit canonical link for the identical
  application path and a fresh, robots-checked canonical page with matching title.
- Rippling server page data preserves role, company and legal text. TikTok and
  ByteDance streamed job modules are decoded as data, with URL/job-ID/title checks,
  bounded page size and rejection of missing text references. No JavaScript is
  executed. These recoveries are partial, not certified complete.
- Oracle candidate sites use the public job-detail response for the page's exact
  requisition and site. All external description, responsibilities, qualifications,
  corporate and organization fields are retained; internal/contact fields are not
  requested. Missing fields prevent a completeness claim.
- Workable application URLs resolve correctly. When the page advertises a Markdown
  document, its exact employer/job route, title and application backlink are checked.
  This is retained as partial source text.
- Backfill writes feed/packs/state/manifest after each completed batch, logs progress,
  and resumes with the recovered description rather than an older input snapshot.
- `poller.tools.stage_descriptions` stages a current-feed release without replacing
  source health, closure history or posting identity. It never writes its input.
- Classifier version 6 adds narrowly evidenced mechanical modeling duties for the
  recovered J&J design co-op. Explicit software roles keep their role; qualification
  lists do not establish duties. Hitachi's multi-discipline pool stays broad.

## Claude adapter integration review

- USAJOBS now requests `Fields=Full` and retains duties, qualifications, education,
  requirements, benefits, application instructions/documents and closing text.
  Summary-only responses are partial. Missing required response structure and
  incomplete pagination fail instead of reporting an empty board.
- USAJOBS requires both `USAJOBS_API_KEY` and the registered `USAJOBS_EMAIL`.
  Workflow environment mappings are prepared; no credentials were present locally,
  so authenticated live USAJOBS validation remains outstanding. Optional federal
  coverage does not block launching the other sources.
- Custom authenticated JSON requests do not forward API keys through redirects.
- iCIMS listing fetches honor robots, reject unrecognized empty HTML and fail on
  exhausting pagination. A live Joby board returned 210 jobs, including two U.S.
  internships. Direct iCIMS detail retrieval uses the same acquisition engine.
- Both new source types are registered in deduplication priority. At the review
  snapshot the 428-company registry did not yet contain either new source type;
  adapters existing does not itself activate those employers. Recheck after Claude
  finishes the registry additions. NASA JPL currently uses its Workday board.

## Validation and release artifacts

- Python full suite: 1,205 passed; ruff and strict mypy passed.
- App full suite: 1,119 passed; TypeScript passed after the final release check.
- `app/scripts/release-validation.test.mjs` is an opt-in, **offline** real SQLite sync
  check using the staged monolith/manifest/shards/packs. It compares every cached
  description against its original full source string. No mocks of the database or
  sync logic, no employer requests, no applicant data.
- Final cohort: 4,305 active postings; **3,202 with text (74.38%)**, versus 2,594
  before these fixes: 608 additional descriptions. Of those, **2,875 complete
  (66.78% of active)**, 321 partial, six stale; 1,103 unavailable. These figures
  measure acquisition completeness, not classifier accuracy. Metrics are retained
  in `.tmp/description-ready/release-metrics.json`.
- The real-app release check passed with 4,471 records including old closures
  and 3,202 exact description strings.
- Logs: `.tmp/descriptions-final4.log`, `.tmp/descriptions-final-app.log`,
  `.tmp/description-release-app-final.log`, `.tmp/icims-live-review.json`.
- Candidates: `.tmp/description-release-v5`, `.tmp/oracle-release-v5`,
  `.tmp/description-followup-v5`, `.tmp/icims-final-v5`. Final staged bundle: `.tmp/description-ready`.

To recreate the combined staged bundle:

```powershell
uv run python -m poller.tools.stage_descriptions --candidate .tmp/description-release-v5 --candidate .tmp/oracle-release-v5 --candidate .tmp/description-followup-v5 --candidate .tmp/icims-final-v5
cd app
$env:NIGHTJAR_RELEASE_DIR='../.tmp/description-ready'
npm.cmd test -- --run scripts/release-validation.test.mjs
```

The temporary Codex Vitest runner works around this environment's parent-directory
configuration bundler restriction; it is removed after validation. Normal local
commands above use the repository's Vite configuration.

The validated staged feed, shards, detail packs, manifest and description retry
state are now installed in local `data/`. Poll history, posting dates and closure
state were checked unchanged. Pre-install backup: `.tmp/description-public-before`.
Nothing has been committed, pushed, published or scheduled by Codex.

## Turning on polling

The normal poller already collects descriptions in bounded batches of 200 and
publishes immutable packs. There is no separate description service to enable.
After Claude finishes verifying the new registry sources, commit the code and the
validated local data, run one manual workflow, inspect its source-health summary
and actual app descriptions, and then enable the commented schedule in
`.github/workflows/poll.yml`. This session does not dispatch workflows or enable
the recurring schedule. Failed sources must retain their previous postings.

Do not classify all remaining extraction failures as JavaScript-only. The remaining
work includes actual removed jobs, access/robots refusals, materially different
source titles, additional site contracts and some still-unrecognized page data.
No blanket fuzzy-title relaxation, CAPTCHA bypass or fabricated description is an
acceptable route to a larger coverage percentage.

Primary source references used during implementation:
[Oracle candidate job details](https://docs.oracle.com/en/cloud/saas/human-resources/farws/op-recruitingcejobrequisitiondetails-get.html)
and [USAJOBS full search fields](https://developer.usajobs.gov/api-reference/get-api-search).
Live first-party page captures and minimized public fixtures substantiate the other
contracts; these observations are not claims that every page from a provider works.


## September 9 follow-up: bounded storage and source readiness

This supersedes the immutable-pack retention policy above. The feed now writes at
most 16 named `details/descriptions-0.json` through `descriptions-f.json` bundles.
Unused generated bundles are removed after shard/index generation; Git retains
history. Both readers accept legacy references, but old app builds need updating
before publishing the new layout. Pack and document hashes remain mandatory.
The app revalidates HTTP caches and retains all local data on a deployment mismatch;
the next sync retries without advancing the stored feed hash. Bundle replacements
can transfer more text per changed job; this change bounds file count, not bytes.

Claude's two registry additions and shared-type test fixes were reviewed and kept.
Registry: 430 companies, all seven source types. Live Joby fetch on September 9
returned 218 total postings and two U.S. internships (the earlier 20 count was not
this complete live snapshot). NASA's credentials were absent in this terminal and
Windows user environment; GitHub Actions already maps both secrets. Do not infer
that missing local credentials means the user's GitHub secrets are missing.
USAJOBS now rejects duplicate job IDs across pages rather than reporting an
incomplete agency snapshot as successful. The offline repeated-page regression
failed before the fix and passes afterward.

Evidence: `.tmp/source-readiness.json`, `.tmp/readiness-tests.log` (1,207 passed),
`.tmp/storage-app-tests.log`. Staged migration: `.tmp/storage-release`.


The migration is installed in local `data/`: **335 files / 19,340,357 bytes became
16 files / 14,768,629 bytes**, retaining all 3,202 descriptions. `feed.json` and
`state.json` are byte-identical to their pre-migration versions; only delivery
shards, manifest and bundles changed. Backup: `.tmp/storage-before`.
Final validation: 1,207 Python tests, ruff and strict mypy clean; 1,122 app tests
across 45 files including the real full-feed import, plus TypeScript clean.
An initial fully parallel app run timed out in an unrelated tracker test; isolated
recheck and the complete suite with four workers passed. Final evidence is
`.tmp/storage-app-final.log`. No preview server, publishing or recurring poll was
started. Commit the app reader and generated bundles together before publishing.
