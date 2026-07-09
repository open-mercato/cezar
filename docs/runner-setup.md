# Self-hosted runner setup

Cezar runs agent jobs on **runners**. There are two kinds:

- **Managed cloud runner** — Cezar's own infrastructure. Handles `anthropic-api`
  jobs (today via the `/api/cron/dispatch` route; a dedicated cloud-runner
  container later). Uses an `ANTHROPIC_API_KEY`, not anyone's personal
  subscription. You don't set this up — it's just there.
- **Self-hosted runner** — a small daemon (`@cezar/runner`, the `cezar-runner`
  CLI) you run on your own host. It picks up `claude-cli` / `codex-cli` jobs and
  drives the Claude Code / OpenAI Codex CLIs **under your own logged-in
  subscription** on **your own** machine. This is the only supported way to use
  the subscription CLIs (see the ToS note below).

This doc covers standing up a self-hosted runner. For the GitHub App side
(installation, permissions, webhook), see [`github-app-setup.md`](./github-app-setup.md).

## 1. Build the runner

From the repo root:

```bash
yarn install
yarn workspace @cezar/runner build
```

This produces the `cezar-runner` binary (`packages/runner/dist/cli.js`). Run it
via `node packages/runner/dist/cli.js …`, or put it on your PATH globally with
`yarn link:bins` (from the repo root; `yarn unlink:bins` removes it).

## 2. Mint a join token in the web app

Runners register **themselves** — you never create a runner row by hand.

1. In the Cezar web app, go to **Settings → Runners**.
2. Click **Mint join token** (any workspace member can; give it a label like
   `laptop` or `ci-box` if you'll mint several).
3. Copy the **join token**. **It is shown once and never again** — only a
   SHA-256 hash is stored. Unlike the old per-runner token it is *reusable*:
   the same join token can register any number of runners across devices,
   until you revoke it.

A runner registered with your join token **belongs to you**: jobs you trigger
in the GUI route to *your* runners; jobs another user triggers route to
*theirs*. System-initiated jobs (webhooks, sweeps) can run on any runner in
the workspace. Runners are identified by *(workspace, owner, name)* — starting
a runner again with the same name re-keys the existing registration instead of
creating a duplicate.

The page also shows a ready-to-paste `cezar-runner start …` command with the
join token filled in.

## 3. Check the CLIs on the runner host

```bash
cezar-runner login
```

This checks whether `claude` and/or `codex` are installed and on `PATH`, and
tells you which `claude login` / `codex login` to run. Log in to whichever
subscription CLIs the runner will use, **as the user whose subscription should
be billed** — those credentials live on this host only; Cezar never sees them.

## 4. Start the runner

```bash
cezar-runner start \
  --url https://<your-cezar-host> \
  --join-token <join-token-from-step-2>
```

Or via environment variables instead of flags:

```bash
export CEZAR_RUNNER_URL=https://<your-cezar-host>
export CEZAR_RUNNER_JOIN_TOKEN=<join-token-from-step-2>
cezar-runner start
```

On first start the daemon registers itself (name defaults to the hostname —
override with `--name` / `CEZAR_RUNNER_NAME`; backends are auto-detected from
the CLIs on `PATH` — override with `--backends`), then persists the resulting
per-runner credential in `~/.cezar-runner/credentials.json` (`0600`; override
the directory with `CEZAR_RUNNER_STATE_DIR`). Later starts reuse the persisted
credential, and if the SaaS ever rejects it (you revoked the runner, or the
database was reset) the daemon automatically re-registers with the join token.

A runner registered before the join-token flow keeps working: pass its
pre-issued token via `--token` / `CEZAR_RUNNER_TOKEN` and registration is
skipped entirely. **Deprecated — `--token` / `CEZAR_RUNNER_TOKEN` will be
removed in v0.3.0**; re-register through a join token before upgrading (this
also gives the runner an owner, without which it only receives
system-initiated jobs).

In the Docker compose stack, set `CEZAR_RUNNER_JOIN_TOKEN` in `.env` — the
`runner` service self-registers as `compose-runner` on first boot and keeps
its credential in the `runner-home` volume.

The daemon polls the SaaS for jobs matching its advertised backends, claims one,
clones the repo into a worktree, runs the agent there (sandboxed to the worktree
— `claude` via `--allowedTools` / scoped `Bash(prefix:*)` patterns; `codex` via
`-s workspace-write --cd <worktree>`), streams events back, and heartbeats so the
web app shows it as `online`. Run it under a process supervisor (systemd, pm2,
`tmux`, …) so it restarts on reboot.

## 5. The managed cloud runner

You don't configure this. `anthropic-api` jobs are dispatched to Cezar's own
infrastructure regardless of what self-hosted runners are connected; self-hosted
runners only ever pick up the `claude-cli` / `codex-cli` jobs they advertised.
A workspace can run with *only* the managed cloud runner (API-key path) and add
self-hosted runners later — or never.

## 6. Terms-of-service note

The Claude Code and OpenAI Codex CLIs authenticate against a **personal
subscription**. Run them **only on your own infrastructure under your own
logged-in account** — that's exactly what a self-hosted runner is. Cezar's
managed cloud runner does **not** use anyone's personal subscription; it uses an
API key. Don't try to point a self-hosted `claude-cli` / `codex-cli` runner at a
subscription that isn't yours.

## 7. Known caveat — in-flight jobs on a crash

A runner executes each job as a subprocess of the daemon. If the daemon crashes
or is restarted while a job is running, that job is **re-queued** by the SaaS
stalled-job watchdog (it notices the missing heartbeats / no progress) and a
healthy runner picks it up again. So a runner restart is safe — at worst a job
re-runs from the start. To take a runner down gracefully, revoke it in
**Settings → Runners** (its token stops working immediately) or stop the daemon
and let any in-flight job re-queue.
