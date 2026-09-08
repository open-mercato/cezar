# Escalation ladder for the unit hierarchy — analysis and design

> Scope: `.ai/specs/units-improvements/01-communication/03-escalation-ladder.md` only. Analysis
> only — no source, test or config file was touched to produce this document. All line numbers
> verified at HEAD (`df73cfa9`) in this worktree.

## 0. What this document answers

Today a unit run's `CEZ:ASK` parks it at `waiting` and raises the question straight to the
**human** Guard inbox, no matter how deep in the tree the run is. §1 proves that with citations.
§2 designs a ladder where a question climbs **one rank at a time**
(centurion → legate → Caesar → human) and only genuinely irreversible/financial questions ever
reach a human. §3 lists ranked proposals. §4 is the state-machine table. §5 is open questions.

---

## 1. Current behaviour, with evidence

### 1.1 `CEZ:ASK` — marker, schema, parse (`packages/cezar/src/core/ask.ts`)

- The wire shape is `askRequestSchema` (`ask.ts:43-53`): `{ questions: AskQuestion[] }`, 1-4
  questions, each `{ id?, header (≤12), question (≤400), options (2-4, unique labels),
  multiSelect? }` (`ask.ts:18-41`). `.strict()` on both objects — unknown keys reject the whole
  payload (`ask.ts:18-23`, `ask.ts:25-41`).
- `parseAskMarkerResult` (`ask.ts:216-244`) matches the trailing marker
  (`ASK_MARKER_CANDIDATE_RE`, `ask.ts:97`), `JSON.parse`s the captured tail, repairs missing
  closers via `closeUnbalancedJson` (`ask.ts:173-198`, the one syntax slip that actually happens,
  #936), then validates strictly and — only on failure — through one normalization pass that clips
  display-only fields but never invents required ones (`ask.ts:114-149`).
- This module is **shared infrastructure**: it is used by every cezar run, unit or not. It carries
  no notion of rank, parent, or unit hierarchy anywhere in the file.

### 1.2 Both turn-end sites call the SAME resolver (`resolveAskTurn`)

`resolveAskTurn` (`run.ts:218-227`) is explicitly the one helper both handlers route through,
"because `AGENTS.md` warns that a lifecycle change applied to only one of them ships half a fix"
(`run.ts:212-214`, verbatim comment). It returns `{ ask, notes }`; the two call sites are:

- **`runAgentStep`** (the streaming turn-end, inside `execute`): `resolveAskTurn` called at
  `run.ts:2968-2971`, `emitAskRequested(sink, ask)` at `run.ts:3025`, park to
  `status: 'waiting', activity: undefined` at `run.ts:3035-3036`, `this.waiting.add(runId)` at
  `run.ts:3040`, `this.releaseSlot()` at `run.ts:3042`.
- **`runContinuation`**: `resolveAskTurn` called at `run.ts:3695-3698`, `emitAskRequested(sink,
  ask)` at `run.ts:3727`, identical park at `run.ts:3737-3738`, `this.waiting.add(runId)` at
  `run.ts:3742`, `this.releaseSlot()` at `run.ts:3744`.

Both sites emit the same v2 event: `emitAskRequested` (`run.ts:173-177`) mints a `requestId` and
calls `sink.handle({ type: 'ask.requested', requestId, questions: ask.questions })` — an **SSE UI
event with no persisted twin on the run record**. Nothing under `unit` or elsewhere in
`RunRecord` stores the pending question (contrast with reports, §1.4).

### 1.3 Unit-marker precedence (`packages/cezar/src/units/markers.ts`, `handleUnitMarkers`)

Precedence is stated once, verbatim, in three places that must agree: the spec
(`.ai/specs/2026-09-08-units-hierarchy.md:83`), `markers.ts:19-20`, and the docstring on
`handleUnitMarkers` (`run.ts:1525`):

> `CEZ:DONE` > `CEZ:SPAWN` > `CEZ:REPORT` > `CEZ:ASK` > `CEZ:MONITORING` > plain end.

`handleUnitMarkers` (`run.ts:1531-1567`) strips `CEZ:DONE` first (`run.ts:1544`), always records a
valid `CEZ:REPORT` regardless of precedence (`run.ts:1546-1554`, the "one deliberate refinement"
noted at `run.ts:1526-1529`), then — only if the turn was not itself a `CEZ:DONE` — attempts
`CEZ:SPAWN` (`run.ts:1558-1564`) and finally checks the budget brake (`run.ts:1566`,
`enforceUnitBudget` at `run.ts:1578-1593`). `CEZ:ASK` is **not parsed inside this helper at all** —
it is parsed separately by `resolveAskTurn`, gated on `!unitTurn.spawned` (`run.ts:2970`,
`run.ts:3697`), which is exactly what gives spawn precedence over ask without `handleUnitMarkers`
needing to know about asking.

### 1.4 The autonomous-nudge exception for a unit run that asked

Both turn-end sites compute the same `autoContinued` boolean. The unit-only guard clause is
identical in both:

```
!(unitTurn.hasUnit && Boolean(ask))
```

— `run.ts:3006` (in `runAgentStep`) — there is no `runContinuation` twin of this exact
`autoContinued` block visible in this scan region; verified by direct diff of the two `if
(sessionOpen)` / autonomous blocks against `runContinuation`'s single `waiting` gate at
`run.ts:3718`, which folds the same "unit asked → do not nudge" behaviour into the simpler
`interactive && sessionOpen` condition upstream (`resolveAskTurn`'s own `enabled` argument at
`run.ts:3697` already excludes a spawned turn, and `runContinuation` has no separate autonomous
nudge — nudging is `runAgentStep`-only, so the guard at `run.ts:3006` is the operative one for
autonomous unit runs). The comment at `run.ts:2998-3000` names this explicitly: *"the Guard
(Q4): an autonomous unit run must not answer its own `CEZ:ASK`. That is the whole point of asking
before something irreversible."*

### 1.5 The Guard rule text (`packages/cezar/src/units/prompts.ts:79-84`)

```
The Guard rule — this one is absolute. Before ANY action that is irreversible, financial, or
widens your scope, end the turn with CEZ:ASK and stop. That includes: pushing to a shared branch,
merging anything, force-pushing, deleting a branch or a remote, publishing a package, spending
money, touching production or any credential, rewriting history, and doing work outside the scope
you were given.

- Ask with CEZ:ASK, not in prose: a single line CEZ:ASK {...} — 1-4 questions, 2-4 options each.
  Then stop. Do not keep working past your own question, and do not answer it yourself.
- Never work around a blocked action...
- Open pull requests as DRAFTS. Never merge to the base branch, and never push to it.
- When in doubt about whether something is reversible, it is not. Ask.
```

`GUARD_RULE` is composed **identically** into `CAESAR_PROMPT`, `LEGATE_PROMPT` and
`CENTURION_PROMPT` (`prompts.ts:111`, `prompts.ts:138`, `prompts.ts:162`) — "identical in all
three prompts, because the whole point is that it does not weaken as you go down the ranks"
(`prompts.ts:77-78`). Nothing in the prompt tells a centurion or legate to ask its own commander
first; it tells every rank to raise `CEZ:ASK` directly.

### 1.6 The cockpit Guard inbox (`packages/web/src/routes/missions/guard.tsx`,
`packages/web/src/lib/missions.ts`)

