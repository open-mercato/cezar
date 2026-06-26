# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Design & architecture guidelines live in [`AGENTS.md`](./AGENTS.md).** Read it before
> writing or changing code — it codifies the patterns this project follows and the
> anti-patterns to avoid, each tied to a concrete reference. The quick-reference rules
> below are the non-negotiables; `AGENTS.md` is the full version.

## Design & Architecture Guidelines (quick reference)

The hard rules (full list + rationale + reference files in `AGENTS.md` §1):

1. **`.js` suffix** on every relative import in ESM packages (`core`/`cli`/`runner`).
2. **No `any`, no `@ts-ignore`/`@ts-expect-error`** — exceptional `any` needs a comment + tracking issue.
3. **Validate all external / LLM / DB / config data with Zod at the boundary.**
4. **`core` is a pure library** — no `console.*`, no `process.exit`, no host I/O ownership.
5. **Narrow errors with `instanceof Error`**, never `(err as Error)`.
6. **Cross-package wire shapes live in `@cezar/core`** — never hand-copy a type.
7. **Dependency direction is one-way:** `cli`/`gui`/`runner` → `@cezar/core` only; no deep or cross-leaf imports.
8. **Fail closed on missing secrets** (503, never fall open); compare with `timingSafeEqual`; verify webhook HMAC on the raw body.
9. **Service-role key is server-only**; never in a client bundle or `NEXT_PUBLIC_*`.
10. **Queue/side-effect code is idempotent** (dedup index + `23505`-as-no-op) and bounds its own lifetime.

When designing something new, copy the cited reference implementation in `AGENTS.md` §2.
Before a PR, run the checklist in `AGENTS.md` §4.

## Project Overview

Cezar is a team SaaS for running AI coding agents on GitHub issues — a **cockpit**
showing every agent run (queued / running / paused / failed / finished) with controls.
Incoming GitHub issues are auto-triaged; bug fixes run as a skill-driven, multi-step
**autofix workflow** (`verify-in-repo → root-cause → fix → review-loop → open PR`)
that ends in a draft PR. Each workflow step binds (in the web GUI) to a skill
(auto-discovered from `.ai/skills/` in the target repo), an agent backend (Anthropic
API · Claude Code CLI · Codex CLI), and a model. Agents run via a managed cloud path
(API key, the `/api/cron/dispatch` cron) or an optional self-hosted `@cezar/runner`
daemon.

**Status:** post-cutover. The agent-cockpit refactor is the live path — the
declarative workflow engine drives every autofix run, the `workflow_runs` /
`agent_runs` / `agent_run_events` tables back the cockpit, and the legacy
`flows`/`flow_events`/`ci_*`/`issue_autofix_candidates` tables + the 5 old
`/api/cron/{issue-match,issue-fix,ci-watch,ci-attribute,ci-fix}` routes + the
`/flows` UI are retired (migration `0011_retire_legacy_path.sql`). `issue-sync`
is kept as the GitHub → `issues`-table reconcile cron (auto-triage backlog +
missed-webhook safety net); `dispatch` and `triage-sweep` are the new path.
The design reference is `docs/ARCHITECTURE.md`. The solo-use CLI (interactive
hub + `init` / `sync` / `run` / `status` / `runs`) still works against a local
file store.

## Commands

Yarn 4 monorepo (`packages/*`). Run from the repo root:

```bash
yarn build           # yarn workspaces foreach -A --topological-dev run build
yarn test            # all workspaces
yarn typecheck       # all workspaces
yarn lint            # all workspaces
yarn dev             # tsx watch the CLI

yarn workspace @cezar/core   run test       # core unit tests (vitest)
yarn workspace @cezar/core   run build      # build core
yarn workspace cezar         run build      # build the CLI
yarn workspace @cezar/runner run build      # build the runner daemon
yarn workspace @cezar/gui    run build      # Next.js build
```

Run a single core test file:
```bash
cd packages/core && npx vitest run tests/store/store.test.ts
```

## Tech Stack

