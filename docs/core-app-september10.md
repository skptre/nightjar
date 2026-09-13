# Latest review: persistence restored

This section supersedes the historical reset-on-launch changes below. User clarified
that public jobs, preferences, watches and tracker state should persist. Claude restored
browser create()/IndexedDB, native migrateFromBrowser()/SQLite and removed the main.tsx
launch wipe. Codex reviewed and retained those changes, removed the remaining one-time
profile wipe, fixed the offline early return that prevented bundled startup, and
removed the forced process exit during window close. Explicit Settings resets remain.

Data-source behavior: make app-dev uses local /data. Production uses the public GitHub
feed, with the bundled public snapshot available on an empty-cache failure or offline
launch. Cached records survive errors; no anonymous live updates while repo is private.
No repository visibility or credential changes were made.

Validation logs: .tmp/persistence-review-final.log (full app + full-feed integrations),
.tmp/persistence-native-tests.log, .tmp/persistence-web-build.log and
.tmp/persistence-desktop-build.log. No live desktop-window smoke test is claimed.

--- Historical work below; the fresh-session policy is obsolete ---

# Core app repair - September 10, 2026

User reported old Tauri icon, unexpected retained preferences, few jobs and a
loading description pane. The running desktop executable initially predated the
icon/description changes (September 5). Local feed manifests and all shard hashes
were checked: 4,471 total records, 4,305 active, 3,202 descriptions.

Changes:
- Browser sessions start with a new in-memory SQLite database, without loading or
  saving IndexedDB. Desktop startup clears local application/cache tables and no
  longer imports browser history. Only Nightjar-owned local/session storage resets.
  This reset is explicitly requested temporary MVP behavior; no accounts were added.
- Closing the desktop window exits instead of retaining a hidden session in tray.
- Job details render supplied text or the missing-description fallback immediately,
  without waiting behind background database work. Older rows without supplied
  evidence retain the database fallback, with a bounded loading indicator.
- Builds include the current public snapshot (feed/manifest/bundles, not poll state).
  On a fresh packaged launch, remote failure falls back to the snapshot. Existing
  caches cannot be overwritten by this fallback. Remote periodic sync is retained.
- Desktop explicitly sets its window icon from the generated Nightjar icon; build
  tracking includes icon inputs. A standalone debug executable embeds the current
  production frontend using the tauri/custom-protocol feature.

Validation:
- Full app suite before fallback addition: 1,128 passed, 47 files; TypeScript clean.
- Four new fresh-session/fallback tests passed after fallback addition.
- Full-data native-interface test: all records imported, detail cache generated and
  guest classification completed within native batch limits. Real SQLite backs the
  bridge; this tests transport shape and budget, not a live WebView.
- Full jobs-screen integration: all 4,305 active opportunities rendered in the count,
  search and opening full recovered description succeeded with exact source text.
- Native Rust suite: five tests passed, including atomic rollback and typed reads.
- Frontend production build passed and includes the public snapshot.

Evidence: .tmp/core-app-tests.log, .tmp/core-followup-tests.log,
.tmp/native-feed-validation.log, .tmp/feed-ui-final.log, .tmp/core-native-tests.log,
.tmp/core-build.log, .tmp/core-desktop-build.log.

Automatic approval review blocked opening browser QA. The UI checks above ran in
jsdom with real SQLite and the actual feed, not a claimed manual visual inspection.
No poller schedule or external publication was enabled. Existing user dev server
was left alone. Tests use isolated synthetic state, never real applicant records.


Desktop artifact: `app/src-tauri/target/debug/Nightjar-Preview.exe` (31,174,656 bytes).
Rust compilation/linking produced the new executable in target/debug/deps. Cargo's
final replacement of target/debug/nightjar.exe failed because Windows locked the
running older process; terminating it was also denied. The completed new executable
was copied to the separate preview filename. Its embedded current frontend and
public feed were verified; its extracted Windows icon is the Nightjar mark
(.tmp/rebuilt-nightjar-icon.png). Quit the old app before opening the preview.
The existing nightjar.exe path remains the older copy until it can be replaced.
This is a standalone debug build, not a signed installer or an installed-app update.
No claim is made of a live WebView smoke test in this restricted session.


Final persistence review verification: full app run passed 1,134 tests with one old
explicit-delete expectation still incorrect; after correcting that assertion, all
six profile-provider tests passed (.tmp/persistence-profile-final.log). No runtime
code changed for that rerun. Full-feed UI and native-interface integrations passed.
TypeScript passed. Five native Rust tests passed. Production frontend and native
standalone build both completed. Both target/debug/nightjar.exe and
Nightjar-Preview.exe now contain the persistent build; the old wipe-on-launch
Preview executable was replaced. make app-dev remains the intended development
entry point. No GUI smoke test, publication, schedule or repository-visibility change
was performed in this review.
