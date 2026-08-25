.PHONY: poll poll-dry test test-live lint dev test-app lint-app infer-ats infer-ats-verify app-dev app-build app-dev-web

poll:
	uv run python -m poller

poll-dry:
	uv run python -m poller --dry-run

test:
	uv run pytest -m "not live" -v

test-live:
	uv run pytest -v

lint:
	uv run ruff check poller/
	uv run mypy poller/ --strict

dev:
	cd app && npm run dev

test-app:
	cd app && npx vitest run

lint-app:
	cd app && npx tsc --noEmit

infer-ats:
	uv run python -m poller.tools.infer_ats

infer-ats-verify:
	uv run python -m poller.tools.infer_ats --verify

app-dev:
	cd app && npm run tauri:dev

app-build:
	cd app && npm run tauri:build

app-dev-web:
	cd app && npm run dev
