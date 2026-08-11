.PHONY: poll poll-dry test test-live lint dev

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
