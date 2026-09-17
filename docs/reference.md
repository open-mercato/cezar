# cezar reference

Everything the [README](../README.md) leaves out: the full configuration, every environment variable, agent backends, remote access, multiple projects and local development.

- [Core concepts](#core-concepts)
- [Cockpit tour](#cockpit-tour)
- [Multiple projects, one cockpit](#multiple-projects-one-cockpit)
- [Workflow format](#workflow-format)
- [How it runs agents](#how-it-runs-agents) (environment variables, troubleshooting)
- [Coding agent backends](#coding-agent-backends)
- [Remote access (host cezar on a server)](#remote-access-host-cezar-on-a-server)
- [Configuration](#configuration-optional)
- [Nightly and preview builds](#nightly-and-preview-builds)
- [Local development](#local-development)

---

## Core concepts

Three words, no jargon — **task**, **skill**, **chain**:

- 📋 **Tasks** are the unit of work. Every task is a **run**: `queued → running →
  review / done / failed / cancelled`, with a live event log, per-step token and
  cost usage, cancel/delete, and — for anything with a diff — a review gate. Attach
  screenshots, PDFs, `.txt` or `.md` files to the task (paperclip, ⌘V or drag-drop;
  the agent gets each one as a real file on disk), or send follow-up messages into
  the live session while it works.
- 📖 **Skills** are Markdown playbooks. Drop them in `.ai/skills/` or
  `.ai/cezar/skills/`, or pull them from a shared **team skills repo** (a bare
  git clone cached globally in `~/.cache/cez/`). A workflow step references one by
  `skill: <name>` and its body becomes the agent's extra system prompt — so you
  shape *how* the agent reasons without touching code.
- 🔗 **Chains (workflows)** stitch steps into a pipeline: agent steps plus shell
  checks, with bounded `onFail` retry loops. Write the YAML yourself, build one by
  drag-ordering skills in the **Workflows** tab, or press **Plan first** and let the
  AI draft a chain for your task that you review, trim and start. The built-in
  `quick-task` (one agent step) works with zero setup.

Five moves that make the cockpit worth the browser tab:

- 🗃️ **Queue + orchestration.** Start as many tasks as you like: cezar runs up to
  `maxParallel` at once across every project (default **2**; a non-git directory
  always runs one) and
  holds the rest in a FIFO queue with visible positions (`#1`, `#2`, …). Cancel a
  queued task before it starts; the queue even survives a cockpit restart —
  everything still `queued` is re-enqueued in order. It's the orchestration layer
  that turns "one agent at a time" into a backlog that drains itself.
- 🧠 **Memory-aware runs.** Each run's whole process tree is sampled (~2 s) for CPU
  and RSS, and its **peak memory** is recorded and shown in the task table. Set an
  optional per-task **memory ceiling** (`memoryLimitMb`) and a run that crosses it
  is *paused* — freeing its tree so the queue keeps advancing — and resumes on
  demand. Event logs are append-only NDJSON and streamed rather than re-serialized,
  and live UI deltas are coalesced so they never hit disk.
- 🪞 **Parallel variants (×2 / ×3).** Run the same task as competing agents in
  separate worktrees, then compare their diffs side by side and **pick** one —
  the losers are archived and their worktrees cleaned up.
- 🧹 **Bounded worktree disk.** Each task runs in its own full checkout, so a busy
  cockpit would otherwise grow without limit. cezar keeps only the last
  `worktreeRetention` **finished** worktrees on disk (default **10**; `0` =
  unlimited) and reclaims the rest — directory only, the `cez/<id8>` branch is
  always kept, so the work stays recoverable. Settings → Resources shows every
  worktree's disk use with per-row delete and a **Reclaim now** button.
- 🛡️ **Review gate.** A finished run with changes waits in `review`. Read the diff,
  type notes that go straight back into the agent's session, or push a
  `gh pr create --draft`. You stay the merge button.
- 📱 **Runs on your coding server, drives from your pocket.** The cockpit is a
  responsive web app streaming over SSE, so the box running cezar can be a
  **VPS, cloud, or dedicated server** you never sit in front of. Point a browser
  — laptop or **phone** — at it and run an **always-on coding team** on the move:
  start tasks, watch them live, and hit the review gate from anywhere.

---

## Cockpit tour

Eight views, one browser window, all live over Server-Sent Events (seven until you opt into the Inbox):

| View | What's in it |
|---|---|
| **Tasks** | Every task with its status, live event stream (agent text · tool calls · tool results · pasted/generated screenshots and file attachments), tokens and cost. Continue, cancel, open in terminal (`claude --resume`), review the diff, or push a draft PR. |
| **All tasks** | Every *registered project's* tasks in one table, filtered and grouped by tag, project, status or workflow — see [Grouping connected repositories](#grouping-connected-repositories-tags-and-the-all-tasks-page). Appears once a second project is registered. |
| **Inbox** | **Opt-in** (`CEZ_FOLLOWUPS=1`; hidden by default). Follow-ups an agent left behind (`todos.json`) — one click turns a suggestion into the next task, pre-wired to its suggested skill. Off, agents are never asked to leave follow-ups; each task's own **Notes** handoff journal is unaffected. |
| **Git** | Branch, working-tree status, diff vs HEAD, recent commits (click one for its inline patch + GitHub link), and the configurable base branch that worktrees fork from and PRs target. |
| **GitHub** | Open issues and PRs of the repo's origin, read through your logged-in `gh`. Hand an issue straight to the agent — pick a workflow and skills, one click runs it. |
| **Skills** | Local skills plus the team skills repo, with a rendered body + prompt preview. Refresh pulls the latest from the remote. |
| **Workflows** | Build a chain by drag-ordering skills, save it as portable YAML, import/export, or delete. Built-ins always come back. |
| **Settings** | Appearance (dark/light theme, accent, density), agent backends, notifications, and the skills catalog. |

The cockpit is a React app served pre-built from the package — `npx cezar-cli`
still means no build step and no dev server on your machine — with a dark/light
theme, a ⌘K command palette, and bookmarklets that launch a task straight from
a GitHub page.

---

## Multiple projects, one cockpit

One `cezar serve` hosts **every repo you work in**, not just the one you started
it in. Projects live in a per-user registry at `~/.cezar/config.json` — the
workspace file that also holds the global knobs
(the parallel cap, the memory ceiling, the browse root, and the checkout root). Nothing is added to
the repo: per-project state stays exactly where it was, in that repo's
`.ai/cezar/`.

**Your first run registers the repo you start it in** — that is the whole setup.
After that the registry is yours to curate: starting cezar somewhere else serves
that folder as usual (its own tasks, its own `.ai/cezar/`) but does not add it to
the list behind your back. It shows up at the top of the sidebar marked **not
saved**, and **Settings → Projects** lists it as *not registered* with an
**Add project** button — so the folder you launched in is always one click from
being kept, and never kept without the click. `cezar projects add` does the same
from a terminal.

Every view is project-scoped:

```
/p/<projectId>/            tasks · git · github · skills · workflows · settings
```

`<projectId>` is a slug derived from the folder name (`my-app`, then `my-app-2`
on a collision), and `/p/default/…` always means the project cezar was started
in. The sidebar shows one collapsible group per project — each with its own nav
and task list — and the new-task composer names the project it will run in.

**Adding a project** — the **+** button beside *New task*:

- 📂 **Open local folder…** browses from the configured browse root
  (**Settings → Projects**, default `~/`) in a folder picker and
  registers the folder you pick.
- ⬇️ **Clone from GitHub…** clones with your logged-in `gh` into the checkout
  root (**Settings → Projects**, default `~/cezar/projects`) with live progress,
  then registers the clone. Close the dialog and the clone is killed and its
  partial directory removed.

Removing a project (**Settings → Projects**) drops the registry entry only — the
repo and its `.ai/cezar/` are never touched, so re-adding it later finds all its
tasks intact. The project cezar is currently serving can't be removed from the
cockpit — stop the server and use `cezar projects remove <id>` instead.

**From the terminal** — the same registry, no cockpit required (handy over ssh):

```bash
cezar projects                    # list: id, branch or status, path, tags
cezar projects add ~/code/api     # register a folder (defaults to the current repo)
cezar projects remove api         # drop the registry entry; the repo is untouched
cezar projects tag api storefront backend   # set the grouping tags (no tags clears them)
```

These read and write `~/.cezar/config.json` directly, so they work with the
server stopped, and `CEZ_HOME` selects which workspace they operate on.

Settings split along the same line: **General** (the project's folder, its
registry facts, its parallel-task ceiling, and Remove), **Agents**,
**Worktrees**, **Bookmarklets**, **Prompt templates** and **MCP** describe one
repo and live under `/p/<projectId>/settings`; **Appearance**,
**Notifications**, **Resources**, **Projects** and **Keyboard** are yours or the
machine's and live at `/settings/global`.

### Grouping connected repositories: tags and the All tasks page

Work rarely stops at a repo boundary. A storefront is an API, a web app and a
design system; a platform is a handful of services plus the infra that runs
them. **Tags** are how you say so, and **All tasks** is where saying so pays off.

**Tag a repo** in **Settings → Projects**: type into the *Tags* cell on its row
and press Enter (comma works too; the × on a chip, or Backspace in an empty
field, removes one). The field **autocompletes from the tags already used in the
workspace** — click the field to see them all, arrow keys and Enter to pick —
which is what keeps the second repo landing on the first one's spelling instead
of inventing `store-front` next to `storefront`. Anything not on the list is
just typed. A tag is a free-form label — `storefront`, `infra`, `client-acme` —
and a project can carry several, because a repo can belong to more than one
piece of work. Tags are trimmed, deduplicated case-insensitively (`API` and
`api` are one tag) and stored in `~/.cezar/config.json` beside the rest of the
registry, so they are yours and this machine's, never something added to the
repo.

**All tasks** — the top item in the sidebar, `/tasks`, or `⌘K → All tasks` —
then shows every registered project's work in one table:

- **Filter** by tag, status and workflow. Tags are one-click chips; status and
  workflow are searchable multi-selects. Every facet ORs inside itself and ANDs
  across, so *"anything running or waiting in storefront or infra"* is one set
  of clicks. Each option carries how many tasks it would leave, so a filter that
  would empty the table says so before you click it. The search box matches
  title, project, workflow, branch and tags.
- **Group by** tag, project, status or workflow — click the pressed one again to
  ungroup. Grouping by tag is the reason tags exist: three repos tagged
  `storefront` become one section, and a repo tagged twice appears under both —
  it genuinely belongs to both.

The filters, the grouping and the Active/Archived tab live in the **URL**, so a
filtered view survives a refresh, pastes into a chat, and sits in a bookmark —
`/tasks?tag=storefront&status=running&group=tag` is a link to exactly what you
were looking at. Only what you changed shows up: Active is the default, so the
Archived view is `?archived=1` and a normal link carries no key for it.

Each row shows **every** PR and issue it references — a task opened on an issue
that landed a PR shows both — plus its cost and live CPU/memory, and can be
marked **read/unread** (the eye) or **archived** (or restored) right there. Every task title, project name and project group heading links into that
project, so the thread, its diff and its worktree are one click away and stay
exactly where they were.

There is deliberately **no project filter**: narrowing this page to one project
is that project's own Tasks page, which is a better version of the same answer
(live updates, the full column set, the composer). So picking a project *leaves*
for it rather than turning the global view into a worse local one.

Nothing else in cezar reads tags, on purpose: a tag is a lens, not a permission,
a queue or a routing rule. Removing one changes what you see and nothing else.

> The page reads a workspace-wide index capped at the newest 200 tasks per
> project — it says so, and names the projects it capped, rather than showing a
> short list as if it were complete. Older tasks are always in that project's own
> Tasks page.

**Old page URLs keep working.** Every unprefixed page path — `/`, `/tasks/<id>`,
`/settings` — still answers, bound to the project cezar was started in; the
cockpit redirects flat paths to their `/p/<boot>/…` twin, so existing bookmarks
and bookmarklets need no change. The HTTP API is the exception: it moved to
`/api/v1/…` (see the CHANGELOG), so a script that calls it needs the extra
segment.

> **Hosted cockpit?** The folder picker is confined to the independent browse
> root. Set `CEZ_BROWSE_ROOT` narrowly before first boot (or save it in
> **Settings → Projects**) when a remote viewer should not enumerate the host's
> whole home. Clones continue to use the separate checkout root.

---

## Workflow format

A workflow is a small YAML file in `.ai/cezar/workflows/`:

```yaml
name: fix-and-verify
description: Implement the task, then verify; retry with failing output on red.
steps:
  - id: implement
    name: Implement
    prompt: "{{task}}"
    skill: project-conventions   # optional — from .ai/skills or .ai/cezar/skills
    # model: opus                # optional per-step model override
    # runner: codex              # optional per-step backend: claude · codex · opencode · pi
    # allowedTools: [Read, Edit, Write, Grep, Glob, Bash]
  - id: verify
    name: Verify
    command: "npm test"          # a check step: exit 0 passes
    onFail:
      retry: implement           # loop back to an earlier step…
      max: 2                     # …at most twice
```

`{{task}}` is replaced with the task text you typed. When a check fails and loops
back, its failing output is appended to the retried agent's prompt so the next
attempt can see what broke.

Prefer skills over steps? A workflow can also be written in the portable
shorthand — an ordered list of skill names, each becoming one agent step:

```yaml
name: triage-and-fix
skills: [reproduce, root-cause, implement, self-review]
```

---

## How it runs agents

cezar shells out to your locally installed, logged-in agent CLI —
**your subscription, no API key**. With the default Claude Code backend that
means headless `stream-json` mode, tool access via `--allowedTools`, with
unapproved tools denied without prompting (`--permission-mode dontAsk`) inside
the task's worktree — but note the zero-config default list (`Read`, `Edit`,
`Write`, `Grep`, `Glob`, `Bash`) grants unrestricted `Bash` unless a step sets
`bashAllowlist`, so treat a run as having full shell access in its worktree,
not a sandboxed allowlist. Set `CEZ_APPROVAL_GATE=1` to opt into Claude's
interactive approval UI. Codex and OpenCode are driven through their own
native protocols and don't honor `allowedTools` at all — see
[Coding agent backends](#coding-agent-backends) for what each one actually
locks down. Nothing runs on a server you don't own.

Useful environment variables:

| Var | Effect |
|---|---|
| `CEZ_DRY_RUN=1` | Use the bundled mock instead of the real `claude` CLI — the entire cockpit works offline, for demos and development. |
| `CEZ_AGENT_MODELS_LOCKED=1` | Globally lock each runner to the model configured in its native Claude/Codex/OpenCode settings while keeping runner selection available. Exact `1` also delegates authentication and provider enablement to those native agents, so Cezar skips its credential probes and provider-disable preferences. Existing Cezar presets are preserved but ignored, and an environment change requires a restart. The config-file equivalent is `"modelsLocked": true` in global `~/.cezar/config.json` or one repository's `.ai/cezar/config.json`; config-file locks do not disable provider checks. |
| `CEZ_APPROVAL_GATE=1` | Opt into Claude's interactive approval UI; by default, unapproved tools are denied without interrupting the run. |
| `CEZ_FOLLOWUPS=1` | Turn on the global follow-up **Inbox**: agents are asked to leave follow-ups in `todos.json` when they finish, and the Inbox view appears. Off by default — each task's own **Notes** handoff journal runs either way. |
| `CEZ_AUTOMATIONS=0` | Turn **automations** off. On by default since the automations redesign (spec `.ai/specs/2026-09-14-automations-redesign.md`): the Automations view lists GitHub-triggered and scheduled automations, and cezar polls GitHub or fires schedules on each enabled one while it is running — nothing runs until you enable an automation yourself. An agent can also **create an automation from a prompt**: type "whenever a PR is opened, review it" into New task — pick the built-in `create-cezar-automation` skill, or just ask; every task's system prompt teaches it to recognise the intent — and the agent writes the definition and creates it through `cez automation create` (paused, with a `cez automation check` preview of what it would match), then links the Automations page. Only the exact value `0` opts out (`CEZ_AUTOMATIONS=1`, the old opt-in, is accepted and changes nothing); opted out, the nav item is absent, the endpoints answer `409`, and the workspace scheduler never starts. Read at boot, so restart after changing it; definitions, receipts and high-watermarks are kept either way. |
| `CEZ_DISPATCH=0` | Turn OFF **task dispatch**, which is on by default: a running task may start other cezar tasks with `cez task create` — each in its OWN worktree forked off the parent's branch, with a budget carved out of the parent's — and they report back into the parent's session when they settle (`cez task report`). Children appear nested under their parent in the task lists. Tasks talk through a tree directory (`.ai/cezar/dispatch/<root>/`: the brief, each task's order/notes/report, an inbox per task) and cezar wakes a parked recipient when a file lands. A `--kind review` child judges another task's branch and answers with a verdict. ON by default (the owner-approved exception to "cost-widening features are opt-in" — see `AGENTS.md`), and only the exact value `0` turns it off; with it off the `/runs/:id/dispatch` and `/runs/:id/report` routes answer `409`, no task is told about the CLI, and the cockpit hides the "Review open PRs" template. A headless `cezar run` never dispatches either way — there is no cockpit for the CLI to reach, so no task is told about it. Read at boot, so restart after changing it. This is the widest cost-widening flag here — one task can start four more agents — so give dispatching tasks a budget. |
| `CEZ_AUTOSAVE=1` | Re-enable the periodic (90 s) autosave commit in task worktrees. Off by default (#471) — turn-end and pre-PR flushes always run, so branches still end complete. Every autosave names its trigger in the commit subject (`cezar autosave (periodic)` vs `(turn end)` / `(run finalize)` / `(pre-PR)`), so the flushes you keep are distinguishable from the timer you disabled. |
| `CEZ_CLAUDE_BIN=/path/to/claude` | Override which `claude` binary is used. |
| `CEZ_CODEX_BIN=/path/to/codex` | Override which `codex` binary is used. |
| `CEZ_OPENCODE_BIN=/path/to/opencode` | Override which `opencode` binary is used. |
| `CEZ_PI_BIN=/path/to/pi` | Override which `pi` binary is used. |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME` | The agents' **own** variables, honoured where the vendor documents one. Setting one moves that agent's **default account** — the config folder cezar discovers. A *second* login of the same CLI is deliberately not an environment setting, since one process-wide value cannot differ per project: add it under **Settings → Agent accounts** and pick it per project. |
| `CEZ_BROWSE_ROOT=~/` | Default root for **Add project → Open local folder…**. The picker cannot navigate above it; a saved workspace value overrides the environment default and must name an existing folder. |
| `CEZ_PROJECTS_DIR=~/cezar/projects` | Default destination for **Clone from GitHub**. Saved workspace settings override it, and missing directories are created recursively. |
| `CEZ_SKILLS_AUTO_UPDATE=0` | Disable automatic checks and updates for upstream-CLI-tracked Open Mercato skill installations. On by default; a saved global Skills setting overrides this environment default. Checks are delayed, bounded, cached, and non-blocking. |
| `CEZ_AUTONOMOUS_DEFAULT=0` | Seed the New Task Autonomous default (`0` or `1`). Without a seed, skills default on and workflows off; a saved global Resources setting overrides it. |
| `CEZ_WORKTREE_DEFAULT=1` | Seed the New Task Worktree default (`0` or `1`). Without a seed, eligible runs default on; a saved global Resources setting overrides it. |
| `CEZ_DISABLE_REPO_LOCK=1` | **Dangerous escape hatch:** allow any run executing in the repository root — an explicit `worktree=false` run, non-Git degradation, or a continuation whose worktree cannot be restored — to proceed without Cezar’s repository-root lease. Agents can overwrite each other’s files or Git state; isolated worktree runs are unaffected. Off by default; only the exact value `1` enables it. |
| `CEZ_SINGLE_PROJECT=1` | Opt into a launch-project-only cockpit: only the exact value `1` enables it. Project add, edit, checkout, folder browsing, and removal are refused and only the launch project is shown. Off by default; stored registry rows are retained, so unsetting it and restarting restores the full multi-project workspace without migration or data loss. |
| `CEZ_HIDE_TOKEN_USAGE=1` | Hide raw input/output token counts throughout the browser cockpit while leaving backend-reported cost visible. Only the exact value `1` enables it; telemetry and API payloads are unchanged, and a restart is required after changing it. |
| `CEZ_HIDE_COST=1` | Hide backend-reported monetary cost throughout the browser cockpit while leaving raw input/output token counts visible. Only the exact value `1` enables it; telemetry and API payloads are unchanged, and a restart is required after changing it. |
| `CEZ_HIDE_TOKEN_METRICS=1` | Legacy master switch that hides both token usage and cost. It takes precedence over the two independent flags; only the exact value `1` enables it, payloads are unchanged, and a restart is required. |
| `GITHUB_TOKEN` | Fallback for GitHub reads/PRs when `gh` isn't authenticated. |
| `CEZ_ENV_PASSTHROUGH=A,B` | Forward these extra host env vars to spawned agents. By default agents get a least-privilege env (safe shell/toolchain vars + the backend's own auth + `GITHUB_TOKEN` + `CEZ_*`), not your full environment — use this to add a var an agent needs. |
| `CEZ_AGENT_ENV_FULL=1` | Escape hatch: give spawned agents the full host environment (pre-hardening behavior). Off by default; only set it if you understand that this hands every host secret to the agent process. |
| `CEZ_AGENT_TMPDIR=0` | Stop giving each task its own temp directory and hand agents the host `TMPDIR` again (pre-#785 behavior). On by default: every run gets `TMPDIR`/`TEMP`/`TMP` pointing at `.ai/cezar/tmp/<task-id>`, created and write-probed before the agent spawns and reaped when the run ends, so concurrent tasks stop sharing one directory and a task refuses to start rather than run against a temp directory that silently swallows its shell output (see Troubleshooting below). Only an exact `0` disables it, and it disables the whole thing — the pre-spawn check included, so this stays an escape hatch you can actually take. |
| `CEZ_REDACT_SECRETS=0` | Disable scrubbing of credential values/token shapes from the on-disk state (the NDJSON transcript and the free-text fields of `runs.json`). On by default; leave it on. Best-effort defense-in-depth, not a guarantee: it catches known token shapes and the values of your own secret-named env vars, so a credential in neither category can still get through. |
| `CEZ_TITLE_UPDATES=0` | Turn off the live task-title refresh (namer re-runs on each turn end). The Settings → Agents toggle overrides this default. |
| `CEZ_AUTONAME=0` | Disable ALL LLM task naming (creation + live) — titles stay heuristic (`437: /om-auto-review-pr`). Under `CEZ_DRY_RUN=1` naming is already off unless forced with `CEZ_AUTONAME=1`. |
| `CEZ_REVIEW_GATE=1` | Turn ON the optional diff-first review gate (#489): a successful, non-autonomous run with changes parks at `review` (Accept / Send back / Draft PR) instead of finishing. Off by default — changed runs settle to `done` with the diff left in the worktree. Only `1` enables. The Settings → Agents toggle overrides this; autonomous runs always skip it. |
| `CEZ_NO_BANNER=1` | Skip the `open-mercato/skills` banner on `cezar serve` startup. (The cockpit no longer shows a banner — its skills now live on the Skills page's Manage panel — so this env var is the terminal banner's only switch.) |
| `VITE_CEZ_API_BASE=http://localhost:4321` | **Build time only**, and only when the cockpit bundle is deployed apart from the service it talks to. Empty (the default) means "the origin that served this page", which is right for both normal cases: the CLI serves the bundle itself, and `npm run dev` proxies `/api` to the local service. A deployment that must be configured without a rebuild can put `<meta name="cez-api-base" content="…">` in the served HTML instead, which wins over this. |

### Troubleshooting: the agent's shell returns nothing

**Symptom.** A task on the Claude backend keeps working, but every shell command
comes back with no output and a spurious non-zero exit status — `echo hello`
included. Redirecting into a file inside the worktree still produces the right
content, so the commands genuinely run; only the *capture* is lost. Codex tasks
on the same machine are unaffected, because that backend streams over stdio
pipes instead of round-tripping a command's output through a temp file.

**Diagnosis.** The temp directory the agent was given is out of space or out of
quota. One line tells you:

```bash
echo probe > "${TMPDIR:-/tmp}/probe"   # "Disk quota exceeded" / "No space left on device"
df -i "${TMPDIR:-/tmp}"                # a tmpfs can exhaust inodes long before bytes
```

Under quota the file is *created* and the write then fails, so the backend reads
back a zero-byte capture file and hands the agent an empty result.

**Fix.** Since #785 cezar gives each task its own `TMPDIR` under
`.ai/cezar/tmp/<task-id>` and write-probes it before spawning, so a broken temp
directory fails the task with `agent temp directory is not writable: …` on the
task thread instead of corrupting its work. If you see that error, free space on
the disk holding the repo. `CEZ_AGENT_TMPDIR=0` turns the whole mechanism off —
per-task directory and pre-spawn check alike — and hands agents the host
`TMPDIR` again, which is the way out if the check itself is wrong on your
platform.

---

## Coding agent backends

cezar is not married to one vendor. Every agent step runs through a single
`AgentRunner` seam with four built-in backends:

| Backend | CLI | How cezar drives it | Tool access |
|---|---|---|---|
| **Claude Code** (default) | [`claude`](https://github.com/anthropics/claude-code) | Headless `stream-json` mode. | Per-tool `--allowedTools` (`bashAllowlist` scopes `Bash`); `dontAsk` denies unapproved tools without prompting (`CEZ_APPROVAL_GATE=1` → `acceptEdits` + approval UI). |
| **Codex** | [`codex`](https://github.com/openai/codex) | `codex app-server` — JSON-RPC over stdio, the same transport the Codex IDE extensions use. | Ignores `allowedTools`; the default auto mode uses `danger-full-access` with `approvalPolicy: never` (`CEZ_CODEX_NETWORK=0` opts into the network-blocked `workspace-write` sandbox). |
| **OpenCode** _(experimental)_ | [`opencode`](https://opencode.ai) | `opencode serve` — a local HTTP server with an SSE event stream. | Ignores `allowedTools` entirely; every permission is auto-approved. |
| **pi** _(experimental)_ | [`pi`](https://github.com/badlogic/pi-mono) | Persistent `--mode rpc` over JSONL; models are picked with the `provider/model` convention. | Maps `allowedTools` onto pi's `--tools` allowlist; a configured `bashAllowlist` disables Bash because pi cannot express command-prefix rules. |

> ⚠️ **OpenCode and pi support are experimental.** Both runners work but are less
> battle-tested than the Claude Code and Codex backends, and OpenCode auto-approves
> every permission (it ignores `allowedTools`). Treat them as previews and expect
> rough edges.

On startup cezar probes which CLIs are installed and the cockpit only offers
the backends it found — install any one of the four and you're operational.

**Models come from your own machine.** The model picker does not ship a list of
vendor releases that goes stale between cezar versions. For Claude, Codex and
OpenCode cezar asks the CLI on your host what *it* currently offers (Claude
Code's `list_models` control request; the Codex app-server's `model/list`;
`opencode models`) and shows exactly that, in that order — so a model your
account gained yesterday is selectable today with no cezar release, and one your
provider retired stops being offered. Discovery is read-only, costs no tokens,
and is cached briefly in memory. If the CLI is missing, logged out, too old or
slow, the picker quietly falls back to that runner's built-in entries (`auto`
plus Claude's tier aliases) and says so in a status row; `pi`, which has no
host-local catalog yet, always shows its built-in entries. `auto` — send no
model at all and let the CLI decide — is always available, and a model you
pinned by hand stays selectable even when it is no longer advertised.

**Pick a backend at three levels** (most specific wins):

1. **Config default** — `"defaultRunner": "codex"` in `.ai/cezar/config.json`.
2. **Per task** — the backend picker next to the task box in the cockpit.
3. **Per workflow step** — `runner:` on any step in the YAML.

Per-step overrides are what make **mixed-agent strategies** a one-liner:
implement with one agent, review with another, and let a shell check referee:

```yaml
name: implement-and-cross-review
steps:
  - id: implement
    name: Implement
    prompt: "{{task}}"
    runner: codex                # one vendor writes the code…
  - id: review
    name: Cross-review
    prompt: "Review the diff produced for: {{task}}. Fix real issues only."
    runner: claude               # …another one reviews it
  - id: verify
    name: Verify
    command: "npm test"
    onFail: { retry: implement, max: 2 }
```

Parallel variants (×2/×3) of one task share that task's backend — mixing
happens per task and per step, not inside a variant group.

The seam is deliberately small: a backend is one class implementing the
`AgentRunner` interface (`packages/cezar/src/core/agent-runner.ts`) that turns a prompt into
a stream of normalized events. Other CLIs — pi, aider, whatever ships next —
can slot in the same way.

---

## Remote access (host cezar on a server)

cezar runs on `localhost` by default. To reach the cockpit from another machine —
a shared team box, a VPS, your phone — put an **authenticated public front** in
front of it. The built-in installer does this interactively, per **platform
strategy**, and never escalates silently: every privileged command is printed
and verified, and it ends with a real authenticated end-to-end check.

```bash
npx cezar-cli server-install   --platform ubuntu-vps   # stand it up
npx cezar-cli server-deploy    --platform ubuntu-vps   # roll out a new version (reload the service)
npx cezar-cli server-uninstall --platform ubuntu-vps   # reverse it

# host a SECOND cockpit for another domain on the same box (ubuntu-vps):
npx cezar-cli server-install   --platform ubuntu-vps --domain shop.example.com
```

On `ubuntu-vps` a single host can run several independent cockpits — add
`--domain <host>` and each gets its own port, nginx site, login and service; a
new domain never resumes or clobbers the first install.

**Already running a reverse proxy?** If Dokploy, Coolify, Caddy or your own
nginx already owns `:80/:443`, cezar's would fight it for the ports. Install the
service only and let your proxy front it:

```bash
npx cezar-cli server-install --platform ubuntu-vps \
  --external-proxy --domain cezar.example.com --bind-host 172.17.0.1
```

`--bind-host` is only needed when the proxy runs in a **container** (Traefik
can't reach the host's loopback); a host-installed proxy uses the `127.0.0.1`
default. In this mode **your proxy must enforce authentication** — cezar has
none of its own. [Details →](server-install/ubuntu-vps.md#the-box-already-has-a-reverse-proxy-dokploy-coolify-caddy)

| Provider | `--platform` | Public front | Guide |
|----------|--------------|--------------|-------|
| Ubuntu / Debian VPS | `ubuntu-vps` | nginx + Let's Encrypt HTTPS, htpasswd login, systemd | [Step-by-step →](server-install/ubuntu-vps.md) |
| Ubuntu + existing proxy | `ubuntu-vps --external-proxy` | your Dokploy/Traefik/Caddy front; cezar ships the service only | [Step-by-step →](server-install/ubuntu-vps.md#the-box-already-has-a-reverse-proxy-dokploy-coolify-caddy) |
| macOS + ngrok | `macosx-ngrok` | ngrok tunnel + `--basic-auth`, launchd | [Step-by-step →](server-install/macosx-ngrok.md) |

See the **[Remote access overview](server-install/README.md)** for how it
works and how to redeploy new versions.

---

## Configuration (optional)

Zero config is the default — everything below is opt-in via
`.ai/cezar/config.json` (a missing or invalid file simply uses the defaults, and
never blocks startup):

```jsonc
{
  "skillsRepos": [{ "repo": "open-mercato/skills", "ref": "main" }], // team skills; [] disables
  // Team-skill repos are code-trusted: a skill body becomes an agent system prompt.
  // Only owner/name, https/ssh URLs, or local paths (`/abs`, `./rel`, `~/dir`,
  // `C:\dir`) are accepted — no ext::/fd:: transport helpers. Write a relative
  // path as `./name`, not a bare `name`. Pin `ref` to a full commit SHA to freeze
  // the source against a moving branch head — cezar verifies it resolves to
  // exactly that commit, and reports it as `team.commit`.
  "worktreeRetention": 10,   // keep the last N finished worktrees on disk; 0 = unlimited (branch always kept)
  "defaultRunner": "claude", // agent backend: "claude" (default) · "codex" · "opencode" · "pi"
  "modelsLocked": true,      // optional: native per-runner model is fixed/read-only; runner stays selectable
  "plannerModel": "sonnet",  // model the "Plan first" button uses to draft chains
  "baseBranch": "develop"    // branch worktrees fork from + PRs target (also settable in the Git tab)
}
```

Put the same `"modelsLocked": true` key in `~/.cezar/config.json` to apply it
to every registered project. When the key is absent or `false` in both config
files (and `CEZ_AGENT_MODELS_LOCKED` is not `1`), each runner's normal model
selector uses that runner's discovered model list. While locked, the model is
shown read-only and follows the selected runner's native settings; the runner
itself remains selectable.

Run data (`runs.json`, NDJSON event logs, worktrees, `todos.json`) is
git-ignored automatically; your workflows and skills stay committable.

Settings that belong to *you* rather than to a repo — the parallel cap
(`maxParallel`, default **2**), the per-task memory ceiling and the checkout
root — live once in `~/.cezar/config.json`, alongside the
[project registry](#multiple-projects-one-cockpit), and are edited from
**Settings → Resources** and **Settings → Projects**. A `maxParallel` left over
in a repo's `.ai/cezar/config.json` is imported into the workspace file the
first time cezar boots there, and ignored afterwards.

### Editing the agents' own config (Settings → Agent config)

cezar picks *which* agent runs; **Settings → Agent config** lets you edit *how* it
behaves — the raw config files Claude, Codex and OpenCode read for settings,
MCP, and memory. In the multi-project cockpit the section is project-scoped:
repo-relative files resolve from the selected project's root, while user-scope
files continue to resolve from the agent's home.

Each file keeps its native format and vendor-documented precedence. Tracked
files reach task worktrees after commit; Claude's gitignored personal layer is
seeded into each run's worktree. Editing is a local-machine capability, so a
hosted cockpit (`CEZ_REMOTE=1`) is read-only and never serves home-file contents.

---

## Nightly and preview builds

Every night we publish the trunk to npm, so the features landing in the next
release are one command away:

```bash
npx cezar-cli@nightly      # everything merged as of last night
```

**Come build this with us.** cezar is shaped by the people who run it on real
repos: if you try a nightly and something feels wrong — a workflow that stalls, a
diff that reads badly, a runner that should exist — [open an
issue](https://github.com/open-mercato/cezar/issues) and tell us. That feedback,
early, is worth more than a bug report six weeks after a release, and it is how
most of the features here got their final shape.

**Know what you're installing.** A nightly is verified (typecheck, unit suites,
packaged-CLI e2e — the same gate a release runs) but it is *not* a release: it
can be rough, a flag or a screen may change under you, and something occasionally
breaks in a way no test caught. Nothing is at risk beyond your patience — every
task runs in its own git worktree and cezar never auto-merges — but if you need a
boring day, stay on the stable release. Pin a nightly you liked with its exact
version (`npx cezar-cli@0.9.2-nightly.20260813.126` — the cockpit prints the
version it booted, and the date in it tells you how old the build is), and drop
back to stable any time with a plain `npx cezar-cli`.

### Preview builds

Every green CI run also publishes an installable npm snapshot
([how it works](publishing.md)), so you can try code that has not even
merged yet:

```bash
npx cezar-cli@develop      # current develop head
```

Every pull request gets its own preview too — the CI bot posts a sticky comment
on the PR with the exact pinned version to copy-paste
(`npx cezar-cli@<version>-pr<N>.<run>`). Nightlies and previews are all
prerelease versions under their own dist-tags; a plain `npx cezar-cli` always
resolves to the latest stable release.

---

## Local development

End-to-end, from a fresh clone to a global `cezar` command you can run in **any**
repo on your machine — no npm publish required.

**1. Prerequisites** — Node 20+ and `git` (plus at least one logged-in agent CLI,
as in [Quick start](../README.md#quick-start)).

**2. Clone & install**

```bash
git clone https://github.com/open-mercato/cezar.git
cd cezar
npm install
```

**3. Build** — compiles the api-client and the server (`tsc → packages/cezar/dist/`) and the cockpit
(`vite build → packages/cezar/web/dist/`), then runs the pack gate:

```bash
npm run build
```

**4. Install as a global command** — build + put `cezar` / `cez` / `cezar-cli` on
your PATH pointing at *this checkout*:

```bash
npm run install-as-command            # live link (default) — see the change loop below
#   or: npm run install-as-command:global   # self-contained snapshot copy
```

Now `cd` into any other repo and run it:

```bash
cd ~/some-other-project
cezar            # cockpit for that repo, straight off your checkout
cezar-cli --help # same binary; the name matches `npx cezar-cli`
```

**5. The change loop**

- **Link mode** (default): edit source → `npm run build` → the global command
  reflects it immediately. No relink needed. (It is a live symlink into this
  checkout — don't move or delete the checkout while it's linked.)
- **Snapshot mode** (`:global`): re-run `npm run install-as-command:global` to
  refresh the installed copy. It survives moving/deleting the checkout.

**6. Uninstall**

```bash
npm run uninstall-as-command    # removes cezar / cez / cezar-cli (either flavor)
```

**7. Troubleshooting**

- **`cezar: command not found`** after install → your npm global bin dir isn't on
  PATH. The script prints the exact dir; add it to your shell profile
  (`export PATH="$(npm prefix -g)/bin:$PATH"`).
- **`EACCES` / permission denied** → your global prefix is root-owned. Point npm
  at a user-writable one and retry — **never** sudo:
  `npm config set prefix ~/.npm-global`.
- **Already installed the published `@open-mercato/cezar` globally?** The
  link/snapshot install replaces it; `uninstall-as-command` removes ours, and
  `npm i -g @open-mercato/cezar` brings the published one back.

### In-checkout scripts

```bash
npm run dev          # server (API :4321) + Vite dev server, opens the cockpit in the browser
npm run dev:server   # tsx packages/cezar/src/index.ts — the API server alone
npm run dev:web      # Vite dev server alone (proxies /api to :4321)
npm run build        # tsc → packages/cezar/dist/, vite build → packages/cezar/web/dist/, then the pack gate
npm run typecheck    # server + web (tsc --noEmit)
npm test             # vitest — server + cockpit unit suites
npm run test:unit    # node:test — fast core-module tests
npm run test:package # pack/install and exercise the built CLI
npm run test:e2e     # real-browser cockpit suite (agent-browser)
```

The stack is deliberately small: **TypeScript** (strict, ESM), **Hono** + SSE for
the server, **Zod** at every boundary, **YAML** for workflows, and a **React 19 +
Vite + Tailwind v4 + shadcn/ui** cockpit shipped pre-built in `packages/cezar/web/dist/` — the
published package carries the built app, so `npx` users never run a bundler.
Every module is meant to be read in one sitting.

---
