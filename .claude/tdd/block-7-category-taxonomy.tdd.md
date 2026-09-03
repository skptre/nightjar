# Block 7 category taxonomy — TDD evidence

## Source plan

`.claude/plans/expansion-phase.md`, Block 7.

## User journeys

- A user can choose target disciplines beyond software and receive matches for any applicable discipline on a cross-functional posting.
- A user sees one stable primary category while filtering and scoring use up to three category tags.
- An existing user upgrades without losing cached postings or an old `ml` preference.

## RED / GREEN evidence

- RED: `node.exe node_modules/typescript/bin/tsc --noEmit` failed after the Block 7 tests were added because category groups, category tags, scoring tags, and the pending-cache migration did not exist.
- GREEN: the same type-check passed after implementation.
- GREEN: the full app suite passed through a temporary programmatic Vitest runner using `config: false` to avoid the managed Windows sandbox's Vite config-resolution restriction: 17 files, 669 tests passed.
- GREEN: a production Vite build with `write: false` transformed 102 modules and completed successfully.

## Guarantees

| Guarantee | Evidence | Type | Result |
|---|---|---|---|
| Expanded taxonomy contains all 18 values and profile choices are grouped by domain | `src/classify/category-taxonomy.test.ts` | Unit | PASS |
| Title evidence wins primary category, specialized rules win ties, and tags are capped at three | `src/classify/category-taxonomy.test.ts` | Unit | PASS |
| Robotics, aerospace controls, ML software, and quant software retain cross-discipline tags | `src/classify/category-taxonomy.test.ts` | Unit | PASS |
| Any tag overlap earns the full category score | `src/classify/category-taxonomy.test.ts`, `src/classify/scoring.test.ts` | Unit | PASS |
| Stored tags are parsed safely and legacy `ml` becomes `data-ml` | `src/classify/category-taxonomy.test.ts`, `src/profile/profile.test.ts` | Unit | PASS |
| A schema-v2 cache migrates to v3 with `category_tags`; all cached rows are reclassified once, including closed rows and offline launch | `src/db/database.test.ts`, `src/classify/category-taxonomy.test.ts` | Integration | PASS |
| Existing application behavior remains green | Full app test suite | Regression | PASS |

## Coverage and known gaps

The repository does not install a Vitest coverage provider, so no numeric coverage report was generated. New Block 7 behavior has 45 focused tests plus the existing classification, scoring, database, profile, feed, and integration suites. The phase-wide manual audit of 200 real postings remains a separate acceptance gate and is intentionally still unchecked in the plan.

## Merge evidence

The managed workspace exposes `.git` read-only, so RED/GREEN checkpoint commits could not be created (`.git/index.lock: Permission denied`). The test files and this report preserve the RED/GREEN evidence for the eventual user-created commit.
