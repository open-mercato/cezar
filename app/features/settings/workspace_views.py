from stario import h
from stario.datastar import at, data
from stario.datastar.format import string_literal
from stario.markup import HtmlElement

from app.config import RUNNERS
from app.features.settings.store import (
    AUTO_RUNNERS,
    KINDS,
    AgentDefaults,
    ComposerDefaults,
    SkillRepo,
    TrackerConnection,
    tri_word,
)
from app.features.settings.urls import (
    AGENTS_SAVE,
    GLOBAL_INSTRUCTIONS_SAVE,
    GLOBAL_SKILLS_REMOVE,
    GLOBAL_SKILLS_SAVE,
    RESOURCES_SAVE,
    TASKS_SETTINGS_SAVE,
    TRACKER_SETTINGS_SAVE,
)


def _tri(label: str, key: str, current: bool | None) -> HtmlElement:
    return h.Label(
        {"class": "field"},
        h.Span(label),
        h.Select(
            {"aria-label": label},
            data.bind(key),
            *[
                h.Option({"value": word, "selected": word == tri_word(current)}, word)
                for word in ("inherit", "on", "off")
            ],
        ),
    )


def tasks(
    branch: str,
    checks: list[str],
    composer: ComposerDefaults,
    default_skill: str,
    ask_skill: str,
) -> tuple[HtmlElement, ...]:
    rows = [h.Li(name) for name in checks] or [h.Li({"class": "muted"}, "No required checks.")]
    return (
        h.P(
            {"class": "sub"},
            "New task worktrees branch from this. Each required check runs in the worktree "
            "before the task is marked done. Auto-land onto the trunk is not this port.",
        ),
        h.Form(
            {"class": "composer"},
            data.on("submit", at.post(TASKS_SETTINGS_SAVE.href()), prevent=True),
            h.Label(
                {"class": "field"},
                h.Span("Base branch"),
                h.Input(
                    {"required": True, "maxlength": "200", "aria-label": "Base branch"},
                    data.bind("branch"),
                ),
            ),
            h.Label(
                {"class": "field"},
                h.Span("Required checks"),
                h.Input(
                    {
                        "maxlength": "2000",
                        "placeholder": "lint, unit",
                        "aria-label": "Required checks",
                    },
                    data.bind("checks"),
                ),
            ),
            h.Label(
                {"class": "field"},
                h.Span("Default skill"),
                h.Input(
                    {"maxlength": "200", "aria-label": "Default skill", "id": "default-skill"},
                    data.bind("default_skill"),
                ),
            ),
            h.Label(
                {"class": "field"},
                h.Span("Ask skill (a task that ends in ?)"),
                h.Input(
                    {"maxlength": "200", "aria-label": "Ask skill", "id": "ask-skill"},
                    data.bind("ask_skill"),
                ),
            ),
            _tri("New tasks are autonomous", "composer_autonomous", composer.autonomous),
            _tri("New tasks get their own worktree", "composer_worktree", composer.worktree),
            h.Button({"class": "btn btn-primary", "type": "submit"}, "Save"),
        ),
        h.P({"class": "meta"}, f"Landing branch: {branch}"),
        h.P(
            {"id": "composer-defaults"},
            f"New task form: autonomous {tri_word(composer.autonomous)}, "
            f"worktree {tri_word(composer.worktree)}, "
            f"skill {default_skill or 'none'}, ask skill {ask_skill or 'none'}.",
        ),
        h.Ul({"id": "required-checks"}, *rows),
    )


def agents(lines: list[str], defaults: AgentDefaults) -> tuple[HtmlElement, ...]:
    fields: list[HtmlElement] = []
    for runner in RUNNERS:
        fields.append(
            h.Label(
                {"class": "field"},
                h.Span(f"{runner} model"),
                h.Input(
                    {"maxlength": "200", "placeholder": "auto", "aria-label": f"{runner} model"},
                    data.bind(f"model_{runner}"),
                ),
            )
        )
        if runner in AUTO_RUNNERS:
            fields.append(
                h.Label(
                    {"class": "inline"},
                    h.Input({"type": "checkbox"}, data.bind(f"auto_{runner}")),
                    f"{runner}: auto when empty, ignore every other default",
                )
            )
    summary = ", ".join(f"{runner}={model}" for runner, model in defaults.models.items())
    return (
        h.P(
            {"class": "sub"},
            "The model a new task starts with, per agent. Empty is auto: no model flag, "
            "the agent's own setting decides. Locked makes the agents' own model settings "
            "authoritative and a task cannot override them.",
        ),
        h.Ul({"id": "agent-bins"}, *[h.Li(line) for line in lines]),
        h.Form(
            {"class": "composer"},
            data.on("submit", at.post(AGENTS_SAVE.href()), prevent=True),
            *fields,
            h.Label(
                {"class": "field"},
                h.Span("Planner model (Claude alias)"),
                h.Input(
                    {"maxlength": "200", "aria-label": "Planner model"}, data.bind("planner_model")
                ),
            ),
            h.Label(
                {"class": "field"},
                h.Span("Namer model (Claude alias)"),
                h.Input(
                    {"maxlength": "200", "aria-label": "Namer model"}, data.bind("namer_model")
                ),
            ),
            h.Label(
                {"class": "inline"},
                h.Input({"type": "checkbox"}, data.bind("locked")),
                "Models locked — use each agent's own model setting",
            ),
            h.Button({"class": "btn btn-primary", "type": "submit"}, "Save"),
        ),
        h.P(
            {"id": "agent-defaults"},
            f"Defaults: {summary or 'all auto'}. Planner {defaults.planner_model}, "
            f"namer {defaults.namer_model}. "
            f"{'Models are locked.' if defaults.locked else 'Models are not locked.'}",
        ),
    )


