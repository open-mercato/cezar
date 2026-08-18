# AGENT_PROTOCOL.md — the cezar agent protocol

cezar runs coding-agent CLIs behind **one backend-agnostic seam** and renders
every backend through **one normalized event vocabulary**. This document is the
operational contract for that seam: what a runner must implement, what it must
emit, how the emissions are tested, and what a *new* runner (e.g. `pi`, PR #387)
has to satisfy to be a first-class backend rather than a second-class one.

It is the concise, load-bearing contract. The deep design record lives in
`.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md` (§7 schema, §7.1 the
per-backend mapping tables) and the spec `.ai/specs/2026-07-14-cockpit-ui-redesign.md`
(§"Normalized agent-event protocol v2", §"Backend parity requirement"). The code
in `packages/cezar/src/core/` cites those two by section; this file cites the code. When the two
disagree, **the code wins** — the golden fixtures and the parity test are
executable, the prose is not.

The protocol has **two layers that ship together**:

- **v1 `AgentEvent`** — the original flat stream. Persisted in old NDJSON
  recordings and still consumed by `cezar run`'s console renderer. Never
  removed; old recordings must keep replaying forever.
- **v2 `UiEvent`** — the normalized, item-lifecycle protocol the redesigned
  cockpit renders. Emitted **alongside** v1, never replacing it. A mixed NDJSON
  file (v1 + v2 lines) is valid by design.

---

## 1. The runner seam (`packages/cezar/src/core/agent-runner.ts`)

Every backend is one class implementing `AgentRunner`, constructed through the
single factory `createRunner(backend)` in `packages/cezar/src/core/runner-factory.ts`. Nothing
outside `packages/cezar/src/core/` should ever `new` a concrete runner or branch on the backend
id — that is the whole point of the seam.

### Identity

```ts
const RUNNER_IDS = ['claude', 'codex', 'opencode', 'pi'] as const;  // the source of truth
type RunnerId     = (typeof RUNNER_IDS)[number];                   // user-selectable
type AgentBackend = RunnerId | 'claude-cli';                       // + legacy id, still parses
```

`RUNNER_IDS` is the tuple every other enumeration derives from — the zod schemas
(config, run store, workflow steps, the API bodies), the server-install
"at least one agent CLI" gate, and the CLI-handoff registry. Re-listing the ids
by hand is how a runner silently goes missing from one seam (#387 review); use
`RUNNER_IDS` / `isRunnerId()` instead.

`claude-cli` is a **legacy** backend id kept so old `runs.json` records and
NDJSON transcripts still parse; `createRunner` maps it onto `claude`. Follow that
precedent — never repurpose or remove a shipped id.

### `AgentRunner`

```ts
interface AgentRunner {
  readonly backend: AgentBackend;
  run(spec: AgentRunSpec, onEvent?: (e: AgentEvent) => void): Promise<AgentRunResult>;
  startSession(spec: AgentRunSpec, onEvent?: (e: AgentEvent) => void, opts?: SessionOptions): AgentSession;
  interrupt(): Promise<void>;
}
```

- `run()` is a one-shot convenience; `startSession()` is the real contract.
- Each backend runs as a **persistent process** so multi-turn follow-ups,
  `waiting`, interrupt and resume all work: claude = stream-json over
  stdin/stdout; codex = `codex app-server` JSON-RPC 2.0 (JSONL) over
  stdin/stdout; opencode = `opencode serve` over HTTP + SSE; pi =
  `pi --mode rpc` over JSONL stdin/stdout.

### `AgentSession`

A live session over one spawned process, alive between turns:

```ts
interface AgentSession {
  result: Promise<AgentRunResult>;   // resolves when the process exits
  readonly pid?: number;             // root of the run's process tree (resource telemetry, #348)
  sendMessage(content: ContentBlock[]): boolean;  // false when closed
  end(): void;                       // graceful: end input, SIGTERM→SIGKILL watchdog
  interrupt(): void;                 // hard stop (cancel)
  readonly open: boolean;
}
```

A termination the runner itself caused is **not** an agent failure (#703).
`end()` arms a SIGTERM→SIGKILL watchdog for CLIs that ignore EOF, and
`interrupt()` signals outright; the agent CLIs install their own handlers and
exit `128 + signal`. A runner MUST therefore record that it sent the signal and
settle such an exit on the normal path — `isSignalTerminationExit(exitCode)`
(`packages/cezar/src/core/agent-runner.ts`) plus a `note` — instead of throwing. Throwing makes
a finished run settle as `failed` and a cancelled run settle as `failed` too.

That watchdog MUST gate its SIGKILL escalation on real termination, never on
`ChildProcess.killed` (#844). Node sets `killed` when a signal is *delivered*,
so the watchdog's own SIGTERM flips it while the CLI — which handles the
signal — keeps running, and the escalation written for exactly that case is
skipped. Use `trackChildExit(child)` (`packages/cezar/src/core/agent-runner.ts`),
which seeds from `exitCode`/`signalCode` and listens for `exit`.

`SessionOptions`:

- `autoEndAfterFirstTurn?` — single-turn behavior for non-interactive workflow
  steps; interactive sessions control `end()` themselves.
- `onUiEvent?: (e: UiEvent) => void` — the **v2 channel**. It receives the
  normalized `UiEvent` stream emitted alongside the v1 `AgentEvent`s passed to
  `onEvent`. A runner that omits `onUiEvent` support degrades to v1-only — but a
  first-class backend MUST wire it (see §7).

### `AgentRunSpec`

The input to a run. Backend-agnostic; each runner translates it to its transport.
Notable fields (full doc-comments in the source):

- `userPrompt` (required), `systemPrompt?`, `images?` (first-message content
  blocks — pasted screenshots), `cwd` (the run dir and the only writable root),
  `model?`, `timeoutMs?`, `env?` (merged over `process.env` — carries
  `CEZ_HANDOFF_FILE` / `CEZ_TODOS_FILE` / `CEZ_TASK_ID`).
- `allowedTools?` / `bashAllowlist?` / `additionalDirectories?` — tool access.
  **Caveat (#430):** the zero-config default (`DEFAULT_ALLOWED_TOOLS`) includes
  unrestricted `Bash`, and Codex/OpenCode do not honor `allowedTools` at all.
  Treat the default `auto` permission mode as full shell access, not a
  sandbox: Codex uses `danger-full-access` with `approvalPolicy: never`, and
  OpenCode auto-approves every permission. Configurable restrictive modes are
  specified by `2026-07-17-permission-modes` (#475).
- `sessionId?` / `resume?` — stable session id for interactive takeover and for
  `--resume` ("Continue" after a run ends).

**System prompt channel** — a backend without a dedicated system-prompt input
must deliver `spec.systemPrompt` as a leading block of the opening user message.
Use the shared helper so the mapping is uniform:

```ts
prependSystemPrompt(spec.systemPrompt, spec.userPrompt)
// claude:          --append-system-prompt   (native channel, do NOT prepend)
// codex / opencode: prepended here
```

`ContentBlock` mirrors the Anthropic wire format (`text` | `image` base64) so it
can be written to the claude CLI's stdin verbatim.

---

## 2. v1 `AgentEvent` — the flat stream

The original normalized stream. Still emitted by every runner, still persisted,
still rendered by `cezar run`. **Do not remove or rename a variant** — v1 event
`type` strings are part of the on-disk NDJSON format.

```ts
type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; tool: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; result: string; isError: boolean }
  | { type: 'image'; mediaType: string; data: string }        // base64; run manager re-emits a URL
  | { type: 'token-usage'; tokensUsed: number }
  | { type: 'cost'; usd: number }
  | { type: 'session'; sessionId: string }                    // backend's real session id, once known
  | { type: 'turn-end' }
  | { type: 'note'; message: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

Every v1 event stays **derivable** from the v2 stream, so a consumer can migrate
one panel at a time. New work should read v2; v1 exists for the console renderer
and old recordings.

### Cezar-owned run metadata events

`provider-auth-required` is not emitted by a backend runner. The server derives it
from an authoritative v1/v2 authentication error, persists a provider id, opaque
incident id, and optional `stepId`, and the cockpit renders recovery guidance. It
does not change backend parity or expose the raw error.

---

## 3. v2 `UiEvent` — the normalized protocol (`packages/cezar/src/core/ui-events.ts`)

Pure vocabulary: no runtime imports, no runner coupling. Mirrored into the
api-client package at `packages/api-client/src/protocol/ui-events.ts`; the mirror is **checked**,
not trusted — `packages/cezar/src/server/api-types.test.ts` asserts type-exactness between the
two, so drift fails `npm run typecheck` (the gate) rather than the UI at runtime.

### Design rules baked in

1. **Item-lifecycle model** (Codex/ACP style): one stable `id` per item with
   `started → delta → updated → completed` phases. Two of the three backends are
   natively item-shaped; claude maps trivially.
2. **ACP vocabulary** wherever a choice is arbitrary (tool status/kind, plan
   entries, diff shape, stop reasons) — ecosystem alignment.
3. **Per-capability degradation, never per-backend** — see §6.

### The item model (one id-keyed stream for text, reasoning and tools)

```ts
type UiItem = UiMessageItem | UiReasoningItem | UiToolItem;
```

- `UiMessageItem` — `kind:'message'`, `role`, `text`, `phase?:'commentary'|'final'`.
- `UiReasoningItem` — `kind:'reasoning'`, `text` (extended thinking / reasoning summary).
- `UiToolItem` — `kind:'tool'`, `name` (backend tool name), `toolKind`, `title`
  (human line computed once — see §5), `status`, `input?`, `output?`, `error?`,
  `diffs?: FileDiff[]`, `locations?`, `exitCode?`, `parentItemId?`.

`parentItemId` nests subagent work under the tool item that spawned it (claude
`parent_tool_use_id`, opencode `subtask` parts, Codex collaboration receiver
thread ids).

### Enumerations

```ts
type ToolStatus = 'pending' | 'running' | 'completed' | 'failed' | 'declined';
type ToolKind   = 'read'|'edit'|'delete'|'move'|'search'|'execute'|'think'|'fetch'|'task'|'plan'|'other';
type StopReason = 'end_turn'|'max_tokens'|'refusal'|'cancelled'|'timeout'|'error';
type PlanStatus = 'pending' | 'in_progress' | 'completed';
```

Supporting shapes: `PlanEntry` (`content`, `status`, `priority?`, `activeForm?`),
`TokenUsage` (raw `input`/`output`/`cacheRead?`/`cacheWrite?`/`reasoning?`/`total`,
`contextWindow?` — **never pre-weighted**; cost weighting is a presentation
concern), `FileDiff` (`path`, `oldText: string|null` where `null` = newly
created, `newText?`, `unified?`), `ToolLocation`, and the reserved
`PermissionOption`/`PermissionOptionKind`.

### The events

```ts
type UiEvent =
  | UiSessionStartedEvent    // 'session.started'  — sessionId, backend, model?, cwd?, tools?
  | UiSessionEndedEvent      // 'session.ended'    — reason: StopReason (replaces v1 done / fatal error)
  | UiSessionErrorEvent      // 'session.error'    — message, fatal (v1 note + error unified)
  | UiTurnStartedEvent       // 'turn.started'     — turnId
  | UiTurnCompletedEvent     // 'turn.completed'   — turnId, stopReason, usage?, costUsd?
  | UiItemStartedEvent       // 'item.started'     — item (tools usually pending/running)
  | UiItemDeltaEvent         // 'item.delta'       — itemId, field:'text'|'reasoning'|'output', delta
  | UiItemUpdatedEvent       // 'item.updated'     — item (status flips, streamed snapshots)
  | UiItemCompletedEvent     // 'item.completed'   — item (final snapshot, safe to persist)
  | UiPlanUpdatedEvent       // 'plan.updated'     — entries: PlanEntry[] (FULL replacement, ACP semantics)
  | UiPermissionRequestedEvent  // 'permission.requested' — RESERVED (types only; wired when approvals become optional)
  | UiPermissionResolvedEvent   // 'permission.resolved'  — RESERVED
  | UiAskRequestedEvent      // 'ask.requested'    — requestId, questions[] (AskUser; the cockpit renders option chips)
  | UiUsageUpdatedEvent      // 'usage.updated'    — usage: TokenUsage, costUsd? (cumulative-for-session)
  | UiImageEvent;            // 'image'            — itemId?, mediaType, data (base64; manager re-emits URL)
```

**AskUser (`ask.requested`, #473, #565).** The portable path remains
backend-neutral: the agent asks a structured
multiple-choice question by ending a turn with a `CEZ:ASK <json>` control marker
(a sibling of `CEZ:DONE` / `CEZ:MONITORING`); the RunManager detects it on the
*assembled* turn text — uniform across claude, codex and opencode with no mapper
work — validates the payload (`packages/cezar/src/core/ask.ts`, modeled on Claude Code's
`AskUserQuestion`: 1–4 questions, 2–4 options each, `header` ≤12 chars), emits
`ask.requested` and parks the run `waiting`. The cockpit renders clickable option
chips; the user's pick (or a free-form reply) rides the normal reply seam
(`POST /api/runs/:id/messages`), and the card resolves client-side when that
message lands (no `ask.resolved` event). Codex additionally bridges its native
`item/tool/requestUserInput` server request onto the same event and routes the
next answer back as the documented JSON-RPC response. Malformed or unsupported
native requests receive an error response rather than hanging the turn. A
malformed marker degrades to plain text — the prose fallback is never made
worse. A native `AskUserQuestion`
control-protocol bridge for claude (the `control_request can_use_tool` path) is a
possible future enhancement; the marker is the portable baseline.

`item.completed` carries **snapshots**, not deltas — safe to persist. `item.delta`
carries **appends** to one field of a live item and must not be persisted as a
standalone truth.

---

## 4. Per-backend mapping (summary)

Each backend has a mapper (`packages/cezar/src/core/<backend>-ui-mapper.ts`) turning its wire
transport into `UiEvent`s. The authoritative table is
`agent-event-protocols.md` §7.1; the load-bearing rows:

| v2 event / field | claude (stream-json) | codex (app-server JSON-RPC) | opencode (serve HTTP+SSE) |
|---|---|---|---|
| `session.started` | `system/init` (model, tools, cwd) | `thread/started` / `thread/start` result | `POST /session` response |
| `turn.started` | each stdin user message | `turn/started` | each prompt POST |
| `turn.completed` + `stopReason` | `result` subtype (`success→end_turn`, `error_max_turns→max_tokens`, `error_during_execution→error`) | `turn/completed→end_turn`, `turn/failed→error`, interrupt→`cancelled` | `session.idle→end_turn` (or `error` if a `session.error` preceded) |
| message item | `assistant` `text` blocks (deltas via `--include-partial-messages`) | `agentMessage` items | text parts |
| reasoning item | `thinking` blocks | `reasoning` items (+ `textDelta`) | `reasoning` parts |
| tool item | `tool_use`→running, `tool_result`→completed/failed, `permission_denials`→`declined` | `commandExecution`→execute (+`exitCode`, `outputDelta`), `fileChange`→edit (`diffs`), `mcpToolCall`→other, `webSearch`→fetch, collaboration spawn→task | tool parts (state `pending/running/completed/error→failed`, `patch` parts→`diffs`) |
| `item.delta` `output` (live terminal) | *(none — card fills on completion; per-capability degradation)* | `item/commandExecution/outputDelta` | running-state metadata |
| `plan.updated` | `TodoWrite` input | `todoList` / `plan` items | `todowrite` tool |
| subagent nesting (`parentItemId`) | `parent_tool_use_id` | collaboration receiver thread id (review mode remains childless) | child-session parts under a `subtask` |
| `usage.updated` | `result.usage` + `total_cost_usd` | `thread/tokenUsage/updated` (no USD) | `message.updated` tokens/cost + `step-finish` |

**Mapper robustness contract.** Inputs come off the wire and may be `null`,
partial or malformed. A mapper **must never throw**: unparseable NDJSON lines are
skipped (`packages/cezar/src/core/ndjson.ts` + the mapper), unknown message/content types
produce **no events**, and malformed entries in a `plan.updated` payload are
filtered out (a non-array plan emits no plan event at all). Mapper state is
**explicit and immutable** — each mapper's map function takes `(frame, state)`
and returns `{ events, state }`, never mutating the passed-in state
(`mapClaudeMessage` / `mapCodexNotification` / `mapOpencodeEvent`, each paired
with a `create<Backend>UiState`; see the claude mapper's "state carries across
messages" tests).

---

## 5. The tool display model (`packages/cezar/src/core/tool-display.ts`)

`toolDisplay(name, input)` turns a backend tool name + raw input into
`{ toolKind, title, subtitle? }`, computed **once** in the protocol layer (never
in components) so the thread, activity groups and notifications all say the same
thing. It is a pure function over untrusted input and **must never throw**. Tool
names are matched case-insensitively, so claude's `Bash` and opencode's `bash`
share one row; unknown tools keep the backend's name as the title with a
heuristic subtitle. `mcp__server__tool` names collapse to `server.tool`.

---

## 6. Backend parity — the hard rule (`packages/cezar/src/core/ui-parity.test.ts`)

> Every capability in the parity matrix MUST be emitted by **every**
> backend, so the GUI degrades **per-capability, never per-backend**.

This is made executable: `ui-parity.test.ts` asserts each capability over each
backend's golden-fixture expected output. If a mapper change drops a capability —
or a new fixture set forgets one — a named row fails. The matrix:

- `plan.updated` with entries (TodoWrite / todoList / todowrite)
- tool status `running`, `completed`, `failed`
- reasoning items (thinking / reasoning items / reasoning parts)
- structured diffs (Edit input / fileChange.changes / patch parts)
- sub-agent task items (Task / review-mode span / subtask parts) — one item per
  sub-agent: codex's `enteredReviewMode`/`exitedReviewMode` pair folds into a
  single `task` item with a running→completed lifecycle, so a consumer counting
  task items counts agents, not frames (spec
  `.ai/specs/2026-07-20-grouped-subagent-display.md`, #474)
- `usage.updated` with raw token counts
- `turn.completed` with a `stopReason`
- sub-agent **nesting** via `parentItemId` where the upstream wire attributes
  child work to a parent

A new backend is not "done" until it produces every row.

## 7. The golden-fixture testing contract

Each backend has, under `packages/cezar/src/core/__fixtures__/<backend>/`:

- `<name>.ndjson` — a **wire-faithful** transcript of the backend's real output
  (shapes from `agent-event-protocols.md`, cross-checked against the backend's
  actual CLI / the dry-run mock, e.g. `packages/cezar/scripts/mock-claude.mjs`).
- `<name>.expected.json` — the **exact** `UiEvent[]` the mapper must produce for
  that transcript.

`<backend>-ui-mapper.test.ts` replays each fixture **exactly as the runner drives
the mapper** (seed turn started before the first line; malformed lines skipped),
round-trips the result through JSON (so a stray `undefined` fails loudly, since
these events get persisted as NDJSON), and asserts `toStrictEqual` against the
`.expected.json`. The same `.expected.json` files feed the parity test in §6.

> Verify fixtures against **upstream wire shapes**, never against your own
> assumptions. PR #443's root cause was a fixture that encoded an *assumed*
> codex shape (`todoList` items that the app-server never emits), which hid a bug
> where a codex plan never rendered at all. When adding a fixture, cite the
> upstream schema/source it was derived from, as #443 did.

## 8. Persistence & transport

- **NDJSON** — one append-only `runs/<id>.ndjson` per run, one JSON object per
  line (`seq`, `ts`, `type`, free extra keys). Never rewrite, reorder or
  re-number; readers skip bad lines. Both v1 and v2 events live here; a mixed
  file is valid. Cezar-owned task events are additive too: for example,
  `provider-auth-required` records only `{ provider, authFailureId, stepId? }`
  when a runtime rejection needs user authorization; it never carries vendor
  error text or credentials.
- **SSE** — the server replays from NDJSON then streams live, deduped by `seq`.
  Event names: `run-event` (v1) and `ui-event` (v2 dotted types). These names are
  a protected contract (see `BACKWARD_COMPATIBILITY.md` §2).

---

## 9. Adding a new runner (the #387 `pi` checklist)

A new backend is a **single class behind the seam** plus its mapper, fixtures and
the parity row — never backend-specific types leaking past
`packages/cezar/src/core/`. PR #387 added `pi` and enumerated every place the
runner union was duplicated; that list is the concrete map, and the union now
derives from one `RUNNER_IDS` tuple in `agent-runner.ts` so most of it is
typecheck-enforced rather than hand-tracked.

To be first-class:

1. **Runner** — `packages/cezar/src/core/pi-runner.ts` implementing `AgentRunner` /
   `AgentSession` (persistent process; `pid`; `sendMessage`/`end`/`interrupt`;
   `result`). Honor `AgentRunSpec` uniformly — use `prependSystemPrompt` if the
   backend has no native system-prompt channel.
2. **Factory** — add the id to `RunnerId` / `RUNNER_IDS` (`agent-runner.ts`) and
   a `case` in `createRunner` (`runner-factory.ts`). Add `UiBackend` in
   `ui-events.ts` **and its mirror** `packages/api-client/src/protocol/ui-events.ts` (the
   type-exactness test guards drift).
3. **Detection** — a `probePi()` in `backend-detect.ts` plus the `BackendCheck`
   name union; degrade gracefully when the CLI is absent (never fail boot). If it
   needs a binary override, add `CEZ_PI_BIN` — and per AGENTS.md's zero-config
   rule, document any new `CEZ_*` var in `.env.example` in the same commit.
4. **Mapper** — `packages/cezar/src/core/<runner>-ui-mapper.ts` emitting the full
   v2 `UiEvent` stream **alongside** v1. Never throw on malformed input; explicit
   immutable state.
5. **v1 alongside v2** — wire `SessionOptions.onUiEvent`; keep the v1
   `AgentEvent` stream flowing unchanged.
6. **Golden fixtures** — `packages/cezar/src/core/__fixtures__/<runner>/*.ndjson` +
   `*.expected.json`, wire-faithful and citing their upstream source, covering
   **every** parity matrix capability (§6), and a `<runner>-ui-mapper.test.ts`
   replaying them.
7. **Parity** — add the id to `BACKENDS` in `ui-parity.test.ts`; every capability
   row must pass. (If the backend has no wire parent attribution, document the
   nesting cell's substitute the way codex's review-mode items are handled.)
8. **Plumbing** — the run-store `runner` enum, workflow step schema, the
   `POST /api/runs` / `PUT /api/config` bodies, `resumeCommand()`, the web
   `Runner` type, composer pills/presets, and Settings → Agents. Keep additive
   so old `runs.json` records still parse (the `runner` enum keeps `claude-cli`
   parseable — follow that precedent).
9. **Model selection** — accept `provider/model` where relevant; #387 documents
   the existing inconsistencies (opencode drops a bare model silently) — do not
   reproduce a silent-drop. A backend with no default provider gets no entry in
   `BACKEND_MODEL_MAP`'s default column, so a bare id fails loud.
10. **Credentials** — one entry in `BACKEND_ALLOW_PREFIXES` (`agent-env.ts`):
   `buildChildEnv` is least-privilege per backend, so a multi-provider runner
   must receive credentials for every provider its own model ids can name
   without widening other backends.

## 10. The plan channel (PR #443)

PR #443 (`fix/issue-433-render-plan-todo`, open at the time of writing) hardens
`plan.updated` across all three backends after finding the plan never reached the
cockpit dock — for a different reason on each backend. Its direction, which any
new runner should follow:

- **Claude** — current-session plans use `TaskCreate` / `TaskUpdate` / `TaskList`
  (not only `TodoWrite`); classify all of them as plan tools and fold them into
  a snapshot keyed by the task id the harness reports in each tool's **result**.
- **Codex** — the real plan channel is the turn-level notification
  `turn/plan/updated`, not a `todoList` item (which the app-server never emits);
  map it to `plan.updated` as a full replacement.
- **OpenCode** — `status` is free-form upstream; `cancelled` is a documented
  value. Don't whitelist a few statuses and silently drop the rest — an
  unrecognized status degrades to `pending` so a todo the agent wrote stays on
  screen.
- **General** — `plan.updated` is full-replacement; only a genuinely empty list
  clears the dock (a malformed frame maps to zero events, never a wipe).

The `plan.updated` **event name and payload structure are unchanged**; #443
extends the *handling*, not the wire shape (on `main`, `PlanStatus` is the three
values in §3).

---

## Compatibility

The agent event protocol is a protected surface: see `BACKWARD_COMPATIBILITY.md`
§7. In short — v1 `AgentEvent` `type` strings and v2 `UiEvent` dotted types are
additive-only; removing/renaming one, or breaking the parity requirement, is a
breaking change requiring the documented deprecation path.

## Related documents

- `AGENTS.md` — repo working rules; the "Agent runners / backends" routing row.
- `BACKWARD_COMPATIBILITY.md` — §7 (this protocol) and §2/§3 (SSE names, NDJSON).
- `.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md` — the deep design record (§7, §7.1).
- `.ai/specs/2026-07-14-cockpit-ui-redesign.md` — the spec (protocol v2, parity requirement).
