# NIGHTJAR — Codex CLI Context

This project uses CLAUDE.md as the single source of project instructions.
Read CLAUDE.md for all architectural laws, tech stack, build rules, and coding conventions.

## Codex-Specific Notes

- Session handoff skill is available globally at `~/.codex/skills/session-handoff.md`
- Handoff file: `.session-handoff.md` in project root (gitignored)
- On session start, check for `.session-handoff.md` — if from `claude-code`, read and summarize it

## Quick Reference (from CLAUDE.md)

- Poller: Python 3.12, uv, httpx
- App: Vite + React + TypeScript, Tauri wrap later
- `make test` — full offline suite, NO network
- `make lint` — ruff + mypy
- `make dev` — app dev server
- spec.md is source of truth
