"""Event automations: GitHub and tracker polls, manual checks, and retry (TypeScript scheduler).

`schedule` rows fire on `next_at` in `Engine._launch_due`. A `github` or `tracker` row is polled on
the same interval, off when dry-run is on or `CEZ_AUTOMATIONS=0`. A poll is baselined first: the
first one after an enable records "now" and launches nothing, so turning an automation on never
starts a backlog. After that each poll asks GitHub (or the tracker) for items since the cursor,
drops the ones already seen (`automation_seen`), starts one run per new match, and records a log
entry. A manual check shares the code: `preview` reads the lookback window and launches nothing,
`execute` launches the new matches.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import replace
from pathlib import Path
from typing import TYPE_CHECKING

from app.clock import after, now, parse_stamp, stamp
from app.config import automations_enabled
from app.engine.git_remotes import enterprise_host
from app.engine.model import Automation, Run
from app.integrations import github_poll, tracker_poll
from app.integrations.github_poll import Candidate, GhError, gh_api
from app.integrations.github_read import repo_handle
from app.integrations.pr_head import resolve_pr_head
from app.store import polling
from app.store.db import get_automation, get_project, list_enabled_automations, save_automation

if TYPE_CHECKING:
    from app.engine.engine import Engine

POLL_KINDS = ("github", "tracker")
# A launch that ended without a run on purpose (a closed PR, an unadmitted fork). Not retried.
SKIPPED = "skipped: "


def _launch_status(run_id: str | None, error: str) -> str:
    if run_id:
        return "launched"
    return "skipped" if error.startswith(SKIPPED) else "launch-error"


def automation_env(run: Run) -> dict[str, str]:
    """`CEZ_GITHUB_*` and `CEZ_PR_*` for the agent and its checks (TypeScript `run.ts`)."""
    info = run.automation
    env: dict[str, str] = {}
    repo, number = info.get("repo"), info.get("number")
    if isinstance(repo, str) and repo and isinstance(number, int):
        env["CEZ_GITHUB_REPO"] = repo
        env["CEZ_GITHUB_NUMBER"] = str(number)
        env["CEZ_GITHUB_EVENT"] = str(info.get("event", ""))
    head = info.get("prHead")
    if isinstance(head, dict):
        for name, key in (
            ("CEZ_PR_HEAD_SHA", "headSha"),
            ("CEZ_PR_HEAD_REF", "headRef"),
            ("CEZ_PR_BASE_REF", "baseRef"),
        ):
            if isinstance(head.get(key), str):
                env[name] = str(head[key])
    return env


def task_text(item: Automation, values: dict[str, str]) -> str:
    """The automation's task with `{{github.number}}`-style placeholders filled in."""
    text = item.task
    used = False
    for key, value in values.items():
        token = "{{" + key + "}}"
        if token in text:
            used = True
            text = text.replace(token, value)
    if not used and values:
        facts = "\n".join(f"- {key}: {value}" for key, value in values.items())
        text = f"{text}\n\nThis run was started by an automation. The item:\n{facts}"
    return text


