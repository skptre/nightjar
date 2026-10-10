# Friends beta: release and recovery

Current documentation review: October 9, 2026. See the current app source
for the uncommitted redesign. Implementation descriptions are source-reviewed;
the test results and installer below are September 15 historical evidence, not
validation of the current UI. No new test pass or installed upgrade is claimed.

## What is implemented

- Persistent local profile, watches, tracker and notes; no accounts or hosted private data.
- Complete workspace backup/restore with validation, atomic tracker replacement and
  recovery of interrupted preference restoration. Newer cached postings are retained.
- Automatic local recovery copies and pre-update/pre-restore copies. Database migrations
  save a separate SQLite snapshot first. Clear-data removes automatic copies too.
- Signed GitHub Releases updates with progress, retry, release notes and explicit restart.
- Shared top navigation, monochrome themes, expandable Jobs rows and layered posting/
  filter sheets, table Tracker with Up next cards, Settings rail and desktop startup
  animation. Compact affects Jobs and Tracker. Native watched alerts and save-error
  notices remain part of the implementation.
- Feed freshness, manual refresh, local diagnostics and user-initiated bug reporting.

## Historical validation and limits — September 15, 2026

The offline Python suite passed 1,207 tests, Ruff passed, and strict mypy passed.
The frontend suite passed 1,163 tests (three opt-in tests skipped in the offline run);
all three opt-in real-feed checks passed separately. Six native tests passed.
TypeScript passed and npm audit reported zero vulnerabilities, including development
dependencies. Validation logs are in the gitignored `.tmp/beta-*.log` files. The opt-in real-feed checks verify exact source-text storage, rendering, native
batch limits and backup/restore using the public dataset. Formatting/excerpt tests
exercise the current description implementation without rewriting Claude's formatter.

The history scan examined 2,286 blobs (2,055,892,329 bytes) without finding matches for
GitHub tokens, AWS access keys, private key headers or quoted long assigned secrets.
That pattern scan is not a guarantee against every possible secret or personal datum.
The intentional tracked `app/.env.production` contains the public feed URL only.

GUI testing is not completed: both the browser connector and an isolated headless
Chrome launch were blocked by the session's approval controls. Do not represent the
layout, Windows notification delivery, file dialogs, clean installation or actual
in-app A-to-B upgrade as manually verified until the checklist below is completed.

## Historical Windows artifact — September 15, 2026

The production NSIS build completed successfully for version 0.1.0:
`.tmp/beta-target/release/bundle/nsis/Nightjar_0.1.0_x64-setup.exe`.
Its companion `.exe.sig` verifies against the public key embedded in the app;
a one-byte mutation of the installer was rejected by the same verification library.
This verifies the artifact signature, not an installed version-to-version update.

Installer SHA-256:
`F406038DA0ED7870F6EC18AC99252FAC97D6298BDF3CAD814FCACBA2F99AF83F`.

## Before friends install

This is a future release checklist, not authorization to commit, publish, change
visibility or dispatch workflows during documentation work.

1. Verify the current repository/hosting visibility and anonymous production-feed
   access. September private-repository notes are historical; do not assume the
   remote state is unchanged or change visibility without authorization.
2. Finish current-code validation and review the local changes before preparing a
   release. The checked-in poll.yml schedules every 15 minutes, supports either
   USAJOBS key secret name plus USAJOBS_EMAIL, and publishes data to gh-pages.
   Check actual workflow health and secret configuration without exposing values.
3. Inspect a successful poll and verify anonymous access to meta.json, source shards
   and description bundles at the app's configured production URL. A bundled
   snapshot does not substitute for live updates.
4. Build a draft Windows release through `.github/workflows/release.yml` when
   authorized. package.json, Cargo.toml, tauri.conf.json and tag versions must match.
5. Complete the installed-app checks below before publishing. The updater consumes
   the latest published non-prerelease manifest, not draft or prerelease assets.

