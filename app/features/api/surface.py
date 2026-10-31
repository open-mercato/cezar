"""Routes that sit beside the run lifecycle.

Git actions, read receipts, bulk archive, UI state, uploads, telemetry consent,
provider and model discovery, terminal sessions, the design-mode proxy, webhook
receivers, and GitHub/Jira/Linear hook intake. Each one is the behavior the
engine can actually perform.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable
from pathlib import Path
from typing import Any, cast

from litewriter import LiteWriter
from stario import App, Context, Route, Writer
from stario.datastar import SSE
from stario.exceptions import RequestBodyError
from stario.json import JsonValue
from stario.json import dumps as json_dumps

from app.config import Config, terminal_enabled
from app.engine.engine import Engine
from app.engine.lifecycle_ops import (
    LifecycleDesk,
    LifecycleFailure,
    pending_reason,
    removal_block_reason,
)
from app.engine.preview import design_proxy_issue, start_proxy
from app.engine.providers import model_catalog, provider_status
from app.engine.telemetry_store import read_consent, write_consent
from app.engine.ui_state import merge_state, read_state
from app.engine.uploads import delete_upload, write_upload
from app.http.loopback import hosted_mode
from app.integrations import webhook_schema
from app.integrations.registry import WebhookStateError
from app.integrations.service import (
    WebhookService,
    webhooks_enabled,
)
from app.integrations.service import (
    subscribe as subscribe_webhook_changes,
)
from app.integrations.service import (
    unsubscribe as unsubscribe_webhook_changes,
)
from app.integrations.tracker import TrackerWatches
from app.store.db import get_project, get_run

_NO_WORKTREE = "no worktree"


class SurfaceApi:
    def __init__(self, db: LiteWriter, engine: Engine, config: Config) -> None:
        self.db = db
        self.engine = engine
        self.config = config
        self._proxies: dict[str, object] = {}
        self.watches = TrackerWatches()
        self.lifecycle = LifecycleDesk(db, engine)

    def register(self, app: App) -> None:
        routes = (
            ("POST", "/runs/archive-finished", self.archive_finished),
            ("POST", "/runs/read-all", self.read_all),
            ("POST", "/runs/{run_id}/read", self.read_one),
            ("POST", "/runs/{run_id}/unread", self.unread_one),
            ("GET", "/runs/{run_id}/diff", self.diff),
            ("GET", "/runs/{run_id}/commits", self.commits),
            ("GET", "/runs/{run_id}/files", self.files),
            ("POST", "/runs/{run_id}/continue", self.continue_run),
            ("POST", "/runs/{run_id}/remove-worktree", self.remove_worktree),
            ("POST", "/worktree-lifecycle/operations", self.lifecycle_start),
            ("GET", "/worktree-lifecycle/operations/{operation_id}", self.lifecycle_get),
            ("POST", "/worktree-lifecycle/operations/{operation_id}/actions", self.lifecycle_act),
            (
                "GET",
                "/worktree-lifecycle/operations/{operation_id}/output",
                self.lifecycle_output,
            ),
            ("POST", "/worktree-lifecycle/preview", self.lifecycle_preview),
            ("POST", "/worktrees/reclaim", self.reclaim),
            ("GET", "/runs/{run_id}/git/status", self.git_status),
            ("POST", "/runs/{run_id}/git/commit", self.git_commit),
            ("POST", "/runs/{run_id}/git/push", self.git_push),
            ("POST", "/runs/{run_id}/pr", self.draft_pr),
            ("POST", "/runs/{run_id}/terminal", self.terminal_open),
            ("POST", "/runs/{run_id}/terminal/{session_id}/input", self.terminal_input),
            ("POST", "/runs/{run_id}/terminal/{session_id}/resize", self.terminal_resize),
            ("GET", "/runs/{run_id}/terminal/{session_id}/output", self.terminal_output),
            ("DELETE", "/runs/{run_id}/terminal/{session_id}", self.terminal_close),
            ("GET", "/ui-state", self.ui_state),
            ("PUT", "/ui-state", self.put_ui_state),
        )
        for method, path, handler in routes:
            app.add(Route(f"{method} /api/v1{path}"), handler)
            app.add(Route(f"{method} /api/v1/p/{{project_id}}{path}"), handler)
        app.add(Route("GET /api/v1/workspace/ui-state"), self.workspace_ui)
        app.add(Route("PUT /api/v1/workspace/ui-state"), self.put_workspace_ui)
        app.add(Route("POST /api/v1/workspace/uploads"), self.upload)
        app.add(Route("DELETE /api/v1/workspace/uploads/{upload_id}"), self.delete_upload)
        app.add(Route("GET /api/v1/telemetry/consent"), self.telemetry)
        app.add(Route("PUT /api/v1/telemetry/consent"), self.put_telemetry)
        app.add(Route("POST /api/v1/telemetry/event"), self.telemetry_event)
        app.add(Route("GET /api/v1/providers/status"), self.providers)
        app.add(Route("GET /api/v1/models"), self.models)
        app.add(Route("POST /api/v1/preview/design-proxy"), self.preview)
        app.add(Route("GET /api/v1/webhooks"), self.webhooks)
        app.add(Route("POST /api/v1/webhooks"), self.create_webhook)
        app.add(Route("PATCH /api/v1/webhooks/{receiver_id}"), self.update_webhook)
        app.add(Route("PUT /api/v1/webhooks/{receiver_id}"), self.update_webhook)
        app.add(Route("DELETE /api/v1/webhooks/{receiver_id}"), self.delete_webhook)
        app.add(Route("POST /api/v1/webhooks/{receiver_id}/test"), self.test_webhook)
        app.add(Route("GET /api/v1/webhooks/{receiver_id}/deliveries"), self.deliveries)
        app.add(Route("GET /api/v1/webhooks/{receiver_id}/activity"), self.webhook_activity)
        app.add(Route("POST /api/v1/webhooks/{receiver_id}/activate"), self.activate_webhook)
        app.add(Route("POST /api/v1/webhooks/{receiver_id}/pause"), self.pause_webhook)
        app.add(Route("POST /api/v1/webhooks/{receiver_id}/resume"), self.resume_webhook)
        app.add(
            Route("POST /api/v1/webhooks/{receiver_id}/rotate-secret"),
            self.rotate_webhook,
        )
        app.add(Route("GET /api/v1/webhooks/history"), self.webhook_history)
        app.add(Route("GET /api/v1/webhooks/events"), self.webhook_events)
        app.add(Route("POST /api/v1/webhooks/notice/acknowledge"), self.acknowledge_notice)
        app.add(
            Route("POST /api/v1/webhooks/deliveries/{delivery_id}/retry"),
            self.retry_delivery,
        )
        app.add(
            Route("POST /api/v1/webhooks/deliveries/{delivery_id}/replay"),
            self.replay_delivery,
        )
        app.add(Route("GET /api/v1/github"), self.github_tab)
        app.add(Route("GET /api/v1/jira/search"), self.jira_search)
        app.add(Route("GET /api/v1/linear/search"), self.linear_search)
        app.add(
            Route("POST /api/v1/webhooks/outbox/{sequence}/replay"),
            self.replay_outbox,
        )
        app.add(Route("GET /api/v1/fs/browse"), self.browse)
        app.add(Route("GET /api/v1/launch-key"), self.launch_key)
        app.add(Route("GET /api/v1/config"), self.read_config)
        app.add(Route("PUT /api/v1/config"), self.write_config)
        app.add(Route("GET /api/v1/github/prs/{number}/merge-state"), self.merge_state)
        app.add(Route("POST /api/v1/github/prs/{number}/merge"), self.merge_pr)
        app.add(Route("POST /api/v1/github/prs/{number}/reviews"), self.review_pr)
        app.add(Route("GET /api/v1/events"), self.project_events)
        app.add(Route("GET /api/v1/p/{project_id}/events"), self.project_events)
        app.add(Route("GET /api/v1/workspace/events"), self.workspace_events)
        for method, path, handler in (
            ("GET", "/github/checks", self.github_checks),
            ("GET", "/github/search", self.github_search),
            ("GET", "/github/ref-status", self.github_ref_status),
            ("GET", "/github/comments/{kind}/{number}", self.github_comments),
            ("GET", "/github/prs/{number}/changes", self.github_pr_changes),
            ("GET", "/repo", self.repo),
            ("GET", "/repo/diff", self.repo_diff),
            ("GET", "/repo/changes", self.repo_changes),
            ("GET", "/repo/tree", self.repo_tree),
            ("GET", "/repo/files", self.repo_file),
            ("GET", "/repo/commit/{sha}", self.repo_commit),
            ("POST", "/repo/branch", self.repo_branch),
            ("GET", "/repo/sync", self.repo_sync),
            ("POST", "/repo/fetch", self.repo_fetch),
            ("POST", "/repo/pull", self.repo_pull),
            ("POST", "/repo/push", self.repo_push),
            ("POST", "/repo/sync", self.repo_sync_now),
            ("GET", "/tracker/connection", self.tracker_connection),
            ("PUT", "/tracker/connection", self.tracker_save_connection),
            ("DELETE", "/tracker/connection", self.tracker_delete_connection),
            ("GET", "/tracker/association", self.tracker_association),
            ("PUT", "/tracker/association", self.tracker_save_association),
            ("DELETE", "/tracker/association", self.tracker_clear_association),
            ("GET", "/tracker/candidates", self.tracker_candidates),
            ("GET", "/tracker", self.tracker_list),
            ("GET", "/tracker/search", self.tracker_search),
            ("GET", "/tracker/{item_id}", self.tracker_item),
            ("POST", "/tracker/watch", self.tracker_watch),
            ("GET", "/tracker/watch/{watch_id}", self.tracker_watch_read),
            ("POST", "/tracker/watch/{watch_id}", self.tracker_watch_refresh),
        ):
            app.add(Route(f"{method} /api/v1{path}"), handler)
            app.add(Route(f"{method} /api/v1/p/{{project_id}}{path}"), handler)

    async def project_events(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None:
            return
        await self._event_stream(c, w, project.id)

    async def workspace_events(self, c: Context, w: Writer) -> None:
        await self._event_stream(c, w, None)

    async def _event_stream(self, c: Context, w: Writer, project_id: str | None) -> None:
        """List-level SSE. `/events` is one project. `/workspace/events` stamps `projectId`."""
        from app.features.api.records import public_run

        sse = SSE(w)
        sse.open()
        pending: list[tuple[str, object]] = []

        def on_event(event: str, data: object) -> None:
            if not _event_visible(event, data, project_id):
                return
            pending.append((event, data))

        off = self.engine.subscribe_workspace(on_event)
        try:
            ping_at = time.monotonic() + 15
            while not c.disconnected:
                while pending:
                    event, data = pending.pop(0)
                    _write_frame(w, event, _event_body(event, data, project_id, public_run))
                if time.monotonic() >= ping_at:
                    sse.ping()
                    ping_at = time.monotonic() + 15
                await asyncio.sleep(0.05)
        finally:
            off()

    async def archive_finished(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None:
            return
        count = await self.engine.archive_finished(project.id)
        w.json({"archived": count})

    async def read_all(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None:
            return
        w.json({"read": await self.engine.mark_all_read(project.id)})

    async def read_one(self, c: Context, w: Writer) -> None:
        await self._seen(c, w, True)

    async def unread_one(self, c: Context, w: Writer) -> None:
        await self._seen(c, w, False)

    async def commits(self, c: Context, w: Writer) -> None:
        from app.features.task.data import list_commits

        run = self._run(c, w)
        if run is None:
            return
        w.json(cast(JsonValue, {"commits": list_commits(run.worktree_path)}))

    async def files(self, c: Context, w: Writer) -> None:
        from app.features.task.data import list_worktree_files

        run = self._run(c, w)
        if run is None:
            return
        w.json(cast(JsonValue, {"files": list_worktree_files(run.worktree_path)}))

    async def continue_run(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        body = await _json(c, w)
        if body is None:
            return
        message = body.get("message", "")
        reason = await self.engine.deliver(run.id, message if isinstance(message, str) else "")
        if reason:
            status = 404 if reason == "not found" else 409
            w.json({"error": reason}, status=status)
            return
        w.json({"continued": True})

    async def remove_worktree(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        if run.status in ("queued", "running", "waiting"):
            w.json({"error": "cancel the run before removing its worktree"}, status=409)
            return
        if not run.worktree_path or run.in_place:
            w.json({"error": _NO_WORKTREE}, status=409)
            return
        project = get_project(self.db, run.project_id)
        if project is not None:
            blocked = removal_block_reason(Path(project.root))
            if blocked:
                w.json({"error": blocked}, status=409)
                return
        if project is None:
            w.json({"error": "not found"}, status=404)
            return
        from app.engine.gitwork import drop_worktree_dir

        gone = await asyncio.to_thread(
            drop_worktree_dir, Path(project.root), Path(run.worktree_path)
        )
        if not gone:
            w.json({"error": "worktree could not be removed"}, status=409)
            return
        from app.clock import stamp

        run.worktree_reclaimed_at = stamp()
        await self.engine._save(run)
        w.json({"removed": True})

    async def reclaim(self, c: Context, w: Writer) -> None:
        w.json(cast(JsonValue, {"reclaimed": await self.engine.retain()}))

    async def launch_key(self, _c: Context, w: Writer) -> None:
        from app.features.editors.store import launch_key

        w.json({"key": launch_key(self.config.data_dir)})

    async def read_config(self, _c: Context, w: Writer) -> None:
        w.json(cast(JsonValue, self._config_body()))

    async def write_config(self, c: Context, w: Writer) -> None:
        body = await _json(c, w)
        if body is None:
            return
        path = self.config.repo_root / ".ai" / "cezar" / "config.json"
        current = _object_file(path)
        if "systemPrompt" in body and isinstance(body["systemPrompt"], str):
            current["systemPrompt"] = body["systemPrompt"]
        if "branchNaming" in body and isinstance(body["branchNaming"], str):
            current["branchNaming"] = body["branchNaming"]
        if "reviewGate" in body and isinstance(body["reviewGate"], bool):
            current["reviewGate"] = body["reviewGate"]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json_dumps(cast(JsonValue, current)) + "\n", encoding="utf-8")
        w.json(cast(JsonValue, self._config_body()))

    def _config_body(self) -> dict[str, object]:
        loaded = _object_file(self.config.repo_root / ".ai" / "cezar" / "config.json")
        prompt = loaded.get("systemPrompt")
        naming = loaded.get("branchNaming")
        gate = loaded.get("reviewGate")
        return {
            "systemPrompt": prompt if isinstance(prompt, str) else "",
            "branchNaming": naming if isinstance(naming, str) else "",
            "reviewGate": gate if isinstance(gate, bool) else None,
        }

    async def diff(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        if not run.worktree_path or not run.base_sha:
            w.json({"error": _NO_WORKTREE}, status=409)
            return
        from app.engine.gitwork import task_diff

        diff = task_diff(
            Path(run.worktree_path),
            base_branch=run.base_branch,
            task_branch=run.branch,
            started_at=run.started_at,
            fallback_sha=run.base_sha,
        )
        w.text(diff.text, 200)

    async def git_status(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        result, reason = await self.engine.git_status(run.id)
        if reason or result is None:
            w.json({"error": reason or _NO_WORKTREE}, status=409 if reason != "not found" else 404)
            return
        w.json(cast(JsonValue, result))

    async def git_commit(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        body = await _json(c, w)
        if body is None:
            return
        message = body.get("message", "")
        if not isinstance(message, str):
            w.json({"error": "commit message must be one plain line"}, status=400)
            return
        project = get_project(self.db, run.project_id)
        if project is not None:
            blocked = pending_reason(Path(project.root), run.id)
            if blocked:
                w.json({"error": blocked}, status=409)
                return
        result, reason = await self.engine.git_commit(run.id, message)
        if reason or result is None:
            status = 404 if reason == "not found" else 409
            w.json({"error": reason or "commit failed"}, status=status)
            return
        if result.get("result") == "nothing":
            w.json({"committed": False, "result": "nothing"})
            return
        w.json({"committed": True, "sha": result.get("sha", "")})

    async def git_push(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        result, reason = await self.engine.git_push(run.id)
        if reason or result is None:
            w.json({"error": reason or "push failed"}, status=409 if reason != "not found" else 404)
            return
        w.json(
            cast(
                JsonValue,
                {
                    "pushed": True,
                    "branch": result.get("branch", ""),
                    "remote": result.get("remote", ""),
                    "upstreamSet": bool(result.get("upstreamSet")),
                    "dryRun": bool(result.get("dryRun")),
                },
            )
        )

    async def draft_pr(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        result, reason = await self.engine.open_draft_pr(run.id)
        if reason or result is None:
            code = 404 if reason == "not found" else 409
            if reason and reason.startswith("no worktree"):
                code = 400
            w.json({"error": reason or "draft PR failed"}, status=code)
            return
        w.json(cast(JsonValue, result), status=201)

    def _terminal_refused(self, w: Writer) -> bool:
        """Every terminal route but close answers 409 where the policy is off, as in TypeScript."""
        if terminal_enabled(hosted_mode(self.config)):
            return False
        w.json({"error": "terminal is disabled"}, status=409)
        return True

    async def terminal_open(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        if self._terminal_refused(w):
            return
        if not run.worktree_path:
            w.json({"error": _NO_WORKTREE}, status=409)
            return
        session_id = await self.engine._terminals.open(Path(run.worktree_path))
        w.json({"id": session_id}, status=201)

    async def terminal_input(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        if self._terminal_refused(w):
            return
        body = await _json(c, w)
        if body is None:
            return
        data = body.get("data", "")
        if not isinstance(data, str):
            w.json({"error": "data must be a string"}, status=400)
            return
        session_id = c.match.params.get("session_id", "")
        if not await self.engine._terminals.write(session_id, data):
            w.json({"error": "not found"}, status=404)
            return
        w.json({"ok": True})

    async def terminal_resize(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        if self._terminal_refused(w):
            return
        body = await _json(c, w)
        if body is None:
            return
        rows = body.get("rows", 24)
        cols = body.get("cols", 80)
        if not isinstance(rows, int) or not isinstance(cols, int):
            w.json({"error": "rows and cols must be integers"}, status=400)
            return
        session_id = c.match.params.get("session_id", "")
        if not self.engine._terminals.resize(session_id, rows, cols):
            w.json({"error": "not found"}, status=404)
            return
        w.json({"ok": True})

    async def terminal_output(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        if self._terminal_refused(w):
            return
        session_id = c.match.params.get("session_id", "")
        session = self.engine._terminals.sessions.get(session_id)
        if session is None:
            w.json({"error": "not found"}, status=404)
            return
        import asyncio
        import time

        sse = SSE(w)
        sse.open()
        sent = 0
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            if len(session.chunks) > sent:
                _frame(w, "".join(session.chunks[sent:]))
                sent = len(session.chunks)
                if "\n" in "".join(session.chunks):
                    return
            await asyncio.sleep(0.05)
        if sent == 0:
            _frame(w, "")

    async def terminal_close(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        closed = await self.engine._terminals.close(c.match.params.get("session_id", ""))
        if not closed:
            w.json({"error": "not found"}, status=404)
            return
        w.json({"closed": True})

    async def ui_state(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None:
            return
        w.json(cast(JsonValue, read_state(_ui_path(Path(project.root)))))

    async def put_ui_state(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None:
            return
        body = await _json(c, w)
        if body is None:
            return
        merged, reason = merge_state(_ui_path(Path(project.root)), body)
        if reason or merged is None:
            w.json({"error": reason or "ui state must be an object"}, status=400)
            return
        w.json(cast(JsonValue, merged))

    async def workspace_ui(self, _c: Context, w: Writer) -> None:
        w.json(cast(JsonValue, read_state(self.config.data_dir / "ui-state.json")))

    async def put_workspace_ui(self, c: Context, w: Writer) -> None:
        body = await _json(c, w)
        if body is None:
            return
        merged, reason = merge_state(self.config.data_dir / "ui-state.json", body)
        if reason or merged is None:
            w.json({"error": reason or "ui state must be an object"}, status=400)
            return
        w.json(cast(JsonValue, merged))

    async def upload(self, c: Context, w: Writer) -> None:
        body = await _json(c, w)
        if body is None:
            return
        media = body.get("mediaType", "")
        data = body.get("data", "")
        name = body.get("name", "")
        if not isinstance(media, str) or not isinstance(data, str):
            w.json(
                {
                    "error": (
                        "unsupported attachment type — send other files as application/octet-stream"
                    )
                },
                status=400,
            )
            return
        meta, reason = write_upload(
            self.config.data_dir / "uploads",
            media,
            data,
            name if isinstance(name, str) else "",
        )
        if reason or meta is None:
            w.json({"error": reason or "attachment rejected"}, status=400)
            return
        w.json(
            cast(JsonValue, {"uploadId": meta["id"], "mediaType": meta["mediaType"]}),
            status=201,
        )

    async def delete_upload(self, c: Context, w: Writer) -> None:
        upload_id = c.match.params.get("upload_id", "")
        if not delete_upload(self.config.data_dir / "uploads", upload_id):
            w.json({"error": "not found"}, status=404)
            return
        w.json({"deleted": True})

    async def telemetry(self, _c: Context, w: Writer) -> None:
        w.json(cast(JsonValue, read_consent(self.config.data_dir / "telemetry.json")))

    async def put_telemetry(self, c: Context, w: Writer) -> None:
        body = await _json(c, w)
        if body is None:
            return
        enabled = body.get("enabled") is True
        w.json(cast(JsonValue, write_consent(self.config.data_dir / "telemetry.json", enabled)))

    async def telemetry_event(self, c: Context, w: Writer) -> None:
        consent = read_consent(self.config.data_dir / "telemetry.json")
        if consent.get("enabled") is not True:
            w.json({"error": "telemetry is off"}, status=403)
            return
        w.empty()

    async def providers(self, _c: Context, w: Writer) -> None:
        w.json(
            cast(
                JsonValue,
                provider_status(
                    self.config.runner_bins, self.config.data_dir / "disabled-providers.json"
                ),
            )
        )

    async def models(self, c: Context, w: Writer) -> None:
        from app.engine.agent_env import build_child_env, profile_env
        from app.integrations.accounts import profile_home_for

        runner = c.req.query.get("runner", "")
        account = c.req.query.get("account", "")
        home = profile_home_for(self.config, account, runner) if account else ""
        env = build_child_env(runner or "claude", extra=profile_env(runner, home or ""))
        w.json(
            cast(
                JsonValue,
                model_catalog(
                    runner,
                    self.config.runner_bins,
                    cwd=str(self.config.repo_root),
                    env=env,
                ),
            )
        )

    async def preview(self, c: Context, w: Writer) -> None:
        body = await _json(c, w)
        if body is None:
            return
        url = body.get("url", "")
        if not isinstance(url, str):
            w.json({"error": "design mode only mirrors loopback http"}, status=400)
            return
        issue = design_proxy_issue(url, enabled=self.config.design_mode)
        if issue:
            w.json({"error": issue}, status=409)
            return
        proxy, close = await start_proxy(url)
        self._proxies[proxy] = close
        w.json({"url": proxy})

    # ---- webhook receivers (contract control plane) -------------------------

    def _webhook_gate(self, w: Writer) -> bool:
        """Every webhook route answers 409 until `CEZ_WEBHOOKS=1`, like server.ts."""
        w.headers.set("cache-control", "no-store")
        if not webhooks_enabled():
            w.json(
                {"error": "Enable webhook delivery with CEZ_WEBHOOKS=1 and restart cezar"},
                status=409,
            )
            return True
        return False

    def _webhook_service(self) -> WebhookService:
        return WebhookService.open(
            self.config.data_dir,
            dry_run=self.config.dry_run,
            project_id=self.engine.boot_project_id or "",
            mode="hosted" if hosted_mode(self.config) else "local",
        )

    def _webhook_call(self, w: Writer, call, status: int = 200) -> None:
        try:
            result = call()
        except WebhookStateError as exc:
            if exc.retry_after:
                w.headers.set("retry-after", str(exc.retry_after))
            w.json({"error": exc.code, "message": str(exc)}, status=exc.status)
            return
        w.json(cast(JsonValue, result), status=status)

    async def webhooks(self, _c: Context, w: Writer) -> None:
        if self._webhook_gate(w):
            return
        w.json(cast(JsonValue, self._webhook_service().list()))

    async def create_webhook(self, c: Context, w: Writer) -> None:
        if self._webhook_gate(w):
            return
        body = await _json(c, w)
        if body is None:
            return
        settings, issue = webhook_schema.parse_settings(body, create=True)
        if issue or settings is None:
            w.json({"error": issue or "rejected"}, status=400)
            return
        self._webhook_call(
            w,
            lambda: self._webhook_service().create(settings),
            status=201,
        )

    async def update_webhook(self, c: Context, w: Writer) -> None:
        if self._webhook_gate(w):
            return
        body = await _json(c, w)
        if body is None:
            return
        revision, issue = webhook_schema.parse_revision(body)
        if issue or revision is None:
            w.json({"error": issue or "Invalid expectedRevision"}, status=400)
            return
        settings, issue = webhook_schema.parse_settings(body, create=False)
        if issue or settings is None:
            w.json({"error": issue or "rejected"}, status=400)
            return
        self._webhook_call(
            w,
            lambda: self._webhook_service().update(
                c.match.params.get("receiver_id", ""), settings, revision
            ),
        )

    async def delete_webhook(self, c: Context, w: Writer) -> None:
        if self._webhook_gate(w):
            return
        self._webhook_call(
            w,
            lambda: self._webhook_service().delete(c.match.params.get("receiver_id", "")),
        )

    async def activate_webhook(self, c: Context, w: Writer) -> None:
        if self._webhook_gate(w):
            return
        body = await _json(c, w)
        if body is None:
            return
        revision, issue = webhook_schema.parse_activation(body)
        if issue or revision is None:
            w.json({"error": issue or "rejected"}, status=400)
            return
        self._webhook_call(
            w,
            lambda: self._webhook_service().activate(
                c.match.params.get("receiver_id", ""), revision
            ),
        )

    async def _webhook_operation(self, c: Context, w: Writer, call) -> None:
        body = await _json(c, w)
        if body is None:
            return
        operation, issue = webhook_schema.parse_operation(body)
        if issue or operation is None:
            w.json({"error": issue or "rejected"}, status=400)
            return
        self._webhook_call(
            w,
            lambda: call(c.match.params.get("receiver_id", ""), operation),
        )

    async def pause_webhook(self, c: Context, w: Writer) -> None:
        if self._webhook_gate(w):
            return
        await self._webhook_operation(c, w, self._webhook_service().pause)

    async def resume_webhook(self, c: Context, w: Writer) -> None:
        if self._webhook_gate(w):
            return
        await self._webhook_operation(c, w, self._webhook_service().resume)

    async def rotate_webhook(self, c: Context, w: Writer) -> None:
        if self._webhook_gate(w):
            return
        body = await _json(c, w)
        if body is None:
            return
        parsed, issue = webhook_schema.parse_rotation(body)
        if issue or parsed is None:
            w.json({"error": issue or "rejected"}, status=400)
            return
        revision, mode = parsed
        self._webhook_call(
            w,
            lambda: self._webhook_service().rotate(
                c.match.params.get("receiver_id", ""), revision, mode
            ),
        )

    async def acknowledge_notice(self, c: Context, w: Writer) -> None:
        if self._webhook_gate(w):
            return
        body = await _json(c, w)
        if body is None:
            return
        expected, issue = webhook_schema.parse_acknowledge(body)
        if issue or expected is None:
            w.json({"error": issue or "rejected"}, status=400)
            return
        w.json(cast(JsonValue, self._webhook_service().acknowledge(expected)))

    async def webhook_history(self, c: Context, w: Writer) -> None:
        if self._webhook_gate(w):
            return
        limit, cursor = _page_args(c)
        w.json(
            cast(
                JsonValue,
                self._webhook_service().history_page(limit=limit, cursor=cursor),
            )
        )

    async def webhook_activity(self, c: Context, w: Writer) -> None:
        if self._webhook_gate(w):
            return
        limit, cursor = _page_args(c)
        w.json(
            cast(
                JsonValue,
                self._webhook_service().activity_page(
                    c.match.params.get("receiver_id", ""), limit=limit, cursor=cursor
                ),
            )
        )

    async def webhook_events(self, c: Context, w: Writer) -> None:
        """`GET /webhooks/events`: `resync`, then `change` per registry commit."""
        if self._webhook_gate(w):
            return
        service = self._webhook_service()
        sse = SSE(w)
        sse.open()
        pending: list[tuple[str, dict]] = [
            ("resync", {"changeSequence": service.registry.change_sequence()})
        ]

        def on_change(sequence: int) -> None:
            pending.append(("change", {"changeSequence": sequence}))

        subscribe_webhook_changes(on_change)
        try:
            ping_at = time.monotonic() + 15
            while not c.disconnected:
                while pending:
                    event, data = pending.pop(0)
                    _write_frame(w, event, cast(dict[str, JsonValue], data))
                if time.monotonic() >= ping_at:
                    sse.ping()
                    ping_at = time.monotonic() + 15
                await asyncio.sleep(0.05)
        finally:
            unsubscribe_webhook_changes(on_change)

    async def retry_delivery(self, c: Context, w: Writer) -> None:
        if self._webhook_gate(w):
            return
        self._webhook_call(
            w,
            lambda: {
                "delivery": self._webhook_service().retry(c.match.params.get("delivery_id", ""))
            },
        )

    async def replay_delivery(self, c: Context, w: Writer) -> None:
        if self._webhook_gate(w):
            return
        body = await _json(c, w)
        if body is None:
            return
        operation, issue = webhook_schema.parse_operation(body)
        if issue or operation is None:
            w.json({"error": issue or "rejected"}, status=400)
            return
        if body.get("confirmed") is not True:
            w.json({"error": "Replay requires confirmed: true"}, status=400)
            return
        self._webhook_call(
            w,
            lambda: {
                "delivery": self._webhook_service().replay(
                    c.match.params.get("delivery_id", ""), operation
                )
            },
        )

    async def github_tab(self, _c: Context, w: Writer) -> None:
        from app.integrations.github_read import github_overview

        w.json(
            cast(
                JsonValue,
                github_overview(self.config.repo_root, dry_run=self.config.dry_run),
            )
        )

    async def jira_search(self, c: Context, w: Writer) -> None:
        from app.integrations.clients import jira_search

        w.json(cast(JsonValue, jira_search(self.config, c.req.query.get("q", ""))))

    async def linear_search(self, c: Context, w: Writer) -> None:
        from app.integrations.clients import linear_search

        w.json(cast(JsonValue, linear_search(self.config, c.req.query.get("q", ""))))

    async def test_webhook(self, c: Context, w: Writer) -> None:
        if self._webhook_gate(w):
            return
        self._webhook_call(
            w,
            lambda: self._webhook_service().test(c.match.params.get("receiver_id", "")),
        )

    async def replay_outbox(self, c: Context, w: Writer) -> None:
        import time

        from app.integrations.outbox import Outbox, OutboxError, replay

        raw = c.match.params.get("sequence", "")
        if not raw.isdigit():
            w.json({"error": "Delivery not found"}, status=404)
            return
        directory = self.config.data_dir / "webhook-outbox"
        install = directory / "installation"
        if not install.is_file():
            w.json({"error": "Delivery not found"}, status=404)
            return
        box = Outbox(directory, install.read_text(encoding="utf-8").strip())
        try:
            box.open()
        except OSError, OutboxError:
            w.json({"error": "Delivery not found"}, status=404)
            return
        reason = replay(box, int(raw), now_ms=int(time.time() * 1000))
        if reason:
            status = 404 if reason == "Delivery not found" else 409
            w.json({"error": reason}, status=status)
            return
        w.json({"replayed": True})

    async def deliveries(self, c: Context, w: Writer) -> None:
        if self._webhook_gate(w):
            return
        limit, cursor = _page_args(c)
        w.json(
            cast(
                JsonValue,
                self._webhook_service().delivery_page(
                    c.match.params.get("receiver_id", ""),
                    limit=limit,
                    cursor=cursor,
                    task_id=c.req.query.get("taskId", ""),
                ),
            )
        )

    async def merge_state(self, c: Context, w: Writer) -> None:
        from app.integrations.github_review import merge_state

        number = _pr_number(c.match.params.get("number", ""))
        if number is None:
            w.json({"error": "invalid pull request number"}, status=400)
            return
        w.json(
            cast(
                JsonValue,
                merge_state(number, dry_run=self.config.dry_run, cwd=self.config.repo_root),
            )
        )

    async def merge_pr(self, c: Context, w: Writer) -> None:
        from app.integrations.github_review import merge_pr

        number = _pr_number(c.match.params.get("number", ""))
        body = await _json(c, w)
        if number is None or body is None:
            if number is None:
                w.json({"error": "invalid pull request number"}, status=400)
            return
        method = body.get("method", "squash")
        expected = body.get("expectedHeadSha", "")
        result = merge_pr(
            number,
            method if isinstance(method, str) else "",
            dry_run=self.config.dry_run,
            cwd=self.config.repo_root,
            expected_head=expected if isinstance(expected, str) else "",
        )
        if not result.get("ok"):
            status = result.get("status")
            code = status if isinstance(status, int) else 409
            payload: dict[str, object] = {"error": str(result.get("error", "merge failed"))}
            if result.get("code"):
                payload["code"] = result["code"]
            if result.get("current"):
                payload["current"] = result["current"]
            w.json(cast(JsonValue, payload), status=code)
            return
        w.json(cast(JsonValue, {key: value for key, value in result.items() if key != "ok"}))

    async def review_pr(self, c: Context, w: Writer) -> None:
        from app.integrations.github_review import review_pr

        number = _pr_number(c.match.params.get("number", ""))
        body = await _json(c, w)
        if number is None or body is None:
            if number is None:
                w.json({"error": "invalid pull request number"}, status=400)
            return
        event = body.get("event", "")
        text = body.get("body", "")
        result = review_pr(
            number,
            event if isinstance(event, str) else "",
            text if isinstance(text, str) else "",
            dry_run=self.config.dry_run,
            cwd=self.config.repo_root,
        )
        if not result.get("ok"):
            status = result.get("status")
            code = status if isinstance(status, int) else 409
            w.json({"error": str(result.get("error", "review failed"))}, status=code)
            return
        w.json(cast(JsonValue, {key: value for key, value in result.items() if key != "ok"}))

    async def browse(self, c: Context, w: Writer) -> None:
        from pathlib import Path

        from app.engine.fs_browse import browse as browse_directory

        root = Path(self.config.browse_root or str(Path.home()))
        result = browse_directory(
            root,
            c.req.query.get("path", ""),
            show_hidden=c.req.query.get("showHidden") == "1",
        )
        if result.get("ok") is not True:
            status = result.get("status")
            code = status if isinstance(status, int) else 400
            w.json({"error": str(result.get("error", "browse failed"))}, status=code)
            return
        w.json(cast(JsonValue, {key: value for key, value in result.items() if key != "ok"}))

    async def _seen(self, c: Context, w: Writer, read: bool) -> None:
        run = self._run(c, w)
        if run is None:
            return
        reason = await self.engine.set_read(run.id, read)
        if reason:
            w.json({"error": reason}, status=404)
            return
        updated = get_run(self.db, run.id)
        from app.features.api.records import public_run

        w.json(cast(JsonValue, public_run(updated or run, full=False)))

    async def github_checks(self, c: Context, w: Writer) -> None:
        from app.integrations.github_read import GH_CHECKS_MAX, github_checks, parse_number_list

        raw = c.req.query.get("prs")
        if raw is None or raw == "":
            w.json({"error": "missing prs query"}, status=400)
            return
        numbers = parse_number_list(raw, cap=GH_CHECKS_MAX)
        if numbers is None or not numbers:
            w.json({"error": "invalid prs query"}, status=400)
            return
        root = self._root(c, w)
        if root is None:
            return
        w.json(cast(JsonValue, github_checks(root, numbers, dry_run=self.config.dry_run)))

    async def github_search(self, c: Context, w: Writer) -> None:
        from app.integrations.github_read import GH_SEARCH_MAX, github_search

        kind = c.req.query.get("kind", "")
        query = c.req.query.get("q") or ""
        if kind not in ("issue", "pr") or not query.strip() or len(query.strip()) > 256:
            w.json({"error": "invalid search query"}, status=400)
            return
        limit_raw = c.req.query.get("limit")
        limit = GH_SEARCH_MAX
        if limit_raw is not None:
            if not limit_raw.isdigit() or not 1 <= int(limit_raw) <= GH_SEARCH_MAX:
                w.json({"error": "invalid search query"}, status=400)
                return
            limit = int(limit_raw)
        root = self._root(c, w)
        if root is None:
            return
        w.json(
            cast(
                JsonValue,
                github_search(root, kind, query, limit=limit, dry_run=self.config.dry_run),
            )
        )

    async def github_ref_status(self, c: Context, w: Writer) -> None:
        from app.integrations.github_read import (
            GH_REF_STATUS_MAX,
            github_ref_status,
            parse_number_list,
        )

        prs = parse_number_list(c.req.query.get("prs"), cap=GH_REF_STATUS_MAX)
        issues = parse_number_list(c.req.query.get("issues"), cap=GH_REF_STATUS_MAX)
        if prs is None or issues is None:
            w.json({"error": "invalid ref-status query"}, status=400)
            return
        if not prs and not issues:
            w.json({"error": "missing prs or issues query"}, status=400)
            return
        root = self._root(c, w)
        if root is None:
            return
        w.json(cast(JsonValue, github_ref_status(root, prs, issues, dry_run=self.config.dry_run)))

    async def github_comments(self, c: Context, w: Writer) -> None:
        from app.integrations.github_read import github_comments

        kind = c.match.params.get("kind", "")
        raw = c.match.params.get("number", "")
        if kind not in ("issue", "pr") or not raw.isdigit() or int(raw) <= 0:
            w.json({"error": "invalid comment request"}, status=400)
            return
        root = self._root(c, w)
        if root is None:
            return
        w.json(
            cast(
                JsonValue,
                github_comments(kind, int(raw), dry_run=self.config.dry_run, cwd=root),
            )
        )

    async def github_pr_changes(self, c: Context, w: Writer) -> None:
        from app.integrations.github_read import PrNotFound, github_pr_changes

        raw = c.match.params.get("number", "")
        refresh = c.req.query.get("refresh")
        if not raw.isdigit() or int(raw) <= 0 or (refresh is not None and refresh != "1"):
            w.json({"error": "invalid pull request number or refresh flag"}, status=400)
            return
        root = self._root(c, w)
        if root is None:
            return
        try:
            w.json(cast(JsonValue, github_pr_changes(root, int(raw), dry_run=self.config.dry_run)))
        except PrNotFound as exc:
            w.json({"error": str(exc)}, status=404)

    async def repo(self, c: Context, w: Writer) -> None:
        from app.engine.repo_read import snapshot
        from app.store.db import list_runs

        root = self._root(c, w)
        if root is None:
            return
        project = self._project(c, w)
        hide = set()
        if project is not None:
            hide = {
                run.branch
                for run in list_runs(self.db, project.id, None)
                if run.branch and not run.in_place
            }
        w.json(cast(JsonValue, snapshot(root, hide)))

    async def repo_diff(self, c: Context, w: Writer) -> None:
        from app.engine.repo_read import diff_text

        root = self._root(c, w)
        if root is None:
            return
        text = diff_text(root)
        w.text(text if text is not None else "not a git repository")

    async def repo_changes(self, c: Context, w: Writer) -> None:
        from app.engine.repo_read import changes

        root = self._root(c, w)
        if root is None:
            return
        result = changes(root)
        if isinstance(result, str):
            w.json({"error": result}, status=409)
            return
        w.json(cast(JsonValue, result))

    async def repo_tree(self, c: Context, w: Writer) -> None:
        from app.engine.repo_read import tree

        root = self._root(c, w)
        if root is None:
            return
        result = tree(root)
        if isinstance(result, str):
            w.json({"error": result}, status=409)
            return
        w.json(cast(JsonValue, result))

    async def repo_file(self, c: Context, w: Writer) -> None:
        from app.engine.repo_read import file_text

        rel = c.req.query.get("path", "")
        raw = c.req.query.get("raw")
        if not rel or (raw is not None and raw not in ("0", "1")):
            w.json({"error": "invalid file query"}, status=400)
            return
        root = self._root(c, w)
        if root is None:
            return
        text, reason = file_text(root, rel)
        if text is None:
            w.json({"error": reason}, status=404)
            return
        if raw == "1":
            w.text(text)
            return
        w.json({"path": rel, "content": text})

    async def repo_commit(self, c: Context, w: Writer) -> None:
        from app.engine.repo_read import commit_structured, commit_text

        sha = c.match.params.get("sha", "")
        structured = c.req.query.get("structured")
        wants_json = structured == "1" or (
            structured is None and "application/json" in c.req.headers.get("accept", "")
        )
        root = self._root(c, w)
        if root is None:
            return
        if wants_json:
            result = commit_structured(root, sha)
            if isinstance(result, str):
                w.json({"error": result}, status=409)
                return
            w.json(cast(JsonValue, result))
            return
        w.text(commit_text(root, sha))

    async def repo_branch(self, c: Context, w: Writer) -> None:
        from app.engine.repo_read import switch_branch

        body = await _json(c, w)
        if body is None:
            return
        name = body.get("name")
        start = body.get("from", "")
        if not isinstance(name, str) or not isinstance(start, str):
            w.json({"error": "invalid branch"}, status=400)
            return
        root = self._root(c, w)
        if root is None:
            return
        result = switch_branch(root, name, start)
        if isinstance(result, str):
            w.json({"error": result}, status=409)
            return
        w.json(cast(JsonValue, result))

    async def repo_sync(self, c: Context, w: Writer) -> None:
        await self._repo_action(c, w, "status")

    async def repo_fetch(self, c: Context, w: Writer) -> None:
        await self._repo_action(c, w, "fetch")

    async def repo_pull(self, c: Context, w: Writer) -> None:
        await self._repo_action(c, w, "pull")

    async def repo_push(self, c: Context, w: Writer) -> None:
        await self._repo_action(c, w, "push")

    async def repo_sync_now(self, c: Context, w: Writer) -> None:
        await self._repo_action(c, w, "sync")

    async def _repo_action(self, c: Context, w: Writer, action: str) -> None:
        from app.engine.repo_read import (
            fetch_remote,
            pull_remote,
            push_remote,
            sync_remote,
            sync_status,
        )

        root = self._root(c, w)
        if root is None:
            return
        if action == "status":
            result = sync_status(root)
        elif action == "fetch":
            result = fetch_remote(root)
        elif action == "pull":
            result = pull_remote(root)
        elif action == "push":
            result = push_remote(root)
        else:
            result = sync_remote(root)
        if isinstance(result, str):
            w.json({"error": result}, status=409)
            return
        w.json(cast(JsonValue, result))

    async def tracker_connection(self, c: Context, w: Writer) -> None:
        from app.integrations.tracker import connection_view

        root = self._root(c, w)
        if root is None:
            return
        w.json(cast(JsonValue, connection_view(self.config, root)))

    async def tracker_save_connection(self, c: Context, w: Writer) -> None:
        from app.integrations.tracker import _credential_issue, save_connection

        body = await _json(c, w)
        if body is None:
            return
        if _credential_issue(body):
            w.json({"error": "Invalid tracker credentials. Check the required fields."}, status=400)
            return
        root = self._root(c, w)
        if root is None:
            return
        saved = save_connection(self.config, root, body)
        if saved is None:
            w.json(
                {"error": "Could not save project credentials. Demo mode cannot save credentials."},
                status=409,
            )
            return
        w.json(cast(JsonValue, saved))

    async def tracker_delete_connection(self, c: Context, w: Writer) -> None:
        from app.integrations.tracker import delete_connection

        root = self._root(c, w)
        if root is None:
            return
        if not delete_connection(self.config, root):
            w.json({"error": "Could not remove project credentials."}, status=409)
            return
        w.json({"cleared": True})

    async def tracker_association(self, c: Context, w: Writer) -> None:
        from app.integrations.tracker import read_association

        root = self._root(c, w)
        if root is None:
            return
        w.json({"association": read_association(root)})

    async def tracker_save_association(self, c: Context, w: Writer) -> None:
        from app.integrations.tracker import resolve_association, write_association

        body = await _json(c, w)
        if body is None:
            return
        root = self._root(c, w)
        if root is None:
            return
        result = resolve_association(self.config, root, body)
        if not result.get("available"):
            status = 404 if result.get("code") == "not_found" else 409
            w.json({"error": result.get("reason", "tracker is not configured")}, status=status)
            return
        association = result["association"]
        if not isinstance(association, dict) or not write_association(root, association):
            w.json({"error": "Could not save the tracker connection."}, status=409)
            return
        w.json(cast(JsonValue, {"association": association}))

    async def tracker_clear_association(self, c: Context, w: Writer) -> None:
        from app.integrations.tracker import clear_association

        root = self._root(c, w)
        if root is None:
            return
        if not clear_association(root):
            w.json({"error": "Could not disconnect the tracker."}, status=409)
            return
        w.json({"cleared": True})

    async def tracker_candidates(self, c: Context, w: Writer) -> None:
        from app.integrations.tracker import candidates

        root = self._root(c, w)
        if root is None:
            return
        w.json(cast(JsonValue, candidates(self.config, root)))

    async def tracker_list(self, c: Context, w: Writer) -> None:
        from app.integrations.tracker import list_issues

        root = self._root(c, w)
        if root is None:
            return
        state = c.req.query.get("state", "active")
        w.json(cast(JsonValue, list_issues(self.config, root, state=state)))

    async def tracker_search(self, c: Context, w: Writer) -> None:
        from app.integrations.tracker import list_issues

        query = c.req.query.get("q", "")
        if not query.strip() or len(query.strip()) > 256:
            w.json({"error": "invalid search query"}, status=400)
            return
        root = self._root(c, w)
        if root is None:
            return
        w.json(
            cast(
                JsonValue,
                list_issues(self.config, root, query=query, state=c.req.query.get("state", "all")),
            )
        )

    async def tracker_item(self, c: Context, w: Writer) -> None:
        from app.integrations.tracker import list_issues

        item_id = c.match.params.get("item_id", "")
        if item_id in ("association", "candidates", "search", "connection", "watch"):
            w.json({"error": "not found"}, status=404)
            return
        root = self._root(c, w)
        if root is None:
            return
        listed = list_issues(self.config, root, state="all")
        if not listed.get("available"):
            w.json(cast(JsonValue, listed))
            return
        items = listed.get("items")
        rows = items if isinstance(items, list) else []
        for item in rows:
            if isinstance(item, dict) and item.get("id") == item_id:
                w.json(cast(JsonValue, {"available": True, "item": item}))
                return
        w.json({"available": False, "code": "not_found", "reason": "not found"}, status=404)

    async def tracker_watch(self, c: Context, w: Writer) -> None:
        from app.integrations.tracker import list_issues, read_association

        body = await _json(c, w)
        if body is None:
            return
        root = self._root(c, w)
        if root is None:
            return
        stored = read_association(root)
        sent = body.get("association")
        if stored is None or sent != stored:
            w.json({"error": "Tracker connection changed. Reload this view."}, status=409)
            return
        result = list_issues(self.config, root, query=str(body.get("query", "")))
        opened = self.watches.open(str(root), body, result)
        if isinstance(opened, str):
            w.json({"error": opened}, status=400)
            return
        w.json(cast(JsonValue, opened))

    async def tracker_watch_read(self, c: Context, w: Writer) -> None:
        root = self._root(c, w)
        if root is None:
            return
        snap = self.watches.snapshot(str(root), c.match.params.get("watch_id", ""))
        if snap is None:
            w.json({"error": "Tracker observation expired. Reopen the view."}, status=404)
            return
        w.json(cast(JsonValue, snap))

    async def tracker_watch_refresh(self, c: Context, w: Writer) -> None:
        from app.integrations.tracker import list_issues

        root = self._root(c, w)
        if root is None:
            return
        watch_id = c.match.params.get("watch_id", "")
        current = self.watches.snapshot(str(root), watch_id)
        if current is None:
            w.json({"error": "Tracker observation expired. Reopen the view."}, status=404)
            return
        result = list_issues(self.config, root)
        snap = self.watches.refresh(str(root), watch_id, result)
        if snap is None:
            w.json({"error": "Tracker observation expired. Reopen the view."}, status=404)
            return
        w.json(cast(JsonValue, snap))

    async def lifecycle_start(self, c: Context, w: Writer) -> None:
        root = self._root(c, w)
        if root is None:
            return
        body = await _json(c, w)
        if body is None:
            return
        await self._lifecycle(w, self.lifecycle.start(root, body), 202)

    async def lifecycle_get(self, c: Context, w: Writer) -> None:
        root = self._root(c, w)
        if root is None:
            return
        operation_id = c.match.params.get("operation_id", "")
        await self._lifecycle(w, self.lifecycle.get(root, operation_id))

    async def lifecycle_act(self, c: Context, w: Writer) -> None:
        root = self._root(c, w)
        if root is None:
            return
        body = await _json(c, w)
        if body is None:
            return
        operation_id = c.match.params.get("operation_id", "")
        await self._lifecycle(w, self.lifecycle.act(root, operation_id, body), 202)

    async def lifecycle_output(self, c: Context, w: Writer) -> None:
        root = self._root(c, w)
        if root is None:
            return
        operation_id = c.match.params.get("operation_id", "")
        try:
            after = int(c.req.query.get("afterSeq", "0"))
            limit = int(c.req.query.get("limit", "100"))
        except ValueError:
            w.json({"error": "limit must be 1–200"}, status=400)
            return
        try:
            payload = self.lifecycle.output(root, operation_id, after, limit)
        except LifecycleFailure as exc:
            w.json({"error": str(exc)}, status=exc.status)
            return
        w.json(cast(JsonValue, payload))

    async def lifecycle_preview(self, c: Context, w: Writer) -> None:
        body = await _json(c, w)
        if body is None:
            return
        try:
            payload = self.lifecycle.preview(body)
        except LifecycleFailure as exc:
            w.json({"error": str(exc)}, status=exc.status)
            return
        w.json(cast(JsonValue, payload))

    async def _lifecycle(
        self, w: Writer, work: Awaitable[dict[str, object]], status: int = 200
    ) -> None:
        try:
            view = await work
        except LifecycleFailure as exc:
            w.json({"error": str(exc)}, status=exc.status)
            return
        w.json({"operation": cast(JsonValue, view)}, status=status)

    def _root(self, c: Context, w: Writer) -> Path | None:
        project = self._project(c, w)
        if project is None:
            return None
        return Path(project.root)

    def _project(self, c: Context, w: Writer):
        from app.store.db import get_project as load

        raw = c.match.params.get("project_id", "")
        project_id = self.engine.boot_project_id if raw in ("", "default") else raw
        project = load(self.db, project_id)
        if project is None:
            w.json({"error": "not found"}, status=404)
            return None
        return project

    def _run(self, c: Context, w: Writer):
        run = get_run(self.db, c.match.params.get("run_id", ""))
        if run is None:
            w.json({"error": "not found"}, status=404)
            return None
        project_id = c.match.params.get("project_id", "")
        if project_id == "default":
            project_id = self.engine.boot_project_id
        if project_id and project_id != run.project_id:
            w.json({"error": "not found"}, status=404)
            return None
        return run


def _object_file(path: Path) -> dict[str, object]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return {}
    if isinstance(loaded, dict):
        return loaded
    return {}


def _pr_number(raw: str) -> int | None:
    if not raw.isdigit():
        return None
    number = int(raw)
    return number if number > 0 else None


def _ui_path(root: Path) -> Path:
    return root / ".ai" / "cezar" / "ui-state.json"


def _event_visible(event: str, data: object, project_id: str | None) -> bool:
    if project_id is None:
        return True
    if event == "run":
        return getattr(data, "project_id", None) == project_id
    if isinstance(data, dict):
        owner = data.get("projectId")
        return owner in (None, project_id)
    return False


def _event_body(
    event: str,
    data: object,
    project_id: str | None,
    public_run: object,
) -> dict[str, JsonValue]:
    if event == "run":
        render = cast(Any, public_run)
        body = dict(render(data, full=False))
        if project_id is None:
            body["projectId"] = cast(Any, data).project_id
        return cast(dict[str, JsonValue], body)
    if isinstance(data, dict):
        if project_id is None:
            return cast(dict[str, JsonValue], data)
        return cast(
            dict[str, JsonValue],
            {key: value for key, value in data.items() if key != "projectId"},
        )
    return {}


def _page_args(c: Context) -> tuple[int, str | None]:
    """`{limit, cursor}` webhook page params: limit is 1-100, default 100."""
    try:
        limit = int(c.req.query.get("limit", "100"))
    except ValueError:
        limit = 100
    limit = min(100, max(1, limit))
    cursor = c.req.query.get("cursor") or None
    if cursor is not None and len(cursor) > 4096:
        cursor = None
    return limit, cursor


def _write_frame(w: Writer, event: str, data: dict[str, JsonValue]) -> None:
    raw = json_dumps(cast(JsonValue, data))
    w.write(f"event: {event}\ndata: {raw}\n\n".encode())


def _frame(w: Writer, text: str) -> None:
    w.write(f"event: output\ndata: {json_dumps(text)}\n\n".encode())


async def _raw(c: Context, w: Writer) -> bytes | None:
    try:
        body = await c.req.body()
    except RequestBodyError:
        w.json({"error": "invalid json"}, status=400)
        return None
    if isinstance(body, str):
        return body.encode()
    if isinstance(body, bytes):
        return body
    w.json({"error": "invalid json"}, status=400)
    return None


async def _json(c: Context, w: Writer) -> dict[str, object] | None:
    raw = await _raw(c, w)
    if raw is None:
        return None
    try:
        loaded = json.loads(raw)
    except json.JSONDecodeError:
        w.json({"error": "invalid json"}, status=400)
        return None
    if not isinstance(loaded, dict):
        w.json({"error": "invalid json"}, status=400)
        return None
    return loaded
