# Nightjar handoff (moving to a Mac, Nov 2026)

Paste or point a new Claude Code chat at this file. It covers who the user is, the house rules, what exists, the design canvas, the current code state, and the agreed plan for what Nightjar becomes next.

---

## 0. Read this first: house rules

- **Never commit, stage or push.** The user does all git writes. "DONT COMMIT" was said loudly. Say "ready for you to commit" instead.
- **Don't change app code when the task is design work.** Design happens on the canvas artifact. The app was then ported to match in a separate, explicit request.
- **The user wants to ship fast.** They want to be a founder and value speed of shipping. Avoid long open-ended exploration; prefer spikes that prove the riskiest piece first.
- **Tone:** casual and direct. Explain plainly. They like seeing results, such as screenshots of the real app.
- **Hooks on their machine** (ECC GateGuard) block the first Bash/Write in a session until you state facts: the request in one sentence, and what the command or file does, who calls it, and what data it touches. State them, then retry.
- **Claude memory does not carry across machines** (it was in `~/.claude/projects/<windows-path>/memory/`). The important memories are restated in section 9.

---

## 1. What Nightjar is

- **The product:** a local-first desktop app (Tauri 2 + React 19 + TypeScript + SQLite) for students to find internships and early-career roles, keep a tracker of applications, and watch companies.
- **The vision:** "Super clean intern-focused discovery/tracking/apply tool, beat Simplify on UX." Scope goes beyond SWE to mechE, ECE, aero, finance and more.
- **The repo:**
  - `app/`: Tauri app.
  - `poller/`: Python job poller.
  - `data/`: the published feed (sharded JSON).
  - `.github/workflows/`: poll, discover, hot-watch, CI and release.
  - Release builds a Windows NSIS installer on GitHub Actions (`release.yml`, `windows-latest`), signed with the updater key in GitHub secrets.
- **The poller** hits Greenhouse, Lever, Ashby, Workday, SmartRecruiters, iCIMS, USAJOBS and more. It runs on GitHub Actions cron, which GitHub throttles badly: about 6 runs a day instead of 96. That's the main reason the "poller is slow".

---

## 2. The design canvas (artifact)

- **Where it is:** a claude.ai Artifact canvas holding the full visual design. Links:
  - https://claude.ai/artifact/AJH72J4yfQvPY87fi34Yxe
  - Internal id seen in this chat: `4b4bd0fd-996a-4ba1-b1eb-4e2aef3e6caf`
- **How to edit it:** read it in the new chat with the Artifact tool's `read` action, then edit and republish to the same URL.
  - The canvas may re-save `canvas.json` itself. On a publish conflict, re-read and merge.
  - The local build scripts that generated boards lived in a Windows temp scratchpad and are gone. Don't look for them. Edit board files read from the artifact directly.
- **How boards are built:**
  - Each board is a `.dc.html` file run by a small React-like runtime (`DCLogic`). It uses `{{x}}` holes, `sc-for` and `sc-if`, with handlers returned from `renderVals()`.
  - Quirk: the canvas runtime doesn't reliably call `componentDidUpdate`. Post-render work is triggered from handlers through an `after(fn)` helper (a microtask, then up to 20 animation frames).
- **Layout (about 24 boards):**
  - **Dark row (y=0):**
    - Jobs (x 0)
    - JobsPosting (1520)
    - JobsFilters (3040)
    - Tracker (4560)
    - Dashboard/Home (6080)
    - Settings (7600)
    - TrackerAdd (9120)
    - TrackerOutcome (10640)
  - **Light versions** at y=2640.
  - **Logo** (0,1320), **Startup** (1520,1320), **States** (3040,1320). Their light versions are at y=3660.
  - **Landing (web)** and LandingLight at y=4980. The landing page is NOT part of the app port.
  - The First-run/onboarding board was deliberately removed. The user said the startup animation is enough.