At the September 15 checkpoint, the release signing key was created outside the repository and uploaded as
`TAURI_SIGNING_PRIVATE_KEY`. Its local location is recorded in the gitignored
`.tmp/signing-key-location.txt`. Secure a durable offline/password-manager backup of
that key before cleaning temporary files. The app contains only its public key.
Never replace this key casually: existing clients trust the embedded public key.
Updater signatures are separate from Windows Authenticode signing; this work does
not provide a purchased Windows signing certificate or guarantee no SmartScreen prompt.

## Current redesign acceptance checklist (not yet executed)

- Verify Home watches, attention cards and links against real local records.
- Exercise shared search on Home, Jobs, Tracker and Settings; direct links and legacy redirects.
- Check inline job expansion, description loading/failure states, full-sheet previous/next,
  sheet close/focus restoration and filters with Role/Field intersections and empty results.
- Verify bookmarks, undo, Apply versus Mark applied, new-arrival Show and list virtualization
  through density changes, scrolling, expanded rows and background refreshes.
- Exercise Tracker All/Saved/Active/Offer/Closed tabs, stage menus, outcome dialogs,
  manual entries, notes/dates/next steps, Up next cards, sorting and undo persistence.
- Test Settings rail/deep links, optional profile, themes, density, exports and notices.
- Check reduced motion, keyboard-only use, focus, contrast and narrow layouts. Test
  startup completion/skip and rapid navigation or repeated actions during animation.
- Run automated frontend, Python, native and opt-in real-feed checks on the current
  tree. Record results and coverage gaps instead of reusing historical test totals.

## Installed-app acceptance checklist

Use a clean Windows user account or VM, with a synthetic profile and notes.

- Install the NSIS setup executable without Node, Python or Rust installed.
- Start offline: bundled jobs are labeled as a snapshot. Reconnect and refresh.
- Personalize, follow a company, save a job, mark applied, edit notes and a deadline.
  Close normally, reopen, reboot, and confirm all data and settings remain.
- Open twice: the existing window should focus, without a second database writer.
- Test dark/light/system themes, Jobs and Tracker density, compact scrolling and
  keyboard selection, and layout at 1024 x 768, 1280 x 800 and a maximized large display.
- Save a workspace backup through the native file dialog. Change a note; restore the
  file and confirm the note/history/preferences. Cancel a restore; confirm no changes.
  Try invalid JSON and an oversized file; confirm rejection before changes.
- Preview and restore an automatic copy. Confirm a failed backup blocks an update.
- Enable/disable launch-on-login. Minimize and test opted-in watched notifications.
  Closing quits; there are no notifications after the process exits.
- Install version A, preserve the test workspace, publish signed version B, then use
  Check for updates, then Update and restart. Confirm version B and all saved data.
  Test an unavailable endpoint and a tampered package in an isolated test channel;
  neither may result in an unverified installation.
- Export diagnostics and inspect their fields before submitting a test issue. They
  must contain no profile, notes, watches, tokens, local paths or arbitrary error text.
- Clear all local data only on the synthetic test workspace. Automatic copies must
  disappear; manually exported copies remain where the tester saved them.

## Release procedure after the first beta

1. Bump all three versions together and describe the changes.
2. Run `npm ci`, `npm run lint`, `npm test`, and `npm run build` in `app`.
   Run `cargo test --locked` in `app/src-tauri` and the offline poller checks.
3. Push a matching version tag. CI creates a draft with the installer, `.sig` and
   `latest.json`. Keep release-note text accurate; it appears inside the app.
4. Exercise the A-to-B upgrade on the previous installed release before publishing.
5. Publish the complete draft. Verify the public latest.json names the intended
   version and all referenced artifacts download without authentication.

Relevant primary documentation:
[Tauri updater](https://v2.tauri.app/plugin/updater/),
[Tauri release action](https://github.com/tauri-apps/tauri-action),
[native notifications](https://v2.tauri.app/plugin/notification/),
[single instance](https://v2.tauri.app/plugin/single-instance/).
