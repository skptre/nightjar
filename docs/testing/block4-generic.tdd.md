# Block 4 Generic Extraction — TDD Evidence

## Source plan and research

- Source plan: `.claude/plans/expansion-phase.md`, Block 4 (local and Git-ignored).
- Robots behavior follows [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html): specific user-agent groups, longest matching path,
  allow-on-tie, wildcard/end anchors, 4xx unavailable handling, and fail-closed unreachable
  handling.
- Sitemap shape/host/`lastmod` behavior follows the
  [Sitemaps protocol](https://www.sitemaps.org/protocol.html); Atom entry identity follows
  [RFC 4287](https://www.rfc-editor.org/rfc/rfc4287.html); job fields follow
  [schema.org `JobPosting`](https://schema.org/JobPosting).
- Scrapling was evaluated from its current
  [official package documentation](https://pypi.org/project/scrapling/). It was not added:
  the parser-only core does not improve these bounded structured formats, and its fetching
  extras emphasize browser execution, fingerprint impersonation, and anti-bot bypasses that
  conflict with Nightjar's explicit bans.

## User journeys

1. As a feed maintainer, I can cover a static custom career site through structured public
   metadata without adding a company-specific scraper.
2. As a source operator, I can trust robots, same-host, request-budget, and challenge-page
   limits to keep generic extraction polite and bounded.
3. As a feed consumer, I receive only stable, high-confidence structured postings; ambiguous
   semantic HTML is quarantined for review and never published.
4. As a poller operator, malformed or unsupported content is a source failure rather than an
   empty snapshot, so existing postings are retained.

## RED and GREEN evidence

| Stage | Command | Result | Evidence |
|---|---|---|---|
| Initial RED | `.venv\Scripts\python.exe -m pytest poller/tests/test_block4_generic.py -q` | RED | Collection failed with `ModuleNotFoundError: No module named 'poller.sources.generic'`. |
| Robots RED | focused disallow test | RED | A `/careers/` rule initially did not block the normalized `/careers` board scope. |
| Robots GREEN | Block 4 focused suite | PASS | Board scope and every subsequent request are robots-checked. |
| Robots-feed RED | focused robots RSS test | RED | An RSS URL advertised through `Sitemap:` was initially rejected as a malformed sitemap. |
| Schema-safety RED | focused malformed feed/sitemap tests | RED | Structurally present but malformed entries initially collapsed to empty lists. |
| Focused GREEN | `.venv\Scripts\python.exe -m pytest poller/tests/test_block4_generic.py -q --basetemp .tmp/pytest-block4-focused` | PASS | `43 passed`. |
| Static checks | Ruff + strict mypy on Block 4 files | PASS | `All checks passed!`; `Success: no issues found in 5 source files`. |
| Full regression | `.venv\Scripts\python.exe -m pytest -m "not live" -q --basetemp .tmp/pytest-block4-combined-final` | PASS | `972 passed in 42.30s`. |

The repository's `.git` metadata is read-only in this managed environment, so RED/GREEN
checkpoint commits cannot be created. This report preserves the checkpoints without
rewriting history.

## Test specification

| Guarantee | Type | Result |
|---|---|---|
| RFC-style robots group/rule selection, sitemap discovery, 4xx allowance, and unreachable fail-closed behavior | Unit/integration | PASS |
| Sitemap index traversal extracts three job pages, same-host only, with `lastmod` provenance | Unit/integration | PASS |
| RSS five-item and Atom feeds preserve stable entry IDs and dates | Unit | PASS |
| Full and minimal JSON-LD populate stable identity, location, salary, dates, work type, and niche metadata | Unit | PASS |
| Next.js and initial-state hydration are parsed as JSON without script execution | Unit | PASS |
| HTML heuristics are low-confidence review candidates and cannot be returned by `fetch` | Unit/integration | PASS |
| CAPTCHA/challenge, malformed structured data, and unsupported markup never become empty snapshots | Unit/integration | PASS |
| No company run exceeds 100 requested pages; all requests carry generic/company accounting into the shared rate-limited client | Integration | PASS |
| Adapter registration and priority 5 are enforced | Contract | PASS |

## Coverage and known constraints

`pytest-cov` is not installed in the offline environment. Python's standard `trace` module
reported 89.5% statement execution for `poller.sources.generic` (`43 passed`). This is
statement coverage, not branch coverage.

No public career site was contacted; all tests are deterministic fixtures. Page-level
conditional 304 reuse is intentionally deferred because the current adapter contract returns
a complete source snapshot and has no safe channel for carrying prior postings from unchanged
individual pages. The adapter records sitemap `lastmod` now; enabling partial conditional
reuse requires a snapshot-preserving cache contract first.
