# Browser and mobile e2e as a cezar verification step

A cezar check step is a shell command: exit 0 passes, non-zero can loop the
agent back with the failing output. That is all an agentic end-to-end runner
needs to become the thing that *judges* an agent's work — not a test suite the
agent runs for itself, but a second opinion the task cannot finish without.

This page wires up [`e2e`](https://github.com/tester-army/e2e) (TesterArmy's
agentic e2e framework: `npx e2e run` for tests, `npx e2e explore` for a goal
with no test file). Nothing here is e2e-specific in the engine — a Playwright,
Cypress or Maestro suite plugs in the same way — but e2e is the one whose exit
codes and reports were designed for an agent to read, and it is what the
examples use.

---

## Before the first run

In the repo you want tested (not in cezar):

```bash
npx e2e init          # e2e.config.ts, tests/, the skill, .mcp.json, a test:e2e script
git add -A && git commit -m "add e2e"
```

Commit it. A cezar task runs in a **fresh git worktree**, so anything a check
step needs has to be in the tree it forks from — an uncommitted `e2e.config.ts`
is not there.

Three things `init` leaves behind matter to cezar:

| What | Why cezar cares |
| --- | --- |
| `.agents/skills/e2e/` (+ `.claude/skills/e2e/`) | cezar discovers both — the `e2e` skill shows up in the Workflows palette and can be named by `skill: e2e` on any agent step |
| a `test:e2e` script | the **Plan first** button detects it and offers it as a verification check |
| `e2e.config.ts` | detected too, as `npx e2e run`, when there is no script |

## Level 1 — e2e as a check

```yaml
# .ai/cezar/workflows/implement-and-e2e.yaml
name: implement-and-e2e
description: Implement, unit-test, then prove it in a real browser.
steps:
  - id: deps
    name: Install
    command: "npm ci --prefer-offline --no-audit"

  - id: implement
    name: Implement
    prompt: "{{task}}"

  - id: unit
    name: Unit tests
    command: "npm test"
    onFail:
      retry: implement
      max: 2

  - id: browser
    name: Browser e2e
    command: |
      npx e2e run --reporter list,markdown; code=$?
      [ -f .e2e/summary.md ] && cat .e2e/summary.md
      exit $code
    onFail:
      retry: implement
      max: 2
      retryOn: [1]
```

A check step may come **first** — that is the `deps` step above, and it is not
optional: a worktree has no `node_modules`, and a bare `npx e2e` with none
would fetch the latest `e2e` from the registry instead of the version the repo
pins, then fail to resolve the config's own imports. Browsers are not a
per-worktree cost: they live in a shared user cache, a missing one downloads
once before the run's clock starts, and `npx @e2e-dev/web install chromium`
does it ahead of time.

### Why `retryOn: [1]`

`npm test` exits 1 for everything, so looping on any non-zero code is right
for it. An agentic runner reports more than a verdict:

| Exit | e2e means | Worth another agent attempt? |
| ---: | --- | --- |
| 0 | passed (or flaky, or skipped) | — |
| 1 | a test, setup or assertion failed; an exploration found a defect | **yes** — this is about the diff |
| 2 | CLI, config, collection, dependency, credential, model-config or policy error | no |
| 3 | engine, app-process, model-provider or artifact failure | no |
| 4 | internal runner error | no |
| 130 | interrupted | no |

Without the gate, a missing `AI_GATEWAY_API_KEY` (exit 2) spends a full agent
session per `max` trying to fix a credential that is not in the worktree.
`retryOn: [1]` loops on the verdict and fails the run on the infrastructure,
naming the code in the rail and the run error. Omit `retryOn` and any failure
loops back, exactly as before this field existed.

## Level 2 — the failure goes back to the agent

That is already what the `onFail` loop does, and it is the reason to prefer
`--reporter list,markdown` over bare output: when a check loops back, cezar
appends its output (capped at 20 000 characters) to the retried agent's prompt
under *"A verification command failed after the previous attempt. Fix the
cause."* `summary.md` is written for exactly that — counts, errors, and the
failing line, steps and screen for each failure — where a raw `report.json` is
megabytes of context nobody can afford.

Two things make the loop land better:

