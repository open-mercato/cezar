# A "monitoring" run activity — stop false "Needs attention" while the agent is still working

> Superseded for lifecycle/accounting by issue #654: monitoring sessions become durable and bounded separately from ordinary user waits; optional periodic wake-ups are designed in the linked #654 specs.

> FR: #490 · Slug: `subagent-monitoring-status`

## TLDR

When a task's agent ends a turn while it is **still working on its own downstream
work** — waiting on a sub-agent or a long-running command it is monitoring, not on
the user — cezar parks the run at `waiting`, which the cockpit renders as **"Needs
attention" / "The agent is paused, waiting for your reply."** That is a false
positive. This spec lets the agent **declare** that state with a new turn-end
marker, **`CEZ:MONITORING`** (a sibling of the existing `CEZ:DONE`), which cezar maps
to the existing **`running`** status plus a new optional **`activity: 'monitoring'`**
sub-state. The cockpit then shows a distinct, non-attention *monitoring* label and
never fires the attention/notification path. A genuine hand-off to the user (no
marker) still becomes `waiting` ("needs you"), exactly as today.

## Problem Statement

`src/workflows/run.ts` turn-end has one non-terminal outcome for an open interactive
session: `status: 'waiting'`, on the assumption *"Turn over, session open: the ball
is in the user's court"* (`run.ts:1204-1207`, and the sibling continuation site at
`run.ts:785-791`). Every attention surface is derived from that status:

- `deriveAttention()` (`web/app/src/lib/attention.ts:96`) maps `waiting` → amber
  pulsing **"needs you"**;
- `task-thread.tsx:219` shows **"The agent is paused, waiting for your reply"**;
- `notifications.ts` fires a browser notification via `wantsAttention`.