- **Design language:**
  - **Monochrome tokens.** Dark: `--bg #000`, `--fg #fff`. Light: `--bg #f4f4f2`, `--fg #0b0b0b`. Everything else is alpha of `--fg-rgb`. The old green accent is gone.
  - **Font:** Geist.
  - **Shapes:** rounded panels (26px radius), pill buttons, a capsule nav (Home / Jobs / Tracker + search), and a round profile button that goes to Settings.
  - **Motion:**
    - `--spring` (about 1% overshoot) and `--bounce` (about 8%), both CSS `linear()` curves, plus `--out: cubic-bezier(.16,1,.3,1)`.
    - A cursor glow and edge light on panels, a single "glider" highlight that slides between rows, card tilt, and FLIP reorder animations.
    - A scroll-driven "recede" on list rows (`animation-timeline: view()`).
    - Alternating A/B keyframe names so an animation can replay.
  - **Stage colours:**

    | Stage | Colour |
    |---|---|
    | Saved | gray |
    | Applied | `#4f8cff` |
    | Assessment | `#dea034` |
    | Interviewing | `#9270fa` |
    | Offer | `#2eb86c` |
    | Closed | dashed gray |

  - **Sheets** rise out of depth while the page behind tilts back. The posting sheet morphs out of its row ("container transform") but closes by falling back into depth. The user disliked the reverse morph.

---

## 3. What's in the app now (design port, done and committed)

The full canvas was ported into the app, except the web landing page. Commits on `main`:
- `a437f91 ui overhaul and fixed feed issues`
- `3afb885 did plumbing, fixed bunch of issues and UX updates` (latest, Oct 10)

**Key files**
- `app/src/index.css`: the whole design system.
  - Tokens on `:root` (light) and `:root.dark`.
  - Legacy aliases, so older Tailwind screens follow the theme.
  - All component styles, keyframes and responsive breakpoints.
- `app/tailwind.config.ts`: legacy colours mapped to the tokens.
- `app/src/motion/motion.ts`: `afterRender`, `useCursorGlow`, `useGlide`, `tilt`, `snapshotRows`/`playFlip` (FLIP), `useTweenedNumber`, `animateScroll`, `useScrollThumb`, `useLayer`/`useLayerOpen` (sheets push the page into depth), and `alt()`.
- `app/src/motion/Panel.tsx`: a rounded panel with cursor glow and edge.
- `app/src/components/Layout.tsx`:
  - Header: brand, capsule nav with the sliding pill and hover pill, and the profile button.
  - Shared header search: on the Tracker it searches applications; elsewhere it searches jobs.
  - Notices: offline, sync failed, stale feed, update ready, save failed, backup failed. The stage slides down 56px per notice.
- `app/src/components/Startup.tsx` + `app/src/styles/startup-morph.css`: the launch animation.
  - Wing-flap morph, wordmark reveal, then the lockup docks into the header logo while Home rises underneath.
  - Desktop only, once per session. Any key or click skips it. `?startup` forces it in the browser.
  - Every launch opens Home (`app/src/lib/startup.ts`).
- `app/src/components/Toast.tsx`: a pill toast, bottom centre, with an optional dot and actions (Undo, Add notes).
- `app/src/components/WorkspaceServices.tsx`: a notices store, plus restyled update and restore overlays.
- `app/src/views/Home/HomeView.tsx`: the Dashboard design.
  - Needs attention cards (tilt).
  - "Since you last looked" rows, with the open-roles count ticking up.
  - Watching panel with add, suggestions, and a fold-away on remove.
  - Alerts card.
- `app/src/views/Feed/FeedView.tsx` and `PostingRow.tsx`: Jobs.
  - **List:** Role / Location / Pay / Posted. Only the visible rows render, with one expandable row, so about 8k rows stay smooth.
  - **Rows:** expand inline to show highlights, Apply and Read full description.
  - **Bookmark:** toggles save/unsave with a pop and ring animation, and Undo.
  - **Posting sheet:** prev/next stepping while the list behind keeps the open row centred, a morph-open, and ghost cards behind it.
  - **Filters sheet:** For you / All jobs, roles, fields.
  - **Empty state:** "A little too narrow" names the single filter whose removal brings roles back.
