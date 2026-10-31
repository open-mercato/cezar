"""Documents stored in SQLite and the workflow values the executor walks.

Field names stay snake_case in Python. The small JSON API maps the ones it exposes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import cast

from app.config import RUNNERS

STATUSES: tuple[str, ...] = (
    "queued",
    "running",
    "waiting",
    "review",
    "done",
    "failed",
    "cancelled",
)
TERMINAL: frozenset[str] = frozenset({"done", "review", "failed", "cancelled"})


def _text(value: object, default: str = "") -> str:
    return value if isinstance(value, str) else default


def _int(value: object, default: int = 0) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else default


def _float(value: object, default: float = 0.0) -> float:
    if isinstance(value, bool) or value is None:
        return default
    if isinstance(value, int | float):
        return float(value)
    return default


def _bool(value: object, default: bool = False) -> bool:
    return value if isinstance(value, bool) else default


def _dict(value: object) -> dict[str, object]:
    if isinstance(value, dict):
        return cast(dict[str, object], value)
    return {}


def _strings(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def _string_tuple(value: object) -> tuple[str, ...]:
    return tuple(_strings(value))


def _dicts(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list):
        return []
    return [cast(dict[str, object], item) for item in value if isinstance(item, dict)]


@dataclass(frozen=True, slots=True)
class Step:
    id: str
    name: str = ""
    prompt: str = ""
    skill: str = ""
    command: str = ""
    runner: str = ""
    model: str = ""
    retry: str = ""
    retry_max: int = 0
    retry_on: tuple[int, ...] = ()
    has_secrets: bool = False
    # None means every `checks` secret. A tuple is the step's `secrets:` list, (name, alias).
    secret_bindings: tuple[tuple[str, str], ...] | None = None
    allowed_tools: tuple[str, ...] = ()
    bash_allowlist: tuple[str, ...] = ()

    @property
    def kind(self) -> str:
        return "check" if self.command else "agent"

    def to_json(self) -> dict[str, object]:
        body: dict[str, object] = {"id": self.id, "name": self.name}
        if self.prompt:
            body["prompt"] = self.prompt
        if self.skill:
            body["skill"] = self.skill
        if self.command:
            body["command"] = self.command
        if self.runner:
            body["runner"] = self.runner
        if self.model:
            body["model"] = self.model
        if self.retry:
            body["onFail"] = {
                "retry": self.retry,
                "max": self.retry_max,
                **({"retryOn": list(self.retry_on)} if self.retry_on else {}),
            }
        if self.secret_bindings is not None:
            body["secrets"] = [
                name if alias == name else {"name": name, "as": alias}
                for name, alias in self.secret_bindings
            ]
        elif self.has_secrets:
            body["secrets"] = True
        if self.allowed_tools:
            body["allowedTools"] = list(self.allowed_tools)
        if self.bash_allowlist:
            body["bashAllowlist"] = list(self.bash_allowlist)
        return body

    @classmethod
    def from_json(cls, raw: object) -> Step:
        data = _dict(raw)
        on_fail = _dict(data.get("onFail"))
        retry_on = data_retry_on(on_fail.get("retryOn"))
        tools = _str_tuple(data.get("allowedTools"))
        allow = _str_tuple(data.get("bashAllowlist"))
        return cls(
            id=_text(data.get("id")),
            name=_text(data.get("name")),
            prompt=_text(data.get("prompt")),
            skill=_text(data.get("skill")),
            command=_text(data.get("command")),
            runner=_text(data.get("runner")),
            model=_text(data.get("model")),
            retry=_text(on_fail.get("retry")),
            retry_max=_int(on_fail.get("max")),
            retry_on=retry_on,
            has_secrets=isinstance(data.get("secrets"), list) or data.get("secrets") is True,
            secret_bindings=_secret_bindings(data.get("secrets")),
            allowed_tools=tools,
            bash_allowlist=allow,
        )


def data_retry_on(value: object) -> tuple[int, ...]:
    if not isinstance(value, list):
        return ()
    nums: list[int] = []
    for item in value:
        if isinstance(item, int) and not isinstance(item, bool):
            nums.append(item)
    return tuple(nums)


def _secret_bindings(value: object) -> tuple[tuple[str, str], ...] | None:
    if not isinstance(value, list):
        return None
    bindings: list[tuple[str, str]] = []
    for item in value:
        if isinstance(item, str):
            bindings.append((item, item))
        elif isinstance(item, dict) and isinstance(item.get("name"), str):
            alias = item.get("as")
            bindings.append((item["name"], alias if isinstance(alias, str) else item["name"]))
    return tuple(bindings)


def _str_tuple(value: object) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(item for item in value if isinstance(item, str))


@dataclass(frozen=True, slots=True)
class Workflow:
    name: str
    description: str
    steps: tuple[Step, ...]
    source: str
    path: str = ""
    graph: dict[str, object] | None = None

    def to_json(self) -> dict[str, object]:
        body: dict[str, object] = {
            "name": self.name,
            "source": self.source,
            "steps": [step.to_json() for step in self.steps],
        }
        if self.description:
            body["description"] = self.description
        if self.path:
            body["path"] = self.path
        if self.graph is not None:
            body["graph"] = self.graph
            body["version"] = 2
        return body

    @classmethod
    def from_json(cls, raw: object) -> Workflow:
        data = _dict(raw)
        steps_raw = data.get("steps")
        steps = (
            tuple(Step.from_json(item) for item in steps_raw) if isinstance(steps_raw, list) else ()
        )
        graph = data.get("graph")
        return cls(
            name=_text(data.get("name")),
            description=_text(data.get("description")),
            steps=steps,
            source=_text(data.get("source"), "built-in"),
            path=_text(data.get("path")),
            graph=graph if isinstance(graph, dict) else None,
        )


@dataclass(slots=True)
class Run:
    id: str
    project_id: str
    title: str
    task: str
    workflow: str
    status: str
    runner: str
    created_at: str
    workflow_def: dict[str, object]
    branch: str = ""
    worktree_path: str = ""
    base_branch: str = ""
    base_sha: str = ""
    started_at: str = ""
    finished_at: str = ""
    error: str = ""
    tokens_used: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    parent_id: str = ""
    root_id: str = ""
    budget_usd: float | None = None
    autonomous: bool = False
    model: str = ""
    step_index: int = 0
    mode: str = "workflow"
    continuation: str = ""
    ask: str = ""
    pending_note: str = ""
    check_failure: str = ""
    retries: dict[str, int] = field(default_factory=dict)
    pending_reports: list[dict[str, object]] = field(default_factory=list)
    reported: bool = False
    in_place: bool = False
    kind: str = "implement"
    archived: bool = False
    archived_at: str = ""
    pinned: bool = False
    pinned_at: str = ""
    queued_messages: list[dict[str, object]] = field(default_factory=list)
    group_id: str = ""
    variant: str = ""
    codex_thread: str = ""
    # The runner that opened an agent session for this run. Claude and Pi name the session after
    # the run id; Codex and OpenCode keep theirs in `codex_thread`. Empty: no session yet.
    session_runner: str = ""
    images: list[dict[str, object]] = field(default_factory=list)
    seen_at: str = ""
    auto_resume_at: str = ""
    auto_resume_attempts: int = 0
    monitoring_wakes: int = 0
    monitoring_wake_at: str = ""
    awaiting_answer_since: str = ""
    pull_request_url: str = ""
    worktree_reclaimed_at: str = ""
    notes: str = ""
    attachment_paths: list[str] = field(default_factory=list)
    dispatch_report: dict[str, object] = field(default_factory=dict)
    graph_park: dict[str, object] = field(default_factory=dict)
    account_id: str = ""
    landing: dict[str, object] = field(default_factory=dict)
    # The automation that started this run and the item it matched (empty for a person).
    automation: dict[str, object] = field(default_factory=dict)

    def to_json(self) -> dict[str, object]:
        body: dict[str, object] = {
            "id": self.id,
            "project_id": self.project_id,
            "title": self.title,
            "task": self.task,
            "workflow": self.workflow,
            "status": self.status,
            "runner": self.runner,
            "created_at": self.created_at,
            "workflow_def": self.workflow_def,
            "branch": self.branch,
            "worktree_path": self.worktree_path,
            "base_branch": self.base_branch,
            "base_sha": self.base_sha,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "error": self.error,
            "tokens_used": self.tokens_used,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_usd": self.cost_usd,
            "parent_id": self.parent_id,
            "root_id": self.root_id,
            "budget_usd": self.budget_usd,
            "autonomous": self.autonomous,
            "model": self.model,
            "step_index": self.step_index,
            "mode": self.mode,
            "continuation": self.continuation,
            "ask": self.ask,
            "pending_note": self.pending_note,
            "check_failure": self.check_failure,
            "retries": self.retries,
            "pending_reports": self.pending_reports,
            "reported": self.reported,
            "in_place": self.in_place,
            "kind": self.kind,
            "archived": self.archived,
            "archived_at": self.archived_at,
            "pinned": self.pinned,
            "pinned_at": self.pinned_at,
            "queued_messages": self.queued_messages,
            "group_id": self.group_id,
            "variant": self.variant,
            "codex_thread": self.codex_thread,
            "session_runner": self.session_runner,
            "images": self.images,
            "seen_at": self.seen_at,
            "auto_resume_at": self.auto_resume_at,
            "auto_resume_attempts": self.auto_resume_attempts,
            "monitoring_wakes": self.monitoring_wakes,
            "monitoring_wake_at": self.monitoring_wake_at,
            "awaiting_answer_since": self.awaiting_answer_since,
            "pull_request_url": self.pull_request_url,
            "worktree_reclaimed_at": self.worktree_reclaimed_at,
            "notes": self.notes,
            "attachment_paths": self.attachment_paths,
            "account_id": self.account_id,
        }
        if self.dispatch_report:
            body["dispatch_report"] = self.dispatch_report
        if self.graph_park:
            body["graph_park"] = self.graph_park
        if self.landing:
            body["landing"] = self.landing
        if self.automation:
            body["automation"] = self.automation
        return body

    @classmethod
    def from_json(cls, raw: object) -> Run:
        data = _dict(raw)
        retries_raw = _dict(data.get("retries"))
        retries = {
            key: value
            for key, value in retries_raw.items()
            if isinstance(value, int) and not isinstance(value, bool)
        }
        budget = data.get("budget_usd")
        budget_usd = None if budget is None else _float(budget)
        if budget is None:
            budget_usd = None
        return cls(
            id=_text(data.get("id")),
            project_id=_text(data.get("project_id")),
            title=_text(data.get("title")),
            task=_text(data.get("task")),
            workflow=_text(data.get("workflow")),
            status=_text(data.get("status"), "queued"),
            runner=_text(data.get("runner"), "claude"),
            created_at=_text(data.get("created_at")),
            workflow_def=_dict(data.get("workflow_def")),
            branch=_text(data.get("branch")),
            worktree_path=_text(data.get("worktree_path")),
            base_branch=_text(data.get("base_branch")),
            base_sha=_text(data.get("base_sha")),
            started_at=_text(data.get("started_at")),
            finished_at=_text(data.get("finished_at")),
            error=_text(data.get("error")),
            tokens_used=_int(data.get("tokens_used")),
            input_tokens=_int(data.get("input_tokens")),
            output_tokens=_int(data.get("output_tokens")),
            cost_usd=_float(data.get("cost_usd")),
            parent_id=_text(data.get("parent_id")),
            root_id=_text(data.get("root_id")),
            budget_usd=budget_usd,
            autonomous=_bool(data.get("autonomous")),
            model=_text(data.get("model")),
            step_index=_int(data.get("step_index")),
            mode=_text(data.get("mode"), "workflow"),
            continuation=_text(data.get("continuation")),
            ask=_text(data.get("ask")),
            pending_note=_text(data.get("pending_note")),
            check_failure=_text(data.get("check_failure")),
            retries=retries,
            pending_reports=_dicts(data.get("pending_reports")),
            reported=_bool(data.get("reported")),
            in_place=_bool(data.get("in_place")),
            kind=_text(data.get("kind"), "implement"),
            archived=_bool(data.get("archived")),
            archived_at=_text(data.get("archived_at")),
            pinned=_bool(data.get("pinned")),
            pinned_at=_text(data.get("pinned_at")),
            queued_messages=_dicts(data.get("queued_messages")),
            group_id=_text(data.get("group_id")),
            variant=_text(data.get("variant")),
            codex_thread=_text(data.get("codex_thread")),
            session_runner=_text(data.get("session_runner")),
            images=_dicts(data.get("images")),
            seen_at=_text(data.get("seen_at")),
            auto_resume_at=_text(data.get("auto_resume_at")),
            auto_resume_attempts=_int(data.get("auto_resume_attempts")),
            monitoring_wakes=_int(data.get("monitoring_wakes")),
            monitoring_wake_at=_text(data.get("monitoring_wake_at")),
            awaiting_answer_since=_text(data.get("awaiting_answer_since")),
            pull_request_url=_text(data.get("pull_request_url")),
            worktree_reclaimed_at=_text(data.get("worktree_reclaimed_at")),
            notes=_text(data.get("notes")),
            attachment_paths=_strings(data.get("attachment_paths")),
            dispatch_report=_dict(data.get("dispatch_report")),
            graph_park=_dict(data.get("graph_park")),
            account_id=_text(data.get("account_id")),
            landing=_dict(data.get("landing")),
            automation=_dict(data.get("automation")),
        )

    def definition(self) -> Workflow:
        return Workflow.from_json(self.workflow_def)


@dataclass(frozen=True, slots=True)
class Event:
    id: int
    run_id: str
    seq: int
    type: str
    text: str
    step_id: str
    at: str


@dataclass(frozen=True, slots=True)
class Project:
    id: str
    name: str
    root: str
    base_branch: str
    created_at: str
    tags: tuple[str, ...] = ()

    def to_json(self) -> dict[str, object]:
        return {
            "id": self.id,
            "name": self.name,
            "root": self.root,
            "base_branch": self.base_branch,
            "created_at": self.created_at,
            "tags": list(self.tags),
        }

    @classmethod
    def from_json(cls, raw: object) -> Project:
        data = _dict(raw)
        return cls(
            id=_text(data.get("id")),
            name=_text(data.get("name")),
            root=_text(data.get("root")),
            base_branch=_text(data.get("base_branch"), "main"),
            created_at=_text(data.get("created_at")),
            tags=_string_tuple(data.get("tags")),
        )


@dataclass(frozen=True, slots=True)
class Settings:
    max_parallel: int = 2
    default_runner: str = "claude"
    theme: str = "dark"
    accent: str = "lime"

    def to_json(self) -> dict[str, object]:
        return {
            "max_parallel": self.max_parallel,
            "default_runner": self.default_runner,
            "theme": self.theme,
            "accent": self.accent,
        }

    @classmethod
    def from_json(cls, raw: object) -> Settings:
        data = _dict(raw)
        parallel = _int(data.get("max_parallel"), 2)
        if not 1 <= parallel <= 16:
            parallel = 2
        runner = _text(data.get("default_runner"), "claude")
        if runner not in RUNNERS:
            runner = "claude"
        theme = _text(data.get("theme"), "dark")
        if theme not in ("dark", "light"):
            theme = "dark"
        accent = _text(data.get("accent"), "lime")
        if accent not in ("lime", "violet"):
            accent = "lime"
        return cls(parallel, runner, theme, accent)


@dataclass(frozen=True, slots=True)
class Automation:
    id: str
    project_id: str
    name: str
    task: str
    workflow: str
    runner: str
    every_minutes: int
    enabled: bool
    next_at: str
    created_at: str
    last_run_id: str = ""
    tracker: str = ""
    tracker_event: str = ""
    revision: int = 1
    once: bool = False
    creation_key: str = ""
    kind: str = "schedule"
    events: tuple[str, ...] = ()
    filters: dict[str, object] = field(default_factory=dict)

    def to_json(self) -> dict[str, object]:
        return {
            "id": self.id,
            "project_id": self.project_id,
            "name": self.name,
            "task": self.task,
            "workflow": self.workflow,
            "runner": self.runner,
            "every_minutes": self.every_minutes,
            "enabled": self.enabled,
            "next_at": self.next_at,
            "created_at": self.created_at,
            "last_run_id": self.last_run_id,
            "tracker": self.tracker,
            "tracker_event": self.tracker_event,
            "revision": self.revision,
            "once": self.once,
            "creation_key": self.creation_key,
            "kind": self.kind,
            "events": list(self.events),
            "filters": self.filters,
        }

    @classmethod
    def from_json(cls, raw: object) -> Automation:
        data = _dict(raw)
        every = _int(data.get("every_minutes"), 60)
        if not 1 <= every <= 10080:
            every = 60
        runner = _text(data.get("runner"), "claude")
        if runner not in RUNNERS:
            runner = "claude"
        return cls(
            id=_text(data.get("id")),
            project_id=_text(data.get("project_id")),
            name=_text(data.get("name")),
            task=_text(data.get("task")),
            workflow=_text(data.get("workflow"), "quick-task"),
            runner=runner,
            every_minutes=every,
            enabled=_bool(data.get("enabled")),
            next_at=_text(data.get("next_at")),
            created_at=_text(data.get("created_at")),
            last_run_id=_text(data.get("last_run_id")),
            tracker=_text(data.get("tracker")),
            tracker_event=_text(data.get("tracker_event")),
            revision=max(1, _int(data.get("revision"), 1)),
            once=_bool(data.get("once")),
            creation_key=_text(data.get("creation_key")),
            kind=_text(data.get("kind"), "schedule"),
            events=_string_tuple(data.get("events")),
            filters=_dict(data.get("filters")),
        )


@dataclass(frozen=True, slots=True)
class Skill:
    name: str
    description: str
    body: str
    path: str
