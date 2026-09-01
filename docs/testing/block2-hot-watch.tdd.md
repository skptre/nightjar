# Block 2 Hot Watch and Seasonality — TDD Evidence

## Source

Behavior was derived from `.claude/plans/expansion-phase.md`, Block 2. The plan was
treated as design input and reconciled with `CLAUDE.md` and `spec.md` poller laws.

## User journeys

- As a Nightjar operator, I can arm a bounded, auditable watch only after a successful
  baseline so launch monitoring never creates phantom-new alerts.
- As a Nightjar operator, I can run a five-minute managed watch that polls only selected
  sources while preserving all unpolled and failed-source postings.
- As a Nightjar operator, I can use a two-minute local foreground watch without writing
  public feed or state files.
- As a feed maintainer, I can mark only known seasonal cohorts so high-priority sources
  fall back to six-hour polling off-season without slowing unknown companies.

## RED evidence

- `python -m pytest poller/tests/test_block2_seasonality.py -q --basetemp
  .tmp/pytest-block2-red` — 14 expected failures because `Company.seasonal_pattern`
  and seasonal validation/scheduling did not exist.
- `python -m pytest poller/tests/test_hot_watch.py
  poller/tests/test_block2_pipeline.py -q --basetemp .tmp/pytest-block2-hot-red`
  — collection failed with `ModuleNotFoundError: No module named 'poller.hot_watch'`.

Git RED/GREEN checkpoint commits could not be created because this managed environment
denied creation of `.git/index.lock`. The failing and passing commands above preserve the
runtime evidence instead.

## GREEN evidence

| Guarantee | Evidence | Type | Result |
|---|---|---|---|
| Invalid, sub-five-minute, over-seven-day, unknown-source, and expired watches cannot poll | `poller/tests/test_hot_watch.py` | Unit | PASS |
| Duplicate watches coalesce without duplicate fetches | `poller/tests/test_hot_watch.py` | Unit | PASS |
| Enabling requires a healthy, bootstrapped baseline from the previous 24 hours | `poller/tests/test_hot_watch.py` | Unit | PASS |
| A focused run polls only selected sources and retains every other posting | `poller/tests/test_block2_pipeline.py` | Integration | PASS |
| Failed focused fetches retain prior postings | `poller/tests/test_block2_pipeline.py` | Integration | PASS |
| Three consecutive failures mark the watch unhealthy without erasing the feed | `poller/tests/test_block2_pipeline.py` | Integration | PASS |
| Local polling detects stable new IDs and represents failure separately from empty | `poller/tests/test_hot_watch.py` | Unit | PASS |
| Seasonal mappings, boundaries, ramp override, and conservative null behavior work | `poller/tests/test_block2_seasonality.py` | Unit | PASS |
| Focused and control workflows share serialized `poller` concurrency | `poller/tests/test_block2_pipeline.py` | Configuration | PASS |

Commands and outcomes:

- Block 2 tests: 50 passed.
- Full offline suite: `726 passed in 42.49s`.
- Strict typing: `python -m mypy poller/ --strict` — 58 source files, no issues.
- Block 2 lint target: Ruff — all checks passed.
- CLI dry-run: resolved a recent baseline and printed 24 expected cycles without creating
  the requested override file.
- YAML validation: both workflows and `polling-overrides.yaml` parse successfully.

## Coverage and known gaps

- The environment does not have the `coverage` module installed and network access is
  restricted, so a numeric coverage percentage could not be produced. The feature has
  unit, pipeline integration, failure-path, CLI, and configuration coverage.
- `actionlint` is unavailable. Workflow YAML parsing and repository assertions cover the
  critical schedule, command, and concurrency invariants.
- Full-repository Ruff currently reports issues in concurrent Block 1A files and the
  pre-existing Block 0 test/benchmark files. All Block 2 files and shared files changed by
  Block 2 pass Ruff; strict mypy and the entire offline suite are green.
- Google/Microsoft launch-watch validation remains an upstream integration gate because
  research found no safe plain-HTTP first-party endpoint. The watch implementation is
  source-generic and is integration-tested with fixture adapters.
