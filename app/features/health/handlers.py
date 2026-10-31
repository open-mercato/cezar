"""`GET /health` and `GET /api/v1/health`.

The JSON shape is the TypeScript discovery document: version, repo, checks,
default runner, capabilities, and id+name projects. Health is the one route
that sends `Access-Control-Allow-Origin: *`. It does not include absolute paths
beyond `repo.root`, and `projects[]` has no `root`.
"""

from __future__ import annotations

import os
from typing import cast

from litewriter import LiteWriter
from stario import App, Context, Writer
from stario.json import JsonValue

from app.config import (
    RUNNERS,
    Config,
    automations_enabled,
    followups_enabled,
    instance_id,
    single_project,
    terminal_enabled,
)
from app.engine.checks import backend_checks
from app.engine.disk_health import disk_health
from app.engine.engine import Engine
from app.engine.gitwork import forge_kind, head_branch, is_git_repo
from app.features.health.urls import API_HEALTH, HEALTH
from app.http.loopback import hosted_mode
from app.integrations.service import webhooks_enabled
from app.store.db import get_settings, list_projects


class HealthPage:
    def __init__(self, db: LiteWriter, engine: Engine, config: Config) -> None:
        self.db = db
        self.engine = engine
        self.config = config

    def register(self, app: App) -> None:
        app.add(HEALTH, self.show)
        app.add(API_HEALTH, self.api)

    async def show(self, c: Context, w: Writer) -> None:
        w.text("ok\n")

    async def api(self, c: Context, w: Writer) -> None:
        w.headers.set("access-control-allow-origin", "*")
        w.json(cast(JsonValue, _health(self.db, self.engine, self.config)))


def _health(db: LiteWriter, engine: Engine, config: Config) -> dict[str, object]:
    root = config.repo_root
    repo: dict[str, str] | None = None
    if is_git_repo(root):
        repo = {"root": str(root), "branch": head_branch(root)}
    hide_all = os.environ.get("CEZ_HIDE_TOKEN_METRICS") == "1"
    usage = not hide_all and os.environ.get("CEZ_HIDE_TOKEN_USAGE") != "1"
    cost = not hide_all and os.environ.get("CEZ_HIDE_COST") != "1"
    local = not hosted_mode(config)
    body: dict[str, object] = {
        "version": config.version,
        "repoRoot": str(root),
        "repo": repo,
        "checks": backend_checks(config),
        "defaultRunner": get_settings(db).default_runner
        if get_settings(db).default_runner in RUNNERS
        else "claude",
        "forge": forge_kind(root),
        "capabilities": {
            "localHandoff": local,
            "terminal": terminal_enabled(not local),
            "designMode": config.design_mode,
            "followups": followups_enabled(),
            "singleProject": single_project(),
            "automations": automations_enabled(),
            "webhooks": webhooks_enabled(),
            "dispatch": config.dispatch_enabled,
            "tokenMetrics": usage and cost,
            "tokenUsageMetrics": usage,
            "costMetrics": cost,
        },
        "projects": [{"id": project.id, "name": project.name} for project in list_projects(db)],
        "bootProject": engine.boot_project_id,
    }
    ident = instance_id()
    if ident:
        body["instanceId"] = ident
    disk = disk_health(root)
    if disk is not None:
        body["disk"] = disk
    return body
