# Block 3 Career-Board Discovery — TDD Evidence

## Source plan and research

- Source plan: `.claude/plans/expansion-phase.md`, Block 3 (local and Git-ignored).
- Common Crawl contracts were checked against the official
  [Index Server](https://index.commoncrawl.org/) and dynamic
  [`collinfo.json`](https://index.commoncrawl.org/collinfo.json). The implementation
  discovers the current `cdx-api` URL at runtime and does not pin a crawl release.
- The initial Common Crawl query set is intentionally limited to Greenhouse, Lever,
  and Ashby. Recognition of Workday and SmartRecruiters URLs does not widen that query.

## User journeys

1. As a registry maintainer, I want a bounded latest-index scan so that Nightjar finds
   public ATS boards without crawling the web itself or creating an unbounded review bill.
2. As a reviewer, I want candidates canonicalized, verified, and provenance-preserving
   so that I can promote stable boards without confusing source failures with empty boards.
3. As a registry maintainer, I want conservative company identity proposals so that hosted
   ATS domains, fuzzy names, and parent/subsidiary relationships never cause silent merges.
4. As an operator, I want monthly discovery serialized with polling so that generated public
   catalog files cannot race other repository writers.

## RED and GREEN evidence

| Stage | Command | Result | Evidence |
|---|---|---|---|
| Initial RED | `.venv\Scripts\python.exe -m pytest poller/tests/test_block3_discovery.py -q` | RED | Collection reached the new test target and failed with `ModuleNotFoundError: No module named 'poller.discovery'`. |
| Security RED | targeted `pytest -k "private_or_non_dns or private_networks"` | RED | 9 intended failures proved private/link-local/non-DNS destinations and private redirect targets were initially accepted. |
| Security GREEN | same targeted command | PASS | `9 passed, 37 deselected`; discovery now rejects those targets before a request. |
| Fairness RED | targeted `pytest -k "global_candidate_budget or fair_across"` | RED | 2 intended failures proved a full Greenhouse result could prevent Lever/Ashby queries. |
| Fairness GREEN | same targeted command | PASS | `2 passed, 45 deselected`; all three PoC families are queried and candidates are selected round-robin under the 500-candidate ceiling. |
| Provenance RED | targeted `pytest -k structured_directory_redirects` | RED | Structured directory provenance was missing after redirect detection. |
| Parse-safety RED | targeted `pytest -k html_error_page` | RED | A 200 HTML upstream error page initially looked like a successful zero-candidate query. |
| Workflow-policy RED | targeted `pytest -k workflow_is_monthly` | RED | The workflow attempted to stage intentionally Git-ignored `registry_candidates.json`. |
| Focused GREEN | `.venv\Scripts\python.exe -m pytest poller/tests/test_block3_discovery.py -q` | PASS | `51 passed`. |
| Static checks | Ruff + strict mypy on Block 3 modules, tests, and `poller/http.py` | PASS | `All checks passed!`; `Success: no issues found in 10 source files`. |
| Full regression | `.venv\Scripts\python.exe -m pytest -m "not live" -q` | PASS | Final gate after documentation and all edge-case additions: `826 passed in 43.75s`. |

The repository's `.git` metadata is read-only in this execution environment, so RED/GREEN
checkpoint commits could not be created (`.git/index.lock: Permission denied`). This report
preserves the checkpoint evidence instead; no history was rewritten.

## Test specification

| # | What is guaranteed | Test target | Type | Result |
|---|---|---|---|---|
| 1 | Only the current Greenhouse/Lever/Ashby PoC patterns are queried through the latest official Common Crawl index | `TestCommonCrawlDiscovery` | Unit/integration | PASS |
| 2 | Canonical board identity ignores job paths/query strings and rejects unsafe or unknown URLs | `TestCandidateCanonicalization` | Unit | PASS |
| 3 | Existing registry sources and duplicate archived URLs are removed before verification | `TestCommonCrawlDiscovery` | Unit | PASS |
| 4 | Verification is schema-aware; 404/410 becomes dead, transient/schema failures remain pending, and valid empty lists remain distinct | `TestVerification` | Unit | PASS |
| 5 | Workday is always manual-review-only and uses the 20-item page limit to estimate poll cost | `TestVerification.test_workday_is_never_auto_promoted` | Unit | PASS |
| 6 | Catalog merges preserve first-seen timestamps, verification state, and all provenance | `TestCatalog` | Unit | PASS |
| 7 | Redirect detection respects robots rules, follows at most three hops, and rejects private/local targets | `TestRedirectAndDirectories`, `TestDiscoveryHttpPrimitives` | Unit/integration | PASS |
| 8 | Exact ATS/domain identity matches may auto-link; fuzzy names only propose review; parent/subsidiary identities remain distinct | `TestIdentityResolution` | Unit | PASS |
| 9 | Only verified supported boards generate registry candidates; discovery never edits `companies.yaml` | `TestCatalog`, `TestDiscoveryIntegration` | Integration | PASS |
| 10 | The monthly workflow is manual-triggerable, bounded, serialized, and has a 90-minute timeout | `test_discovery_workflow_is_monthly_manual_bounded_and_serialized` | Contract | PASS |

## Coverage and known gaps

`coverage.py`/`pytest-cov` are not installed in the offline environment. Python's standard
`trace` module was used as a statement-execution fallback:

```text
python -m trace --count --missing --summary ... --module pytest poller/tests/test_block3_discovery.py -q
51 passed
weighted statement execution across new discovery modules/tool: 83.1%
```

This is statement coverage, not branch coverage. Individual results include 89.3% for
`common_crawl.py`, 90.8% for `identity.py`, 92.6% for `models.py`, and 81.2% for
`verify.py`. The lower-level HTTP client is also covered by the pre-existing HTTP suite;
the Block 3 tests specifically exercise text/NDJSON fetching, bounded redirects, and private
target rejection.

No live Common Crawl scan or public-board verification was run during the offline test suite.
The first live workflow run, review/promotion of its output, and measured post-promotion poll
remain operational exit gates before the PoC pattern set may be widened.
