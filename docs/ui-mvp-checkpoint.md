# MVP interface checkpoint — September 8, 2026

User direction: implement the design in `.claude/plans/UIUX.md` now, while Claude
handles employer additions. Warm charcoal, restrained surfaces, minimal navigation,
and a clear primary Apply action. No new UI library or font/image service dependency.

## Implemented

- Shared design tokens, custom Nightjar mark/favicon, dark default, Light/System modes
  and comfortable/compact tracker rows. Appearance survives navigation and reload.
- Home / Jobs / Tracker. Top navigation in browser, sidebar when Tauri is detected,
  bottom navigation on narrow screens. Settings stays a utility. Returning users resume
  their last destination; first-time Browse jobs goes directly to the catalog.
- Skippable welcome/personalization. Opening and cancelling preferences preserves the
  existing profile; editing retains contacts, company tiers and other unrelated fields.
- Home uses real local deadlines, saved jobs and watched-company updates. Following
  companies works without a profile. Empty states are actionable, with no fake activity.
- Jobs retains virtual scrolling and Role/Field intersections. Guest classification
  now runs without inventing a personal profile or eligibility assessment. New arrivals
  wait for Show, while changes to existing descriptions update normally.
- Job detail pane / mobile reading view: original excerpts, full source text, pay when
  available, company follow, Save, external Apply and explicit Mark applied. Missing,
  partial and stale descriptions have distinct explanations. Incoming description
  text refreshes an already-open pane. No browser-side employer scraping was added.
- Tracker is an editable table with All/Saved/In progress/Archived, search, company/due
  sorting, stages, dates, next steps, notes, manual URL entries and CSV export. Mobile
  expands rows to expose the same fields. Public closure is separate from application
  stage; manual records are not closed merely because a public feed omits them.
- Applied / Interviews / Offers use modest counts, without response-rate judgments.
  Existing outcome events retain interview/offer milestones after status transitions.
- Settings exposes appearance, preferences, alerts and existing data exports/deletion.
  Removed sync interval/feed URL controls and persistent background-success labels.
- Watched-company system alerts are explicitly enabled in Settings after following a
  company. No automatic permission prompt. At most one bundled notice per update,
  only while Nightjar is running in the background. Job IDs prevent repeat batches.
  Home has a persistent, dismissible invitation; saving a company grants no permission.
- Save no longer overwrites existing application status, dates or notes. Apply opens
  the employer page without claiming submission. Outcome dialogs contain keyboard
  focus. Clear local data now includes the description cache with foreign keys enabled.

## Validation and preview

Full offline app run: **1,109 tests passed across 43 files**. Additional focused
checks cover incoming descriptions, deferred new rows, cancelling profile edits and
clearing description records. TypeScript and production Vite build passed. Logs:
`.tmp/ui-tests.log`, `.tmp/ui-final-workflow.log` and `.tmp/ui-final-checks.log`.

Inspected actual local Chrome renders at 1440px and 390px, including the welcome,
populated Jobs, full/absent descriptions, light Settings, Home watches and expanded
mobile Tracker. The QA browser used an isolated profile in `.tmp/ui-chrome-review`;
one previously recovered public Notion description was inserted **only in that QA
browser** to inspect the populated state. No demo jobs were added to production data.

Screenshots are gitignored under `.tmp/ui-*.png`. The local development preview is
`http://127.0.0.1:5174` while its server remains running. Normal local command:
`cd app; npm.cmd run dev`. In the restricted Codex environment, Vite's configuration
bundler cannot read a parent directory; validation used a temporary runner loading
the transpiled same configuration. The browser connector could not approve opening
a tab, so visual checks used an isolated local Chrome process instead. No hosted
deployment, public data publication or employer registry changes were made.

## Deliberately still outstanding

- Full live description coverage/accuracy validation and the automatic coverage engine.
  The UI handles incoming data; its presence does not mean every posting has a description.
- Saved searches and saved-search alerts; advanced quiet hours and notifications while
  the application is fully closed. Native notification delivery needs a packaged Tauri
  smoke test; browser Notification support varies by runtime.
- Spreadsheet import, cross-device restore and configurable optional table columns.
  Existing exports and manual entry work; no nonfunctional import button is displayed.
- Assessment milestone counts need persistent assessment events before displaying a
  historical total. The MVP shows three supported counts instead of a misleading fourth.
- The tracker currently expands application notes and fields inline; sharing the full
  Jobs description pane there can follow. Optional personalization is still the existing
  two-step form, with corrected theme and preservation behavior.
- Hosted marketing/download distribution and actual company logos. The welcome is local;
  there is no fabricated download link or guessed company-logo domain.

The full UIUX plan remains the longer-term design direction. This checkpoint records
the functional MVP slice actually implemented, rather than marking every future item done.
