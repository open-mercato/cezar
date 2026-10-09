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

- **cwd** is the task's worktree, and the command runs under `bash -lc`. On Windows, cezar
  automatically uses an installed Git Bash executable when the default `bash.exe` may be the WSL
  launcher; Git for Windows does not need to be added to PATH for this fallback to work. If Git
  Bash is not installed, cezar preserves the normal `bash` lookup and reports its spawn failure.
- **Environment** is the cezar server's own `process.env`. There is no
  per-step `env:` — export the model credential your provider reads
  (`AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, …) before starting cezar, or use
  a subscription with `npx e2e login`. Tests with no agent step need no model
  at all.
- **`CI` is not set**, so e2e uses its local defaults: no retries, workers at
  half the cores, and a read-write replay cache — a verified `agent.act`
  recorded on one attempt replays without a model call on the next. Set `CI=1`
  in the command to get the stricter CI defaults instead.
- **No timeout.** cezar does not bound a check step; e2e's own startup,
  test and exploration timeouts are what stop a hung app from holding the
  task's parallel slot. Keep them configured.
- **No service orchestration.** e2e starts `app.command` and nothing else. A
  database or a mock stack has to be up before the run, or started by the
  command the config names.
- **Cancelling a task** sends SIGTERM to the running check, and e2e stops the
  app process it started.

## Cost

Every agent step in a test and every exploration step is model calls, charged
to whatever provider the config names — separately from the cezar task's own
agent. Three things keep it bounded: the replay cache (verified actions replay
for free until the app changes), `--max-failures <n>` (stop before spending a
model call on every remaining test of a broken build), and a low `onFail.max`
— each retry re-runs the whole check.
