<p align="center">
  <img src="docs/brand/cezar-icon-black.svg" alt="" width="104" />
</p>

<div align="center">
  <h1>Cezar - orchestrate hundreds of AI coding agents, 24/7.</h1>
</div>

<p align="center">
  <a href="https://www.youtube.com/watch?v=nNLJm9gArnE">Demo</a>&nbsp;·
  <a href="#quick-start">Quick start</a>&nbsp;·
  <a href="docs/reference.md">Docs</a>&nbsp;·
  <a href="https://github.com/open-mercato/cezar/issues">Issues</a>
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
</p>

<div align="center">
  <h2>
    One control center for Claude Code, Codex, OpenCode and other coding agents.<br />
    Run agents locally or on a VPS, automate multi-step workflows,<br />
    and let them keep working while you're away.
  </h2>
</div>

<p align="center">
  <a href="https://cezar.run/">
    <img alt="Website: cezar.run" src="https://img.shields.io/badge/website-cezar.run-9655FD" /></a>
  <a href="LICENSE">
    <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <a href="https://www.npmjs.com/package/@open-mercato/cezar">
    <img alt="npm version" src="https://img.shields.io/npm/v/@open-mercato/cezar" /></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-20%2B-339933" />
  <a href="https://github.com/open-mercato/cezar/pulls">
    <img alt="PRs welcome!" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat" /></a>
</p>

<p align="center">
  <a href="https://openmercatocloud.com/247agentic-cear" target="_blank" rel="noopener">
    <img src="docs/screenshots/cloud-banner.svg" alt="Use cezar on a cloud sandbox for 24/7 coding. Start for free." width="720" /></a>
</p>

<div align="center">
  <a href="https://www.youtube.com/watch?v=nNLJm9gArnE" target="_blank" rel="noopener">
    <img src="docs/screenshots/video-thumbnail.jpg" alt="Meet Cezar, your new parallel coding tool (video)" width="720" />
  </a>
  <p align="center"><em>▶ Watch the video: Meet cezar, your new parallel coding tool.</em></p>
</div>

## Features

- 💯&nbsp;Free and open source.
- 🖥️&nbsp;Uses your own `claude`, `codex`, `copilot`, `cursor`, `junie`, `opencode` or `pi` login. No API key needed.
- ☁️&nbsp;Easy to set up on a VPS, so your agents keep working when your laptop is closed.
- 📱&nbsp;Fully responsive. Start and review tasks from your phone.
- 🔀&nbsp;Every task gets its own git worktree, so several agents can work at the same time. Extra tasks wait in a queue.
- 🤖&nbsp;Turn on **Autonomous** and a run never stops to ask. It just finishes.
- 📡&nbsp;Watch it work live: agent text, tool calls, tokens and cost.
- 🏁&nbsp;Run the same task ×2 or ×3, compare the diffs and keep the best one.
- 🧩&nbsp;Skills are Markdown files and workflows are short YAML files. Mix agents per step.
- 🐙&nbsp;Run the agent straight on a GitHub issue. Nothing merges on its own.
- 📂&nbsp;One cockpit for all your projects.
- 📊&nbsp;A workspace dashboard shows what needs you, what is running and what finished across your projects.
- 💸&nbsp;Track reported cost and token usage by project in **Usage & cost**.
- ⏰&nbsp;Schedule recurring work or launch tasks from GitHub and supported tracker events with **Automations**.
- 🌳&nbsp;Agents can delegate independent work to child tasks, each in its own worktree, and receive their reports in the parent session.
- 🎫&nbsp;Connect **Jira or Linear** to browse issues and launch tasks from your project tracker.
- 💾&nbsp;No database. Everything is saved as plain files in `.ai/cezar/`.

## Screenshots

**Parallel tasks** — Run and queue many tasks, each in its own git worktree.

[![Parallel tasks: Run and queue many tasks, each in its own git worktree.](docs/screenshots/task-view.png)](docs/screenshots/task-view.png)

**Live run** — Every step, tool call and token, as it happens.

[![Live run: Every step, tool call and token, as it happens.](docs/screenshots/live-run.png)](docs/screenshots/live-run.png)

**Variants** — Run a task ×2 or ×3 and keep the best diff.

[![Variants: Run a task ×2 or ×3 and keep the best diff.](docs/screenshots/variants-compare.png)](docs/screenshots/variants-compare.png)

**Workflows** — Drag skills and checks into a chain, saved as YAML.

[![Workflows: Drag skills and checks into a chain, saved as YAML.](docs/screenshots/workflow-builder.png)](docs/screenshots/workflow-builder.png)

**GitHub** — Hand an open issue to the agent in one click.

[![GitHub: Hand an open issue to the agent in one click.](docs/screenshots/github-issues.png)](docs/screenshots/github-issues.png)

**Skills + Autonomous** — Pick a playbook, flip Autonomous and walk away.

[![Skills + Autonomous: Pick a playbook, flip Autonomous and walk away.](docs/screenshots/skills-autonomous.png)](docs/screenshots/skills-autonomous.png)

**Dashboard** — See what needs your input or review, what is running and what finished across your workspace.

