# One-click e2e setup

Status: implemented on PR #1291 · Base: `feat/check-env` @ `af752cc6` (2026-10-10) · Related:
`.ai/specs/2026-10-06-agentic-e2e-checks.md`, `.ai/specs/2026-10-10-project-secrets-vault-options.md`,
`docs/e2e-verification.md`

## Goal

A user who wants browser e2e tests in a project clicks one button. cezar installs and configures
TesterArmy's [`e2e`](https://github.com/tester-army/e2e), proves it works, and leaves an
`implement-and-e2e` workflow behind. The user never runs `npx e2e init`, edits `e2e.config.ts`,
writes workflow YAML or exports a key.

## Why this reverses two earlier non-goals

The #1265 plan (`.ai/runs/2026-10-04-e2e-verification-steps.md`) listed "no `cez init` scaffolding
of an e2e workflow, and no built-in workflow — a built-in would appear in every project's catalog".
`2026-10-06-agentic-e2e-checks` listed "any e2e-specific code in the engine". The owner rejected the
result — five manual steps in `docs/e2e-verification.md` — as too complicated (2026-10-10): § Zero
config says "when a feature seems to need configuration, the design is wrong".

Neither original concern applies to an opt-in setup:

- **Catalog pollution.** The setup workflow is ad-hoc (`startRun(workflowDef)`, the same path an
  approved "(planned)" chain takes) and is never in any catalog. The `implement-and-e2e` workflow is
  written into the ONE project that asked for it, as a reviewed commit.
- **Engine code.** The engine is unchanged. The setup is a prompt plus two check steps; the only
  e2e knowledge is in `src/e2e-setup.ts` (the prompt and the status read), like `planner.ts`
  already knows `e2e.config.*`.

## Design

### Settings → project → End-to-end tests

Status (`configFile`, `workflow`, which model keys check steps can read, the latest setup run and its
live status via `useRun`), a provider select over `E2E_CREDENTIAL_NAMES`, an optional password
field and one button. Submitting starts the setup and navigates to its task.

### `GET /e2e`, `POST /e2e/setup`

Contract in `packages/contract/src/e2e.ts`; inventoried in `BACKWARD_COMPATIBILITY.md` §2.

`POST /e2e/setup {credential?}`:

1. 409 when a setup run is queued, running or waiting (two would race on the same files).
2. 409 when the project is not a git repository — the setup must land as a reviewable branch.
3. Stores `credential` as a project secret with audience `checks` (the existing secrets write).
4. Starts `e2eSetupWorkflow(credentialNames)` with `autonomous: true` (the setup must not park on
   a question; a real blocker ends the run with the agent's explanation).

The provider gate (`providerActionError`) applies, as on `POST /runs`.

### The setup workflow (`e2e-setup`)

| Step | Kind | What |
| --- | --- | --- |
| `setup` | agent | Check Node (`^22.22.3 \|\| >=24.8.0`) and that there is a web app; `npx --yes e2e@latest init --yes`; install with the repo's package manager; `app.url: http://127.0.0.1:0` with a `{port}` dev-server command; wire the provider of the first stored key name; a locator-only `tests/smoke.e2e.ts`; write `implement-and-e2e.yaml` from `E2E_WORKFLOW_TEMPLATE`; commit. |
| `e2e-list` | check | `npx --no-install e2e list` — loads the config, collects tests, no model, no app. |
| `e2e-smoke` | check | `npx --no-install e2e run --reporter list,markdown --max-failures 3`, printing `.e2e/summary.md`. |

Both checks loop back to `setup` (max 2) on ANY exit code: for the setup, a config (2) or app-process
(3) failure is its own work, unlike a coding task where `retryOn: [1]` is right. The generated
`implement-and-e2e` keeps `retryOn: [1]`.

The agent is told the key NAME only. Values never enter a prompt, a workflow definition or the run
record; check steps get them from the secret store.

`--no-install` pins every check to the version the setup installed. `E2E_TELEMETRY_DISABLED=1` is on
every e2e command cezar writes: cezar does not widen network exposure on the user's behalf.

## Facts the design rests on (e2e 0.19.0, verified 2026-10-10)

- `init --yes` is non-interactive (Web engine, AI Gateway, skill + MCP files, **no** dependency
  install); without a TTY and without `--yes` it exits 2. It never overwrites existing files.
- `e2e list` needs no credential; a locator-only test passes with no key.
- Port 0 is accepted only on literal `127.0.0.1`/`[::1]` and requires `app.command`.
- A missing browser downloads once per run, before the run's clock starts.
- Keys: `AI_GATEWAY_API_KEY` (default `gateway()`), `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `OPENROUTER_API_KEY`, read by the provider package on the first model call.

## Default path

| Scenario | Before | After |
| --- | --- | --- |
| Project that never opens the section | — | unchanged; nothing is detected, fetched or written |
| Workflow catalog | — | unchanged everywhere; `implement-and-e2e` appears only after the user merges the setup branch |
| `POST /runs`, check steps, secrets | — | unchanged |

Network use (npm, the browser download) happens only inside a task the user started.

## Not in scope

- Mobile targets, `e2e login` subscriptions (interactive), CI (`.github/workflows/e2e.yml`).
- A built-in or catalog entry for the setup.
- Running the setup without a git repository.

## Tests

- `src/e2e-setup.test.ts`: the chain validates (`workflowDefSchema`, `stepsIssue`), both checks loop
  to `setup` on any code, every e2e command is `--no-install` with telemetry off, the template parses
  through `workflowFileSchema` with `retryOn: [1]`, and each key name selects its provider hint.
- `src/server/e2e-setup-api.test.ts`: empty status on both mounts; key stored as a `checks` secret
  and absent from the workflow and input; in-flight 409; settled run allows a retry; non-git 409
  before anything is stored; unknown key name 400; a workspace `checks` key counts, a `cezar`-only one
  does not.
- `src/server/contract-parity.e2e.test.ts`: route types match the contract.
- `packages/web/src/routes/settings/e2e-section.test.tsx`: empty state, start with and without a key,
  live in-flight status blocks a second start, installed state, a refused start keeps the key.