`GuardRoute` (`guard.tsx:25-81`) reads `guardQueue(buildMissionTrees(runs.data ?? []))`
(`guard.tsx:39`) and renders every row with `<Link to={`/tasks/${node.run.id}`}>Open</Link>`
(`guard.tsx:73`) — straight to that **individual run's own thread**, not its parent's. The
membership rule is a pure function of the run's own status, at any depth:

```ts
// missions.ts:106
needsGuard: run.status === 'waiting',
```

```ts
// missions.ts:242-252
export function guardQueue(trees) {
  return trees
    .flatMap((mission) => flattenMission(mission.root).map((node) => ({ node, mission })))
    .filter(({ node }) => node.needsGuard)
    .sort(...)
}
```

`flattenMission` walks the **whole tree**, so a centurion three levels down that is `waiting`
appears in this queue exactly like Caesar would. The code comment even names the gap explicitly:
*"the record carries no pending-ask flag ... A unit run only parks at `waiting` when it asked
something, so the two coincide today"* (`missions.ts:58-62`) — i.e. the cockpit cannot currently
tell "waiting because it asked something Guard-worthy" from any other kind of waiting, because the
engine gives it nothing more to look at than `status`.

### 1.7 Conclusion — confirmed

**A centurion's `CEZ:ASK` parks it at `waiting` (`run.ts:3035-3036` / `run.ts:3737-3738`), raises
an `ask.requested` SSE event with no persisted twin (`run.ts:173-177`), and is picked up by the
Guard inbox purely because `status === 'waiting'` (`missions.ts:106`, `missions.ts:242-252`),
regardless of `unit.parentRunId`. No code path reads or notifies `unit.parentRunId` when a
`CEZ:ASK` fires — contrast `reportSettledChildToParent` (`run.ts:1756-1827`), which explicitly
resolves `child.unit.parentRunId` (`run.ts:1759`) and delivers into the parent's own session. The
ask path has no equivalent. Confirmed: the ladder does not exist today.**

---

## 2. Findings