- **TypeScript 5.x** (strict, ES2022, NodeNext/ESM; `.js` on relative imports in core)
- **Node.js 20+** — native fetch, ESM; `node:util.parseArgs` (the runner CLI)
- **Commander.js** — CLI routing; **@inquirer/prompts** — interactive menus
- **@octokit/rest** — GitHub API; GitHub App auth via `@octokit/auth-app`
- **@anthropic-ai/sdk** — Claude API (streaming); **@anthropic-ai/claude-agent-sdk** — agent runs
- **Zod** — config + LLM-response validation
- **vitest** — test runner
- **cosmiconfig** — config discovery (`.issuemanagerrc.json`)
- **Next.js 15 + Supabase + Tailwind** — the `@cezar/gui` app (cockpit, settings, job queue, webhook receiver)
- **Local JSON store** at `.issue-store/store.json` (CLI) / Supabase (GUI) — no extra database for the CLI

## Architecture

### Data Flow (Three Phases)

1. **Fetch** — `init`/`sync` (CLI) or the `issue-sync` cron + the GitHub App webhook (GUI) pulls issues from the GitHub API into the store.
2. **Digest** — Claude generates compact per-issue summaries; comments are fetched and stored too.
3. **Analyze** — Actions run against digested issues; the workflow engine / autofix run on top.

### Key Design Patterns

**Actions v2** (`packages/core/src/actions-v2/`): analysis capabilities are data-driven
`ActionDef` rows — `system_prompt` + `skill_refs` + `triggers` + `effects` — no bespoke
TypeScript per action. Two run modes in `runner.ts`: *declared* (`effects` non-null —
the model returns JSON validated against `output_schema`, the runner executes the listed
effects) and *tool-use* (`effects: null` — the effect registry in `effects.ts` is exposed
as Anthropic tools and the model calls them itself, self-reporting `_confidence` for
human-in-the-loop routing). Skills (`packages/core/skills/*.md`, plus repo `.ai/skills/`)
are the reusable prompt building blocks an action composes via `skillRefs`. 2 built-in
defaults ship in `default-actions.ts`: `auto-triage` (adds a `bug`/`feature` label and
links confident duplicates; HITL 90/60) and `security`. They're seeded per workspace
(SaaS) and users override by copy; the CLI reads the TS catalog directly plus
`.ai/actions/**/*.md`. Retired actions/skills are restorable from git history.

**Agent runner abstraction** (`packages/core/src/agents/`): `AgentRunner` interface with
three implementations — `AnthropicApiRunner`, `ClaudeCodeCliRunner`, `CodexCliRunner` —
and `createAgentRunner(backend, …)`. Normalized `AgentEvent` stream + `AgentRunResult`
(structured output + cost-weighted token usage). The Codex path (`codex exec --json`) is
implemented against the documented interface but not yet validated against a live binary
(`grep phase-4-verify`).

**Workflow engine** (`packages/core/src/workflows/`): a declarative `Workflow` is an ordered
list of `WorkflowStep`s (`agent` / `effect` / `human-gate` / `commit` / `open-pr` / `push`)
with optional loops. `runWorkflow` (in `workflow-engine.ts`) executes it, threading a
blackboard, emitting an `AgentRunRecord` per step, and posting one *living* comment on the
issue (then the PR). Definitions: `autofixWorkflow`, `ciFollowupWorkflow`, `triageWorkflow`
(under `definitions/`). Step config resolves via `resolveStepConfig` /
`WorkflowBinding`: step binding → run-launch override → workspace default → built-in default.
Effect steps receive `{ github, git, store }` as their `deps` (the `store` lets the real
`dedupe-check` triage step pull the open-issue knowledge base without a separate fetch).
`config.workflow.useEngine` flips the cron dispatch path to always-on inside
`executeWorkflowJob`; the legacy hand-rolled `AutofixOrchestrator` path remains for the CLI.

**Skills** (`packages/core/src/skills/skill-catalog.ts`): `discoverSkills` globs `.ai/skills/**/*.md`
in the target repo (config: `autofix.skillsDir`, default `.ai/skills`). A skill is a Markdown
file with optional YAML frontmatter (`name`, `description`, `cezar-stages`). Empty/absent
`.ai/skills/` is fully supported — every step uses its built-in default.