- `app/src/components/JobDetail.tsx`: the sheet body.
  - Facts grid (Location, Pay, Posted), Apply on X, bookmark, Mark applied, Watch, the description, and report a problem.
- `app/src/details/useJobDetails.ts`: loads and caches details. `app/src/details/pay-label.ts` formats pay.
  - `concretePay` was later tightened with a regex and plausibility minimums.
- `app/src/views/Pipeline/PipelineView.tsx` + `stages.ts`: Tracker.
  - Tabs (All/Saved/Active/Offer/Closed) with a sliding indicator, and Up next cards.
  - Colour pills with a stage menu.
  - Instant stage change, with a toast offering Undo (exact restore via `snapshotApplicationStatus`/`restoreApplicationStatus`) and Add notes (`annotateLatestOutcome`).
  - Expandable rows edit next step, due date, notes and applied date. The Add sheet has an optional link field.
  - Rows are ordered by `created_at` so they don't jump.
- `app/src/outcomes/OutcomeDialog.tsx`: the outcome-notes sheet ("How did the interview go?" / "An offer from X" / "Closing out X").
- `app/src/views/Settings/SettingsView.tsx` (+ `BackupSection`, `UpdateSection`, `SupportSection`):
  - The left rail follows your scroll. Deep links like `/settings#updates` work.
  - Sections: Profile (inline edit), Appearance (theme cards, density preview), Alerts (switch), Workspace and backups, Updates, Jobs and support, Data (exports, typed delete), General (autostart), and Gmail (behind a flag).
- `ProfileProvider`: the welcome / first-run gate was removed. The old ProfileSetup wizard still exists for "Personalize" and picks up the new colours, but it was never designed.

**Tests:** about 1165 passing at port time. Commands:
- `cd app && npx vitest run`
- `npx tsc --noEmit`
- `npx vite build`

**Known issues found during the port**
- Local dev feed: `data/feed` shard SHA-256 checks fail on Windows because of CRLF line endings. There's no `.gitattributes`, and `core.autocrlf=true`. A fresh clone on a Mac should be fine, but add a `.gitattributes` (for example `data/** -text` or `* text=auto eol=lf`) so the two machines agree.
- In dev, the Pay column is empty until descriptions and details have been fetched by a real sync.

---

## 4. Uncommitted work on the Windows PC (watch out)

The Windows checkout has **about 382 uncommitted changes**, from other sessions:
- poller sources: eightfold, oracle_careers, public_careers, recruitpro
- `poller/pagination.py`, `redaction.py`, tools/health and validate_publication, plus tests
- `data/feed/details/*` and snapshots, and `data/health.json`
- edits to workflows (`discover.yml`, `poll.yml`)
- many app files: sync, backup, db, classify, motion and others

**None of that is on the Mac unless it was committed and pushed.** Last pushed commit: `3afb885` (Oct 10). Check `git log` on the Mac against this.

---

## 5. Windows → Mac notes (agreed earlier)

- **The code is portable.** On a fresh clone: `npm install` in `app/`, `uv sync` for Python, and install Rust plus the Xcode Command Line Tools. Don't copy `node_modules`, `.venv` or `target` across.
- **Releases are unaffected.** The Windows installer is built on GitHub's Windows machine and existing users keep updating. Keep the updater private key safe (it's in GitHub secrets; there was no local copy at `~/.tauri`).
- **The user wants a Mac version.**
  - Add Mac to the build targets in `tauri.conf.json` and a `macos-latest` job to `release.yml`.
  - Signing and notarization needs an Apple Developer account ($99/yr). Without it, users have to right-click and Open the first time.
- **Windows testing from a Mac:**
  - Parallels or UTM running Windows 11 ARM, which runs the x64 installer through emulation and still uses WebView2.
  - Or keep the PC.
  - The release builds the Windows installer on GitHub anyway.
