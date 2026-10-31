"""Routes that close the remaining HTTP families.

Plan is one agent step and does not call a model. Skill refresh copies local
files. Provider connect writes a marker. Checkout calls `gh` only when the
cockpit is not a dry run.
"""

from __future__ import annotations

from pathlib import Path
from typing import cast

from litewriter import LiteWriter
from stario import App, Context, Route, Writer
from stario.json import JsonValue

from app.clock import stamp
from app.common.body import json_body
from app.config import RUNNERS, Config
from app.engine import project_forge
from app.engine.disk_health import disk_health
from app.engine.engine import Engine
from app.engine.landing import land_inplace
from app.engine.model import Project, Run
from app.engine.planner import plan_chain
from app.engine.providers import (
    connect_provider,
    retry_provider,
    set_provider_enabled,
    update_provider,
)
from app.engine.team_skills import cached_sources, refresh_sources
from app.engine.uploads import materialize
from app.engine.workspace_files import (
    add_draft,
    add_profile,
    branding,
    drafts,
    layouts,
    profiles,
    read_start_state,
    templates,
    write_branding,
    write_layouts,
    write_start_state,
    write_templates,
)
from app.features.api.handlers import _images
from app.features.settings.store import read_agent_defaults, read_skill_repos
from app.store.db import get_project, get_run, list_events, list_runs

_TEMPLATES: tuple[dict[str, object], ...] = (
    {
        "id": "nightly",
        "kind": "schedule",
        "name": "Nightly",
        "everyMinutes": 1440,
        "events": [],
        "filters": {},
    },
    {
        "id": "github-pr",
        "kind": "github",
        "name": "Pull request opened",
        "everyMinutes": 60,
        "events": ["pull_request"],
        "filters": {"action": "opened"},
    },
    {
        "id": "tracker-issue",
        "kind": "tracker",
        "name": "Tracker issue",
        "everyMinutes": 30,
        "events": ["issue"],
        "filters": {"tracker": "github"},
    },
)


