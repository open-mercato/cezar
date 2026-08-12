<div align="center">

# cezar ⚡

**Parallel coding agents orchestrator** — a local cockpit for running and
tracking AI coding-agent tasks in your repo.

Type a task, pick a workflow and an agent — **Claude Code, Codex or OpenCode
(experimental), or a mix of them per step** — and watch it work live: steps, tool calls,
tokens, diffs, in a browser cockpit that runs entirely on your machine.
Your CLI logins, your `gh`, your files. No accounts, no database, no cloud.

🔥 **Fire and forget.** Queue a stack of autonomous coding and maintenance
tasks and let them run — cezar orchestrates them across isolated worktrees,
in parallel. Flip the **Autonomous** flag
and a run never stops to ask; it just finishes. Leave it on a VPS and you get
a dev team that's *always on* — a mobile-friendly cockpit you can check from
your phone, working your backlog while you're away.

[A look inside](#a-look-inside) · [What cezar does best](#what-cezar-does-best) · [What it solves](#what-it-solves) · [Who it's for](#who-its-for) · [Quick start](#quick-start) · [How it works](#how-it-works) · [Core concepts](#core-concepts) · [Cockpit tour](#cockpit-tour) · [Agent backends](#coding-agent-backends) · [Remote access](#remote-access-host-cezar-on-a-server)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)
![Node 20+](https://img.shields.io/badge/Node-20%2B-339933)
![TypeScript 7.x](https://img.shields.io/badge/TypeScript-7.x-3178c6)
![Zero config](https://img.shields.io/badge/config-zero-success)
![No database](https://img.shields.io/badge/database-none-success)

</div>

---

```bash
cd your-repo
npx cezar-cli        # → cockpit at http://localhost:4321
```

That's the whole setup. If your `claude` CLI is logged in (Pro/Max) and `gh` is
authenticated, there is nothing else to configure. State lives in `.ai/cezar/`
inside your repo — plain JSON, NDJSON and Markdown you can `cat` and fix by hand.

## A look inside

Click any thumbnail for the full-size screenshot.

| Orchestrate parallel agents | Watch a run live | Parallel variants |
|:--:|:--:|:--:|
| [![The Tasks view — parallel runs, a queue with positions, per-run cost and peak memory, and a variants compare card](docs/screenshots/task-view.png)](docs/screenshots/task-view.png) | [![A running task streaming agent text, tool calls and screenshots live](docs/screenshots/live-run.png)](docs/screenshots/live-run.png) | [![Two competing variants of the same task compared side by side — pick the winner](docs/screenshots/variants-compare.png)](docs/screenshots/variants-compare.png) |
| *Run and queue many tasks at once — each in its own worktree — with live status, cost and peak memory per run.* | *Every step, tool call, token and screenshot — streamed as it happens.* | *Run a task ×2/×3 in isolated worktrees, compare the diffs, keep one.* |
| **Workflow builder** | **GitHub, one click away** | **Skills + fire-and-forget** |
| [![The workflow builder — drag skills into an ordered chain of agent steps and shell checks](docs/screenshots/workflow-builder.png)](docs/screenshots/workflow-builder.png) | [![The GitHub tab — hand an open issue to the agent with a workflow and skills](docs/screenshots/github-issues.png)](docs/screenshots/github-issues.png) | [![The task composer — pick a skill playbook and flip the Autonomous flag to run unattended](docs/screenshots/skills-autonomous.png)](docs/screenshots/skills-autonomous.png) |
| *Stitch skills and shell checks into a reusable YAML chain, no code.* | *Open issues and PRs via your `gh` — run the agent straight on an issue.* | *Pick a Markdown skill and flip **Autonomous** — the run never stops to ask, so you can walk away.* |

---

## What cezar does best 🏆

Plenty of tools wrap a single coding agent in a nicer window — a "Codex GUI", a
conductor-style app, one-agent front-ends. cezar's bet is different. Three things
it does better than any of them:

- 🪶 **Genuinely zero config.** `npx cezar-cli` in your repo and you're running —
  no wizard, no API keys, no env vars, no schema, no database. It rides the
  `claude` / `codex` / `opencode` logins and the `gh` you already have, and every
  missing piece degrades gracefully instead of blocking you.
- 🖥️ **Built for a server (VPS mode).** cezar is made to live on a **VPS, cloud,
  or dedicated box** as an always-on janitor for your repo — headless-first, with
  a mobile-friendly cockpit you drive from anywhere. It's a coding server you can
  actually watch, not a desktop app bolted onto one machine.
- 🔀 **Parallel + autonomous orchestration.** The real edge: cezar runs **many
  agents at once** in isolated worktrees, **queues** the overflow, and pushes each
  one **autonomously** through skill playbooks — fire-and-forget. This is exactly
  what single-agent GUIs don't do well: they babysit one agent, while cezar
  orchestrates a whole team and drains your backlog while you're away.

---

## What it solves

Most "AI coding agent" tooling makes you choose between a **terminal** you can't
see into once it's running, and a **cloud product** that wants your API key, your
code on their servers, and an account. cezar is the third option: the agents run
locally under *your* subscription, a cockpit shows you exactly what they're doing,
and an orchestrator keeps a whole queue of them moving.

- 👀 **No visibility into a running agent.** A headless `claude` run is a black box
  until it finishes. cezar streams every step — agent text, each tool call and
  its result, tokens and cost per step — live, and keeps the full replay.
- 🧩 **One agent, one working tree, one thing at a time.** Kick off a second task and
  it fights the first over your files. cezar runs each task in its **own git
  worktree**, so two (or three) agents work in parallel without stepping on
  each other — or on the branch you're editing.
- 🗂️ **A backlog that needs babysitting.** Queue a stack of tasks and cezar
  **orchestrates** them: it runs up to your parallel limit and holds the rest in
  an ordered queue. Point it at a GitHub issue and it runs straight on that, so
  working the tracker down stops being a manual chore. Turn on the opt-in
  **Inbox** (`CEZ_FOLLOWUPS=1`) and an agent's leftover follow-ups become the
  next tasks too — one click each.
- 🤖 **"Autonomous" means you still have to sit there.** Flip the **Autonomous**
  flag and a run never parks to ask — it keeps going until the task is done. Pair
  it with a **skill** (a Markdown playbook) and you've got fire-and-forget
  automation: hand off "fix this", "upgrade that", "triage these" and walk away.
- ✅ **The agent finishes and you have to trust it.** cezar ends non-trivial runs at
  a **review gate**: inspect the diff, send notes back into the same session, or
  push a **draft PR** — never an auto-merge.
- ♻️ **Losing a session when it fails.** Every run records its `claude` session id.
  Take it over interactively in one click (`claude --resume <id>`), or continue it
  in-process from the cockpit.
- 🔀 **Locked into one agent vendor.** Most tools wed you to a single CLI. cezar
  drives **Claude Code, Codex and OpenCode (experimental)** through one runner seam — set a
  default, pick a backend per task, or mix them inside one workflow (implement
  with one agent, review with another) — and through **OpenCode** you can point
  a run at **open-source or local models**, not just the big vendors. See
  [Agent backends](#coding-agent-backends).
- 🖥️ **Close the laptop and the work stops.** A local agent only runs while your
  machine is on and awake. Put cezar on a **VPS, cloud box, or dedicated server**
  and the cockpit becomes the GUI for an **always-on AI coding team** — kick off,
  watch and steer tasks from your laptop or **phone**, on the train or between
  meetings, while the agents keep grinding through the backlog back on the server.
- ⚡ **Setup tax.** No wizard, no env vars, no schema. Skills are Markdown, workflows
  are short YAML, and everything degrades: no `gh` → works without PRs, no network
  → local skills still load, no `.ai/skills` → the bare prompt still runs.

---

## Who it's for

- **Solo devs and small teams** who want the leverage of coding agents without
  handing their code and keys to a SaaS — the agent runs on your subscription,
  on your machine.
- **`claude` CLI power users** who love headless runs but want to *see* them,
  compare a few attempts side by side, and review a diff before it lands.
- **Anyone with a backlog** who'd rather queue three tasks into isolated worktrees
  and pick the winners than babysit one terminal.
- **Teams with shared conventions** who want their playbooks (skills) pulled from
  a git repo, applied consistently, with zero per-project setup.

---

## Quick start

**Prerequisites:** Node 20+, at least one logged-in agent CLI — the
[`claude` CLI](https://github.com/anthropics/claude-code) (Pro/Max subscription),
the [`codex` CLI](https://github.com/openai/codex), or
[OpenCode](https://opencode.ai) — and, optionally, `git` and the `gh` CLI.

```bash
cd your-repo
npx cezar-cli              # start the cockpit for the current repo
#   or: npx @open-mercato/cezar
```

The cockpit opens at `http://localhost:4321` (auto-picks the next free port if
busy). Type a task, pick a workflow, hit **Start**. That's it.

```bash
npx cezar-cli run "add a --json flag to the export command"   # headless, CI-friendly
npx cezar-cli init                                            # scaffold .ai/cezar/
```

Both the `cezar` and `cez` commands are installed, so once it's on your PATH you
can run either. No API key is ever used — cezar shells out to whichever agent
CLIs you are already logged into, `claude` by default.

> **Contributing?** [Local development](#local-development) shows how to get a
> global `cezar` command straight off your checkout (`npm run install-as-command`)
> — no publish needed.

> **Just kicking the tires?** Set `CEZ_DRY_RUN=1` to run against a bundled mock
> instead of the real CLI — the whole cockpit works with no `claude` login, so
> you can explore runs, diffs, variants and the review gate offline.

### Preview builds

Every green CI run publishes an installable npm snapshot
([how it works](docs/publishing.md)), so you can try unreleased code without
cloning anything:

```bash
npx cezar-cli@develop      # current develop head
npx cezar-cli@main         # current main head (ahead of the latest stable release)
```

Every pull request gets its own preview too — the CI bot posts a sticky comment
on the PR with the exact pinned version to copy-paste
(`npx cezar-cli@<version>-pr<N>.<run>`). Previews are prerelease versions under
their own dist-tags; a plain `npx cezar-cli` always resolves to the latest
stable release.

---

## How it works

You describe a task. cezar runs it as a **workflow** — an ordered list of agent
steps and shell checks — shelling out to your locally installed agent CLI
(Claude Code by default; Codex and OpenCode are drop-in alternatives, per task
or per step). Each task gets its own git worktree; the cockpit streams every
event live and parks the run at a review gate when there's a diff to inspect.

```
   you type a task
        │
        ▼
   ┌─────────────┐   optional: Plan → AI drafts a chain of steps you approve
   │  workflow   │   (agent steps + shell checks, with bounded onFail retries)
   └─────────────┘
        │
        ▼
   ┌──────────────────────────────┐     ┌───────────────────────────────┐
   │  git worktree per task       │     │  agent CLI  (your login)      │
   │  (isolated branch, parallel) │◄───►│  claude · codex · opencode    │
   └──────────────────────────────┘     │  Bash open · no prompts       │
        │                                 └───────────────────────────────┘
        │  agent text · tool calls · tool results · tokens · cost
        ▼
   ┌─────────────┐   SSE (replay + live)   ┌──────────────────────────┐
   │ .ai/cezar/  │ ──────────────────────► │  cockpit  localhost:4321 │
   │ JSON·NDJSON │                         │  Tasks · Git · GitHub ·  │
   │ ·Markdown   │                         │  Skills · Workflows      │
   └─────────────┘                         └──────────────────────────┘
                                                  │
                                          review gate: read the diff →
                                          send notes back · draft PR · finish
```

When a check fails, the workflow can loop back to an earlier step (bounded by
`max`) with the failing output appended to the retried agent's prompt. Nothing
auto-merges: a run with changes rests in `review` until you act on it.

---

## Core concepts

Three words, no jargon — **task**, **skill**, **chain**:

- 📋 **Tasks** are the unit of work. Every task is a **run**: `queued → running →
  review / done / failed / cancelled`, with a live event log, per-step token and
  cost usage, cancel/delete, and — for anything with a diff — a review gate. Paste
  screenshots into the task, or send follow-up messages into the live session
  while it works.
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

Seven views, one browser window, all live over Server-Sent Events (six until you opt into the Inbox):

| View | What's in it |
|---|---|
| **Tasks** | Every task with its status, live event stream (agent text · tool calls · tool results · pasted/generated screenshots), tokens and cost. Continue, cancel, open in terminal (`claude --resume`), review the diff, or push a draft PR. |
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
it in. Each repo cezar boots in registers itself in a per-user registry at
`~/.cezar/config.json` — the workspace file that also holds the global knobs
(the parallel cap, the memory ceiling, the browse root, and the checkout root). Nothing is added to
the repo: per-project state stays exactly where it was, in that repo's
`.ai/cezar/`.

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
tasks intact. The project cezar is currently serving can't be removed: it
re-registers itself at the next start.

**From the terminal** — the same registry, no cockpit required (handy over ssh):

```bash
cezar projects                    # list: id, branch or status, path
cezar projects add ~/code/api     # register a folder (defaults to the current repo)
cezar projects remove api         # drop the registry entry; the repo is untouched
```

These read and write `~/.cezar/config.json` directly, so they work with the
server stopped, and `CEZ_HOME` selects which workspace they operate on.

Settings split along the same line: **Agents**, **Worktrees**, **Bookmarklets**,
**Prompt templates** and **MCP** describe one repo and live under
`/p/<projectId>/settings`; **Appearance**, **Notifications**, **Resources**,
**Projects** and **Keyboard** are yours or the machine's and live at
`/settings/global`.

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
    # runner: codex              # optional per-step backend: claude · codex · opencode
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
| `CEZ_AUTOSAVE=1` | Re-enable the periodic (90 s) autosave commit in task worktrees. Off by default (#471) — turn-end and pre-PR flushes always run, so branches still end complete. Every autosave names its trigger in the commit subject (`cezar autosave (periodic)` vs `(turn end)` / `(run finalize)` / `(pre-PR)`), so the flushes you keep are distinguishable from the timer you disabled. |
| `CEZ_CLAUDE_BIN=/path/to/claude` | Override which `claude` binary is used. |
| `CEZ_CODEX_BIN=/path/to/codex` | Override which `codex` binary is used. |
| `CEZ_OPENCODE_BIN=/path/to/opencode` | Override which `opencode` binary is used. |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME` | The agents' **own** variables, honoured where the vendor documents one. Setting one moves that agent's **default account** — the config folder cezar discovers. A *second* login of the same CLI is deliberately not an environment setting, since one process-wide value cannot differ per project: add it under **Settings → Agent accounts** and pick it per project. |
| `CEZ_BROWSE_ROOT=~/` | Default root for **Add project → Open local folder…**. The picker cannot navigate above it; a saved workspace value overrides the environment default and must name an existing folder. |
| `CEZ_PROJECTS_DIR=~/cezar/projects` | Default destination for **Clone from GitHub**. Saved workspace settings override it, and missing directories are created recursively. |
| `CEZ_SKILLS_AUTO_UPDATE=0` | Disable automatic checks and updates for upstream-CLI-tracked Open Mercato skill installations. On by default; a saved global Skills setting overrides this environment default. Checks are delayed, bounded, cached, and non-blocking. |
| `CEZ_AUTONOMOUS_DEFAULT=0` | Seed the New Task Autonomous default (`0` or `1`). Without a seed, skills default on and workflows off; a saved global Resources setting overrides it. |
| `CEZ_WORKTREE_DEFAULT=1` | Seed the New Task Worktree default (`0` or `1`). Without a seed, eligible runs default on; a saved global Resources setting overrides it. |
| `CEZ_SINGLE_PROJECT=1` | Opt into a launch-project-only cockpit: only the exact value `1` enables it. Project add, edit, checkout, folder browsing, and removal are refused and only the launch project is shown. Off by default; stored registry rows are retained, so unsetting it and restarting restores the full multi-project workspace without migration or data loss. |
| `CEZ_HIDE_TOKEN_USAGE=1` | Hide raw input/output token counts throughout the browser cockpit while leaving backend-reported cost visible. Only the exact value `1` enables it; telemetry and API payloads are unchanged, and a restart is required after changing it. |
| `CEZ_HIDE_COST=1` | Hide backend-reported monetary cost throughout the browser cockpit while leaving raw input/output token counts visible. Only the exact value `1` enables it; telemetry and API payloads are unchanged, and a restart is required after changing it. |
| `CEZ_HIDE_TOKEN_METRICS=1` | Legacy master switch that hides both token usage and cost. It takes precedence over the two independent flags; only the exact value `1` enables it, payloads are unchanged, and a restart is required. |
| `GITHUB_TOKEN` | Fallback for GitHub reads/PRs when `gh` isn't authenticated. |
| `CEZ_ENV_PASSTHROUGH=A,B` | Forward these extra host env vars to spawned agents. By default agents get a least-privilege env (safe shell/toolchain vars + the backend's own auth + `GITHUB_TOKEN` + `CEZ_*`), not your full environment — use this to add a var an agent needs. |
| `CEZ_AGENT_ENV_FULL=1` | Escape hatch: give spawned agents the full host environment (pre-hardening behavior). Off by default; only set it if you understand that this hands every host secret to the agent process. |
| `CEZ_REDACT_SECRETS=0` | Disable scrubbing of credential values/token shapes from the on-disk state (the NDJSON transcript and the free-text fields of `runs.json`). On by default; leave it on. Best-effort defense-in-depth, not a guarantee: it catches known token shapes and the values of your own secret-named env vars, so a credential in neither category can still get through. |
| `CEZ_TITLE_UPDATES=0` | Turn off the live task-title refresh (namer re-runs on each turn end). The Settings → Agents toggle overrides this default. |
| `CEZ_AUTONAME=0` | Disable ALL LLM task naming (creation + live) — titles stay heuristic (`437: /om-auto-review-pr`). Under `CEZ_DRY_RUN=1` naming is already off unless forced with `CEZ_AUTONAME=1`. |
| `CEZ_REVIEW_GATE=1` | Turn ON the optional diff-first review gate (#489): a successful, non-autonomous run with changes parks at `review` (Accept / Send back / Draft PR) instead of finishing. Off by default — changed runs settle to `done` with the diff left in the worktree. Only `1` enables. The Settings → Agents toggle overrides this; autonomous runs always skip it. |
| `CEZ_NO_BANNER=1` | Skip the `open-mercato/skills` banner on `cezar serve` startup. (The cockpit no longer shows a banner — its skills now live on the Skills page's Manage panel — so this env var is the terminal banner's only switch.) |
| `VITE_CEZ_API_BASE=http://localhost:4321` | **Build time only**, and only when the cockpit bundle is deployed apart from the service it talks to. Empty (the default) means "the origin that served this page", which is right for both normal cases: the CLI serves the bundle itself, and `npm run dev` proxies `/api` to the local service. A deployment that must be configured without a rebuild can put `<meta name="cez-api-base" content="…">` in the served HTML instead, which wins over this. |

---

## Coding agent backends

cezar is not married to one vendor. Every agent step runs through a single
`AgentRunner` seam with three built-in backends:

| Backend | CLI | How cezar drives it | Tool access |
|---|---|---|---|
| **Claude Code** (default) | [`claude`](https://github.com/anthropics/claude-code) | Headless `stream-json` mode. | Per-tool `--allowedTools` (`bashAllowlist` scopes `Bash`); `dontAsk` denies unapproved tools without prompting (`CEZ_APPROVAL_GATE=1` → `acceptEdits` + approval UI). |
| **Codex** | [`codex`](https://github.com/openai/codex) | `codex app-server` — JSON-RPC over stdio, the same transport the Codex IDE extensions use. | Ignores `allowedTools`; the default auto mode uses `danger-full-access` with `approvalPolicy: never` (`CEZ_CODEX_NETWORK=0` opts into the network-blocked `workspace-write` sandbox). |
| **OpenCode** _(experimental)_ | [`opencode`](https://opencode.ai) | `opencode serve` — a local HTTP server with an SSE event stream. | Ignores `allowedTools` entirely; every permission is auto-approved. |

> ⚠️ **OpenCode support is experimental.** The runner works but is less battle-tested
> than the Claude Code and Codex backends, and OpenCode auto-approves every permission
> (it ignores `allowedTools`). Treat it as a preview and expect rough edges.

On startup cezar probes which CLIs are installed and the cockpit only offers
the backends it found — install any one of the three and you're operational.

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
none of its own. [Details →](docs/server-install/ubuntu-vps.md#the-box-already-has-a-reverse-proxy-dokploy-coolify-caddy)

| Provider | `--platform` | Public front | Guide |
|----------|--------------|--------------|-------|
| Ubuntu / Debian VPS | `ubuntu-vps` | nginx + Let's Encrypt HTTPS, htpasswd login, systemd | [Step-by-step →](docs/server-install/ubuntu-vps.md) |
| Ubuntu + existing proxy | `ubuntu-vps --external-proxy` | your Dokploy/Traefik/Caddy front; cezar ships the service only | [Step-by-step →](docs/server-install/ubuntu-vps.md#the-box-already-has-a-reverse-proxy-dokploy-coolify-caddy) |
| macOS + ngrok | `macosx-ngrok` | ngrok tunnel + `--basic-auth`, launchd | [Step-by-step →](docs/server-install/macosx-ngrok.md) |

See the **[Remote access overview](docs/server-install/README.md)** for how it
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
  "defaultRunner": "claude", // agent backend: "claude" (default) · "codex" · "opencode"
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

## Local development

End-to-end, from a fresh clone to a global `cezar` command you can run in **any**
repo on your machine — no npm publish required.

**1. Prerequisites** — Node 20+ and `git` (plus at least one logged-in agent CLI,
as in [Quick start](#quick-start)).

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

## Relationship to cezar (the SaaS)

cez is the radically-simple, single-user sibling of
[**cezar**](https://github.com/comerito/cezar) — the team SaaS cockpit for
running agents across the whole GitHub issue lifecycle (auto-triage, webhooks,
Supabase, multi-repo). Same core ideas — agent runner, skills, declarative
workflows, a live run cockpit — with none of the accounts, database or cloud.
Start here; graduate to cezar when a team needs shared visibility.

---

## License

**MIT** © Patryk Lewczuk