[![Dashboard: Workspace task counts, review requests and recent results.](docs/screenshots/dashboard.png)](docs/screenshots/dashboard.png)

**Usage & cost** — Compare reported spend and token usage across projects.

[![Usage and cost: Reported spend, input and output tokens, and a project breakdown.](docs/screenshots/usage-costs.png)](docs/screenshots/usage-costs.png)

**Automations** — Schedule maintenance and reviews, and see the week ahead alongside GitHub triggers.

[![Automations: A weekly calendar of scheduled tasks and a pull-request review trigger.](docs/screenshots/automation-calendar.png)](docs/screenshots/automation-calendar.png)

**On your phone** — the same cockpit, from the task list to the diff.

<table>
  <tr>
    <td width="33%"><img src="docs/screenshots/mobile-tasks.png" alt="Task list on mobile" /></td>
    <td width="33%"><img src="docs/screenshots/mobile-session.png" alt="A session on mobile" /></td>
    <td width="33%"><img src="docs/screenshots/mobile-review.png" alt="Reviewing a diff on mobile" /></td>
  </tr>
</table>

## Quick start

You need **Node 20+** and at least one agent CLI you're logged into:
[Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex),
[GitHub Copilot CLI](https://github.com/github/copilot-cli), [OpenCode](https://opencode.ai),
[Cursor Agent](https://cursor.com/docs/cli/overview), [Junie](https://junie.jetbrains.com/cli) or [pi](https://github.com/badlogic/pi-mono).
`git` and `gh` are optional.

```bash
cd your-repo
npx cezar-run
```

This opens the cockpit at `http://localhost:4321`. Type a task, pick a workflow, then hit **Start**. `npx cezar-cli` still works too — it's the same package under its older name.

```bash
npx cezar-run run "add a --json flag to the export command"   # headless, no browser
npx cezar-run init                                            # scaffold .ai/cezar/
npx cezar-run@nightly                                         # try tonight's build
```

> Just want to look around? Run `CEZ_DRY_RUN=1 npx cezar-run`. It uses a built-in mock agent, so you don't need to log in.

### Run it on a server

```bash
npx cezar-run server-install --platform ubuntu-vps
```

This sets up HTTPS, a login and a system service, so you can open the cockpit from anywhere, including your phone.
There are guides for [Ubuntu VPS](docs/server-install/ubuntu-vps.md) and [macOS + ngrok](docs/server-install/macosx-ngrok.md).

## How it works

1. **You describe a task.** Type it, attach files, or start from a GitHub issue.
2. **cezar runs a workflow** (agent steps plus shell checks) in a new git worktree, using your agent CLI.
3. **The cockpit streams every step live.** If a check fails, the agent tries again and sees the error.
4. **You check the result.** Read the diff, send notes back, or open a draft PR.

A workflow is a small YAML file in `.ai/cezar/workflows/`:

```yaml
name: fix-and-verify
steps:
  - id: implement
    prompt: "{{task}}"
    skill: project-conventions   # optional: a Markdown skill from .ai/skills
    runner: codex                # optional: which agent runs this step
  - id: verify
    command: "npm test"          # exit 0 = pass
    onFail: { retry: implement, max: 2 }
```

The built-in `quick-task` workflow runs with no setup.

## Automations

Turn repeatable work into an automation: check dependencies every morning, draft
release notes on Fridays, or review each new pull request. Each match or scheduled
occurrence launches an ordinary cezar task with the workflow and agent you choose.

Create one in **Automations**, or ask the agent to set it up from a prompt.
Preview event filters before enabling them. The list shows triggers, upcoming
runs and recent outcomes; pause an automation whenever you need to.

[![Automation list: Triggers, next runs and recent task outcomes.](docs/screenshots/automations.png)](docs/screenshots/automations.png)

## Task dispatch

For independent pieces of work, an agent can dispatch child tasks — for example,
changes in separate modules or a fresh review of a finished branch. Each child
gets its own worktree, appears under its parent in the task list and reports back
into the parent session.
cezar limits a parent to four children in flight; when a parent has a budget,
its children share that budget. Nothing auto-merges.

## Documentation

The [reference](docs/reference.md) covers everything else:
[configuration](docs/reference.md#configuration-optional),
[environment variables](docs/reference.md#how-it-runs-agents),
[agent backends](docs/reference.md#coding-agent-backends),
[multiple projects](docs/reference.md#multiple-projects-one-cockpit),
[remote access](docs/reference.md#remote-access-host-cezar-on-a-server) and
[local development](docs/reference.md#local-development).

## Contributing

- Found a bug or missing something? [Open an issue](https://github.com/open-mercato/cezar/issues).
- Want to contribute? PRs are welcome. See [local development](docs/reference.md#local-development) to get started:

```bash
git clone https://github.com/open-mercato/cezar.git && cd cezar
npm install
npm run dev
```

## License

**MIT** © Patryk Lewczuk. Full text in [LICENSE](LICENSE).

## Jira and Linear

Connect a project issue tracker in Settings to browse issues, launch workflows and configure event automations. See [setup, permissions and recovery](docs/issue-trackers.md).
