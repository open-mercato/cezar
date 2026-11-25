# Frameworks & stage board

Status: DRAFT (2026-11-23) · Mockups: `assets/framework-board/mockups.html` · Framework reference:
[open-mercato/sdd](https://github.com/open-mercato/sdd) @ `04ba2cc` (2026-11-22, "preview") ·
Builds on: spec `2026-09-30-workflow-node-editor` (graph engine), `2026-09-10-dispatch`, #347
(waiting holds no slot), #472 (editable queued prompt) · Touches: `workflows/graph.ts`,
`workflows/run.ts`, `runs/store.ts`, new `frameworks/`, `packages/contract/src/{frameworks,cards}.ts`,
`packages/web/src/routes/tasks-overview.tsx`, `routes/settings/`

## Goal

A spec-driven development framework (Open Mercato SDD, OpenSpec, spec-kit, or none) becomes a
first-class thing a project **uses**, not a skill the user has to remember to call in the right
order. Work that goes through a framework is a **card**: it moves across a board whose columns
are the framework's stages, stops at the framework's gates for a human, and otherwise runs on its
own whenever a slot is free. Ad-hoc tasks stay exactly what they are today.

The deliverable is the same as every cezar task: a branch and a draft PR at a review gate. The
board never merges.

## Today (what we build on, and what it is load-bearing for)

| Mechanism | Today | Role here |
|---|---|---|
| Graph workflows v2 | `agent` (fresh or `session.continue`), `check`, `loop` (bounded, never-reset counter), `gate.human` (approve/reject + comment), `ask-user`, `dispatch`, `CEZ:VERDICT` ports, GitHub nodes | A framework **compiles** to a graph. No second execution engine. |
| One run = one worktree + one branch | `cez/<id8>`, shared by every node | One card = one run. All stages share the branch — which is exactly SDD's "one branch per change" rule (`sdd new` off a non-base branch records that branch). |
| `waiting` holds no slot (#347) | idle parked session costs no slot | Gates and conversation stages park as `waiting` → "holds slot: no" in the mockup is already true. |
| `queued` + scheduler | FIFO, workspace-wide `maxParallel` | Ready column = queued runs; order = Ready order. |
| Dispatch children | `parentRunId`, carved budget, 4 in flight | "Child of card" rows in the list; nothing new. |
| Review gate at run end | config gate, draft PR button, `CEZ:MONITORING` | The Ship stage. Unchanged. |
| Tracker links | GitHub / Jira / Linear issue refs on runs | "Linked issue" on a card. |

Guarantees this spec must keep: a project with no framework and no cards behaves byte-for-byte as
today (`quick-task` default, no new list rows, no new polls); every parked state has an
on-by-default exit or is explicitly a human's decision that holds no slot; every loop is bounded.

## Terms

- **Framework** — a YAML template: ordered **stages**, each with a skill/command, a mode, a session
  policy, an optional gate, loops and required artifacts. Built-in or project-local.
- **Stage** — one column. Compiles to one or more graph nodes tagged `stage: <id>`.
- **Card** — a run whose workflow is a compiled framework, plus board metadata (`card` field).
- **Ad-hoc task** — every other run. Never on the board.

## Decisions (owner answers to Q1–Q6, 2026-11-23, are folded in; see Owner decisions)

| # | Decision |
|---|---|
| D1 | **A card is a `RunRecord` with an optional `card` field**, not a second store. Lists, SSE, dispatch nesting, cost, recovery and the task view work unchanged. Rejected: a separate `cards.json` (two lifecycles to keep in sync); a new `backlog` run status (`RunStatus` is a parsed enum — an older cezar reading the file would drop the record). |
| D2 | **Backlog = `queued` + `card.held: true`.** The scheduler skips held runs. The prompt stays editable (#472). Ready = `held: false`; the only human "go" is Backlog → Ready. |
| D3 | **A framework compiles to a v2 graph** at card creation, snapshotted into the run's `workflowDef` like any workflow. In-flight cards keep the framework they started with; changing the project framework affects new cards only. "Open compiled graph" opens it in the existing node editor read-only. |
| D4 | **Stage = the `stage` tag of the active graph node**, persisted to `card.stage` on every node transition so lists render without the graph. Stage progress strip = per-stage `{pending, running, waiting, done, failed, skipped}`. |
| D5 | **Board shows framework cards only**; ad-hoc tasks stay in the List (header counter "+ N other tasks"). List and Board are two views of the same Tasks route (`?view=board`). |
| D6 | **Zero config: the framework is discovered, Generic is the fallback** (owner, Q2). With no explicit `framework` in `.ai/cezar/config.json`, the project uses the first built-in whose `detect` paths all exist (file checks only, no network, evaluated when the board or New card opens — never polled); none matches → Generic (Plan ⏸ → Build → Review), so the board always works. An explicit choice in Settings always wins, including an explicit `generic`. The board header says where the choice came from: "Open Mercato SDD · detected (.ai/sdd/sdd.mjs) · Change". |
| D7 | **The framework's own state is the authority when it has one.** For Open Mercato SDD, cezar reads `node .ai/sdd/sdd.mjs status --json` and never infers a stage as done that the script calls `pending`/`stale`. For frameworks without state, the graph position is the truth. |
| D8 | **Gates hold no slot and have no timeout by default.** A gate is a human decision; it surfaces in Now/"Needs you" and on the card (amber). Not a dead end: it holds nothing and the card can be cancelled. |
| D9 | **SDD approvals happen in the cockpit** (owner, Q1). `sdd.mjs approve` refuses to run without a TTY; the framework's sanctioned path for automation is `SDD_NONINTERACTIVE_APPROVAL=<change id>`. The gate's **Approve** button (confirm dialog naming the change id and the stage) makes cezar's own process run `node .ai/sdd/sdd.mjs approve <stage> --by <git user.name>` in the card's worktree with that variable set, then commit `change.json` on the card's branch (the framework's "an approval is also a commit"). `sdd status` then shows the approval as non-interactive, and the card history records who clicked. Guard rails: the variable is set ONLY on that one spawn — never in an agent session's env, a check node's env or a terminal cezar opens — and the stage prompt keeps the framework's "never run approve" rule. Scrubbing is case-insensitive and covers checks, prechecks, `state.command` and the approve commit's git hooks; it is advisory against an agent that deliberately sets the variable itself — the prompt rule is the guard there. The button is local-only (409 when `capabilities().localHandoff` is false, like agent-config writes). A user who prefers the terminal can still run the command there; the watcher (engine step 3) advances either way. |
| D10 | **Conversation stages** park after every turn (no slot) and end only when the agent proposes `CEZ:STAGE-DONE` and the user confirms, or the user presses **Finish stage**. **Let the agent decide** flips the card to autonomous for the rest of that stage. |
| D11 | **Autonomous card**: conversation stages run unattended and list their assumptions; those are shown at the next gate as accept/change rows, and a "change" becomes the gate's request-changes comment. For SDD this maps to `done discover --unconfirmed` + the spec's open-questions round, which the framework already defines. |
| D12 | **Drag rules**: Backlog ↔ Ready freely; reorder within Ready. Forward drag is accepted only onto the stage right after an open gate and equals **Approve** (for SDD → D9). Backward drag = **Re-run from this stage** (confirm dialog). Every other drop is refused with a reason. |
| D13 | **Per-stage WIP limit** (`wip: n`): a card that reaches a full stage parks `waiting` (no slot) with reason `wip`, and is woken in Ready order whenever a card leaves that stage by any path (advance, fail, cancel, delete, re-run) and once at boot. |
| D14 | **"Must leave" artifacts** are checked by cezar after the stage's agent finishes: a missing glob fails the stage with the missing path named, before any gate opens. |
| D15 | **No new `CEZ_*` env var, no config file required.** Project framework choice lives in `.ai/cezar/config.json` (`framework`, optional, default `generic`); project frameworks in `.ai/cezar/frameworks/*.yaml` (committable, added to the `ensureDataGitignore` allowlist like `workflows/`). |

## Framework file

```yaml
id: open-mercato-sdd
name: Open Mercato SDD
description: Discover, spec + plan, mockup, threat model, validate, implement, verify, archive.
detect:                       # suggestions only (D6); every entry is a path that must exist
  - .ai/sdd/sdd.mjs
  - .claude/skills/om-sdd/SKILL.md
state:                        # optional framework-owned state (D7)
  command: node .ai/sdd/sdd.mjs status --json
  watch: .ai/specs/*/change.json
cardFields:                   # extra New-card fields, passed to the first stage as {{card.<name>}}
  - { name: slug, label: Change id, pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', from: title }
  - { name: ui, label: Changes a screen, type: boolean, default: true }
stages:
  - id: discover
    skill: om-sdd-discover
    mode: conversation        # conversation | autonomous (default)
    session: fresh            # fresh (default) | continue: <stageId>
    artifacts: [ '.ai/specs/*-{{card.slug}}/brief.md' ]
    gate: { kind: framework, approve: null }   # SDD: owner confirmation is `done discover`
  - id: spec
    skill: om-sdd-spec
    model: claude-opus-5-5
    artifacts: [ '.ai/specs/*-{{card.slug}}/spec.md' ]
    gate: { kind: framework, approve: spec }   # D9
  - id: implement
    skill: om-sdd-implement
    runner: codex
    wip: 2
    checks: [ node .ai/sdd/sdd.mjs run-gate ]
  - id: verify
    skill: om-sdd-verify
    review: true              # reviewer, never the implementer's session
    verdicts: [ pass, fail ]
    onVerdict: { fail: implement }
    loopMax: 2
  # …
```

Field rules (zod, in `packages/contract/src/frameworks.ts`):

- `stages[].skill` XOR `stages[].command` (a backend slash command, e.g. `/openspec:apply`). The
  stage prompt is generated: the card title + brief, the stage's role, the required artifacts, the
  allowed verdicts, and "never run approve" for framework gates.
- `gate.kind`: `approve` (a `gate.human` node: Approve / Request changes → `onReject`, default the
  previous stage) or `framework` (wait until `state.command` reports the stage approved/done).
- `onVerdict` targets must be earlier stages; every back edge compiles through a `loop` node with
  `loopMax` (default 2). The existing graph validator then guarantees finiteness.
- `runner`/`model` are per-stage defaults; the New-card dialog may override per stage.
- `checks` compile to `check` nodes after the stage's agent; a failing check retries the agent
  (existing `onFail` semantics) up to `loopMax`.

Compilation is a pure function `compileFramework(framework, card) → WorkflowGraph`, golden-tested
per built-in. Every node carries `stage`. The Ship stage is not compiled: it is the run's existing
review gate.

## Built-in frameworks

### Open Mercato SDD (replaces the mockup's provisional 7 stages)

The mockup was drawn before the framework landed (`om-discovery`, `om-spec-writing`, 7 stages). The
real framework has eight stages and a state script; the board follows it:

| # | Stage | Skill | Mode | Gate (from `sdd.mjs`) | Back edge | Holds slot |
|---|---|---|---|---|---|---|
| 1 | Discover | `om-sdd-discover` | 💬 conversation (autonomous → `--unconfirmed`) | owner confirms scope (`done discover`) | — | only while the agent works |
| 2 | Spec + plan | `om-sdd-spec` (`--auto` when autonomous) | autonomous, stops on open questions as an ask | ⏸ `approve spec` (D9) | request changes → 2 | no while parked |
| 3 | Mockup | `om-sdd-mockup` | autonomous; review link (`server.mjs`, port 4747) shown on the card | ⏸ `approve mockup`; skipped when `ui: false` | substantive comment → 2 | no while parked |
| 4 | Secure | `om-sdd-secure` | autonomous | ⏸ `approve secure` only when a risk is accepted | — | — |
| 5 | Validate | `om-sdd-validate` | autonomous, read-only | verdict `go`/`conditional` passes | `no-go` → 2 | — |
| 6 | Implement | `om-sdd-implement` | autonomous, `wip: 2` | `run-gate` green, draft PR | — | yes |
| 7 | Verify | `om-sdd-verify` | autonomous, `review: true`, fresh session | verdict `pass` | `fail` → 6 (max 2) | yes |
| 8 | Archive | `om-sdd-archive` | autonomous | — | — | yes |
| — | Ship | (cezar review gate) | 🧑 human | merge | — | no |

Notes that follow from the framework, not from cezar:

- Every stage reads `.ai/sdd/CONVENTIONS.md`; the stage prompt adds only the card context.
- A stage whose `sdd.mjs gate <stage>` exits non-zero is not started: the card goes amber with the
  script's blocker lines. A `stale` stage (spec edited after approval, code changed after verify)
  moves the card's strip back to that stage. Cezar shows it; it does not fight it.
- Stages 3 and 4 may run in parallel per the framework ("this stage can run while the mockup is
  being reviewed"). v1 keeps them sequential (D1 of the graph spec: one active node).
- Merging stays human in both the framework and cezar.

### Installing Open Mercato SDD (one click)

A built-in may carry an install recipe (`vendor-catalog.ts`, dated): only SDD does —
`open-mercato/sdd` pinned to `04ba2cc1102a…`, installer `install.mjs`. "Install into this repo"
(Framework settings and the board's Choose-framework state; "Use" becomes "Install & use") calls
`POST /frameworks/:id/install {commit?}`: the source is fetched at that commit into
`~/.cache/cez/frameworks/<id>/<sha>/` (verified, reused), `node install.mjs <repo>` runs with a
scrubbed env, serialized per repo. Local-only like approve (409 off `localHandoff`); refused (409)
when `.ai/sdd/sdd.mjs` exists and the paths it writes have local changes. With `commit`, the changed
paths are committed only when the checked-out branch is the one cards fork from — cards run in
worktrees off it, so uncommitted skills are invisible to them. An explicit click, so no `CEZ_*`
flag; `CEZ_DRY_RUN=1` answers success without network or writes.

### Generic (default)

`Plan ⏸ → Build → Review`. Plan writes `.ai/cezar/plans/<run>.md` and parks at an approve gate;
Build implements; Review is a `review: true` agent with `approve`/`changes` verdicts, `changes → Build`
(max 2). Needs nothing installed.

### OpenSpec, spec-kit (phase 3, provisional)

Shipped as templates whose stage commands are verified against the repo when shown (Framework
detail marks a missing command red). The command names in the mockup (`/openspec:proposal|apply|archive`;
spec-kit `constitution → specify → clarify → plan → tasks → analyze → implement`) are vendor
knowledge: keep them in one file, dated, like `agent-config/catalog.ts`, and re-check at
implementation time. spec-kit's set-up command is shown, never run.

## Card lifecycle — every state and who moves it out

| State | Run status | Exits (on by default) |
|---|---|---|
| Backlog | `queued`, `held` | human: → Ready, edit, delete. Holds nothing. |
| Ready | `queued` | scheduler, in Ready order, when a slot frees (Autopick on). Autopick off (board toggle, per project) = human "Start". |
| Stage running | `running` | agent turn end → next node; failure → Failed; cancel. |
| Waiting: gate | `waiting` | human approve / request changes; framework state watcher (D9); cancel. |
| Waiting: conversation | `waiting` | user reply, Finish stage, Let the agent decide; cancel. Existing idle timeout still applies to the session process, not to the card. |
| Waiting: WIP | `waiting` | a card leaves that stage (D13); boot recheck; cancel. |
| Waiting: question | `waiting` | existing `CEZ:ASK` card. |
| Failed | `failed` | Re-run from stage; Continue; delete. Loop exhaustion lands here, never parks. |
| Ship | `review` | existing review gate (merge / PR / discard). |
| Done | `done` | — |

## Tasks view

**List** (mockup 0): one list for everything. Filter `All · Framework · Other`; Framework adds a
stage filter. Groups: Needs you, Running, Review, then a collapsed **Backlog** group (with the Ready
count). Card rows show ◆, stage chip `Spec review · 3/8`, state (⏸ approve, 💬 your turn, ✕ failed),
runner, cost. Dispatched children nest under their card (existing `parentRunId`).

**Board** (mockup 1): Backlog, Ready, one column per stage, Done. Column header: index, count, WIP
`n/m`. Card: title, issue ref, stage strip (done / running / waiting-for-you amber / failed), the
one most important line (`codex · step 6/11 · $3.10`, `💬 your answer · 4 questions`, `↻ 1 back
from review`). Header: framework name, Autopick + slot usage, "N need you", Filter, New card (`N`).
Empty board: the Choose framework screen. Keyboard: arrow keys move focus, `Enter` opens, `N` new.

**Card wizard** (mockups 2–3): the stepper is the framework; the body is the selected stage.
- Gate stage: what the stage produced (artifacts with diff size, draft PR, review verdict and nits),
  the assumptions to accept/change (autonomous cards), and Approve & continue / Request changes
  (`loop 1/2`) / Re-run. For SDD, Approve follows D9; the dialog names the change id and the
  stage, and the card's history line reads "spec approved by <name> in cezar (non-interactive)".
- Conversation stage: the run's thread, with ask cards inline, plus Let the agent decide and
  Finish stage. The next stage starts in a fresh session and reads the artifact, not the chat.
- Side panel: stage skill, session, gate, runner, holds slot, card issue, total cost, history.
  "Open task view" is the existing task route.

**New card** (mockup 4): title, brief, framework (project default preselected), linked issue, the
framework's `cardFields`, stage preview, Skip first stage / Start at, per-stage model overrides,
Autonomous, Ready toggle (shows slot usage and cards ahead), budget. Save to Backlog / Create · Ready.

**Choose framework** (mockup 5, Settings → Project → Framework and the board header's Change):
built-ins with their stage strip and an availability line ("om-sdd-* skills found", ".specify/ not found"),
the detected framework marked "in use · detected" (D6) — picking another one writes an explicit
choice, and "Back to automatic" removes it — "New project framework (YAML)" and "Duplicate as
project framework" → `.ai/cezar/frameworks/<id>.yaml`.

**Framework detail** (mockup 6): read-only table per stage — runs, mode, session, gate/loop, must
leave, and whether this repo has the skill/command — the YAML source, Open compiled graph,
Duplicate & edit.

## Data model

```ts
// RunRecord (runs/store.ts) — optional, so old runs.json files still parse
card?: {
  framework: string;            // id at creation
  frameworkHash: string;        // of the YAML the graph was compiled from (D3)
  stage: string;                // D4
  stages: Record<string, 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped' | 'stale'>;
  held?: boolean;               // D2
  order?: number;               // Ready / Backlog position
  autonomous?: boolean;         // D11
  fields?: Record<string, string | boolean>;
  frameworkState?: { changeId: string; lastStatus: unknown }; // D7, SDD only
}
```

New state written (never required): `.ai/cezar/frameworks/` (user-authored, allowlisted as
committable). No new file in `~/.cezar/`.

## API (all project-scoped, chained into a family builder, schemas in `packages/contract`)

| Route | Purpose |
|---|---|
| `GET /frameworks` | built-in + project frameworks, availability, detection suggestion |
| `GET /frameworks/:id` | resolved stages (D14 artifacts, command presence), YAML, compiled graph |
| `POST /frameworks/:id/duplicate` | write `.ai/cezar/frameworks/<newId>.yaml` (never overwrite) |
| `PUT /project/framework` | `{ framework \| null }` → `.ai/cezar/config.json` (`null` = automatic, D6) |
| `POST /cards/:runId/approve` | SDD framework gate only (D9); local-only, 409 otherwise |
| `POST /cards` | create (compiles, `held` unless `ready: true`) |
| `PATCH /cards/:runId` | `held`, `order`, `autonomous`, fields while still in Backlog |
| `POST /cards/:runId/rerun` | `{ fromStage }` — reset the graph cursor to that stage's first node |
| `POST /cards/:runId/finish-stage` | conversation stage → next node |

Gate approve / request changes reuse the existing ask-answer route of `gate.human`. The board reads
the existing runs list (filter `card` present) and SSE — no new poll, no new WS topic. Every route
gets its `BACKWARD_COMPATIBILITY.md` §2 inventory line and its `/api/v1/p/:projectId` alias.

## Engine changes (`workflows/run.ts`, both turn-end handlers)

1. Node `stage` tag → update `card.stage`/`card.stages` on transition (one helper, called from the
   streaming and non-streaming handlers).
2. Agent node `mode: conversation`: after a turn without `CEZ:STAGE-DONE`, park as `waiting`
   instead of emitting `done`. `CEZ:STAGE-DONE` → an ask card "Finish this stage?" (Yes / Not yet).
3. `gate: framework` node: park `waiting`; a watcher on `state.watch` (plus a recheck after the
   D9 approve, on cockpit focus and at boot) runs `state.command` and emits `approve` when the
   stage is approved/done. The watcher is the only thing that advances the node — the Approve
   button's success is read back from the script, never assumed.
4. Artifact check after a stage's last node (D14).
5. WIP admission before a stage's first node (D13).
6. `rerun-from`: allowed on `waiting`/`review`/`failed` cards; loop counters are not reset (graph
   spec D18), so a re-run cannot make a run unbounded.
7. Scheduler skips `held` runs and orders queued cards by `card.order`, ad-hoc runs keep FIFO among
   themselves; a card and an ad-hoc run compete by enqueue time.

## Default path diff

With no card created: the scheduler's extra branch is never true, no `card` field is written,
the Tasks list renders the same rows (the filter chips appear only when a card exists), and
nothing is polled. Detection (D6) is a handful of `existsSync` calls when the board or New card
opens. A repo that has `.ai/sdd/` gets SDD as its board framework, but its ad-hoc tasks and
`quick-task` are untouched — a framework only ever applies to cards.

## Phases

1. **Engine + Generic**: `card` field, held/order scheduling, framework schema + compiler, Generic
   built-in, stage tagging, artifact check, List filters, New card, read-only Board (no drag).
2. **Open Mercato SDD**: detection as the default (D6), state watcher and in-cockpit approve (D9), conversation stages, autonomous
   assumptions at the gate, gate wizard, re-run from stage, drag rules, WIP limits.
3. **Authoring**: Choose framework (explicit choice / back to automatic), Framework detail, duplicate to project YAML,
   OpenSpec and spec-kit templates.

## Tests

- `compileFramework` golden graphs per built-in; validator rejects forward `onVerdict`, unbounded
  back edges, unknown stage refs.
- Scheduler: held runs never start; Ready order respected; an ad-hoc run is not starved by cards.
- WIP: card parked on a full stage wakes on each exit path (advance, fail, cancel, delete, re-run)
  and at boot — one test per path.
- Conversation stage: parks every turn without a slot; `CEZ:STAGE-DONE` + No stays; Finish moves on.
- SDD gate: watcher advances on `approved`, stays on `stale`, never on the agent's own output;
  a stage whose `sdd gate` exits non-zero never starts. Use a fixture repo with the vendored script.
- D9: Approve runs the script with `SDD_NONINTERACTIVE_APPROVAL` and commits `change.json`; the
  variable is absent from agent, check-node and terminal environments (one test each); remote
  mode answers 409; a failed approve leaves the card parked with the script's message.
- D6: detected SDD is used with no config; explicit `generic` beats detection; removing `.ai/sdd/`
  falls back to Generic for new cards while in-flight cards keep theirs.
- Recovery: a card parked at a gate, at WIP and in a conversation stage survives a restart.
- Contract parity + route parity for the new routes; `data-gitignore` covers `frameworks/`.
- Cockpit: list filters, board columns from the framework, drag refusal reasons, gate wizard.
- Guard (passes both ways): no card → today's list rows and scheduling, byte for byte.

## Owner decisions (2026-11-23)

| # | Question | Decision |
|---|---|---|
| Q1 | How does a person approve an SDD gate from a card? | In the cockpit: cezar runs `approve` with `SDD_NONINTERACTIVE_APPROVAL`, recorded as non-interactive (D9). |
| Q2 | Repo has `.ai/sdd/sdd.mjs` — which framework do new cards use? | SDD automatically; an explicit Settings choice wins (D6). |
| Q3 | Shape of Generic | `Plan ⏸ → Build → Review`. |
| Q4 | SDD Mockup and Secure in parallel? | Sequential in v1. |
| Q5 | Board scope | Per project. |
| Q6 | OpenSpec and spec-kit | Built-in templates in phase 3, marked provisional. |

## Mobile board

Below `md` (768px, `PHONE_QUERY` — the cockpit's phone breakpoint) `?view=board` renders
`MobileBoard` (`routes/cards/mobile-board.tsx`) instead of the kanban: same `useRuns` data, same
`boardColumns`, same drop handler. Drag does not exist on a phone; nothing else changes.

- **Header**: framework name (truncated) over its source; a `⏸ N need you` toggle that filters
  to cards needing a person; `⋯` holds slot usage, Change framework, Filter, `+N other tasks`
  (switches to the List).
- **Columns**: a `tablist` of chips `Name · count` (WIP stages `2/2`, warning tone when full, an
  amber dot — also in the chip's label — when a card there needs you); one `tabpanel` per column in
  a horizontal scroll-snap pager, so a swipe moves one column. Non-active panels are `inert`. The
  board fills the scroller's height and each column scrolls on its own, so the strip never
  scrolls away (no sticky offset needed — the shell's top bar already pads the safe area).
  Arrow keys / Home / End rove the strip; reduced motion jumps instead of smooth-scrolling.
- **Column in the URL**: `?view=board&col=<column id>` (replace, not push). Absent or unknown:
  the first column with a card that needs you, else the first non-empty stage, else Ready — and
  that choice is written back, so a card that stops needing you does not move the board.
- **Action sheet** (per-tile `⋯`) replaces drag: `cardMoves(run, { names, ready })` in
  `lib/cards.ts` asks `dropRule` one target at a time — Backlog/Ready, Move up/down (Ready),
  Approve & continue → next stage, Re-run from a stage (a second step). A refused move stays
  listed, `aria-disabled`, with the refusal reason a desktop drop would toast. Approve and Re-run
  go through the desktop's confirm dialog. Open card / Open task view close the sheet.
- **New card**: a 56px FAB above the phone bar (`--phone-bar`) and the home indicator; the dialog
  takes the full screen below `md`.