| id | severity | finding | evidence | why it matters |
|---|---|---|---|---|
| F-E1 | high | `CEZ:ASK` bypasses the whole unit tree — every rank's question reaches the human Guard inbox identically, with no notion of "ask my commander first." | `run.ts:3035-3036`, `run.ts:3737-3738`, `missions.ts:106`, `missions.ts:242-252` (§1.7) | Defeats the stated goal of a hierarchy: a human running an army-sized mission is paged for every centurion's routine clarification, which is worse than a flat run — more agents, same interruption rate per agent. |
| F-E2 | high | A `waiting` run — asked or not — is unconditionally **settled** (`done`/`review`) on restart recovery, and the pending question is discarded with no trace beyond the transcript. | `run.ts:1328-1338` (`recover()`: `settleSuccess` then `reportSettledChildToParent`); pinned by `recover-unit.test.ts:136-167` ("reports a waiting child settled by recovery to its parent" — asserts `status` becomes `'done'`) | Any escalation design that reuses `status: 'waiting'` inherits this: a cezar restart while a question is in flight silently answers it "done" and reports that upward, which is a correctness bug for a Guard whose entire premise is "stop before anything irreversible." |
| F-E3 | high | `ask.requested` has no persisted counterpart on the run record — only an ephemeral v2 SSE event (`run.ts:173-177`). | `run.ts:173-177`; grep of `ask.requested` shows it only in event-history / UI-event plumbing, never in `unitSchema` (`packages/contract/src/units.ts:101-117`) | Combined with F-E2, a pending ask/escalation is invisible to anything that reads only the record (a recovered process, a script, a second cockpit tab that missed the SSE event) — the ONLY durable trace is the transcript event, not structured state a new marker/escalation design can safely branch on. |
| F-E4 | med | `resolveAskTurn`'s unit-run nudge-skip guard (`!(unitTurn.hasUnit && Boolean(ask))`, `run.ts:3006`) exists in `runAgentStep` but the equivalent fold happens implicitly inside `runContinuation`'s `waiting` gate (`run.ts:3718`) rather than as a parallel named guard — the two sites express the same rule through different code shapes. | `run.ts:3002-3018` vs `run.ts:3718-3745` | Any escalation marker that needs the "must not answer its own question" guarantee has to be re-verified against BOTH shapes independently; a naive port of the `runAgentStep` guard into a hypothetical `runContinuation` rewrite could silently diverge, which is precisely the AGENTS.md "two near-identical turn-end handlers" trap. |
| F-E5 | med | The cockpit Guard inbox filter (`needsGuard: run.status === 'waiting'`) has no way to distinguish "waiting on the human" from "waiting on a live ancestor" — its own comment admits this is coincidence, not a guarantee (`missions.ts:58-62`). | `missions.ts:58-62`, `missions.ts:106` | Any ladder design that keeps the CHILD at `status: 'waiting'` while its question is only addressed to a parent (not the human) will, unless the filter changes, immediately re-flood the Guard inbox with internal rank-to-rank chatter — the exact regression F-E1 is meant to fix, shipped as a "fix" that changes nothing on the default path (AGENTS.md § replacement-that-ships-off). |
| F-E6 | med | Role prompts (`CAESAR_PROMPT`, `LEGATE_PROMPT`, `CENTURION_PROMPT`) are the ONLY place a unit run learns the `CEZ:ASK`/`CEZ:SPAWN`/`CEZ:REPORT` shapes (`prompts.ts:7-10`) — a marker/schema change with no matching prompt change is unreachable by any model. | `prompts.ts:7-10`, `prompts.ts:79-84` composed identically into all three roles | This is the concrete form of "a replacement that ships OFF is not a replacement" for this specific feature: shipping a new marker without updating `CENTURION_PROMPT`/`LEGATE_PROMPT` means zero unit runs will ever emit it — the ladder is dead on the default path even with `CEZ_UNITS=1`. |
| F-E7 | low | `MAX_AUTO_CONTINUES` (`run.ts:313`) and the monitoring-wake counters (`ActiveRun.autoContinues`, `ActiveRun.monitoringWakeups`, `run.ts:276`, `run.ts:264`) are **in-memory only** — not persisted on the record — so they reset to 0 on every restart. | `run.ts:253-310` (`ActiveRun` interface, no `autoContinues`/`monitoringWakeups` in `unitSchema`, `packages/contract/src/units.ts:101-117`) | Pre-existing gap, not introduced here, but directly relevant: any NEW round-cap for escalation ping-pong must decide up front whether to repeat this in-memory-only pattern (simple, but restart-forgetful) or persist on `unit` (restart-safe, but a new field every read path must thread through — see §3, P-E4). |

---

## 3. Proposals (ranked)

### P-E1 — New `CEZ:ESCALATE` / `CEZ:ANSWER` marker pair, routed through `handleUnitMarkers`

**Problem.** `CEZ:ASK` is shared, unit-agnostic infrastructure (`ask.ts`) used by every cezar run.
Overloading it with a rank-aware routing field would either (a) leak unit concepts into
non-unit runs' wire schema, or (b) require every non-unit caller of `ask.ts` to reason about a
field that is meaningless outside a mission. `markers.ts` already makes this exact call for
`CEZ:SPAWN`/`CEZ:REPORT` — modeled on `ask.ts`'s parsing machinery but deliberately **not**
sharing its schema or its normalization layer (`markers.ts:1-21`, `markers.ts:12-17`).

**Concrete change.**

- New marker `CEZ:ESCALATE <json>` — a unit-only "ask my commander" question, parsed by
  `units/markers.ts` via the shared `parseMarker` helper (`markers.ts:62-89`), same pattern as
  `parseSpawnMarkerResult`/`parseReportMarkerResult`:

  ```ts
  // packages/contract/src/units.ts — new
  export const unitEscalateSchema = z.object({
    requestId: z.string().min(1).max(64).optional(), // engine mints one when absent
    irreversible: z.boolean(),   // asker classifies — see below
    financial: z.boolean(),
    questions: askQuestionSchema.array().min(1).max(4)
      .refine((qs) => new Set(qs.map((q) => q.question)).size === qs.length),
  }).strict();
  ```

  Wire form, spelled in the (updated) role prompt exactly like `SPAWN_CONTRACT`/`REPORT_CONTRACT`
  are today (`prompts.ts:44-59`, `prompts.ts:62-75`):

  ```
  CEZ:ESCALATE {"irreversible":true,"financial":false,"questions":[{"header":"…","question":"…?","options":[{"label":"…"}]}]}
  ```

- New marker `CEZ:ANSWER <json>` — a parent answering one or more pending child escalations in
  one turn (bounded like `CEZ:SPAWN`'s children, `markers.ts` / `unitSpawnSchema`,
  `packages/contract/src/units.ts:128-153`):

  ```ts
  export const unitAnswerSchema = z.object({
    answers: z.array(z.object({
      requestId: z.string().min(1).max(64),
      childRunId: z.string().min(1),
      text: z.string().min(1).max(2000),
    })).min(1).max(4),
  }).strict();
  ```

- **`CEZ:ASK` is unchanged, byte-for-byte** — `ask.ts` gains nothing. It keeps meaning "reach the
  human directly" and is now reserved, by role-prompt convention (not engine enforcement — see
  classification below), for Caesar (which has no parent to escalate to) and for the terminal
  fallback case in P-E2.

**Classification rule — who decides "irreversible/financial"?** The **asker declares it** via the
two required booleans on `unitEscalateSchema`, because:

1. `GUARD_RULE` already trains every rank on these two named categories verbatim
   (`prompts.ts:79`: "irreversible, financial, or widens your scope" with a concrete list at
   `prompts.ts:79-80`) — the model already has the vocabulary; asking it to name what it already
   recognizes is not new judgment, just structured output.
2. An engine-side heuristic (keyword-matching the question text, say) is exactly the kind of
   invisible, unaccountable policy AGENTS.md's zero-config section warns against — "when a
   feature seems to need configuration, the design is wrong. Discover it, or default it" cuts the
   other way here: there is nothing in the repo, environment or run record to discover this from;
   only the asker's own intent supplies it.