**GUI cockpit + job queue** (`packages/gui`): the cockpit pages (`/cockpit`, `/cockpit/[runId]`)
render `workflow_runs` / `agent_runs` / `agent_run_events` live via Supabase Realtime. The job
queue is `jobs` → `workflow_runs` → `agent_runs` → `agent_run_events` plus a `runners` table
(migrations `0007`–`0011`). `/api/cron/dispatch` claims jobs (`claim_next_job`,
`FOR UPDATE SKIP LOCKED`) and runs them in-process via `execute-workflow-job.ts`;
`/api/cron/triage-sweep` is the missed-webhook poll fallback; `/api/cron/issue-sync` is
the GitHub → `issues`-table reconcile; `/api/runner/*` is the long-poll API for
self-hosted runners. Shared `workflow_runs` / `agent_runs` / `agent_run_events` writes
go through `lib/persist-workflow-run.ts`. New Supabase migrations
(`packages/gui/supabase/migrations/`) use a UTC timestamp prefix —
`YYYYMMDDHHMMSS_desc.sql` (`date -u +%Y%m%d%H%M%S`) — not a sequential number, so
branches never collide; legacy `00xx_` files (≤ `0044`) are grandfathered. CI's
"Migration naming sanity" step enforces this. See `docs/DEVELOPMENT.md`.

**Webhook receiver** (`packages/gui/src/app/api/github/webhook/`): GitHub App deliveries —
`issues.opened`/`reopened`/`edited` enqueue a deduped `triage` job; `check_run.completed`
with a failing conclusion on an autofix-owned PR enqueues a `ci-followup` job (capped at
3 prior attempts; deduped against open jobs); `installation` records
`workspaces.installation_id`. Returns 503 (no-op) until `GITHUB_APP_WEBHOOK_SECRET` is set.

**`@cezar/runner`** (`packages/runner`): the optional self-hosted daemon (`cezar-runner login`/`start`,
CLI built on `node:util.parseArgs`). Long-polls `/api/runner/jobs`, claims jobs whose backend
it serves (`claude-cli`/`codex-cli`), clones the repo, runs the engine + CLI agent runners
locally, streams `agent_run_events` back, heartbeats. Cron-dispatched jobs handle `anthropic-api`;
runners handle the subscription-CLI backends.

**Store as Source of Truth** (`packages/core/src/store/`): the CLI's single JSON file with atomic
writes; the GUI's Supabase tables. Each action writes to its own namespace in the `analysis`
object — actions are independent and can run in any order. Zod schemas validate all store data.

**Interactive-by-Default, Scriptable-by-Flag**: the CLI hub (`packages/cli/src/ui/hub.ts`) is
the primary solo UX. `--no-interactive` enables CI usage; `--apply` applies results without
confirmation; `--dry-run` previews.

### Entry Points

- `packages/cli/src/index.ts` — Commander setup, shebang, action side-effect imports; commands: `init`, `sync`, `status`, `run`, `runs`, `pipeline`
- `packages/cli/src/ui/hub.ts` — interactive menu (launched when no args)
- `packages/cli/src/commands/` — `init.ts`, `sync.ts`, `run.ts`, `runs.ts`, `status.ts`
- `packages/gui/src/app/` — the Next.js app (cockpit, settings, API routes, webhook, crons)
- `packages/runner/src/cli.ts` — the runner daemon entry point

### Services

- `packages/core/src/services/github.service.ts` — Octokit wrapper (fetch, label, update issues, PRs, CI)
- `packages/core/src/services/github-app.service.ts` — GitHub App auth (short-lived install tokens); additive — OAuth login flow untouched
- `packages/core/src/services/llm.service.ts` — Anthropic SDK wrapper (digest generation, duplicate detection), batched with JSON response validation

## Environment Variables

- `GITHUB_TOKEN` — GitHub API authentication (CLI / OAuth fallback)
- `ANTHROPIC_API_KEY` — Claude API (digests + agent runs on the managed path)
- `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_WEBHOOK_SECRET` — the GitHub App (webhooks + install tokens); without the secret the webhook receiver returns 503
- `CEZAR_USE_WORKFLOW_ENGINE` — local CLI only: `true` opts the legacy `AutofixOrchestrator` path into delegating to `runWorkflow` (or set `workflow.useEngine: true` in `.issuemanagerrc.json`). The SaaS dispatch path always uses the engine.
- `CRON_SECRET` — bearer check shared by `/api/cron/dispatch`, `/api/cron/triage-sweep`, `/api/cron/issue-sync`
- `CEZAR_RUNNER_URL` / `CEZAR_RUNNER_TOKEN` — the self-hosted runner
- Supabase vars + `NEXT_PUBLIC_APP_URL` (GUI) — see `docs/SELF-HOSTING.md` and `.env.docker.example` for the full list and the `CEZAR_DISPATCH_*` / `CEZAR_TRIAGE_SWEEP_*` tuning vars
