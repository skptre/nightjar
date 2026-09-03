# Block 8 outcome recalibration — TDD evidence

## Source plan

`.claude/plans/expansion-phase.md`, Block 8.

## User journeys

- A user can move an application to an interview or terminal stage, optionally record rounds and notes, or skip details without cancelling the move.
- A later result does not erase an earlier interview; Nightjar keeps an immutable, local event history while showing the latest outcome on the application.
- After 10 recorded outcomes, a user sees cautious, sample-sized patterns and can explicitly apply or dismiss any scoring suggestion.
- A user can inspect local application, interview, offer, response-time, category, tier, ghost-rate, and weekly activity statistics.
- Outcome data survives browser-to-Tauri migration and is included in application exports.

## RED / GREEN evidence

- RED: `node.exe node_modules/typescript/bin/tsc --noEmit` failed after the initial tests because the outcome service, recalibration engine, profile adjustments, and UI components did not exist.
- RED: focused tests then exposed missing company-level response analysis, tier ghost-rate observations, non-atomic migration rollback, duplicate-submit locking, browser-to-Tauri outcome transfer, and outcome export coverage.
- GREEN: each focused suite passed after its implementation.
- GREEN: strict TypeScript checking passed.
- GREEN: the full app suite passed through a temporary programmatic Vitest runner using `config: false` to avoid the managed Windows sandbox's Vite config-resolution restriction: 19 files, 702 tests passed.
- GREEN: an equivalent production Vite build with `configFile: false` and `write: false` transformed 107 modules and completed successfully.

## Guarantees

| Guarantee | Evidence | Type | Result |
|---|---|---|---|
| Schema v4 adds outcome summaries, immutable events, suggestion actions, indexes, and upgrades v2/v3 databases | `src/db/database.test.ts` | Integration | PASS |
| A failed migration rolls back both schema changes and version atomically | `src/db/database.test.ts` | Integration | PASS |
| Interview and terminal transitions persist timestamps, normalized details, cumulative rounds, and event history | `src/outcomes/outcomes.test.ts` | Integration | PASS |
| Auto-ghost writes both the application summary and outcome event | `src/views/Pipeline/pipeline.test.ts` | Integration | PASS |
| Browser-to-Tauri migration preserves category tags, outcome summaries/history, and suggestion decisions, while older databases receive safe defaults | `src/db/database.test.ts` | Integration | PASS |
| Recalibration waits for 10 outcomes and covers category, tier, company response, ATS association, timing, and ghost patterns with cautious language and sample sizes | `src/outcomes/outcomes.test.ts` | Unit | PASS |
| Suggestions never alter scoring until explicitly applied; profile validation bounds stored adjustments | `src/outcomes/outcomes.test.ts`, `src/profile/profile.test.ts` | Unit | PASS |
| Empty and all-rejection histories receive the required safe, supportive messaging | `src/outcomes/outcomes.test.ts`, `src/outcomes/outcomes-ui.test.tsx` | Unit/UI | PASS |
| Outcome dialogs support optional details, skip/cancel, keyboard dismissal, and repeat-submit locking | `src/outcomes/outcomes-ui.test.tsx` | UI | PASS |
| Stats render with accessible summaries, tables, weekly activity, and explicit Apply/Dismiss controls | `src/outcomes/outcomes-ui.test.tsx` | UI | PASS |
| CSV exports latest outcome fields and JSON preserves immutable event history | `src/export/export.test.ts` | Integration | PASS |
| Existing application behavior remains green | Full app test suite | Regression | PASS |

## Coverage and known gaps

The repository does not install a Vitest coverage provider, so no numeric coverage report was generated. Block 8 has focused persistence, migration, analysis, profile, export, auto-ghost, and UI tests in addition to the full regression suite. Gmail-assisted outcome detection remains Block 9 and was intentionally not implemented here.

## Merge evidence

The managed workspace exposes `.git` read-only, so RED/GREEN checkpoint commits could not be created (`.git/index.lock: Permission denied`). The test files and this report preserve the RED/GREEN evidence for the eventual user-created commit.
