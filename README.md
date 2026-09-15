<div align="center">
  <img src="app/src-tauri/icons/128x128@2x.png" alt="Nightjar icon" width="88" height="88" />

  <h1>Nightjar</h1>

  <p><strong>Find your next internship. Keep your search organized.</strong></p>
  <p>A desktop home for internship listings, saved opportunities and application tracking.</p>

  <p>
    <img src="https://img.shields.io/badge/status-early_beta-d8ed95?style=flat-square&labelColor=181818" alt="Status: early beta" />
    <img src="https://img.shields.io/badge/desktop-Windows-d8ed95?style=flat-square&labelColor=181818" alt="Desktop: Windows" />
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-d8ed95?style=flat-square&labelColor=181818" alt="License: MIT" /></a>
  </p>

  <p>
    <a href="#get-nightjar">Get Nightjar</a> &nbsp;?&nbsp;
    <a href="#what-you-can-do">Features</a> &nbsp;?&nbsp;
    <a href="#your-data">Privacy</a> &nbsp;?&nbsp;
    <a href="https://github.com/skptre/nightjar/issues">Feedback</a>
  </p>
</div>

---

Internship searches spread across career pages, browser tabs and spreadsheets.
Nightjar brings listings and your application tracker into one place, so you can
find a role, read the details, save it and keep track of what happens next.

## What you can do

| Find opportunities | Keep track of your search |
| --- | --- |
| Browse internship listings collected from company career systems and public sources. | Save jobs and track applications through their stages. |
| Filter opportunities and personalize results with your profile and preferences. | Keep notes and deadlines alongside each application. |
| Read descriptions and open the original application page. | Follow companies and opt in to alerts for watched opportunities. |
| Refresh the feed without reinstalling the app. | Export your workspace and restore it from a backup. |

Light and dark themes, compact lists and a resizable desktop layout let you adjust
the workspace to your screen.

## Get Nightjar

**The first public Windows release is being prepared.** Once it is published,
installers will be available on the [Releases page](https://github.com/skptre/nightjar/releases).

1. Download the Windows `setup.exe` from a published release.
2. Run the installer and open Nightjar.
3. Set your preferences, browse jobs and save your first opportunity.

No Nightjar account is required. End users do not need Python, Node.js or Rust.

> **Early beta:** performance and loading behavior are being improved. Clean-install
> and version-to-version upgrade checks are still part of release validation.
> See the [release checklist](docs/beta-release.md) for the current verification limits.

### Updates

Job listings refresh independently of desktop releases. Use Settings to refresh
jobs or check for a new app version.

The desktop updater checks GitHub Releases for newer versions. When you choose to
update, Nightjar saves a recovery copy and verifies the downloaded package's
signature before installation. Published releases and feed files must be publicly
accessible for this distribution setup to work.

## Your data

**Your profile, saved jobs, notes and preferences stay on your device.**

- No Nightjar account or cloud workspace sync.
- Workspace backups and diagnostics are exported as local files.
- Cached jobs remain available offline; fresh listings require a connection.
- Local data and exported backups are not encrypted by Nightjar.

The app contacts listing sources and GitHub to retrieve job data and releases.
Opening an application link takes you to the employer's website; reporting an issue
is an action you choose. Avoid including personal notes or workspace backups in
public bug reports.

## Feedback

Found a broken description, an incorrect listing or something that feels slow?
[Open an issue](https://github.com/skptre/nightjar/issues/new/choose) with what you
were doing, what happened and what you expected. Include the app version and a
screenshot if useful. Settings includes a diagnostics export to help investigate.

## Under the hood

A Python poller maintains the shared job feed. The React and Tauri desktop app
stores your workspace locally in SQLite and handles your preferences on-device.
The poller has no access to your personal workspace.

<details>
<summary><strong>Run locally, build and test</strong></summary>

### Desktop app

Install Node.js, Rust and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.
Then, from the repository root:

```sh
cd app
npm ci
npm run tauri:dev
```

For browser development, use `npm run dev` instead. To build a desktop installer,
use `npm run tauri:build`; signed updater builds also require the release signing
configuration described in the [release guide](docs/beta-release.md).

### Poller

Requires Python 3.12 and [uv](https://docs.astral.sh/uv/).

```sh
uv sync
make test
make lint
```

`make test` runs the offline poller suite. It does not fetch live jobs.

### App checks

From `app`:

```sh
npm run lint
npm test
npm run build
```

From `app/src-tauri`:

```sh
cargo test --locked
```

See [spec.md](spec.md) for architecture and data contracts, and
[docs/beta-release.md](docs/beta-release.md) for signing, recovery and release checks.

</details>

## License

[MIT](LICENSE) ? Copyright 2026 Yash Singh