- **WebKit differences** (the Mac app uses Safari's engine; Windows uses Chromium):
  - The startup wing morph animates CSS `d: path()`, which Safari likely doesn't support, so the mark won't flap.
  - The scroll-driven `animation-timeline: view()` row recede only works on newer Safari.
  - Both degrade to no animation, but should get checked, with a JavaScript fallback (for example, animating the wing path from JS).

---

## 6. THE NEXT PHASE: what Nightjar becomes (discussed in detail)

The user decided a browser plus quick links isn't enough. Two big features, with the goal of being **better** than existing tools, not a copy.

**The reference they shared:** https://github.com/OjasMishra32/applytwin, built by someone they know.
- **License:** PolyForm Strict, so no copying code. Ideas only; that's fine with the user.
- **How it works:**
  - A local Python server plus a React page at `localhost:4747`.
  - It runs the **user's own Claude Code / Codex CLI** in the background as the AI layer:
    - `claude -p --allowedTools <its MCP tools> --permission-mode acceptEdits --output-format text`
    - `codex exec --skip-git-repo-check -s workspace-write -c approval_policy=never`
  - Its own MCP tool server, plus Playwright / Claude in Chrome for the browser.
  - One instruction guide (playbook) per application system: Greenhouse, Lever, Ashby, Workday, iCIMS, Oracle, SmartRecruiters, LinkedIn, general.
  - A "Career Vault", a fact check that rejects invented numbers, 8 single-column templates, an answer bank, and "ask the user once" for new questions.
  - It stops on the review screen unless auto-submit is turned on. It never shows passwords to the AI, never solves CAPTCHAs, and never accepts legal agreements.
  - Its poller runs **locally on the user's machine**, in parallel threads, every couple of minutes, and also pulls the community internship lists, The Muse and HN "Who is hiring". That's why it's fast.

### 6.1 The AI layer: the user's own subscription, inside our app
- **The idea:** no API cost to the user or to us. Nightjar runs the user's installed `claude` / `codex` (and possibly `gemini`) CLI in the background. The user only ever sees Nightjar's UI, and the AI acts like a plugin behind it.
- **The user's stance:** the gray area is fine with them because it runs on the user's own CLI. Don't re-argue it. Still keep an optional "paste an API key" fallback in the design.
- **Keep it tight:**
  - The agent gets only Nightjar's narrow MCP tools (read profile, read job, save answer, get PDF). Never a free shell.
  - Every call requests JSON matching a fixed schema. Bad output is retried, never used.

### 6.2 The structure

```
Nightjar (Tauri app)
  UI (React): Jobs · Tracker · Vault · Apply queue · Review · Inbox
  Rust core:  process manager (spawns engine + AI CLIs), OS keychain (job-site passwords), window/browser control
Engine (local TypeScript sidecar, bundled): Scanner · Matcher · Tailor · Apply runner · Answer bank · MCP tool server
  AI bridge: ClaudeCodeCLI | CodexCLI | GeminiCLI | API key (detects installed + signed in; "Install and sign in" button)
  Browser: Playwright Chromium, persistent profile (job-site logins persist), visible window with a
           "Nightjar is filling this" bar + Pause / Take over
  Data: SQLite (jobs, vault, resumes, answers, applications, outcomes)
Cloud: only the shared job feed (existing GitHub data)
```
- **Why a TypeScript sidecar:** it shares types with the UI and Playwright is best in Node. The Rust side stays thin. The Python poller stays for the shared feed.
- **Repo layout:**
  - New top-level `engine/`.
  - Rust bits in `app/src-tauri`.
  - New views in `app/src/views` (Vault, Apply queue, Review, Inbox).

### 6.3 One application, end to end
1. **Scan.** The shared feed is the base. The engine also scans watched and top-matching companies directly through the public Greenhouse, Lever and Ashby APIs, in parallel, every few minutes. This fixes the slow poller. Separately, give the GitHub poll an external trigger.
2. **Match.** The existing scoring ranks jobs. The user's later idea plugs in here: learn which companies and roles they actually open and narrow the search space conservatively. A CS major shouldn't see manufacturing-ops roles unless they search for them.
3. **Queue states:** queued → tailoring → ready for review → filling → waiting for Submit → submitted / failed / needs you.
4. **Tailor.** The resume engine (6.5) runs once per job.
5. **Fill**, cheapest tier first:
   - **ATS driver.** Deterministic code per platform (Greenhouse, Lever, Ashby, SmartRecruiters, then Workday) maps known fields from saved answers: name, school, work authorization, EEO, links, resume upload. **No AI.**
   - **Answer bank.** Fuzzy or semantic match against past answers.
   - **AI.** Only for free-text answers, grounded in vault facts and the posting.
   - **Inbox.** An unknown required question goes to the user once, and the answer is saved forever.
   - **Fallback.** For an unknown platform, the AI drives the browser through MCP. Slower, so it's not the default.
6. **Stop before Submit.** Show a screenshot, every filled value and the resume used. One click submits. Auto-submit is opt-in, with a daily cap.
7. **Record.** A Tracker entry is created automatically, linked to the resume version and answers. Duplicates are blocked.
8. **Learn.** Outcomes flow back into the resume engine.
- **Throughput:** a code-driven fill takes about 1–2 minutes, with 2–3 browsers in parallel, so hundreds a day. That's one or two AI calls per application, versus dozens when an agent drives every click. Subscription caps (5-hour and weekly limits) make an "agent does everything" approach slow and wasteful.
- **Hard rules:** passwords never reach the AI, no CAPTCHA solving, stop on legal agreements, never fabricate.

### 6.4 Where we beat ApplyTwin
- Plain-code ATS drivers first, AI only where needed: faster, more reliable, and far cheaper on the user's plan.
- An outcome-learning loop (Nightjar already has outcome tracking and a recalibration engine).
- A real native Mac and Windows app with the designed UI, instead of a localhost web page.
- A local fast scan alongside the shared feed.

### 6.5 Resume engine: anti-slop design (the user's main edge)

AI rewrites are sloppy because the model is free to invent numbers, tools and buzzwords, every bullet comes out the same shape, and the user's voice disappears. Our rule: **choose first, rewrite second, verify always.**

1. **Career Vault: facts, not prose.**
   - Import the resume. The AI splits each bullet into atomic facts (what, how, tools, scale, result) and the user confirms them.
   - **Interview mode** asks for missing numbers ("roughly how many users?"). Real data, not invented.
   - Approved variants are saved back, so the vault grows with every application.
2. **Job analysis.** The posting becomes a structure: must-have and nice-to-have skills, domain, seniority, role family, and the posting's exact terms.
3. **Selection: deterministic code.**
   - Score each fact and bullet against the requirements (keyword + semantic).
   - An optimizer (knapsack) maximises coverage within one page.
   - Section order comes from a role-family template.
   - It explains itself: "chosen because it covers *distributed systems*".
4. **Constrained rewrite.**
   - The AI may only rephrase the selected bullets: lead with what this reader wants, use the posting's term only where the user truly used it, tighten.
   - Every bullet must carry `source_fact_ids`.
5. **Verifier (anti-slop gate).**
   - Every number, tool and proper noun in the output must exist in its source facts (exact check in code). Otherwise the bullet is rejected.
   - A banned-phrase list: spearheaded, leveraged, synergy, passionate, results-driven and similar.
   - Varied verbs, consistent tense, no "I", a length cap.
   - An AI critic pass scores the draft against the role-family rubric.
   - A bullet that fails twice reverts to the user's original wording.
6. **Render.** Single-column Typst templates (exact page measurement, so one page is real). ATS check: render, extract the text, re-parse it and confirm the sections survive.
7. **Review.** A diff against the master resume, a reason for each change, accept or reject per bullet. Accepted variants go back into the vault.

**"Train on proven resumes": the honest version.** Fine-tuning through a subscription is impossible, and scraped resumes come with no consent and unknown quality. Instead:
- **Layer 1, role-family playbooks (day 1).** Written rubrics per field (SWE, data, mechE, finance, consulting…), versioned like code.
- **Layer 2, an example library.** Curated strong bullets per role family, fed in as examples by similarity. Sources: opt-in user donations, permissioned samples (check the licenses on university career-center material), and bullets that earned interviews. Used as patterns, never copied.
- **Layer 3, outcome learning (the moat).**
  - Each application stores its resume version and features (bullets chosen, keyword coverage, template, length). The Tracker supplies the outcome.
  - Per role family, a simple model or bandit (no AI needed) learns which features correlate with interviews and adjusts the selection weights.
  - Opt-in, anonymized cross-user aggregates become the real "proven" dataset.
  - Early on, quality comes from layers 1 and 2. Layer 3 grows with the number of applications.
- **A fixed test set of about 50 (vault, posting) pairs,** scored by rubric, fact check and human spot-check. No prompt or rubric change ships if it makes the scores worse. This is what keeps it from getting sloppy over time.
- **Also:** a "review like a recruiter" mode, the six-second scan.

### 6.6 Suggested shipping order (speed matters)
1. **Two-day spike.** Tauri spawns `claude -p` (and `codex exec`) against a tiny Nightjar MCP server and tailors one resume to a PDF. This proves the riskiest part.
2. **Week 1.** Career Vault (import, fact extraction, interview mode) + tailoring pipeline (analysis → selection → constrained rewrite → verifier → Typst render) + the review diff UI.
3. **Week 2.** Apply queue + Greenhouse and Lever drivers + answer bank + Inbox, stopping before Submit. Auto-create Tracker entries.
4. **Then:**
   - Ashby, SmartRecruiters and Workday drivers
   - the agent-driven fallback for unknown platforms
   - the local fast scanner
   - the outcome-learning loop
   - the personal narrowing of the job search
   - the Mac build in CI
   - WebKit fallbacks
- **Last and minimal:** the user's own UX extras, such as learning their frequent companies and roles and narrowing the search space conservatively.

The user's last preference: focus is a **better product** than ApplyTwin. Most interested in the **resume engine edge** and the **structure**. The recommended next concrete step was the Career Vault + tailoring pipeline (or the two-day spike first).

---

## 7. Earlier history (brief)

- **Months of on-and-off work:**
  - Python poller and adapters (aero expansion; USAJOBS and iCIMS)
  - the description engine and validation
  - persistence fixes
  - feed performance work
  - the schema v6 changes
- **README:**
  - Light theme only (no dark switching).
  - New logo at `docs/logo-light.svg`.
  - Screenshots `docs/screenshots/{posting,tracker,filters}-light.png`.
  - `docs/architecture-light.svg`.
  - Black and white badges.
- **Optional cleanups, never done:**
  - remove `spec.md` from git history
  - add `.gitattributes` for `data/`
  - fix dead `spec.md` links in the docs
  - delete the old unused screenshots

---

## 8. Commands

```bash
cd app && npm install
npm run dev            # web dev server on :5173 (needs data/ served by vite middleware)
npm run tauri:dev      # desktop app
npx vitest run         # tests
npx tsc --noEmit       # types
npx vite build         # production web build
```
The `.claude/launch.json` config `nightjar-web` runs the dev server on port 5173.

---

## 9. Memories to restore on the new machine

- **No Auto-Commit:** never commit, stage or push. The user handles all git writes.
- **Product Vision:** a super clean intern-focused discovery/tracking/apply tool that beats Simplify on UX.
- **Scope Expansion:** beyond SWE to mechE, ECE, aero and finance. Non-engineering fields deferred.
- **Spec Flexibility:** `spec.md` is a living document, not a fixed mandate.
- **Poller Schedule Drops (Sep 29):** GitHub drops `poll.yml` cron runs (about 6 a day instead of 96). It needs an external `workflow_dispatch` trigger, and the repo needs to be public.
- **Persistence Fix (Sep 10):** local persistence was restored. The live feed returned 404s while the repo was private.
- **Feed Perf (Sep 15):** navigation retention, a slim query, chunked recompute. A Web Worker was deferred.
- **Coverage strategy:** Common Crawl discovery, new ATS adapters, seasonal polling, a JSON-LD fallback.