3. Classification is **not final** — see P-E2: each parent re-applies its own judgment on receipt
   and can escalate further (or answer) regardless of what the child claimed. A child that
   over-classifies "irreversible" gets a legate's or Caesar's answer instead of a human's, same as
   a human today would tell an over-cautious report to stand down.
4. A malformed payload (missing `irreversible`/`financial`, since both are required with no
   default) is refused with a transcript note, exactly like a malformed `CEZ:SPAWN` today
   (`markers.ts:12-17`, `run.ts:1562-1564`'s `unitMarkerRejection` pattern) — never silently
   defaulted to either "trust the chain" or "go straight to human." Reusing that pattern means one
   more schema, zero new refusal machinery.

**Precedence.** Extends the existing chain (`markers.ts:19-20`, `run.ts:1525`) at the point
`CEZ:ASK` sits today, with `CEZ:ANSWER` next to `CEZ:REPORT` (both are "the parent telling someone
something," and `CEZ:REPORT` already runs unconditionally before the precedence gate,
`run.ts:1546-1554`):

```
CEZ:DONE > CEZ:SPAWN > CEZ:REPORT > CEZ:ANSWER > CEZ:ESCALATE > CEZ:ASK > CEZ:MONITORING > plain end
```

`CEZ:ANSWER` does not by itself change the parent's own park decision (mirrors `CEZ:REPORT`); if
the parent still has other in-flight children or open escalations after answering, it auto-parks
as monitoring exactly the way a fresh `CEZ:SPAWN` does today (`run.ts:2972-2980`,
"a spawn parks the parent exactly like `CEZ:MONITORING` does") — this reuses `unitTurn.spawned`'s
existing role in the `monitoring` boolean (`run.ts:2975-2980`, `run.ts:3701-3707`) by adding a
sibling `unitTurn.escalated` / `unitTurn.answered` flag to `handleUnitMarkers`'s return shape.

**Default-path impact (every new knob at its shipped default).**

- `CEZ_UNITS` unset → nothing parses `CEZ:ESCALATE`/`CEZ:ANSWER` at all (same gate as today's
  `unitOf` at `run.ts:1450-1453`). Byte-for-byte unchanged.
- `CEZ_UNITS=1`, run has no `unit` (a plain flat run) → `state.unitRole` is unset, and the new
  markers are gated on it exactly like `stripUnitMarkers` is today (`run.ts:2928`). `CEZ:ASK`
  behaves exactly as it does today for every non-unit run. **This is the single most important
  default-path check**: it must never regress the far more common flat-run ask flow.
- `CEZ_UNITS=1`, unit run, **prompt not updated** → dead knob (F-E6). This proposal is only a
  replacement if shipped together with P-E5 (prompt update) in the same commit — see effort/risk
  below.

**Transitions out of the new states** — see §4 (state-machine table) for the full enumeration;
summarized: `running →(CEZ:ESCALATE)→ escalated-waiting →(answer delivered | human answers
directly | cancel cascade | round-cap forces human fallback)→ running | cancelled`.

**Tests to pin.**

- `units/markers.test.ts` twin for `CEZ:ESCALATE`/`CEZ:ANSWER`: valid, malformed (missing
  `irreversible`/`financial`), unknown keys, >4 answers, repaired-JSON case (reuse
  `closeUnbalancedJson` coverage pattern already exercised for `CEZ:ASK`/`CEZ:SPAWN`).
- Engine test (fake runner, **both** turn-end sites, per the existing engine test file's own
  stated coverage list, `.ai/specs/2026-09-08-units-hierarchy.md:153`): a centurion's
  `CEZ:ESCALATE` delivers into its legate's open session and does not touch the human Guard queue;
  an unreachable/over-budget legate causes fallback to the grandparent (see P-E2); Caesar's own
  `CEZ:ESCALATE` is refused (or, per P-E2's design, silently treated as `CEZ:ASK` — pick one and
  pin it) since Caesar has no parent.
- Guard test (mirrors `.ai/specs/2026-09-08-units-hierarchy.md:153`'s "autonomous unit run does
  not auto-continue past `CEZ:ASK`"): an autonomous unit run must not auto-continue past
  `CEZ:ESCALATE` either, in **both** handlers (F-E4 makes this its own explicit assertion, not an
  assumed corollary).
- `contract-parity.units.test.ts` extended for the two new schemas (this is the existing parity
  suite named in the spec, `.ai/specs/2026-09-08-units-hierarchy.md:36`).

**Effort:** L. **Risk:** med — two new markers, one new engine delivery path reused in two
directions (child→parent, parent→child), and a mandatory same-commit prompt change (P-E5) to avoid
F-E6.

---

### P-E2 — Routing: one hop to the immediate parent, with a "dead ancestor" skip rule

**Problem.** A ladder that always targets the immediate parent is correct only when that parent is
reachable. `reportSettledChildToParent` (`run.ts:1756-1827`) already had to solve this for
reports and its answer is the template: try `deliverMessage` (open session), then
`enqueueMessage` (queued), then — only for a **non-cancelled** settled parent —
`continueRun(...)` (`run.ts:1812-1822`); a cancelled parent gets nothing, because the cascade is
already killing it (`run.ts:1787-1794`). An escalation is a **blocking** question, not a
fire-and-forget report, so a parent that is unreachable for a structural reason (over budget,
cancelled, permanently settled with the cascade already underway) cannot be where the question
stops — the child would sit `escalated-waiting` forever with no live wake source, which is
exactly the AGENTS.md "state with no exit" failure mode.

**Concrete change.** A new engine method, sibling to `reportSettledChildToParent`, e.g.
`deliverEscalationToParent(childId)`:

1. Resolve `unit.parentRunId` off the **current** record (same re-read discipline as `unitOf`,
   `run.ts:1450-1453`, since `unit` is written mid-turn).
2. If the parent is **live** (open session, or settled-but-resumable per the same
   `['done','failed','review'].includes(parent.status)` check at `run.ts:1820`, and **not**
   `unit.overBudget` and **not** `status === 'cancelled'`): deliver via the identical 3-route
   cascade (`deliverMessage` → `enqueueMessage` → `deferMessage`/`continueRun`), persisting
   `unit.pendingEscalation` (see P-E3) on the child and appending to
   `unit.pendingEscalationsFromChildren` (mirrors `unit.pendingReports`,
   `packages/contract/src/units.ts:114`) on the parent.
3. If the parent is **not live** (over budget, cancelled, or the store lookup fails — parent
   record missing, which cannot happen in-tree but must degrade rather than throw): **skip one
   rank** — retarget the SAME escalation at `grandparent = parent.unit?.parentRunId`, with a
   transcript note on the child explaining the skip ("escalation routed around <parent role>
   <parent id> — parked/over budget/cancelled"). Recurse the same reachability check.
4. If no reachable ancestor exists at all (walked to the mission root and it too is unreachable,
   or the child itself is the root, i.e. Caesar) — fall back to today's `CEZ:ASK` path exactly:
   `emitAskRequested` (`run.ts:173-177`) and park `waiting` with `activity: undefined` (human
   case). This is the **one and only** place the ladder is allowed to terminate at the human
   directly from a non-Caesar rank, and it must leave an explicit note naming why (unreachable
   chain), so the Guard inbox row is self-explaining rather than looking identical to a normal
   escalation.

**Default-path impact.** Only reachable when `CEZ_UNITS=1` and the run is a unit run with a
`parentRunId` — a Caesar (no parent) always falls to step 4 immediately, which is exactly
`CEZ:ASK`'s current, unchanged behaviour. No new knob.

**Transitions.** Every hop in step 3 is a **synchronous, in-process** function call inside the
same turn-end handler invocation that parsed the marker — not a scheduled retry, not a timer. "Who
fires this?" is answered the same way `spawnChildren` is answered: the engine code running at
turn-end, once, deterministically. There is no unbounded loop: the tree has a hard-coded maximum
depth of 3 (`caesar → legate → centurion`, `CHILD_ROLE` at `engine.ts:21-25`), so the walk in step
3 terminates in at most 2 hops before reaching Caesar or the human fallback.

**Tests to pin.** Escalation from a centurion whose legate is `overBudget` skips to Caesar in one
engine-test turn; escalation from a centurion whose legate is `cancelled` (mid-cascade) also
skips; escalation with **no** reachable ancestor (mission root's own escalate, or every ancestor
down) falls back to `emitAskRequested` and is annotated as such.

**Effort:** M. **Risk:** med — the "skip a dead rank" logic is new and must be proven against the
existing budget/cancel tests already listed in the spec (`.ai/specs/2026-09-08-units-hierarchy.md:153`)
so it does not regress those guarantees while extending them.

---

### P-E3 — Persist the pending escalation on the record; answers travel back through the same three routes, in reverse

**Problem.** F-E3: today's `ask.requested` is SSE-only. Any state a restart or a second cockpit
tab needs to reconstruct must be on the `RunRecord`, not only in the event log.

**Concrete change.** Extend `unitSchema` (`packages/contract/src/units.ts:101-117`) — the SAME
schema the store persists directly (`store.ts:200`, "the CONTRACT's own `unitSchema` rather than
a hand-copied twin," so no separate persistence-twin edit is needed, unlike the general
AGENTS.md warning about two construction sites):

```ts
export const unitPendingEscalationSchema = z.object({
  requestId: z.string(),
  irreversible: z.boolean(),
  financial: z.boolean(),
  questions: askQuestionSchema.array(),
  at: z.string(),               // ISO instant raised
  rounds: z.number().int().nonnegative().default(0),
  toHuman: z.boolean().default(false),  // set once P-E2 step 4 fires
});

// on unitSchema:
pendingEscalation: unitPendingEscalationSchema.optional(),               // this run's own open question
pendingEscalationsFromChildren: z.array(z.object({
  fromRunId: z.string(), requestId: z.string(), questions: askQuestionSchema.array(),
  irreversible: z.boolean(), financial: z.boolean(), at: z.string(),
})).max(MAX_PENDING_REPORTS).optional(),   // mirrors unitPendingReportSchema exactly
```

- The **child's own** `unit.pendingEscalation` is authoritative for "am I mid-escalation" —
  cleared only when an answer is delivered (or the round cap forces the human fallback, which sets
  `toHuman: true` and leaves it in place until a human answers).
- **Answer delivery, parent → child**, is the reverse of `reportSettledChildToParent`
  (`run.ts:1756-1827`): a new `deliverAnswerToChild(parentId, { requestId, childRunId, text })`
  resolves the child record, confirms `child.unit?.pendingEscalation?.requestId === requestId`
  (stale/duplicate answers are a no-op with a note, mirroring the cancelled-child short-circuit at
  `run.ts:1794`), then runs the **identical** `deliverMessage` → `enqueueMessage` cascade
  (`run.ts:1812`) targeted at the child instead of the parent, and clears
  `unit.pendingEscalation` on success.
- **Human → child** is entirely unchanged: exactly today's ask-answer path, "the resume path is
  plain `sendMessage`" (spec Q4, `.ai/specs/2026-09-08-units-hierarchy.md:27`) — no new route.

**What is persisted vs held in memory.** Persisted: `unit.pendingEscalation`,
`unit.pendingEscalationsFromChildren`, `rounds`, `toHuman` — all through the existing
`store.updateRun`/`unitSchema` machinery, so they survive a restart exactly as `unit.report` and
`unit.pendingReports` already do today. Held in memory only: the `ActiveRun.session` handle used
to attempt live delivery — never the fact that a question exists.

**Default-path impact.** New optional fields on an already-optional `unit` object; a record with
no `unit` (the overwhelming majority of runs) is untouched; `.catch(undefined)` at `store.ts:200`
already degrades a malformed `unit` to `undefined` rather than failing the whole record read, so
this is additive with no migration.

**Effort:** M. **Risk:** low — pure additive schema change plus a mechanical mirror of an
already-shipped, already-tested delivery cascade.

---

### P-E4 — Round cap, analogous to `MAX_AUTO_CONTINUES`, and restart re-arming (fixes F-E2 for asks AND escalations)

**Problem.** Nothing bounds "child escalates → parent answers → child unsatisfied, escalates
again" — the tree depth bounds the *rank* dimension (P-E2), but not the *round-trip* dimension on
a single question. Separately, F-E2 is a live correctness bug today, not just a risk for the new
feature: a restart mid-ask silently settles the run "done" and reports that upward.

**Concrete change, two parts.**

1. **Round cap.** `unit.pendingEscalation.rounds` (P-E3) increments each time the SAME
   `requestId` is re-escalated (the child re-emits `CEZ:ESCALATE` referencing a `requestId` it was
   already answered on). Cap `MAX_ESCALATION_ROUNDS = 3` (a constant beside `MAX_AUTO_CONTINUES`,
   `run.ts:313`), checked in `handleUnitMarkers` the same way `enforceUnitBudget` is checked
   (`run.ts:1566`, `run.ts:1578-1593`): on the round after the cap, the engine refuses the fresh
   `CEZ:ESCALATE` (transcript note, no state change — same refusal shape as every other unit
   marker, `unitMarkerRejection`, `run.ts:164-170`) **and** forces `toHuman: true` on the existing
   `pendingEscalation` so it surfaces to the Guard inbox on its own terms rather than bouncing
   again. This is persisted (P-E3), unlike `autoContinues`/`monitoringWakeups` today (F-E7) — a
   round cap that resets itself on every restart is not a bound at all against the ping-pong this
   proposal exists to stop.
2. **Restart re-arming.** `recover()`'s `waiting` branch (`run.ts:1328-1338`) must not blindly
   `settleSuccess` a run whose `unit.pendingEscalation` (or, by the same argument, whose
   `ask.requested`-shaped pending state) is still open. Concretely: before the existing
   `settleSuccess`/`reportSettledChildToParent` calls, check `store.getRun(run.id)?.unit
   ?.pendingEscalation`; if present, **re-park** the run exactly as it was (status `waiting`,
   `activity` unchanged) instead of settling it, and re-attempt delivery of the pending
   escalation to its parent (P-E2's routing, since the parent may itself have restarted into a
   different reachability state) rather than treating "cezar restarted" as "the question is
   answered." A plain `CEZ:ASK` with no unit involvement is unaffected — it keeps today's settle
   behaviour, which is a pre-existing, separately-scoped bug (F-E2's ask-only half is noted here
   but is **not** fixed by this proposal; fixing it would need a persisted pending-ask flag on
   `RunRecord` outside `unit`, which is out of this ladder's scope and listed in §5).

**Default-path impact.** `CEZ_UNITS` unset or run has no `unit` → `recover()`'s new check reads
`undefined` and falls straight through to today's `settleSuccess` path, unchanged. A unit run with
no pending escalation (the common case even with the feature on) also falls through unchanged.

**Transitions out of the re-armed state.** Identical to the original: answer delivered (P-E3),
round cap forces human fallback, or cancel cascade reaches it independently — no new terminal
state is introduced, recovery just stops manufacturing a false one.

**Tests to pin.** `recover-unit.test.ts` gains a sibling to its existing "reports a waiting child
settled by recovery to its parent" case (`recover-unit.test.ts:136-167`): a `waiting` unit run
**with** `unit.pendingEscalation` survives `recover()` still `waiting`, its pending escalation
intact, and is NOT reported to its parent as settled. Round-cap test: three rounds on the same
`requestId` refuses a fourth `CEZ:ESCALATE` and sets `toHuman: true`.

**Effort:** M. **Risk:** med — touches `recover()`, a path with narrow, well-pinned existing
coverage (`recover-unit.test.ts`, `recover-autonomous.test.ts` per its own docstring reference at
`recover-unit.test.ts:17`); must not regress either.

---

### P-E5 — Update `CENTURION_PROMPT` / `LEGATE_PROMPT` in the same commit; `CAESAR_PROMPT` keeps `CEZ:ASK`

**Problem.** F-E6: a marker nobody is told to emit is dead code.

**Concrete change.** Add an `ESCALATE_CONTRACT` block (parallel structure to `SPAWN_CONTRACT`/
`REPORT_CONTRACT`, `prompts.ts:44-75`) documenting `CEZ:ESCALATE`'s exact JSON shape and the
classification instruction ("declare `irreversible`/`financial` honestly — your commander decides
whether to answer you or carry it further"). Splice it into `CENTURION_PROMPT` and `LEGATE_PROMPT`
in place of their current shared `GUARD_RULE` reference to `CEZ:ASK` for the "ask your commander"
case, while **`GUARD_RULE` itself stays composed unmodified into all three** (`prompts.ts:79-84`
unchanged text) — the rule about *when* to stop is unchanged; only *who* the stop message is
addressed to changes. `CAESAR_PROMPT` gets an `ANSWER_CONTRACT` block instead (how to review and
answer a child's escalation, or itself re-raise via bare `CEZ:ASK` since it has no parent) and
keeps emitting `CEZ:ASK` for its own questions, unchanged.

**Default-path impact.** Per-repo prompt overrides (`.ai/cezar/units/<role>.md`,
`prompts.ts:181-233`) are untouched by this change — an existing override file keeps whatever it
already says (today, `CEZ:ASK`-only instructions), and `resolveUnitPrompt` still falls back to the
(now updated) shipped default only when no override exists (`prompts.ts:215-233`). This is the
one place the default-path diff is genuinely asymmetric: **the shipped default changes, an
existing repo-authored override does not**, and the engine (P-E2 step 4) must keep the bare
`CEZ:ASK` fallback working forever specifically so a stale override still functions.

**Tests to pin.** `prompts.test.ts` gains assertions that `CENTURION_PROMPT`/`LEGATE_PROMPT`
contain the new marker's contract and that `CAESAR_PROMPT` does not (it has no parent to
escalate to).

**Effort:** S. **Risk:** low, but **required** alongside P-E1 — shipping P-E1 without this in the
same commit is the textbook "replacement that ships OFF" (AGENTS.md).

---

### P-E6 — Guard inbox filter: distinguish "waiting on a live ancestor" from "waiting on a human" (fixes F-E5)

**Problem.** F-E5: `needsGuard: run.status === 'waiting'` (`missions.ts:106`) cannot tell the two
apart once a child can also be `waiting` mid-ladder (P-E1/P-E2). Shipped unchanged, the Guard
inbox becomes noisier than today, not quieter — the opposite of this whole document's goal.

**Concrete change (cockpit-only, `packages/web/src/lib/missions.ts`, pure function, no engine
change needed).**

```ts
needsGuard: run.status === 'waiting'
  && !(run.unit?.pendingEscalation && run.unit.pendingEscalation.toHuman !== true),
```

i.e. a unit run parked `waiting` with an **unresolved, not-yet-human-routed** escalation
(`pendingEscalation` present, `toHuman` false) is filtered OUT of the Guard queue — it is someone
else's turn to look at it, and that "someone" is visible via the existing parent breadcrumb link
already shipped in the task thread header (spec §Cockpit, `.ai/specs/2026-09-08-units-hierarchy.md:145`).
A plain `CEZ:ASK` (`run.unit` absent, or `unit.pendingEscalation` absent) is unaffected — today's
Guard-inbox behaviour for a genuine human-facing ask is unchanged.

**Default-path impact.** `capabilities.units` off → `GuardRoute` never renders past
`UnitsOffState` (`guard.tsx:37`), unchanged. `unit.pendingEscalation` absent (every run today,
and every unit run before P-E1 ships) → the added clause is `!(undefined && ...)` = `true`,
identical to today's bare `run.status === 'waiting'`. No behaviour change until P-E1-P-E3 land.

**Tests to pin.** `missions.test.ts` gains a case: a centurion `waiting` with
`pendingEscalation.toHuman: false` is excluded from `guardQueue`; the same node with
`toHuman: true` (round-cap fallback, or an unreachable-ancestor fallback from P-E2 step 4) is
included, annotated distinctly if the row rendering is also extended (out of scope here — cockpit
row copy is implementation, not this analysis).

**Effort:** S. **Risk:** low — additive filter clause, pure function, already-tested module
(`missions.test.ts` exists per the file listing).

---

## 4. State-machine table

### 4.1 The asking child

| state | entered by | exits to | who fires the exit |
|---|---|---|---|
| `running` | normal turn start | `escalated-waiting` (on `CEZ:ESCALATE`), `waiting`/human (on `CEZ:ASK`, or P-E2 step 4 fallback), `running`/monitoring (on `CEZ:MONITORING` or a `CEZ:SPAWN`), settled (`CEZ:DONE`, error, cancel) | the run's own turn-end handler, one of the two sites (`run.ts:2949` / `run.ts:3676`) |
| `escalated-waiting` (`status: 'waiting'`, `unit.pendingEscalation` set) | `handleUnitMarkers` parsing a valid `CEZ:ESCALATE` at turn end | `running` (answer delivered), `escalated-waiting` again with `rounds+1` (re-escalated, still under cap), `waiting`/human (`toHuman` set by round cap, P-E4, or by P-E2 step 4's unreachable-ancestor fallback), `cancelled` (cascade) | **answer delivered**: `deliverAnswerToChild` (P-E3) calling `deliverMessage`/`enqueueMessage`, itself fired synchronously inside the PARENT's turn-end handler when it emits `CEZ:ANSWER`. **human answers directly**: existing plain `sendMessage` route, fired by the human, unchanged (spec Q4). **cancel**: `cancelDescendants` (`run.ts:1837-1845`), fired by a human cancelling any ancestor, or by the user cancelling this run directly. **restart**: `recover()`'s re-park check (P-E4) — fired by the process boot sequence, re-attempts delivery rather than settling. |
| `waiting`/human (`unit.pendingEscalation.toHuman: true`, or a bare `CEZ:ASK`) | round cap (P-E4), unreachable-ancestor fallback (P-E2 step 4), or Caesar's own `CEZ:ASK` | `running` | a human sending a message into this run's own thread (existing route, unchanged) — the ONE state whose only on-by-default exit is a human, which AGENTS.md flags as a dead end **unless it is the deliberate, narrowed terminus of the ladder** — here it is, by design, and only reached via the three routes above, never as the default for every escalation. |

### 4.2 The answering parent

| state | entered by | exits to | who fires the exit |
|---|---|---|---|
| `running` / `monitoring` (unchanged states) | normal turn end, or a prior `CEZ:SPAWN`/`CEZ:MONITORING` (`run.ts:2972-2980`) | delivery of a child's `CEZ:ESCALATE` lands as a message in this run's session or queue (P-E2) — this is NOT a new state, it is the existing `reportSettledChildToParent`-style delivery reusing the SAME three routes (`deliverMessage`/`enqueueMessage`/`continueRun`) | the CHILD's turn-end handler, synchronously, exactly the way `reportSettledChildToParent` is called synchronously from settle/turn-end sites today (`run.ts:1264`, `run.ts:1343`, `run.ts:1423`, `run.ts:2264`) |
| `running` (with a delivered escalation in its prompt/session) | delivery above | `running`/monitoring again (on `CEZ:ANSWER`, auto-parked like `CEZ:SPAWN`), `escalated-waiting` (parent itself escalates further via its own `CEZ:ESCALATE`), `waiting`/human (parent is Caesar and emits bare `CEZ:ASK`) | the parent's own turn-end handler, one of the two sites — same mechanism as §4.1's `running` row, because a parent reviewing an escalation is running an ordinary turn |
| over budget / cancelled / settled | pre-existing states, unchanged (`enforceUnitBudget`, `run.ts:1578-1593`; cancel cascade, `run.ts:1837-1845`) | N/A for THIS parent — P-E2 step 3 routes the child's escalation to the grandparent instead | the CHILD's `deliverEscalationToParent`, detecting non-liveness and re-targeting, fired synchronously in the same call that would otherwise have delivered to this parent |

### 4.3 Every wake source, "who fires this?"

| # | wake source | pre-existing? | who fires it |
|---|---|---|---|
| 1 | a human sends a message into a run's own thread | yes (`deliverMessage`, AGENTS.md's own list) | the human, via the existing message route |
| 2 | the autonomous nudge | yes, turn-end only | the run's own turn-end handler, immediately after its own turn — never an external wake |
| 3 | the monitoring wake timer | yes (`armMonitoringWakeTimer`, `run.ts:4284-4328`) | a `setTimeout` armed by the engine when a run parks as monitoring, capped by `MAX_AUTO_CONTINUES` (`run.ts:4290`, `run.ts:4312`) |
| 4 | a settled child's report delivered to its parent | yes (`reportSettledChildToParent`, `run.ts:1756-1827`) | the CHILD's own settle/turn-end code path, synchronously |
| 5 | an escalation delivered to a parent | **new (P-E1/P-E2)** | the CHILD's own turn-end handler, synchronously — same three routes as #4, no new primitive |
| 6 | an answer delivered to a child | **new (P-E3)** | the PARENT's own turn-end handler, synchronously, on a valid `CEZ:ANSWER` — same three routes as #4/#5, reversed direction |
| 7 | restart recovery | yes (`recover()`, `run.ts:1314-1370`) | the process boot sequence, once, before the server accepts requests — **must be extended (P-E4)** to re-arm rather than settle a run with an open `pendingEscalation` |
| 8 | Guard-inbox visibility (NOT a wake — a rendering filter) | yes (`needsGuard`, `missions.ts:106`), **narrowed by P-E6** | no engine timer; a pure derived computation over `useRuns()`, re-evaluated on every SSE run update the cockpit already streams |

No new timer, webhook, or process-exit callback is introduced anywhere in this design — every new
edge in §4.1-4.3 is one of the eight rows above, all of which already exist as primitives in this
engine. This is the deliberate answer to "cezar has no process-exit callback, no CI webhook, no
sub-agent-completion event" (AGENTS.md): the ladder is built entirely out of the same
turn-end-synchronous delivery cascade the report path already proved out, never a new asynchronous
wake mechanism.

---

## 5. Open questions for the user

1. **Should `CEZ:ASK` ever be reachable directly by a centurion/legate**, e.g. as an explicit
   "skip the ladder, this is for the human only" override (a fourth boolean on
   `unitEscalateSchema`, or simply: bare `CEZ:ASK` still works for a non-Caesar rank and always
   goes straight to human, same as today)? P-E1/P-E2 as designed make `CEZ:ASK` Caesar-only by
   *convention* (the prompt), not by *engine enforcement* — a centurion whose prompt was never
   updated, or a hand-edited override, can still emit it and it will still reach the human exactly
   as today. Is that fallback-forever behaviour acceptable, or should the engine actively refuse a
   non-Caesar `CEZ:ASK` (transcript note, same shape as a centurion's refused `CEZ:SPAWN`,
   `run.ts:1614-1621`) once the ladder ships, forcing every non-Caesar rank onto `CEZ:ESCALATE`?
2. **`MAX_ESCALATION_ROUNDS = 3`** (P-E4) is a placeholder matching this codebase's taste for small
   integer bounds (`MAX_CHILDREN_IN_FLIGHT = 4`, `engine.ts:29`); is 3 round-trips per question the
   right number, or should it scale with rank distance (a centurion↔legate exchange is cheaper
   than a legate↔Caesar one, since a legate's own turn also burns budget deciding whether to pass
   the question on)?
3. **F-E2's non-unit half is out of scope for this ladder** (P-E4 only fixes it for
   escalation-bearing runs, since that is the field being added): should a follow-up separately
   persist a pending-ask flag for a PLAIN `CEZ:ASK` too, so a restart mid-question never settles
   *any* run as falsely "done," unit or not? That is a `RunRecord`-level change outside `unit` and
   was flagged, not designed, here.
4. **Should `unit.pendingEscalationsFromChildren` cap at `MAX_PENDING_REPORTS` (20,
   `engine.ts:34`)**, sharing the constant with reports, or does an army-sized mission (`legate`
   fan-out of up to 4 centurions each escalating) need its own, smaller bound given escalations are
   meant to be rarer and more urgent than routine reports?
5. **Cockpit row copy for the two `waiting` sub-kinds** (P-E6 only specifies the filter, not the
   UI): should the Missions tree show a *different* visual state for "escalated to parent" versus
   "waiting for you," beyond simply excluding the former from `/guard`? This document deliberately
   stops at the filter boundary — the row-rendering decision belongs to a cockpit-focused pass,
   not this engine/schema-focused one.
