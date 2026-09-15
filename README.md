# Nightjar

An internship feed and a desktop application tracker. Shared job listings come from
public sources; your profile, saved jobs, application notes and preferences stay on
your device.

## Windows beta

The first public release is being prepared. The desktop app includes local
backup/restore and a signed updater. Once a release is published, download the
`setup.exe` from [Releases](https://github.com/skptre/nightjar/releases).

Job data refreshes separately from app updates. A code change reaches installed
apps only after a new version is built and published. Settings includes manual
refresh and update checks.

See [release and recovery instructions](docs/beta-release.md) for release status,
validation limits and the installation checklist.

## Privacy

There are no Nightjar accounts or cloud workspace sync. Local storage and exported
backups are not encrypted by Nightjar; protect them as you would other personal
files. The app retrieves public listings and release information. Opening a job
application link or choosing to report an issue connects to the relevant website.
Diagnostics and workspace backups are exported locally.

## Development

- Poller: Python 3.12, uv, httpx.
- Desktop: React, TypeScript, Vite, Tauri and SQLite.
- `uv sync` installs poller dependencies.
- `make test` runs the offline poller suite; `make lint` runs Ruff and mypy.
- In `app`, run `npm ci`, then `npm run dev` for browser development.
- In `app`, run `npm run lint`, `npm test`, and `npm run build` for frontend checks.
- Native builds require Rust and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

Tests, fixtures and architecture documentation belong in source control. Temporary
logs, local databases, signing keys, personal environment files and agent settings
do not. The architecture and data contracts are documented in [spec.md](spec.md).

## License

See [LICENSE](LICENSE).
