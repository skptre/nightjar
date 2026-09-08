# Description and classification validation — September 7, 2026

Latest checkpoint for [expansion](expansion.md): implementation and offline checks
are in place. Full live backfill and independently reviewed accuracy are **not
complete**. The proposed 95% completeness target has not been demonstrated.

## Implemented

- Acquisition v4 tries supported ATS APIs, then guarded public job pages. Extraction
  handles matching JSON-LD, JobPosting microdata, hydrated job data and scoped visible
  descriptions. It preserves additional structured requirements, headings, lists and
  ending clauses. Conflicting documents are rejected; significant job query parameters
  remain part of identity matching. Generic HTML/hydration stays `partial`. A visibly
  fuller document containing a structured teaser is retained as partial evidence.
- Public HTTPS fallback handles unfamiliar employers without guessing ATS boards.
  Bounded redirects check every destination and its robots policy. Prohibited domains
  and private URL literals are declined. Robots 404/410 permit collection; authorization,
  throttling and server failures do not. Acquisition records method and provenance.
- Every active job has a collection outcome, including when the batch budget is zero.
  Persistent retries advance through older attempts. A quarter of each batch (at least
  one slot when there is budget) is reserved for overdue successful content. Failed or
  partial refreshes preserve earlier complete descriptions as stale.
- Source shards reference immutable, content-addressed description packs. All changed
  jobs are hydrated before local classification, including unopened jobs. The app
  verifies pack/document hashes, reuses local text and bounds concurrent downloads.
  Corruption preserves existing local data. The monolithic feed retains inline text.
  Legacy clients see external content as unavailable; updated clients restore actual
  acquisition status only after verified hydration.
- Classifier v5 keeps work and industry separate. Explicit employer self-description
  can establish aerospace/quant fields without inventing employee duties. Customers,
  partners, preferred skills and recruiting prose do not establish duties. Generic
  research titles can use specialized duties. Software + aerospace and software +
  quant keep intersection semantics.
- Details v3 recognizes additional headings and separates mandatory and preferred
  sentences in mixed paragraphs while preserving original evidence offsets.
  Partial/unverified descriptions cannot justify applicant exclusion.
- The isolated enrichment tool supports bounded `--rounds`, resumes output state and
  reports complete coverage against **all active jobs**, outcomes and pack bytes.
  It does not publish output.

## Validation

| Check | Result |
| --- | --- |
| Full offline Python suite | 1,150 passed |
| Full offline app suite | 1,100 passed across 39 files |
| Final pack compatibility regressions | 33 Python and 57 app tests passed |
| Static checks | Ruff, strict mypy (96 source files), TypeScript passed |
| Production app build | Passed using the project's Vite configuration |
| Published snapshot | 4,305 active jobs; zero descriptions; unchanged |
| Recognizable ATS detail targets | 3,027/4,305; recognition, not successful collection |
| Existing September 6 isolated backfill | 12 descriptions from 20 attempts; unchanged |
| Re-audit of those 12 documents | Zero invalid evidence offsets; unresolved roles 3 without text, 2 with text |
| Pack round trip on that snapshot | 4,471 records including closed; 12 documents, 11 packs, 58,887 bytes; equal after hydration |
| New bounded live collector probe | One attempt, zero successes; network blocked |

The 12-document sample is neither representative nor an independent holdout. Unknown
rate is not precision/recall. Regression fixtures establish specific contracts, not
universal extraction accuracy.

Gitignored evidence: `.tmp/expansion-release-pytest.log`,
`.tmp/expansion-release-vitest.log`, `.tmp/expansion-details-audit.json`,
`.tmp/expansion-pack-validation/report.json`, and
`.tmp/description-validation-20260907/report.json`.

Outbound sockets fail with `WinError 10013` in this workspace. The bounded collector
report records a failed source fetch and 4,304 pending jobs. No public data was
replaced. Vite config bundling also hit a parent-directory ACL restriction; a temporary
runner loaded the transpiled **same project configuration** for tests/build, without
changing permanent configuration. The runner was removed after validation.

## Remaining release work

1. Run the isolated backfill below on a network-capable machine and review its report.
   Resume as needed; persistent backoff still applies. Diagnose failures by provider
   and template instead of treating recognizable URLs as successful extractions.
2. Independently compare stored text with source documents across providers, role
   families, unfamiliar employers and partial/failure outcomes. Measure identity,
   completeness, requirement evidence and role/field accuracy. Check ending clauses.
3. Add fixture-backed contracts for measured gaps. PDF extraction and broad custom
   template certification are not implemented. Protected/JavaScript-only pages may
   remain partial or unavailable; no bypass or headless navigation was added.
4. Measure full-backfill transfer/storage costs. Old immutable packs are retained so
   older manifests work; garbage collection and Git-history retention need a measured
   policy. The monolithic compatibility feed still grows with descriptions.
5. Roll out the updated app and verified public data together, then proceed to the
   description UI. Coverage discovery and the wider UIUX plan remain separate work.

```powershell
uv run python -m poller.tools.enrich_descriptions --live --limit 200 --rounds 25 --output .tmp/description-release
cd app
npm.cmd run audit:details -- ../.tmp/description-release/feed.json
```

This stages a candidate feed, not a publication or quality certification. No personal
data belongs in these outputs. Source contracts consulted:
[Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html) and
[Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309.html).