**Point the implementing step at the evidence.** The retried agent sees the
output, not the artifacts, and it has Read and Bash in the worktree:

```yaml
  - id: implement
    name: Implement
    prompt: |
      {{task}}

      If a browser check fails, read .e2e/summary.md and the pages under
      .e2e/failures/ before changing anything — they carry the failing line,
      the steps, the recent model turns and the screen at failure. Use the
      `e2e` skill for anything you change under tests/.
```

**Give every parallel task its own port.** cezar runs tasks concurrently, each
in its own worktree, so a fixed `localhost:3000` in `e2e.config.ts` is a race
between two tasks. e2e allocates one per run when the URL asks for port 0 and
the app command takes the `{port}` placeholder:

```ts
// e2e.config.ts
app: {
  url: 'http://127.0.0.1:0',
  command: { executable: 'npm', args: ['run', 'dev', '--', '--port', '{port}'], env: { PORT: '{port}' } },
},
```

Use `127.0.0.1`, not `localhost` (which e2e rejects with port 0). On a Next.js
dev target, add `allowedDevOrigins: ['127.0.0.1']` to `next.config.ts` or the
page renders and never hydrates.

## Level 3 — an independent QA pass

`e2e explore` takes a goal instead of a test file: it plans its own steps,
drives the app, reports findings with evidence, and exits 1 when it finds a
functional defect (a cosmetic `warning` does not fail it). As a check step it
is a second agent judging the first one's work, with no cezar agent step and
no prompt to write:

```yaml
  - id: qa
    name: QA exploration
    command: |
      npx e2e explore 'Use the part of the app this task changed the way a skeptical first-time user would, and report anything that misbehaves.' --max-steps 10 --reporter list,markdown; code=$?
      [ -f .e2e/summary.md ] && cat .e2e/summary.md
      exit $code
    onFail:
      retry: implement
      max: 1
      retryOn: [1]
```

Budgets are bounded by design: 1–12 steps (8 by default) and a 3–15 minute
wall clock, which is what makes this safe as a step in an unattended chain.
Exploration ignores the replay cache, so every step is live model calls — keep
`max` low.

For the richer version, the second agent *runs the campaign*: it reads the
diff, writes charters, fans out several explorations, triages what the local
environment explains, and proves each surviving finding with a repro test.
That is e2e's own `bug-bash` skill topic, and it is an agent step — ideally on
a **different backend** than the one that wrote the code, so the reviewer's
blind spots are not the author's:

```yaml
  - id: bug-bash
    name: QA agent
    runner: codex
    skill: e2e
    prompt: |
      Bug bash the change on this branch (`git diff main...HEAD`). Follow the
      bug-bash topic of the e2e skill: plan charters, run them, triage, and
      prove every surviving finding with a repro test.

      Write every repro test under `tests/repro/` and tag it `repro` — the next
      step runs exactly that directory, so a repro test written anywhere else
      leaves the gate green with the bug still in.

      Report what reproduced. Do NOT change application code — you are the
      reviewer, not the author.
    allowedTools: [Read, Grep, Glob, Bash, Write]

  - id: qa-gate
    name: QA verdict
    command: "npx e2e run tests/repro --pass-with-no-tests --reporter list,markdown"
    onFail:
      retry: implement
      max: 1
      retryOn: [1]
```

A repro test fails until its bug is fixed, so the gate is simply "do the repro
tests pass": green when nothing reproduced (`--pass-with-no-tests`), red with
the failure that the implementing step then has to fix. For the same reason a
repro test has to stay out of the suite that gates everything else until it is
fixed — tag them and add `--exclude-tag repro` to the level-1 run.

Note that ending a workflow with a check means the last agent step is not
interactive: the run goes to the review gate instead of leaving a session open
for follow-ups.

---

## What cezar gives the check, and what it does not

- **cwd** is the task's worktree, and the command runs under `bash -lc`.
- **Environment** is the cezar server's own `process.env` plus the **secrets**
  the step may read (below). There is no per-step `env:` — workflow files are
  committed, and a secret's value does not belong in them; a step names the
  secrets it needs instead. Tests with no agent step need no model at all.
