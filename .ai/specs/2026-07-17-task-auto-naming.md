# Task auto-naming — short, LLM-generated titles with PR/issue extraction

Status: proposed · Date: 2026-07-17 · Issues: #432 (naming quality), owner direction 2026-07-17 · Relates: PR #442 (kept — becomes this spec's heuristic fallback), spec 008 (the planner, the one-shot template this reuses)

## Problem

The tasks table is unreadable. Real failures from the cockpit today:

- `469` — a skill run whose whole prompt was the argument `469` (`makeTitle` = first line of the task).
- `463 with autofix - a…`, `443 - make sure the…` — raw prompt prefixes, truncated at the ~20–25 chars the column shows.
- `Reading the handoff…` (×3), `The skill is loaded a…` — `deriveTitleSummary` takes the **agent's first streamed sentence** (`recordTurnEnd` → `src/runs/title-summary.ts`), which is opening narration, not intent. Three different tasks, the same useless title.

Issue #432 called the mechanism "LLM-based naming"; it is not — both layers are heuristics, and
neither knows the skill, the arguments, or the referenced PR/issue. Separately, PR/issue-number
discovery is 100 % programmatic and narrow: `RunRecord` has no issue/PR-number field at all —
only `pullRequestUrl`, set when the agent *creates* a PR (regex over transcript text in
`store.appendEvent`) or by the cockpit's own create-PR path. A task started *about* PR 437
carries no machine-readable link to 437.

## Target contract

A title is **`<number>: <terse lowercase gerund phrase>`** when a PR/issue number exists, else
just the phrase — e.g. `437: implementing cr fixes`, `469: verifying pr ui`. Aim ≤ ~30 code
points (the visible column is ~20–25). Hard rule: **a title is never derived from the agent's
first streamed words** — only from the task's intent: skill name + skill description +
arguments + prompt + PR/issue context.

## Survey (how the tools we wrap do it — verified 2026-07-17)

| Tool | Mechanism |
|---|---|
| Claude Code | Background **Haiku** one-shot: "write a 5-10 word title for the following conversation"; separate Haiku topic-change detector returns JSON `{isNewTopic, title}`; stored as `summary` in session JSONL; SDK splits auto `summary` vs manual `custom_title` |
| Codex app-server | `thread.name` exists in the JSON-RPC protocol but is **manually set** (`thread/name/set`); auto-naming is an open feature request |
| opencode | Hidden "title agent" fired after the first user message on the configurable `small_model` |
| Zed / ChatGPT-style UIs | Separate cheap-model title call after the first exchange, click-to-edit + regenerate |
| ACP | `SessionInfo.title` + accepted RFD for agent-pushed `session_info_update` title changes |

**Pattern:** every surveyed tool uses a **separate cheap LLM request, fired once, never
blocking**; none uses in-band structured output in the main agent request (latency + prompt
contamination). Heuristics are the universal fallback.

## Design

### Step 0 — programmatic reference extraction (always runs, sync, zero-config)

New pure module `src/runs/task-refs.ts`: regex over the task prompt — bare-integer argument
(`^\s*\d+\s*$`), `#N`, `github.com/<o>/<r>/(pull|issues)/N` URLs, and the GitHub-tab templates
(`Fix GitHub issue #N…` from `web/app/src/lib/github-task.ts`). Results land in **new optional
`RunRecord` fields `prNumber?` / `issueNumber?`** (additive-safe per the store rule) and feed
the heuristic title prefix immediately at creation.

### Step 1 — heuristic title at creation (PR #442, kept)

`makeRunTitle(task, workflow)` from #442 is this spec's permanent fallback and the instant
title while the namer runs: `469` → `469: /om-auto-review-pr`. #442 also gives the main agent
the skill name/description in its system prompt — independently valuable; keep both. (#442
needs a trivial rebase: two conflict hunks in `src/workflows/system-prompt.test.ts` only.)

### Step 2 — one-shot LLM namer (the SOTA part)

New `src/runs/auto-name.ts`, mirroring `src/planner.ts` (spec 008) exactly:

- Fired **fire-and-forget from `startRun()`** right after `store.createRun` — all inputs are
  known there; never awaited, never blocks, never fails a run.
- `createRunner(config.defaultRunner).run({...})`, `allowedTools: []`, ~20 s timeout; new
  config key **`namerModel`** (default a cheap alias, e.g. `haiku`; passed only on the claude
  backend — the `plannerModel` precedent).
- User prompt carries a `[cez-namer]` marker (dry-run mockability, like `[cez-planner]`),
  the skill name + description, the first ~500 chars of the task, and the step-0 numbers as
  *advisory* context.
- Output contract: strict JSON `{"title": string, "pr"?: number, "issue"?: number}` via
  `parseStructured` + zod, one retry on junk.
- **Anti-hallucination cross-check:** accept the LLM's `pr`/`issue` only if the number also
  occurs in the task text or matches step 0; the regex always wins on disagreement.
  Post-validate the title: non-empty, ≤ ~40 code points, lowercase start, prepend `N: ` when a
  number is known and missing from the title.
