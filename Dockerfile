FROM python:3.14-slim-bookworm

COPY --from=ghcr.io/astral-sh/uv:0.13.6 /uv /uvx /bin/

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The project is a package, so the source has to be present before `uv sync`
# installs it. Static files stay beside `app/` because the cockpit resolves
# them from that layout.
COPY pyproject.toml uv.lock MIGRATION.md ./
COPY app ./app
COPY static ./static
RUN uv sync --frozen --no-dev

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    STARIO_HOST=0.0.0.0 \
    STARIO_PORT=4321 \
    PROJECT_DATA_DIR=/data \
    CEZ_DRY_RUN=1

EXPOSE 4321

HEALTHCHECK --interval=5s --timeout=3s --retries=12 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4321/health')"

CMD ["python", "-m", "app.main"]