- **Model credentials go in `cezar secrets`, not in your shell.** Store the
  key your provider reads once per project:

  ```bash
  printf %s "$MY_GATEWAY_KEY" | cezar secrets set AI_GATEWAY_API_KEY
  cezar secrets list              # names and audiences — a value never comes back out
  cezar secrets unset AI_GATEWAY_API_KEY
  ```

  (or Settings → *Secrets* in the cockpit; `--workspace` / Settings → Global →
  *Secrets* for a key every project shares). `set` reads the value from stdin —
  run it bare to type it at a hidden prompt — so it never lands in shell history
  or `ps`. The values are handed to this project's **check steps only** and live
  encrypted under `~/.cezar/secrets/`, with the data key in your OS keychain
  when one is available (see [reference](reference.md#workflows) for the file
  fallback). A check step gets every secret stored for check steps by default,
  or exactly the ones it binds:

  ```yaml
  - id: e2e
    command: npx e2e run
    secrets: [AI_GATEWAY_API_KEY]
  ```

  A stored value of **12 characters or more** is also redacted from the check's
  output and from the failing output fed back to the agent — the same floor
  `MIN_SECRET_LEN` applies to the host's own secret-named variables, because
  below it a "secret" is too common a word to replace safely (`POSTGRES_PASSWORD=postgres`
  once turned `apt install postgresql-16` into `apt install [REDACTED]ql-16`).
  A shorter value is stored and injected like any other, but it is **not**
  scrubbed from the run transcript or the retry prompt, so keep anything that
  must not be logged above the floor — every real API key already is.

  **Why not just `export ANTHROPIC_API_KEY` before starting cezar?** Because
  cezar passes provider-prefixed variables (`ANTHROPIC_*`, `OPENAI_*`, …) to
  the agents it starts. A key exported for e2e would reach every Claude Code or
  Codex session too, and switch it from the subscription account you chose in
  Agent accounts to API billing — silently. A secret never reaches an agent:
  agents are not an audience a secret can have.
- **Use an API key or a service-account key**, not a subscription login: a
  check runs unattended, and `npx e2e login`-style sessions are not supported
  there.
- **`CI` is not set**, so e2e uses its local defaults: no retries, workers at
  half the cores, and a read-write replay cache — a verified `agent.act`
  recorded on one attempt replays without a model call on the next. Set `CI=1`
  in the command to get the stricter CI defaults instead.
- **The replay cache can be shared across tasks.** Every task starts in a
  fresh worktree, and `.e2e/cache/` is gitignored, so by default each task
  re-records every `agent.act`. cezar hands each check `CEZ_SHARED_CACHE_DIR`
  (`~/.cezar/cache/<project>`, one per project) — point the cache there:

  ```ts
  // e2e.config.ts
  import { join } from 'node:path'
  cache: {
    mode: 'read-write',
    dir: process.env.CEZ_SHARED_CACHE_DIR ? join(process.env.CEZ_SHARED_CACHE_DIR, 'e2e') : '.e2e/cache',
  },
  ```

  cezar hands every parallel task the same directory and takes no lock on it —
  it does not own the writes, your e2e tool does. A recording one task
  overwrites costs the next one a re-recording (model calls), never a wrong
  verdict: e2e verifies the end state of every replay. Two tasks writing the
  *same* entry at once is the case cezar cannot speak for — if your cache
  writer is not atomic, a torn entry surfaces as an e2e error rather than a
  re-record. Keep the cache per project (the default shape above) rather than
  sharing one across projects, and nothing prunes the directory: it is yours to
  reclaim with `rm -rf ~/.cezar/cache` (or one project's subdirectory), which
  only costs the next run its warm cache. Unregistering a project does not
  remove it.
- **The check knows its run.** `CEZ_RUN_ID`, `CEZ_PROJECT_ID`, `CEZ_WORKTREE`,
  `CEZ_BRANCH`, `CEZ_BASE`, `CEZ_STEP_ID` and `CEZ_ATTEMPT`, plus
  `CEZ_GITHUB_REPO`/`CEZ_GITHUB_NUMBER`/`CEZ_GITHUB_EVENT` on a run a GitHub
  automation launched — see the [reference](reference.md#workflow-format).
- **No timeout.** cezar does not bound a check step; e2e's own startup,
  test and exploration timeouts are what stop a hung app from holding the
  task's parallel slot. Keep them configured.
- **No service orchestration.** e2e starts `app.command` and nothing else. A
  database or a mock stack has to be up before the run, or started by the
  command the config names.
- **Cancelling a task** sends SIGTERM to the running check, and e2e stops the
  app process it started.

## Verify a pull request

A task's check already gates its own changes before the review gate. To verify
**someone else's open pull request** — a teammate's, a bot's — use a GitHub
automation whose worktree is the PR's head instead of the base branch:

```json
{
  "name": "Browser e2e on every new PR",
  "kind": "github",
  "events": ["pull_request.opened"],
  "task": {
    "prompt": "Verify #{{github.number}}",
    "checkout": "pr-head",
    "steps": [
      {
        "id": "e2e",
        "name": "Browser e2e on PR head",
        "command": "npm ci --prefer-offline --no-audit >/dev/null\nnpx e2e run --reporter list,markdown --max-failures 3; code=$?\nif [ -f .e2e/summary.md ] && [ -n \"$CEZ_GITHUB_NUMBER\" ]; then\n  gh pr comment \"$CEZ_GITHUB_NUMBER\" --repo \"$CEZ_GITHUB_REPO\" --edit-last --create-if-none --body-file .e2e/summary.md\nfi\nexit $code"
      }
    ]
  }
}
```

(`cezar automation create --file verify-prs.json` — created paused; preview it
with `cezar automation check <id>` before enabling.) The workflow has no agent
step: the check is the whole job, and the run settles like any other.

What `checkout: "pr-head"` does at launch:

1. reads the PR (`gh api repos/<repo>/pulls/<n>`); a PR that is no longer open
   launches nothing — the execution log says `skipped: pr-not-open`;
2. a head from a **fork** launches nothing (`skipped: fork-head`) unless the
   automation sets `"allowForkHeads": true`;
3. fetches the head into `refs/cezar/pr/<n>` — a ref, never a branch, so
   nothing appears in your branch list — and forks the task's worktree from
   that commit. If the PR moved between the poll and the launch, the fetched
   commit is what is tested, and the run says so;
4. a fetch or `gh` failure launches nothing (`failed: pr-head-unavailable`,
   with the reason); Retry in the execution log tries again.

The check gets `CEZ_PR_HEAD_SHA`, `CEZ_PR_HEAD_REF` and `CEZ_PR_BASE_REF` on
top of the usual run context, the PR shows as the task's referenced pull
request, and diffs measure only what the run changed on top of the PR. The
ref is deleted with the last run that needs it.

**Fork heads are untrusted code.** An admitted fork's checks run **without
any secrets** — the same rule GitHub Actions applies to fork
PRs, and the one e2e's own security model asks for. A fork check therefore has
no model key; agent-driven tests in it will fail on the missing credential
(exit 2) rather than run a stranger's code with your key.

**A PR-head run cannot publish.** Its branch holds the whole PR under the
run's own changes, so *Draft PR* answers `409` instead of re-proposing someone
else's PR into your base. Report back from the check itself, as above —
`--edit-last --create-if-none` keeps one comment per PR. If your `gh` predates
`--create-if-none`, use two calls: `gh pr comment … --edit-last || gh pr comment …`.

`pull_request.opened` fires once per PR; re-verifying on every push needs an
event the poller cannot see yet.

## On every PR, in CI

For teams that already run CI, the recommended "every PR" path is a GitHub
Actions workflow using `@e2e-dev/github`, not a cezar automation: keep the model
key in **repository secrets**, and leave fork PRs out (GitHub does not give
them secrets either). cezar's automation is for the machine you already run
cezar on, with no CI to configure.

## Cost

Every agent step in a test and every exploration step is model calls, charged
to whatever provider the config names — separately from the cezar task's own
agent. Three things keep it bounded: the replay cache (verified actions replay
for free until the app changes), `--max-failures <n>` (stop before spending a
model call on every remaining test of a broken build), and a low `onFail.max`
— each retry re-runs the whole check.
