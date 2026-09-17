<div align="center">
  <h1>cezar ⚡</h1>
</div>

<h4 align="center">
  <a href="https://www.youtube.com/watch?v=nNLJm9gArnE">Demo</a>&nbsp;·
  <a href="#quick-start">Quick start</a>&nbsp;·
  <a href="docs/reference.md">Docs</a>&nbsp;·
  <a href="https://github.com/open-mercato/cezar/issues">Issues</a>
</h4>

<div align="center">
  <h2>
    Run coding agents in parallel, right in your repo.<br />
    Local, zero config, no accounts.
  </h2>
</div>

<p align="center">
  <a href="LICENSE">
    <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <a href="https://www.npmjs.com/package/@open-mercato/cezar">
    <img alt="npm version" src="https://img.shields.io/npm/v/@open-mercato/cezar" /></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-20%2B-339933" />
  <a href="https://github.com/open-mercato/cezar/pulls">
    <img alt="PRs welcome!" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat" /></a>
</p>

<div align="center">
  <a href="https://www.youtube.com/watch?v=nNLJm9gArnE" target="_blank" rel="noopener">
    <img src="docs/screenshots/video-thumbnail.jpg" alt="Meet Cezar, your new parallel coding tool (video)" width="720" />
  </a>
  <p align="center"><em>▶ Watch the video: Meet cezar, your new parallel coding tool.</em></p>
</div>

## Features

- 💯&nbsp;Free and open source.
- 🖥️&nbsp;Uses your own `claude`, `codex`, `opencode` or `pi` login. No API key needed.
- ☁️&nbsp;Easy to set up on a VPS, so your agents keep working when your laptop is closed.
- 📱&nbsp;Fully responsive. Start and review tasks from your phone.
- 🔀&nbsp;Every task gets its own git worktree, so several agents can work at the same time. Extra tasks wait in a queue.
- 🤖&nbsp;Turn on **Autonomous** and a run never stops to ask. It just finishes.
- 📡&nbsp;Watch it work live: agent text, tool calls, tokens and cost.
- 🏁&nbsp;Run the same task ×2 or ×3, compare the diffs and keep the best one.
- 🧩&nbsp;Skills are Markdown files and workflows are short YAML files. Mix agents per step.
- 🐙&nbsp;Run the agent straight on a GitHub issue. Nothing merges on its own.
- 📂&nbsp;One cockpit for all your projects.
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
[OpenCode](https://opencode.ai) or [pi](https://github.com/badlogic/pi-mono).
`git` and `gh` are optional.

```bash
cd your-repo
npx cezar-cli
```

This opens the cockpit at `http://localhost:4321`. Type a task, pick a workflow, then hit **Start**.

```bash
npx cezar-cli run "add a --json flag to the export command"   # headless, no browser
npx cezar-cli init                                            # scaffold .ai/cezar/
npx cezar-cli@nightly                                         # try tonight's build
```

> Just want to look around? Run `CEZ_DRY_RUN=1 npx cezar-cli`. It uses a built-in mock agent, so you don't need to log in.

### Run it on a server

```bash
npx cezar-cli server-install --platform ubuntu-vps
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