def tracker(row: TrackerConnection) -> tuple[HtmlElement, ...]:
    saved = "A token is saved." if row.token else "No token yet."
    return (
        h.P(
            {"class": "sub"},
            "Connect this cockpit to Jira or Linear. Lookup uses the saved token when "
            "the row is complete, otherwise the process credentials. The token is not shown again.",
        ),
        h.Form(
            {"class": "composer"},
            data.on("submit", at.post(TRACKER_SETTINGS_SAVE.href()), prevent=True),
            h.Label(
                {"class": "field"},
                h.Span("Tracker"),
                h.Select(
                    {"aria-label": "Tracker"},
                    data.bind("kind"),
                    *[
                        h.Option({"value": kind, "selected": kind == row.kind}, kind)
                        for kind in KINDS
                    ],
                ),
            ),
            h.Label(
                {"class": "field"},
                h.Span("Site"),
                h.Input(
                    {"type": "url", "maxlength": "200", "aria-label": "Site"}, data.bind("site")
                ),
            ),
            h.Label(
                {"class": "field"},
                h.Span("Email"),
                h.Input(
                    {"type": "email", "maxlength": "200", "aria-label": "Email"},
                    data.bind("email"),
                ),
            ),
            h.Label(
                {"class": "field"},
                h.Span("Token"),
                h.Input(
                    {"type": "password", "maxlength": "500", "aria-label": "Token"},
                    data.bind("token"),
                ),
            ),
            h.Button({"class": "btn btn-primary", "type": "submit"}, "Save connection"),
        ),
        h.P({"id": "tracker-saved"}, f"{row.kind} · {row.site or 'no site'} · {saved}"),
    )


def instructions(prompt: str) -> tuple[HtmlElement, ...]:
    return (
        h.P(
            {"class": "sub"},
            "Prepended to every agent step, before the project's own system prompt.",
        ),
        h.Form(
            {"class": "composer"},
            data.on("submit", at.post(GLOBAL_INSTRUCTIONS_SAVE.href()), prevent=True),
            h.Label(
                {"class": "field"},
                h.Span("Global system prompt"),
                h.Textarea(
                    {"id": "global-prompt-input", "maxlength": "20000"},
                    data.bind("prompt"),
                ),
            ),
            h.Button({"class": "btn btn-primary", "type": "submit"}, "Save"),
        ),
        h.Pre({"id": "global-prompt"}, prompt),
    )


def skills(rows: list[SkillRepo]) -> tuple[HtmlElement, ...]:
    items = [
        h.Li(
            f"{row.repo} @ {row.ref}",
            h.Button(
                {"type": "button", "class": "btn"},
                data.on(
                    "click",
                    f"$repo = {string_literal(row.repo)}; " + at.post(GLOBAL_SKILLS_REMOVE.href()),
                ),
                "Remove",
            ),
        )
        for row in rows
    ] or [h.Li({"class": "muted"}, "No org skill repos.")]
    return (
        h.P(
            {"class": "sub"},
            "Cloned as a bare repository. A step that names one of its skills "
            "gets that body in the prompt.",
        ),
        h.Ul({"id": "skill-repos"}, *items),
        h.Form(
            {"class": "composer"},
            data.on("submit", at.post(GLOBAL_SKILLS_SAVE.href()), prevent=True),
            h.Label(
                {"class": "field"},
                h.Span("Repository"),
                h.Input(
                    {
                        "type": "text",
                        "required": True,
                        "maxlength": "500",
                        "aria-label": "Repository",
                    },
                    data.bind("repo"),
                ),
            ),
            h.Label(
                {"class": "field"},
                h.Span("Ref"),
                h.Input({"maxlength": "80", "aria-label": "Ref"}, data.bind("ref")),
            ),
            h.Button({"class": "btn btn-primary", "type": "submit"}, "Add repo"),
        ),
    )


def resources(limit: int | None) -> tuple[HtmlElement, ...]:
    sentence = "No memory cap." if limit is None else f"Memory cap: {limit} MB."
    return (
        h.P(
            {"class": "sub"},
            "How much memory one task's process tree may use. "
            "Crossing it pauses the task so the queue can move on.",
        ),
        h.Form(
            {"class": "composer"},
            data.on("submit", at.post(RESOURCES_SAVE.href()), prevent=True),
            h.Label(
                {"class": "field"},
                h.Span("Memory cap (MB)"),
                h.Input(
                    {
                        "type": "number",
                        "min": "256",
                        "max": "65536",
                        "aria-label": "Memory cap",
                    },
                    data.bind("memory"),
                ),
            ),
            h.Button({"class": "btn btn-primary", "type": "submit"}, "Save"),
        ),
        h.P({"id": "memory-cap"}, sentence),
    )
