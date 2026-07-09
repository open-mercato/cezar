# Self-hosting

How to run Cezar on your own infrastructure — both the managed-runner side and
the self-hosted-runner daemon.

- [Self-hosted runner](#self-hosted-runner)
- [Skill-source sync needs git + a writable home](#skill-source-sync-needs-git--a-writable-home)
- [Configuration](#configuration)
- [Environment variables](#environment-variables)

---

## Self-hosted runner

The `@cezar/runner` daemon claims jobs whose backend it serves — `claude-cli`
or `codex-cli` — so subscription CLIs run under *your* login on *your* infra.
Cron-dispatched jobs (`anthropic-api`) stay on the managed path.

```bash
yarn workspace @cezar/runner build

# verify `claude` / `codex` are on PATH and logged in
node packages/runner/dist/cli.js login

# start the daemon (or `cezar-runner start ...` if linked)
node packages/runner/dist/cli.js start \
  --url   https://app.example.com \
  --token <runner-token> \
  --backends claude-cli,codex-cli
```

What it needs:

- **`claude` / `codex` on PATH** and logged in for the relevant backends.
- **`git`** on PATH. The runner clones repos to `~/.cezar/runner-repos`.
- A **runner token** created on **Settings → Runners** (shown once, stored
  hashed server-side).

The runner never sees a Supabase credential — the SaaS mints a short-lived
GitHub App token per job and ships it (plus the merged workspace config and
the issue store snapshot) in the claim response. Heartbeats every few seconds;
stalled jobs are re-queued by the dispatcher.

![Settings → Runners — registered runners with backend tags and heartbeat, plus a one-time token + ready-to-paste start command](images/cezar-setting-runner.png)

![Register a runner — name it, pick which backends (`claude-cli` · `codex-cli` · `anthropic-api`) it will serve](images/cezar-settings-runner-register.png)

See also [`runner-setup.md`](runner-setup.md) and
[`claude-subscription-runner.md`](claude-subscription-runner.md) for deeper
runner notes.

---

## Skill-source sync needs git + a writable home

Syncing a **workspace repo** or an **external skill repo** (the *Refresh* button
on **/skills → Sources**) shells out to the `git` binary and writes a clone
under `homedir()/.cezar/` (`repos/` for workspace repos, `external-skills/` for
external sources). Both run inside a Next.js **server action**, so the host that
serves the GUI must provide:

- a **`git` binary** on PATH, and
- a **writable home directory** (`$HOME`).

This rules out a pure read-only / ephemeral serverless target (e.g. stock
Vercel) **for that sync operation** — there is no `git` and the filesystem is
read-only. Run the GUI on a host that satisfies the two requirements above
(a long-lived container / VM, the same model `@cezar/runner` already assumes).

Note this only affects the admin-triggered **sync**. Dispatch is unaffected:
synced skill bodies are cached inline in the database (`external_repo_skills`,
`repo_skills`), so agent runs never re-clone at dispatch time.

---

## Configuration

The CLI uses [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig)
(`.issuemanagerrc.json` / `.yaml` / `issuemanager.config.js`). Example:

```json
{
  "github":  { "owner": "your-org", "repo": "your-repo" },
  "llm":     { "model": "claude-sonnet-4-6", "maxTokens": 4096 },
  "store":   { "path": ".issue-store" },
  "sync":    { "includeClosed": false, "digestBatchSize": 20 },
  "autofix": { "skillsDir": ".ai/skills" }
}
```

The SaaS path stores per-workspace config in Supabase; the same shape applies.

---

## Environment variables

The full template with every supported variable is in
[`../.env.docker.example`](../.env.docker.example). The key ones:

| Var | Used by |
|---|---|
| `GITHUB_TOKEN` | CLI / OAuth fallback for the GitHub API |
| `ANTHROPIC_API_KEY` | Claude API — digests + agent runs on the managed path |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | GitHub App auth (short-lived install tokens) |
| `GITHUB_APP_WEBHOOK_SECRET` | Webhook signature verification (until set, the receiver returns 503) |
| `CRON_SECRET` | Bearer check shared by `/api/cron/*` routes |
| `CEZAR_RUNNER_URL` / `CEZAR_RUNNER_JOIN_TOKEN` | `@cezar/runner` connection defaults (join token minted in Settings → Runners) |
| `CEZAR_RUNNER_TOKEN` | **Deprecated — removed in v0.3.0.** Pre-issued runner token; migrate to `CEZAR_RUNNER_JOIN_TOKEN` |
| Supabase + `NEXT_PUBLIC_APP_URL` | GUI |

The CLI auto-loads `.env` from the project root; env vars override config-file
values.