class CloseoutApi:
    def __init__(self, db: LiteWriter, engine: Engine, config: Config) -> None:
        self.db = db
        self.engine = engine
        self.config = config

    def register(self, app: App) -> None:
        scoped = (
            ("POST", "/plan", self.plan),
            ("GET", "/skills/importable", self.importable),
            ("POST", "/skills/refresh", self.refresh_skills),
            ("POST", "/skills/update", self.update_skills),
            ("GET", "/start-app", self.get_start_app),
            ("PUT", "/start-app", self.put_start_app),
            ("GET", "/e2e", self.e2e_status),
            ("POST", "/e2e/setup", self.e2e_setup),
            ("GET", "/drafts", self.get_drafts),
            ("POST", "/drafts", self.post_draft),
            ("GET", "/layouts", self.get_layouts),
            ("PUT", "/layouts", self.put_layouts),
            ("GET", "/prompt-templates", self.get_templates),
            ("PUT", "/prompt-templates", self.put_templates),
            ("GET", "/runs/{run_id}/history", self.history),
            ("GET", "/runs/{run_id}/handoff", self.get_handoff),
            ("PUT", "/runs/{run_id}/handoff", self.put_handoff),
            ("POST", "/runs/{run_id}/images", self.images),
            ("POST", "/runs/{run_id}/land", self.land),
            ("POST", "/runs/{run_id}/start-now", self.start_now),
            ("GET", "/runs/{run_id}/report", self.read_report),
        )
        for method, path, handler in scoped:
            app.add(Route(f"{method} /api/v1{path}"), handler)
            app.add(Route(f"{method} /api/v1/p/{{project_id}}{path}"), handler)
        app.add(Route("GET /api/v1/workspace/profiles"), self.get_profiles)
        app.add(Route("POST /api/v1/workspace/profiles"), self.post_profile)
        app.add(Route("GET /api/v1/workspace/branding"), self.get_branding)
        app.add(Route("PUT /api/v1/workspace/branding"), self.put_branding)
        app.add(Route("GET /api/v1/workspace/host-usage"), self.host_usage)
        app.add(Route("GET /api/v1/automation-templates"), self.automation_templates)
        app.add(Route("POST /api/v1/projects/checkout"), self.checkout)
        app.add(Route("POST /api/v1/projects/github"), self.create_github)
        app.add(Route("GET /api/v1/github/owners"), self.owners)
        app.add(Route("POST /api/v1/providers/{name}/connect"), self.connect)
        app.add(Route("POST /api/v1/providers/{name}/retry"), self.retry_provider)
        app.add(Route("POST /api/v1/providers/{name}/update"), self.update)
        app.add(Route("PUT /api/v1/providers/{name}/enabled"), self.enable_provider)

    async def plan(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None:
            return
        body = await json_body(c, w)
        if body is None:
            return
        task = body.get("task")
        if not isinstance(task, str) or not task.strip():
            _send(w, {"error": "task is required"}, status=400)
            return
        import asyncio

        runner = _runner(body, self.db)
        binary = self.config.runner_bins.get(runner, "claude")
        # `plannerModel` is a Claude alias: other runners pick their own default.
        planner_model = read_agent_defaults(self.config.data_dir).planner_model
        result = await asyncio.to_thread(
            plan_chain,
            project.root,
            task.strip(),
            binary=binary,
            dry_run=self.config.dry_run,
            model=planner_model if runner == "claude" else "",
        )
        _send(w, result)

    async def importable(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None:
            return
        _send(
            w,
            {"skills": cached_sources(self.config.data_dir, self._skill_repos()), "network": False},
        )

    async def refresh_skills(self, c: Context, w: Writer) -> None:
        await self._refresh(c, w)

    async def update_skills(self, c: Context, w: Writer) -> None:
        await self._refresh(c, w)

    async def _refresh(self, c: Context, w: Writer) -> None:
        if self._project(c, w) is None:
            return
        import asyncio

        result = await asyncio.to_thread(
            refresh_sources,
            self.config.data_dir,
            self._skill_repos(),
            dry_run=self.config.dry_run,
        )
        _send(w, result)

    def _skill_repos(self) -> list[tuple[str, str]]:
        return [(row.repo, row.ref) for row in read_skill_repos(self.config.data_dir)]

    async def get_start_app(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None:
            return
        _send(w, read_start_state(Path(project.root), self.config.data_dir, project.id))

    async def put_start_app(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None:
            return
        body = await json_body(c, w)
        if body is None:
            return
        scope = body.get("scope")
        if not isinstance(scope, str):
            _send(w, {"error": "scope must be project or personal"}, status=400)
            return
        stored = write_start_state(
            Path(project.root), self.config.data_dir, project.id, scope, body.get("recipe")
        )
        if isinstance(stored, str):
            _send(w, {"error": stored}, status=400)
            return
        _send(w, stored)

    async def e2e_status(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None:
            return
        root = Path(project.root)
        config_file = ""
        for name in ("e2e.config.ts", "e2e.config.mts", "e2e.config.py"):
            if (root / name).is_file():
                config_file = name
                break
        names = _credential_names(root / "e2e.credentials.json")
        latest = ""
        for run in list_runs(self.db, project.id, None, limit=200):
            if run.task.startswith("set up e2e"):
                latest = run.id
        _send(
            w,
            {
                "configured": bool(config_file),
                "configFile": config_file,
                "credentials": names,
                "latestRunId": latest,
                "network": False,
            },
        )

    async def e2e_setup(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None:
            return
        run, reason = self.engine.plan_run(
            project=project,
            task="set up e2e",
            workflow_name="quick-task",
            runner=_runner({}, self.db),
        )
        if run is None:
            _send(w, {"error": reason or "invalid task"}, status=400)
            return
        _send(w, {"runId": run.id}, status=201)
        await self.engine.enqueue(run)

    async def get_drafts(self, c: Context, w: Writer) -> None:
        if self._project(c, w) is None:
            return
        _send(w, {"drafts": drafts(self._path("drafts.json"))})

    async def post_draft(self, c: Context, w: Writer) -> None:
        if self._project(c, w) is None:
            return
        body = await json_body(c, w)
        if body is None:
            return
        text = body.get("text")
        if not isinstance(text, str) or not text.strip():
            _send(w, {"error": "text is required"}, status=400)
            return
        _send(w, add_draft(self._path("drafts.json"), text.strip(), stamp()), status=201)

    async def get_layouts(self, c: Context, w: Writer) -> None:
        if self._project(c, w) is None:
            return
        _send(w, {"layouts": layouts(self._path("layouts.json"))})

    async def put_layouts(self, c: Context, w: Writer) -> None:
        if self._project(c, w) is None:
            return
        body = await json_body(c, w)
        if body is None:
            return
        raw = body.get("layouts", body)
        if not isinstance(raw, dict):
            _send(w, {"error": "layouts must be an object"}, status=400)
            return
        stored = write_layouts(self._path("layouts.json"), cast(dict[str, JsonValue], raw))
        if isinstance(stored, str):
            _send(w, {"error": stored}, status=400)
            return
        _send(w, {"layouts": stored})

    async def get_templates(self, c: Context, w: Writer) -> None:
        if self._project(c, w) is None:
            return
        _send(w, {"templates": templates(self._path("prompt-templates.json"))})

    async def put_templates(self, c: Context, w: Writer) -> None:
        if self._project(c, w) is None:
            return
        body = await json_body(c, w)
        if body is None:
            return
        raw = body.get("templates")
        if not isinstance(raw, list):
            _send(w, {"error": "templates must be a list"}, status=400)
            return
        rows: list[dict[str, str]] = []
        for item in raw:
            if not isinstance(item, dict):
                _send(w, {"error": "invalid template"}, status=400)
                return
            name = item.get("name")
            text = item.get("text")
            if not isinstance(name, str) or not isinstance(text, str):
                _send(w, {"error": "invalid template"}, status=400)
                return
            ident = item.get("id")
            rows.append(
                {
                    "id": ident if isinstance(ident, str) and ident else stamp(),
                    "name": name,
                    "text": text,
                }
            )
        write_templates(self._path("prompt-templates.json"), rows)
        _send(w, {"templates": rows})

    async def history(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        _send(
            w,
            {
                "events": [
                    {"type": event.type, "text": event.text, "at": event.at}
                    for event in list_events(self.db, run.id)
                ]
            },
        )

    async def get_handoff(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        path = self.config.data_dir / "handoff" / f"{run.id}.md"
        text = path.read_text(encoding="utf-8") if path.is_file() else ""
        _send(w, {"text": text})

    async def put_handoff(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        body = await json_body(c, w)
        if body is None:
            return
        text = body.get("text")
        if not isinstance(text, str):
            _send(w, {"error": "text is required"}, status=400)
            return
        path = self.config.data_dir / "handoff" / f"{run.id}.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        _send(w, {"text": text})

    async def images(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        body = await json_body(c, w)
        if body is None:
            return
        images = _images(body.get("images"))
        if isinstance(images, str) or not images:
            _send(w, {"error": images or "images are required"}, status=400)
            return
        if not run.worktree_path:
            _send(w, {"error": "the run has no worktree yet"}, status=409)
            return
        paths = materialize(
            self.config.data_dir / "uploads",
            Path(run.worktree_path) / ".cezar-attachments",
            images,
        )
        run.attachment_paths = paths
        await self.engine._save(run)
        _send(w, {"paths": paths})

    async def land(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        if not run.in_place:
            _send(w, {"result": "skipped", "reason": "not an in-place run"})
            return
        project = get_project(self.db, run.project_id)
        root = Path(project.root) if project else self.config.repo_root
        import asyncio

        result = await asyncio.to_thread(land_inplace, root)
        _send(w, cast(JsonValue, result))

    async def start_now(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        reason = await self.engine.start_now(run.id)
        if reason == "not found":
            _send(w, {"error": reason}, status=404)
            return
        if reason:
            _send(w, {"error": reason}, status=409)
            return
        _send(w, {"started": True})

    async def read_report(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        _send(w, {"report": cast(JsonValue, run.dispatch_report) if run.dispatch_report else None})

    async def get_profiles(self, _c: Context, w: Writer) -> None:
        _send(w, {"profiles": profiles(self._path("profiles.json"))})

    async def post_profile(self, c: Context, w: Writer) -> None:
        body = await json_body(c, w)
        if body is None:
            return
        name = body.get("name")
        runner = body.get("runner")
        if not isinstance(name, str) or not name.strip() or not isinstance(runner, str):
            _send(w, {"error": "name and runner are required"}, status=400)
            return
        if runner not in RUNNERS:
            _send(w, {"error": "unknown runner"}, status=400)
            return
        _send(w, add_profile(self._path("profiles.json"), name.strip(), runner), status=201)

    async def get_branding(self, _c: Context, w: Writer) -> None:
        _send(w, branding(self._path("branding.json")))

    async def put_branding(self, c: Context, w: Writer) -> None:
        body = await json_body(c, w)
        if body is None:
            return
        name = body.get("name")
        accent = body.get("accent", "lime")
        if not isinstance(name, str) or not name.strip() or not isinstance(accent, str):
            _send(w, {"error": "name is required"}, status=400)
            return
        if accent not in ("lime", "violet"):
            _send(w, {"error": "accent must be lime or violet"}, status=400)
            return
        _send(w, write_branding(self._path("branding.json"), name.strip(), accent))

    async def host_usage(self, _c: Context, w: Writer) -> None:
        _send(w, {"disk": disk_health(self.config.data_dir)})

    async def automation_templates(self, _c: Context, w: Writer) -> None:
        _send(w, {"templates": list(_TEMPLATES)})

    async def checkout(self, c: Context, w: Writer) -> None:
        body = await json_body(c, w)
        if body is None:
            return
        url = body.get("url")
        if not isinstance(url, str) or not url.strip():
            _send(w, {"error": "url is required"}, status=400)
            return
        result = project_forge.checkout(
            url.strip(),
            self.config.projects_dir,
            dry_run=self.config.dry_run,
            runner=project_forge.gh,
        )
        await self._register_forged(w, result)

    async def create_github(self, c: Context, w: Writer) -> None:
        body = await json_body(c, w)
        if body is None:
            return
        name = body.get("name")
        owner = body.get("owner", "")
        if not isinstance(name, str) or not isinstance(owner, str):
            _send(w, {"error": "name is required"}, status=400)
            return
        result = project_forge.create_repo(
            name.strip(),
            self.config.projects_dir,
            dry_run=self.config.dry_run,
            owner=owner.strip(),
            runner=project_forge.gh,
        )
        await self._register_forged(w, result)

    async def owners(self, _c: Context, w: Writer) -> None:
        _send(
            w,
            cast(
                JsonValue,
                project_forge.owners(dry_run=self.config.dry_run, runner=project_forge.gh),
            ),
        )

    async def connect(self, c: Context, w: Writer) -> None:
        await self._provider_command(c, w, connect_provider)

    async def retry_provider(self, c: Context, w: Writer) -> None:
        await self._provider_command(c, w, retry_provider)

    async def update(self, c: Context, w: Writer) -> None:
        await self._provider_command(c, w, update_provider)

    async def enable_provider(self, c: Context, w: Writer) -> None:
        body = await json_body(c, w)
        if body is None:
            return
        enabled = body.get("enabled")
        if not isinstance(enabled, bool):
            _send(w, {"error": "enabled must be a boolean"}, status=400)
            return
        row, reason = set_provider_enabled(
            self._provider_store(),
            c.match.params.get("name", ""),
            self.config.runner_bins,
            enabled,
        )
        if row is None:
            _send(w, {"error": reason or "unknown provider"}, status=400)
            return
        _send(w, cast(JsonValue, row))

    async def _provider_command(self, c: Context, w: Writer, command) -> None:
        row, reason = command(
            c.match.params.get("name", ""),
            self.config.runner_bins,
            dry_run=self.config.dry_run,
        )
        if row is None:
            _send(w, {"error": reason or "unknown provider"}, status=400)
            return
        _send(w, cast(JsonValue, row))

    async def _register_forged(self, w: Writer, result: dict[str, object]) -> None:
        if result.get("ok") is not True:
            _send(
                w,
                {"error": str(result.get("error") or "could not create the checkout")},
                status=400,
            )
            return
        path = result.get("path")
        if not isinstance(path, str):
            _send(w, {"error": "could not create the checkout"}, status=400)
            return
        project, reason = await self.engine.add_project(Path(path))
        if project is None:
            _send(w, {"error": reason or "could not add"}, status=409)
            return
        _send(
            w,
            {
                "id": project.id,
                "root": project.root,
                "dryRun": result.get("dryRun") is True,
            },
            status=201,
        )

    def _project(self, c: Context, w: Writer) -> Project | None:
        raw = c.match.params.get("project_id", "")
        project_id = self.engine.boot_project_id if raw in ("", "default") else raw
        project = get_project(self.db, project_id)
        if project is None:
            _send(w, {"error": "not found"}, status=404)
            return None
        return project

    def _run(self, c: Context, w: Writer) -> Run | None:
        if self._project(c, w) is None:
            return None
        run = get_run(self.db, c.match.params.get("run_id", ""))
        if run is None:
            _send(w, {"error": "not found"}, status=404)
            return None
        return run

    def _path(self, name: str) -> Path:
        return self.config.data_dir / name

    def _provider_store(self) -> Path:
        return self.config.data_dir / "disabled-providers.json"


def _send(w: Writer, body: object, status: int = 200) -> None:
    w.json(cast(JsonValue, body), status=status)


def _runner(body: dict[str, object], db: LiteWriter) -> str:
    from app.store.db import get_settings

    chosen = body.get("runner")
    if isinstance(chosen, str) and chosen in RUNNERS:
        return chosen
    return get_settings(db).default_runner


def _credential_names(path: Path) -> list[str]:
    from stario.json import loads as json_loads

    try:
        loaded = json_loads(path.read_text(encoding="utf-8"))
    except OSError, ValueError, TypeError:
        return []
    if isinstance(loaded, dict):
        return [key for key in loaded if isinstance(key, str)]
    return []