So whenever an agent ends a turn while its own work is still in flight, the whole
"needs a human" pipeline lights up with nothing asked of the user (issue #490, *"the
subagents are progressing ok and actually no user attention is needed but I got [the
paused banner]"*, confirmed by the author).

### Why detection cannot be inferred from tool events (rejected approach)

An earlier design tried to *infer* the state server-side by watching for an open
sub-agent (`Task`) tool-use at turn-end. Investigation of the actual runtime
disproved it, and it is recorded here so it is not re-attempted:

- **cezar models no background/async work at all** — there is zero handling of
  `run_in_background`, background tasks, or completion-notifications anywhere in
  `src/`. A turn ends when the backend emits its terminal message; cezar has no
  signal for "ended but work still pending."
- **Sub-agents are observed as synchronous.** The claude golden fixture
  (`src/core/__fixtures__/claude/subagent-task.ndjson`), this feature's own run
  transcript, and three large production run transcripts all show every `Task`
  tool-use resolving (its `tool_result` arriving) **before** the turn's `result`
  event. Across all sampled real runs, **no turn ever ended with an open sub-agent
  tool-use** — so an "open-tool-at-turn-end" signal would never fire.
- **`Task`/`Agent` isn't even in the default tool allowlist**
  (`DEFAULT_ALLOWED_TOOLS`, `types.ts:176`), and codex/opencode expose no
  comparable background lifecycle.

The information that separates "still working" from "needs you" is **not present in
the event stream** — but the *agent itself* knows which one it is (it chose to end
the turn). So the agent should declare it, the same way it already declares
completion with `CEZ:DONE`.

## Proposed Solution

Mirror cezar's existing agent-contract marker mechanism:

1. **Agent contract** — extend the injected handoff instructions
   (`HANDOFF_ONLY_INSTRUCTIONS`, `src/handoff.ts:139`, which every backend receives)
   with one rule: *if you end a turn still working on your own downstream work (a
   sub-agent or a command you're monitoring) and are NOT waiting on the user, end
   your final message with a line containing exactly `CEZ:MONITORING`.*
2. **Server detection** — at both turn-end sites, after the `CEZ:DONE` check, test
   the accumulated turn text for `CEZ:MONITORING`. When present (and the session is
   open and the turn wasn't auto-continued), set `status: 'running', activity:
   'monitoring'` instead of `waiting` — but otherwise treat the run **identically to
   a waiting run** (same slot release, same idle-liveness timer, same resume path).
3. **UI** — because the status stays `running` (already outside the attention path),
   the only additive UI change is `deriveAttention()` returning the label
   **"monitoring"** when `activity === 'monitoring'`. No notification, no "paused"
   hint, stays in the *Working* group — all inherited.

**Why a marker (agent-declared) beats inference.** It is **backend-agnostic** (the
contract is injected for claude, codex, and opencode alike → satisfies FR Q4 "work
for all agents"), **reliable and observable** (turn text is always present; detection
runs on the *accumulated* text so delta-streaming backends can't split the marker —
the same guarantee `CEZ:DONE` relies on), and **idiomatic** (it reuses the existing
`CEZ:DONE` pattern rather than inventing a parallel mechanism). Agents that don't emit
the marker degrade gracefully to today's `waiting` behavior.

**Why `activity` and not a new `RunStatus`** (per FR Q1: *"it should be a state of
running"*). A new top-level status would thread through ~a dozen status-enumeration
guard sites (`store.ts` recover/interrupt guards, `run.ts` live-run enumerations,
`task-groups` ordering, the `ALL_STATUSES` exhaustiveness test). Modelling it as an
optional **sub-state of the existing `running` status** keeps the change to one
optional field + one `deriveAttention` branch, and inherits correct non-attention
behavior everywhere.

## Research (how leaders distinguish "working" from "needs you")

Separating *in-progress* from *action-required* is standard in job/agent dashboards
(GitHub Actions splits "in progress" from manual-approval "waiting"; agent cockpits
distinguish an actively-working agent from one that asked the operator a question).
The rule they get right — *an agent blocked on its own downstream work is not blocked
on you* — is exactly this split. The novel constraint here is that cezar can't
observe that distinction from the stream, so it adopts the same agent-declared
sentinel it already uses for completion.

## Architecture

### Agent contract (`src/handoff.ts`)

Add to `HANDOFF_ONLY_INSTRUCTIONS` (inherited by `HANDOFF_INSTRUCTIONS`), alongside
the existing `CEZ:DONE` sentence, one rule introducing `CEZ:MONITORING`: emit it as
the final line when ending a turn while still working on downstream work and not
waiting on the user; never combine it with `CEZ:DONE`; a plain end (no marker) still
means "genuinely waiting on the user." Because both `HANDOFF_ONLY_INSTRUCTIONS` and
`HANDOFF_INSTRUCTIONS` are composed into the system prompt for every agent step
(`composeSystemPrompt`, `run.ts:803` and `:1226`), all three backends receive it.

### Detection (`src/workflows/run.ts`)

Add, next to `DONE_MARKER_RE` (`run.ts:42`):

```ts
const MONITORING_MARKER_RE = /CEZ:MONITORING\s*$/;   // detected on accumulated turn text
function stripMonitoringMarker(text: string): string { … }  // mirror stripDoneMarker
```

At **both** turn-end sites — `runAgentStep` (`~1188-1216`) and `runContinuation`
(`~752-793`) — after the existing `done` branch and (in the continuation site) inside
the `if (!autoContinued)` block, decide monitoring vs waiting:

```
const monitoring = sessionOpen && !done && MONITORING_MARKER_RE.test(turnText.trimEnd());
if (monitoring) {
  updateRun(runId, { status: 'running', activity: 'monitoring' });
  updateStep(runId, step.id, { status: 'running' });
} else {
  updateRun(runId, { status: 'waiting' });          // unchanged
  updateStep(runId, step.id, { status: 'waiting' });
}
// SHARED for both branches (unchanged from today's waiting path):
this.waiting.add(runId);      // frees the concurrency slot (busy() subtracts waiting)
this.armIdleTimer(runId, state);  // 15-min liveness reclaim — KEPT (see below)
void this.pump();
```

`CEZ:DONE` keeps precedence (checked first). The two sites are **not identical** —
only `runContinuation` has the autonomous-nudge escape hatch — so the branch is
inserted into each with its local structure; the autonomous nudge still wins over
monitoring (an autonomous run never parks).

**Lifecycle parity (resolves the slot-leak risk).** A `monitoring` run is treated
exactly like a `waiting` run for lifecycle: it is added to `this.waiting` (so it
frees its slot), and it **keeps** `armIdleTimer`. Per FR Q3 there is no escalation
*to "needs you"* — but the existing 15-minute idle timer still closes a truly-dead
session and reclaims its slot, identically to a waiting run. Monitoring changes only
the **surfaced status/attention**, never the liveness/slot accounting, so it can
never leak a slot that `waiting` wouldn't.

**Clearing `activity`.** `activity: 'monitoring'` is written only at the two turn-end
sites. It is cleared (`activity: undefined`) wherever a run leaves that state:

- `sendMessage` resume (`run.ts:601`) — already sets `status: 'running'`; also clears
  `activity` (a user reply means the agent is actively working again);
- `runContinuation` start (`run.ts:711`) and `recover()` (which resumes via
  `continueRun`);
- terminal transitions (`settleSuccess`/`finish`/cancel/fail, `run.ts:~1081`) and the
  `waiting` branch above.

Because `deriveAttention` gates the label on `status === 'running'`, a stale
`activity` on a non-running record is visually harmless, but it is cleared for
correctness so no finished record carries it.

### Cross-backend behavior (FR Q4)

The marker is agent-declared, so it works for **any** backend whose agent follows the
injected contract — claude, codex, and opencode all receive it. Backends/agents that
do not emit it fall back to `waiting`, exactly as today. This is strictly better than
the rejected tool-inference approach, which only ever had a chance on claude. (Same
reliability profile as `CEZ:DONE`: model-followed, gracefully degrading.)

### Data model

One optional field, additive and backward-compatible (old run files must still parse
— the `store.ts` convention that new `RunRecord` fields are optional):

```ts
// src/runs/store.ts
export type RunActivity = 'monitoring';
// on RunRecord:  activity?: RunActivity;
// zod:           activity: z.enum(['monitoring']).optional()
```

Mirrored in `web/app/src/api/types.ts` (`RunActivity` + `RunRecord.activity?`). No
`StepStatus` change — steps stay `running`.

### UI/UX

- **`deriveAttention`** (`attention.ts`): widen its input from
  `Pick<RunRecord,'status'>` to `Pick<RunRecord,'status'|'activity'>` (**required** —
  the current `AttentionInput` doesn't carry `activity`; call sites that build it must
  pass the field), and add, **before** the plain `running` branch:
  `if (run.status === 'running' && run.activity === 'monitoring') return { bucket:
  'running', tone: 'violet', pulse: true, label: 'monitoring' }`. Bucket `running` ⇒
  `wantsAttention` is `false`.
- **Sidebar dot / header pill** render `attention.{tone,pulse,label}` already, so the
  pill shows **"monitoring"** automatically. Note (honesty): the sidebar *dot* is the
  same violet-pulse as a running dot — only the label/pill text differs. This matches
  FR Q1 ("a state of running"); a distinct dot tone is out of scope.
- **"Paused, waiting for your reply" hint** (`task-thread.tsx:219`) keys on `status
  === 'waiting'` — a monitoring run is `running`, so the hint and the "reply" composer
  placeholder are already suppressed. Covered by a test.
- **Bucketing** (`task-groups.ts`): `running` → *Working* already; unchanged.
- **Notifications** (`notifications.ts`): gated on `wantsAttention` → a transition into
  `monitoring` fires **no** notification. Covered by a test.
- **Transcript hygiene**: strip a trailing `CEZ:MONITORING` from displayed text
  wherever `stripDoneMarker` is applied, so the marker doesn't show in the thread.

### Edge Cases & Failure Scenarios

- **Agent emits `CEZ:MONITORING`, then the user replies anyway.** `sendMessage`
  clears `activity` → back to plain `running`. Correct.
- **Agent emits both markers.** `CEZ:DONE` wins (checked first) → run completes.
- **Agent never emits the marker** (older agents, a backend ignoring the contract):
  falls back to `waiting` — status quo, no regression.
- **Monitoring run that never resumes.** The 15-minute idle timer closes the session
  and reclaims the slot, exactly as for a waiting run. No escalation to "needs you"
  (FR Q3), no slot leak.
- **Cancel / fail while monitoring.** Terminal transitions clear `activity`.
- **Delta-streaming backends** (codex/opencode) splitting the marker across text
  events: detection runs on the *accumulated* `turnText`, so the marker is matched
  whole — same guarantee `CEZ:DONE` documents (`run.ts:39-40`).

### Risks & Impact Review

- **Blast radius:** one optional persisted field, one marker regex + strip helper, one
  agent-contract sentence, the two turn-end branches, the `activity` clears, and one
  `deriveAttention` branch (+ widening its input type). No `RunStatus` enum change → no
  status-guard/exhaustiveness churn.
- **Backward compatibility:** additive optional field; old `runs.json`/NDJSON parse
  unchanged (schema test). No public route/config change. No new `CEZ_*` env var (a
  safe-by-default status refinement, not an exposure/cost-widening feature) →
  `.env.example` untouched.
- **Behavioral regression risk:** the only status-behavior change is at turn-end and
  is *opt-in by the marker* — without the marker, behavior is byte-for-byte today's.
  Guarded by a test asserting no-marker → `waiting`.
- **Rollback:** revert the PR; agents stop being told about the marker, `activity`
  stops being written, old records ignore it.

## Phasing

Each phase leaves the app working and is independently shippable.

- **Phase 1 — contract + server detection:** marker regex/strip, agent-contract line,
  the `activity` field, and the turn-end branch. After this, an agent that emits
  `CEZ:MONITORING` parks as `running`/`monitoring` server-side instead of `waiting`.
- **Phase 2 — UI surfacing:** `deriveAttention` label + tests proving no "paused"
  hint, no notification, correct pill/bucket.
- **Phase 3 — polish & docs:** transcript marker-stripping, heartbeat wording, and
  documenting the new marker beside `CEZ:DONE` in the agent-contract docs.

## Implementation Plan

### Phase 1 — Agent contract + server detection

1. **Marker + strip helpers.** In `src/workflows/run.ts` add `MONITORING_MARKER_RE =
   /CEZ:MONITORING\s*$/` and `stripMonitoringMarker` (mirror `DONE_MARKER_RE` /
   `stripDoneMarker`, `run.ts:42-48`).
   *Test:* the regex matches only at end-of-text (accumulated), tolerant of trailing
   whitespace; strip removes a trailing marker and leaves other text intact.
2. **Agent-contract line.** Add the `CEZ:MONITORING` rule to
   `HANDOFF_ONLY_INSTRUCTIONS` (`src/handoff.ts:139`).
   *Test:* `system-prompt.test.ts` — the composed prompt contains `CEZ:MONITORING`
   (both handoff variants).
3. **`activity` field.** `src/runs/store.ts`: add `RunActivity = 'monitoring'`,
   `RunRecord.activity?`, zod `activity: z.enum(['monitoring']).optional()`. Mirror in
   `web/app/src/api/types.ts`. Ensure `updateRun` can clear it (write `undefined`).
   *Test:* `runRecordSchema` parses a record without `activity` (back-compat) and with
   `activity:'monitoring'`; rejects an unknown activity value.
4. **Turn-end branch (both sites).** In `runAgentStep` (`~1204`) and `runContinuation`
   (`~785`, inside `if (!autoContinued)`), choose `running`+`activity:'monitoring'` vs
   `waiting` per `MONITORING_MARKER_RE`; keep `this.waiting.add`, `armIdleTimer`,
   `pump` in both branches. Clear `activity` on `sendMessage` resume (`~601`),
   continuation start (`~711`), and terminal transitions.
   *Test:* a fake turn-text ending in `CEZ:MONITORING` → run becomes
   `running`+`activity:'monitoring'`, is added to `this.waiting`, and arms the idle
   timer; without the marker → `waiting`; `CEZ:DONE` still wins; a `sendMessage`
   resume clears `activity`. (Use the existing run-test harness / dry-run mock, adding
   a `mock:monitoring` trigger analogous to `mock:done`.)

### Phase 2 — UI surfacing

5. **`deriveAttention` branch + input widening.** Widen `AttentionInput` to include
   `activity`; add the monitoring branch; update any call site that constructs the
   input to pass `activity`.
   *Test:* `attention.test.ts` — monitoring → `{bucket:'running', label:'monitoring'}`
   and `wantsAttention === false`; plain running unchanged; the `ALL_STATUSES`
   exhaustiveness set still passes (no new status).
6. **Surface + suppression tests.** `run-header.test.tsx` (pill shows "monitoring"),
   `task-thread.test.tsx` (a `running`+`monitoring` run shows **no** paused hint and an
   enabled composer without the "reply" placeholder), `notifications.test.ts` (a
   `running → monitoring` transition does not notify), a `task-groups`/quick-list test
   (stays in *Working*).

### Phase 3 — Polish & docs

7. **Transcript hygiene + heartbeat + docs.** Apply `stripMonitoringMarker` wherever
   `stripDoneMarker` is applied so the marker never shows in the thread; reflect
   `monitoring` in the turn-end handoff-heartbeat message (`run.ts:793`, `:1215`).
   Document `CEZ:MONITORING` beside `CEZ:DONE` in the agent-contract docs
   (`AGENTS.md` and/or `AGENT_PROTOCOL.md` — wherever `CEZ:DONE` is described). No
   `CEZ_*` env var, so `.env.example` is untouched.
   *Test:* a text event ending in the marker is stripped in the emitted transcript.