- Apply via `store.updateRun(runId, { titleSummary, prNumber, issueNumber })`. A **user
  rename always wins**: PATCH sets a user-owned marker (it already writes `titleSummary`;
  track origin with a new optional `titleOrigin: 'user' | 'auto'`), and the namer never
  overwrites a user-owned title. Namer-owned titles MAY be replaced by later namer results
  (the live updates of Step 3). SSE fan-out is free (`store.updateRun` → `run` event).

### Step 3 — live title updates ("on the go"), switchable, default OFF

Owner change request (PR #479 review): the task name must keep **updating as the run
progresses** — but through the namer, never through raw turn text.

- **Trigger:** on each `turn-end` (the hook `recordTurnEnd` already owns), re-run the same
  one-shot namer with richer context: skill + arguments + task prompt + the finished turn's
  text + current `diffStat`. Same strict-JSON contract, same post-validation, same
  cross-checked `pr`/`issue` numbers.
- **Precedence:** a user rename always wins and permanently stops auto-updates for that run
  (the existing `titleSummary`-set-by-PATCH rule). Otherwise the freshest namer result may
  replace an earlier one — a run that started as `469: /om-auto-review-pr` becomes
  `469: fixing sse watchdog races` once the work has a shape.
- **The switch (settings-based, env default, default OFF):** new `config.json` key
  **`liveTitleUpdates: boolean`**, surfaced in Settings → Agents next to `plannerModel`/
  `namerModel`. When the key is absent, the default comes from the env:
  **`CEZ_TITLE_UPDATES`** (`'1'` → on, anything else/unset → **OFF**). Config wins over env;
  env wins over the built-in OFF. The refresh spawns one agent process per turn end that the
  run's own cost never shows, so it follows the "cost widens ⇒ opt-in" house rule
  (BACKWARD_COMPATIBILITY.md, "Live title refresh default flip").
- **Cost bounding:** one cheap-model call per turn end, skipped when the toggle is off, when
  a user rename exists, when the run is `CEZ_DRY_RUN`-mocked (canned answer), or when the
  namer inputs haven't changed since the last call (no new turn text and unchanged diffStat).
  Off (`liveTitleUpdates: false` / `CEZ_TITLE_UPDATES` unset) the title is set once at creation
  (Steps 0–2) and then only by the user.

### Step 4 — retire raw turn-text titles

Remove the `deriveTitleSummary` assignment from `recordTurnEnd` and retire
`src/runs/title-summary.ts`. This is the single change that makes "Reading the handoff…"
titles impossible — the on-the-go updates of Step 3 replace it with namer-generated titles.
When no LLM is available, the creation-time heuristic title simply stays; the raw
first-words derivation does NOT return as a fallback. (One #442 dry-run test asserts
turn-text `titleSummary` gets set — expected churn, update it in the same step.)

### Degradation (zero-config rules)

No runner / `CEZ_DRY_RUN` mock / timeout / junk twice → the heuristic title simply stays; at
most a `note` event. `scripts/mock-claude.mjs` gets a `[cez-namer]` branch next to the
planner's returning canned JSON so tests are deterministic. Naming must never block task
start, never park a run, never surface an error state.

### Rejected: in-band title markers

Asking the main agent to emit a `CEZ_TITLE:` line contaminates every skill's prompt, is
unreliable across backends, arrives a full turn late — and no surveyed tool does it. Revisit
only if cezar adopts ACP `session_info_update` natively.

> **Superseded in part (owner decision 2026-07-18):** spec
> `2026-07-18-task-ref-markers.md` introduces in-band `CEZ:PR` / `CEZ:ISSUE` /
> `CEZ:TITLE` markers after conversation-borne references kept defeating both
> the janitor and this namer. The namer stays the default title mechanism; a
> marker title takes precedence and silences the live refresh (`titleOrigin:
> 'marker'`), and marker-declared numbers block the namer's `pr`/`issue`.

## Phasing

1. Land #442 (rebase first — 2 test hunks).
2. `task-refs.ts` + `RunRecord.prNumber/issueNumber` + number-prefixed heuristic title.
3. `auto-name.ts` + mock branch + `startRun` wiring + `namerModel` config key.
4. Live title updates: `recordTurnEnd` wiring + `liveTitleUpdates` config key +
   `CEZ_TITLE_UPDATES` env default (OFF) + the Settings → Agents toggle.
5. Remove raw turn-text derivation (`title-summary.ts` retired).
6. Optional: "regenerate title" row action reusing the same call (Zed/opencode pattern).

## Test plan

Unit: `task-refs` regex matrix; namer prompt builder; JSON schema + retry; cross-check matrix
(LLM agrees / disagrees / hallucinates / regex-only); title post-validation; the live-updates
switch matrix (config `liveTitleUpdates` wins over `CEZ_TITLE_UPDATES` wins over built-in OFF;
only `'1'` enables). Dry-run integration (pattern of `system-prompt.test.ts`): task `"437"` +
skill → instant heuristic title, then async `titleSummary === "437: implementing cr fixes"`-
shaped result + `prNumber` + an SSE `run` event; a later turn end refreshes the title through
the namer (and does NOT when the toggle is off, when the user renamed first, or when namer
inputs are unchanged); runner-failure → heuristic stays; user renames first → LLM result
discarded. UI: tasks-table tests pin the short-title rendering; Settings tests pin the
`liveTitleUpdates` toggle.