class AutomationPoller:
    def __init__(self, engine: Engine) -> None:
        self.engine = engine
        self._busy: set[str] = set()

    async def tick(self) -> None:
        engine = self.engine
        if engine.config.dry_run or not automations_enabled():
            return
        moment = now()
        for item in list_enabled_automations(engine.db):
            if item.kind not in POLL_KINDS or item.id in self._busy:
                continue
            due = parse_stamp(item.next_at)
            if due is None or due > moment:
                continue
            await engine.db.write(save_automation, replace(item, next_at=after(item.every_minutes)))
            self._busy.add(item.id)
            engine._schedule(self._poll(item), name=f"poll-{item.id[:8]}")

    async def _poll(self, item: Automation) -> None:
        try:
            await self.check(item, "poll", guard=False)
        except Exception as exc:
            await self._store(self._entry(item, "poll", status="error", message=str(exc)[:500]))
        finally:
            self._busy.discard(item.id)

    async def baseline(self, item: Automation) -> None:
        """Forget what was seen and start the cursor at now (enable, edit)."""
        if item.kind == "github":
            await self.engine.db.write(_reset, item.id, {"since": github_poll.zstamp(now())})
        else:
            await self.engine.db.write(_reset, item.id, None)

    async def check(self, item: Automation, mode: str, *, guard: bool = True) -> dict[str, object]:
        """One poll. `mode` is `poll` (cursor, launches), `preview` or `execute` (lookback)."""
        engine = self.engine
        if item.kind not in POLL_KINDS:
            return self._entry(
                item, mode, message="a schedule has no event filter; use run to launch it"
            )
        if engine.config.dry_run:
            entry = self._entry(item, mode, message="polling is off while CEZ_DRY_RUN=1")
            return await self._store(entry) if mode != "poll" else entry

        async def failed(message: str) -> dict[str, object]:
            return await self._store(self._entry(item, mode, status="error", message=message))

        if guard and mode == "execute" and item.id in self._busy:
            return await failed("a poll is already running")
        project = get_project(engine.db, item.project_id)
        if project is None:
            return await failed("the project is gone")
        try:
            find = self._github if item.kind == "github" else self._tracker
            found = await find(item, mode, Path(project.root))
        except Exception as exc:
            return await failed(str(exc)[:500] or "poll failed")
        if found is None:
            return self._entry(item, mode, message="baselined; the next poll looks for new items")
        rows, cursor = found
        seen = polling.seen_keys(engine.db, item.id)
        for row in rows:
            row["status"] = "seen" if row["key"] in seen else "new"
        launched = 0
        if mode != "preview":
            for row in (row for row in rows if row["status"] == "new"):
                run_id, error = await self.launch(item, row)
                row["runId"], row["error"] = run_id or "", error
                row["status"] = _launch_status(run_id, error)
                launched += 1 if run_id else 0
            await engine.db.write(
                polling.mark_seen,
                item.id,
                [str(row["key"]) for row in rows if row["status"] != "seen"],
                stamp(),
            )
            if mode == "poll" and cursor:
                await engine.db.write(polling.put_state, item.id, {"since": cursor})
        fresh = sum(1 for row in rows if row["status"] == "new")
        message = f"{len(rows)} match(es), {launched} launched"
        if mode == "preview":
            message = f"{len(rows)} match(es), {fresh} not yet seen; nothing launched"
        entry = self._entry(item, mode, message=message)
        entry.update({"matches": len(rows), "launched": launched, "candidates": rows})
        if mode == "poll" and all(row["status"] == "seen" for row in rows):
            return entry
        return await self._store(entry)

    async def _github(
        self, item: Automation, mode: str, root: Path
    ) -> tuple[list[dict[str, object]], str] | None:
        engine = self.engine
        filters = item.filters
        repo = str(filters.get("repo") or "")
        if not repo:
            repo = await asyncio.to_thread(repo_handle, root)
        if not repo:
            raise GhError("no GitHub repository found for this project (`gh repo view` said none)")
        moment = now()
        since = github_poll.lookback_start(filters, moment)
        if mode == "poll":
            state = polling.get_state(engine.db, item.id)
            if state is None or not isinstance(state.get("since"), str):
                await engine.db.write(
                    polling.put_state, item.id, {"since": github_poll.zstamp(moment)}
                )
                return None
            since = max(since, str(state["since"]))
        host = await asyncio.to_thread(enterprise_host, root, repo)
        result = await asyncio.to_thread(
            github_poll.poll,
            repo,
            item.events,
            filters,
            since=since,
            gh=lambda args: gh_api(args, host=host),
            enterprise=bool(host),
        )
        rows: list[dict[str, object]] = [
            {
                "key": cand.event_id,
                "event": cand.event,
                "label": f"{cand.repo}#{cand.number} {cand.title}",
                "url": cand.url,
                "runId": "",
                "error": "",
                "candidate": cand.to_json(),
            }
            for cand in result.candidates
        ]
        cursor = result.cursor if result.cursor > since else ""
        return rows, cursor

    async def _tracker(
        self, item: Automation, mode: str, root: Path
    ) -> tuple[list[dict[str, object]], str] | None:
        engine = self.engine
        found, reason = await asyncio.to_thread(
            tracker_poll.poll, engine.config, root, item.filters
        )
        if reason:
            raise GhError(reason)
        rows: list[dict[str, object]] = [
            {
                "key": cand.key,
                "event": "issue.status_changed",
                "label": f"{cand.id} {cand.title} [{cand.status}]",
                "url": cand.url,
                "runId": "",
                "error": "",
                "candidate": cand.to_json(),
            }
            for cand in found
        ]
        if mode == "poll" and polling.get_state(engine.db, item.id) is None:
            await engine.db.write(
                polling.mark_seen, item.id, [str(r["key"]) for r in rows], stamp()
            )
            await engine.db.write(polling.put_state, item.id, {"since": stamp()})
            return None
        return rows, ""

    async def launch(self, item: Automation, row: dict[str, object]) -> tuple[str | None, str]:
        """Start one run for a matched item. Returns the run id or the reason it did not start."""
        engine = self.engine
        project = get_project(engine.db, item.project_id)
        if project is None:
            return None, "the project is gone"
        root = Path(project.root)
        fork_sha = ""
        note = ""
        values: dict[str, str] = {}
        info: dict[str, object] = {"automationId": item.id, "kind": item.kind}
        raw = row.get("candidate")
        if item.kind == "github":
            cand = Candidate.from_json(raw)
            if cand is None:
                return None, "the stored candidate cannot be read"
            values = {
                "github.repo": cand.repo,
                "github.number": str(cand.number),
                "github.title": cand.title,
                "github.url": cand.url,
                "github.event": cand.event,
                "github.author": cand.author,
            }
            info.update(
                {
                    "repo": cand.repo,
                    "number": cand.number,
                    "event": cand.event,
                    "githubUrl": cand.url,
                }
            )
            if cand.event.startswith("pull_request."):
                host = await asyncio.to_thread(enterprise_host, root, cand.repo)

                def gh(args: list[str], host: str = host) -> str:
                    return gh_api(args, host=host)

                if item.filters.get("checkout") == "pr-head":
                    resolution = await asyncio.to_thread(
                        resolve_pr_head,
                        root,
                        cand.repo,
                        cand.number,
                        allow_fork_heads=item.filters.get("allowForkHeads") is True,
                        dry_run=engine.config.dry_run,
                        gh=gh,
                    )
                    if resolution.kind == "skipped":
                        return None, f"{SKIPPED}{resolution.reason}"
                    if resolution.kind == "failed":
                        return None, resolution.reason
                    fork_sha = str(resolution.head["headSha"])
                    note = resolution.note
                    info["prHead"] = resolution.head
                    if resolution.head.get("untrusted"):
                        info["untrustedHead"] = True
                else:
                    head = await asyncio.to_thread(github_poll.pr_head, gh, cand.repo, cand.number)
                    if head:
                        info["prHead"] = head
        else:
            tracked = tracker_poll.TrackerCandidate.from_json(raw)
            if tracked is None:
                return None, "the stored candidate cannot be read"
            values = {
                "tracker.id": tracked.id,
                "tracker.title": tracked.title,
                "tracker.url": tracked.url,
                "tracker.status": tracked.status,
            }
            info.update({"event": "issue.status_changed", "trackerUrl": tracked.url})
        run, reason = engine.plan_run(
            project=project,
            task=task_text(item, values),
            workflow_name=item.workflow,
            runner=item.runner or "claude",
            autonomous=True,
            # A pull-request head is verified in its own worktree, forked from the fetched sha.
            base_branch=fork_sha,
            in_place=False if fork_sha else None,
        )
        if run is None:
            return None, reason or "could not plan a run"
        run.automation = info
        await engine.enqueue(run)
        if note:
            await engine._note(run.id, "note", note)
        stored = get_automation(engine.db, item.id)
        if stored is not None:
            await engine.db.write(save_automation, replace(stored, last_run_id=run.id))
        return run.id, ""

    async def retry(
        self, automation_id: str, entry_id: str
    ) -> tuple[dict[str, object] | None, str | None, int]:
        """Relaunch the candidates of a log entry that failed to start: (entry, reason, status)."""
        engine = self.engine
        entry = polling.get_log(engine.db, entry_id)
        if entry is None or entry.get("automationId") != automation_id:
            return None, "not found", 404
        item = get_automation(engine.db, automation_id)
        if item is None:
            return None, "automation not found", 404
        rows = entry.get("candidates")
        failed = (
            [r for r in rows if isinstance(r, dict) and r.get("status") == "launch-error"]
            if isinstance(rows, list)
            else []
        )
        if not failed:
            return None, "nothing in this entry can be retried", 409
        launched = 0
        for row in failed:
            run_id, error = await self.launch(item, row)
            row["runId"], row["error"] = run_id or "", error
            row["status"] = _launch_status(run_id, error)
            launched += 1 if run_id else 0
        entry["launched"] = int(str(entry.get("launched") or 0)) + launched
        entry["retriedAt"] = stamp()
        await engine.db.write(polling.append_log, entry)
        engine.publish()
        return entry, None, 200

    def _entry(
        self, item: Automation, mode: str, *, status: str = "complete", message: str = ""
    ) -> dict[str, object]:
        return {
            "id": uuid.uuid4().hex,
            "automationId": item.id,
            "at": stamp(),
            "mode": mode,
            "status": status,
            "matches": 0,
            "launched": 0,
            "message": message,
            "candidates": [],
        }

    async def _store(self, entry: dict[str, object]) -> dict[str, object]:
        await self.engine.db.write(polling.append_log, entry)
        self.engine.publish()
        return entry

    async def record_run(self, item: Automation, run_id: str, mode: str) -> None:
        """Log a schedule launch or a run-now so the execution log shows every run."""
        entry = self._entry(item, mode, message="started a run")
        entry.update(
            {
                "matches": 1,
                "launched": 1,
                "runId": run_id,
                "candidates": [
                    {
                        "key": run_id,
                        "event": mode,
                        "label": item.name,
                        "url": "",
                        "runId": run_id,
                        "error": "",
                        "status": "launched",
                    }
                ],
            }
        )
        await self._store(entry)


def _reset(tx, automation_id: str, state: dict[str, object] | None) -> None:  # type: ignore[no-untyped-def]
    polling.reset_state(tx, automation_id)
    polling.clear_seen(tx, automation_id)
    if state is not None:
        polling.put_state(tx, automation_id, state)
