# `just` lists the targets. Install: uv tool install rust-just

# run the app with hot reload
dev:
    # `python`, not `uv run python`: the app must be watchfiles' direct child.
    uv run watchfiles 'python -m app.main' app/ static/

# run the app once, no reload
serve:
    uv run python -m app.main

# lint, typecheck, test — run before done
check:
    uv run ruff check .
    uv run ruff format --check .
    uv run pyright
    uv run pytest -q

# auto-fix lint and format
fix:
    uv run ruff check --fix .
    uv run ruff format .

# run the tests
test:
    uv run pytest -q
