# AskUser — structured questions across claude, codex & opencode

## TLDR

When an agent needs the user to choose between options it currently falls back
to prose ("`AskUserQuestion` isn't available in this session, so I'll ask
directly…") — easy to miss, impossible to render as clickable choices. This spec
adds a **backend-agnostic AskUser capability**: the agent emits a `CEZ:ASK`
control marker (mirroring the existing `CEZ:DONE` / `CEZ:MONITORING` markers),
cezar parks the run as `waiting`, the cockpit renders the question as clickable
option chips, and the user's pick (or a free-form reply) is delivered straight
back to the live session through the reply seam that already exists. One
mechanism, identical behavior on claude, codex and opencode.

## Open Questions (resolved by pre-authorized defaults)

> The user instructed: *"use recommended defaults if spec writing requires some
> input."* The gate decisions are recorded here with their default resolution so
> they stay visible on the PR and remain overridable before implementation lands.

- **Q1 — Uniform marker vs native tools.** Research (below) shows only claude has
  a native structured ask (`AskUserQuestion`), and even that is **suppressed in
  headless `stream-json`** unless a `--permission-prompt-tool` / `canUseTool`
  handler is wired and answered over the `control_request can_use_tool` protocol
  (verified against Claude Code v2.1.211 — this is the exact cause of the issue's
  screenshot). codex & opencode have only approve/deny gates (opencode's even
  renamed across versions), and MCP `elicitation` is disabled/unconfirmed in
  both. → **DEFAULT: a cezar-owned `CEZ:ASK` marker as the single mechanism
  across all three backends.** Uniform by construction (parsed post-mapper on
  assembled turn text, exactly like `CEZ:DONE`), reliable, low blast radius.
  A native `AskUserQuestion` control-protocol bridge for claude is documented as
  a **future enhancement**, not this spec.
- **Q2 — Answer channel & free-text.** → **DEFAULT: clickable option chips AND
  the normal composer stays enabled.** The user clicks an option or types a
  free-form reply. A chip answer rides `POST /api/runs/:id/messages` while the
  session is live, or the existing `POST /api/runs/:id/continue` seam once the
  session has closed; both append the answer as a normal user message (no
  `tool_result` / endpoint changes). `multiSelect` questions collect several
  picks confirmed with Send; an implicit free-text "Other" is always available
  via the composer (matching `AskUserQuestion` semantics).
- **Q3 — Event model.** → **DEFAULT: one additive `ask.requested` `UiEvent`.**
  The ask card resolves client-side when the next user message for the run posts
  (or the run leaves `waiting`); no `permission.*` overloading (that reserved
  pair stays for the separate future approval-gate feature). A dedicated
  `ask.resolved` event + a `messages`-endpoint extension was considered and
  rejected as unnecessary surface for a risk-high change.
- **Q4 — Scope / phasing (split check).** → **DEFAULT: one spec, phased.** The
  three backends share one marker + one parser + one UI and are uniform by
  construction, so this is a single independently-deployable capability:
  Phase 1 (protocol + parser + UI + system prompt), Phase 2 (end-to-end
  cross-backend proof + graceful degradation), Phase 3 (docs). Not three specs.

## Problem Statement

Agents routinely hit a fork where a short human decision unblocks the best path
(which of two designs, which file to touch, confirm a destructive step). Cezar
drives three backends and none gives a portable, renderable structured-question
primitive:

- **claude** — has the built-in `AskUserQuestion` tool (input
  `{questions:[{header,question,multiSelect,options:[{label,description}]}]}`,
  1–4 questions, 2–4 options each, header ≤12 chars). But cezar runs claude
  headless over `stream-json` with `--permission-mode dontAsk` and **no**
  permission-prompt tool. Per the shipped CLI (`isEnabled()` guards, v2.1.211),
  that combination means the tool is *not even offered to the model* → it reports
  "isn't available" and answers in prose (the issue screenshot). Enabling it
  natively would require cezar to speak the `control_request`/`control_response`
  `can_use_tool` protocol and inject the answer via `updatedInput.answers` — a
  claude-only, non-trivial addition.
- **codex** (`codex app-server`) — *does* have a native ask, but it is the
  **EXPERIMENTAL** `item/tool/requestUserInput` JSON-RPC request (gated behind the
  `experimentalApi` capability), plus MCP elicitation (`mcpServer/elicitation/
  request`) — a wholly different transport (server→client JSON-RPC requests over
  stdio, answered with typed responses).
- **opencode** (`opencode serve`) — *does* have a native `question` tool and a
  permission approve/deny flow, but over HTTP+SSE, and the API was renamed across
  majors (`permission.updated` ≤v0.9 → `permission.asked` v1.18); MCP
  `elicitation` is explicitly commented out in its client capabilities.

So every backend has *some* native ask, but they are three **divergent,
experimental, version-fragile** protocols (claude's `control_request` framing,
codex's `experimentalApi` JSON-RPC, opencode's HTTP/SSE) — each a separate,
heavy, moving integration. A native-tool strategy means building and maintaining
three of them; it is not the clean "works for codex, opencode, and claude" the
issue asks for. What all three DO share, and cezar already relies on, is: (1) a
**system-prompt channel** (`prependSystemPrompt` for codex/opencode; the system
prompt for claude), (2) plain assistant **text output** scanned for cezar control
markers on the assembled turn text, and (3) a uniform **reply seam**
(`sendMessage`) that resumes a `waiting` run. AskUser rides those three — exactly
like `CEZ:DONE` / `CEZ:MONITORING` already do (`src/workflows/run.ts:43-64`,
`src/handoff.ts:146-148`).

## Proposed Solution

A cezar-owned marker protocol, uniform across backends:

1. **Instruct** — the run system prompt gains an AskUser block (in `src/handoff.ts`
   next to the `CEZ:DONE` / `CEZ:MONITORING` instructions): *when you need the
   user to choose between concrete options, emit a single trailing line*
   `CEZ:ASK <json>` *with this schema instead of asking in prose, then end your
   turn.*
2. **Detect** — the RunManager turn-end handler (`src/workflows/run.ts`, where
   `DONE_MARKER_RE` / `MONITORING_MARKER_RE` are already matched on accumulated
   turn text) recognizes a trailing `CEZ:ASK <json>` marker, validates the
   payload with a zod schema, strips the marker line from the displayed
   transcript (like the existing markers), emits an `ask.requested` UiEvent into
   the sink, and parks the run `waiting` (the existing attention path).
3. **Render** — the cockpit thread renders an **ask card**: the question
   header chip + text, each option a clickable chip carrying its description;
   `multiSelect` shows checkboxes + a Send button. The composer stays enabled
   below for a free-form reply.
4. **Answer** — clicking a chip posts the human-readable answer
   (`<header>: <label>`, comma-joined for multi-select) to the existing
   `POST /api/runs/:id/messages`; `sendMessage` persists the user-message event,
   flips `waiting`→`running`, and resumes the session. The ask card resolves the
   moment that user message lands. Once the session has CLOSED with the question
   still unanswered, the same answer travels the second half of that seam instead
   — `POST /api/runs/:id/continue`, which reopens the last recorded session on the
   run's own engine and appends the answer as its opening `user-message`. Same
   answer text, same resolution rule, one routing decision in `useAskAnswer`
   (see the session-ends edge case below).

Precedence on one turn: `CEZ:DONE` wins (goal done); else a valid `CEZ:ASK`
(attention — the user is genuinely blocked); else `CEZ:MONITORING`
(non-attention); else plain text → the existing `waiting`.

Alternatives considered: (a) **native per-backend tools** — rejected: no
codex/opencode parity, claude path heavy + suppressed by default; (b)
**overloading the reserved `permission.*` events** — rejected: an N-option
question with descriptions is semantically distinct from allow/deny; (c) **a new
answer endpoint / `ask.resolved` event** — rejected: the reply seam already flips
`waiting`→`running` and the card resolves client-side on the next user message.

## Architecture

Backend-agnostic by construction — everything hangs off assembled turn text and
the existing sink, so no per-backend mapper work is required.

- **Payload + validator** — `src/core/ask.ts` (new): the `AskRequest` /
  `AskQuestion` / `AskOption` types + a zod schema, modeled 1:1 on
  `AskUserQuestion` (1–4 questions; each `{header (≤12 chars), question,
  options[2..4] of {label, description?}, multiSelect?}`; unique question texts,
  unique option labels per question). Shared by the server parser and the web.
- **Marker + parser** — `src/workflows/run.ts`: add `ASK_MARKER_RE`
  (`/CEZ:ASK[ \t]+(\{[\s\S]*\})\s*$/`) and a `parseAskMarker(text)` that returns
  `{ request, cleanedText }` or `null` (invalid JSON / schema → `null`, text left
  intact). Hooked into both turn-end sites (`~:789-836`, `~:1232-1277`) with the
  precedence above; on a valid ask it mints a `requestId`, calls
  `sink.handle({type:'ask.requested', requestId, questions})`, records the id on
  the in-memory run state, and parks `waiting`.
- **Event type** — `src/core/ui-events.ts`: add `UiAskRequestedEvent`
  (`{type:'ask.requested', requestId, questions}`) to the `UiEvent` union +
  `UiEventType`; mirror in `web/app/src/protocol/ui-events.ts`; held type-exact
  by `src/server/api-types.test.ts`. `UiEventSink` persists it via its existing
  pass-through `default` branch (no sink change beyond the union).
- **Answer path** — unchanged server routes. `packages/web/src/routes/task-thread`:
  the ask card's chip click uses `useAskAnswer(run)`, which sends the formatted
  answer through `useSendMessage(run.id)` while the session is live or through
  an override-free `useContinueRun(run.id)` after it closes. The latter stays
  gated on the run's recorded provider and never silently switches engines;
  free-text uses the normal composer.
- **UI** — `thread-state.ts` gains an `ask.requested` case producing an ask row;
  a new `AskCard` component renders it; the row is marked resolved when a later
  user-message row for the run appears (client-side lifecycle). No attention
  change — `waiting` already derives "needs you" (`web/app/src/lib/attention.ts`).
- **System prompt** — `src/handoff.ts`: the AskUser instruction block + schema
  summary, appended to the run system prompt delivered to all three backends.

## Data Model

No persisted schema change. `RunRecord` is untouched (the pending ask lives only
as the last unresolved `ask.requested` in the persisted event log + an in-memory
`pendingAskId` on the live run state). The wire/payload types:

```ts
interface AskOption { label: string; description?: string }
interface AskQuestion {
  id?: string;            // stable key; defaults to the array index
  header: string;         // ≤12-char chip label
  question: string;       // ends with '?'
  options: AskOption[];   // 2..4
  multiSelect?: boolean;  // default false
}
interface AskRequest { questions: AskQuestion[] }   // 1..4
```

## API Contracts

- **No new endpoints.** Chip answers reuse `POST /api/runs/:id/messages`
  (`{ text, images? }`) while live and `POST /api/runs/:id/continue` (`{ text }`)
  after closure; free-text continues through the normal composer.
- **New UiEvent** (additive, SSE `ui-event` transport unchanged):
  `{ type: 'ask.requested', requestId: string, questions: AskQuestion[] }`.
- **New system-prompt marker** (agent → cezar): a trailing line
  `CEZ:ASK <compact-json AskRequest>`.

## UI/UX

Rendered from the real cockpit design tokens (dark `#0d0d0d` / card `#171717` /
border `#262626` / lime `#a8f372` / amber-pending `#fbbf24`, Inter + JetBrains
Mono, radii 8/10/12px). Mockups embedded here:

**Ask card in the thread (single-select):**

![AskUser card — single select](assets/askuser/askuser-card-single.png)

**Multi-select variant + sidebar "needs you" attention:**

![AskUser card — multi-select and attention](assets/askuser/askuser-card-multi.png)

Behavior: the header renders as a chip; each option is a full-width clickable
chip showing `label` (bold) + `description` (muted). Single-select resolves on
click; multi-select toggles checkboxes and resolves on **Send**. The composer
below stays enabled ("Reply — / for skills, @ for files…") so the user can
answer free-form (an implicit "Other"). Once answered, the card collapses to a
compact "You chose: …" line and the run flips to `running`. Accessibility: chips
are real buttons (keyboard/enter, focus ring `--ring`), the card has
`role="group"` labelled by the question, `aria-pressed` on multi-select toggles.

## Edge Cases & Failure Scenarios

- **Malformed `CEZ:ASK` JSON / schema violation** (bad counts, non-unique labels)
  → parser returns `null`, the marker text is shown verbatim, run parks `waiting`
  as today (prose fallback intact), a non-fatal `session.error` note is emitted.
  The feature never makes the current behavior worse.
- **Multiple `CEZ:ASK` markers in one turn** → the first valid one wins; extras
  are ignored (documented; agents are instructed to ask once).
- **Agent ignores the marker and asks in prose** → unchanged: `waiting`, no card,
  composer works.
- **User types instead of clicking** → normal message; card resolves.
- **`CEZ:DONE` and `CEZ:ASK` both present** → `DONE` wins (no dangling card).
- **Session ends while the ask is still unanswered** (idle timeout, a cezar restart,
  Finish, or a cancel) → the question outlives its session, so the card stays
  answerable: `useAskAnswer` (`ask-answer.ts`) routes the answer by run state —
  `POST /messages` while the engine still owns a session, `POST /continue` once it
  has closed, with the answer as the reopened session's opening prompt. The
  continuation appends it as a `user-message`, which is what resolves the card, so
  the resumed and live paths agree. A closed run that never recorded a session has
  nothing to reopen and says so; a `409` from the live path (a cockpit whose record
  is stale) is retried as a resume rather than dropped. Idle shutdown has a brief
  teardown interval where `/messages` already reports `session closed` but the old
  run still occupies the RunManager's active map; during that interval the ask card
  keeps the answer single-flight and retries only the exact transient
  `409 run is still active` continuation refusal with bounded, capped exponential
  backoff for roughly five seconds. Other
  continuation failures surface immediately on the card. The original design
  ("the card renders resolved/closed") left a card whose chips silently failed —
  every tap posted to `POST /messages` and died on its `409 session closed`.
- **Reload / resume of a run parked on an ask** → the card is reconstructed from
  the persisted `ask.requested` (last one with no following user message);
  answering resolves it. Recovery re-opens the session (existing behavior).
- **Marker collision with legitimate text** → same risk profile as `CEZ:DONE`:
  requires a trailing line + valid JSON payload; low likelihood.

## Risks & Impact Review

- **Blast radius: small & additive.** One new UiEvent type, one system-prompt
  block, one parser branch, one component. No RunRecord/schema migration, no
  endpoint change, no per-backend mapper change.
- **BACKWARD_COMPATIBILITY §7** — adding a UiEvent type is explicitly additive/
  allowed; `ask.requested` is added to the enumerated v2 discriminators and to
  `AGENT_PROTOCOL.md`. Frozen v1 `AgentEvent` strings and the golden-fixture
  parity contract are untouched (ask detection is post-mapper, uniform).
- **System-prompt growth** — a short block; negligible token cost, consistent
  with the existing marker instructions.
- **Rollback** — remove the marker instruction + event handling; agents revert to
  the prose fallback with zero data-format debt (no persisted schema change).

## Phasing

- **Phase 1** — protocol (`ask.ts` + `ask.requested` event + web mirror +
  `api-types` exactness), marker parser + emission + `waiting`-park in `run.ts`,
  system-prompt block in `handoff.ts`, thread reducer case + `AskCard` component,
  chip-click answer formatting. Ships working on all three backends via the
  marker.
- **Phase 2** — end-to-end cross-backend proof (drive each of the 3 mock runners
  through a `CEZ:ASK` turn → assert `ask.requested` + `waiting`), graceful-
  degradation tests (malformed marker → plain text), a11y/interaction tests.
- **Phase 3** — docs: `AGENT_PROTOCOL.md` (new event + marker + the future
  native-`AskUserQuestion` bridge note), `BACKWARD_COMPATIBILITY.md §7`,
  README/handoff mention.

## Implementation Plan

### Phase 1 — Protocol, parser & cockpit UI

1. **Payload module + validator.** Add `src/core/ask.ts` with the `AskRequest` /
   `AskQuestion` / `AskOption` types and a zod schema (counts, header length,
   uniqueness). Unit test: valid payload parses; each violation rejects.
2. **`ask.requested` UiEvent.** Add `UiAskRequestedEvent` to
   `src/core/ui-events.ts` (union + `UiEventType`); mirror in
   `web/app/src/protocol/ui-events.ts`. Update `src/server/api-types.test.ts` to
   keep the mirror exact. Unit test: event shape + discriminator.
3. **Marker parser.** Add `ASK_MARKER_RE` + `parseAskMarker()` +
   `stripAskMarker()` in `src/workflows/run.ts`. Unit test: extraction, invalid
   → `null`, marker stripped from display text.
4. **Turn-end wiring + park.** Hook `parseAskMarker` into both turn-end sites with
   the `DONE > ASK > MONITORING > plain` precedence; on a valid ask, emit
   `ask.requested`, record `pendingAskId` on run state, park `waiting`; clear it
   in the cancel/finish/sendMessage paths. Unit test (RunManager): a `CEZ:ASK`
   turn → `ask.requested` emitted + status `waiting`; `CEZ:DONE`+`CEZ:ASK` → done.
5. **System-prompt instruction.** Add the AskUser block + schema summary in
   `src/handoff.ts`. Test: the assembled system prompt contains the instruction.
6. **Thread reducer + AskCard.** Add the `ask.requested` case in
   `thread-state.ts` and the `AskCard` component (single + multi-select), wired to
   `useSendMessage`. Client-side resolution on the next user message. Component
   tests: renders options, single-click sends `header: label` + resolves,
   multi-select sends comma-joined + resolves, composer stays enabled.

### Phase 2 — Cross-backend proof & degradation

7. **End-to-end per backend.** Using the mock claude/codex/opencode runners, drive
   a turn whose text ends with `CEZ:ASK <json>` and assert `ask.requested` +
   `waiting` for each — proving uniform behavior across all three.
8. **Graceful degradation.** Tests: malformed marker → plain text + `waiting`, no
   card, non-fatal note; multiple markers → first wins.

### Phase 3 — Documentation

9. **Docs.** `AGENT_PROTOCOL.md` (event + marker + future native bridge),
   `BACKWARD_COMPATIBILITY.md §7` (enumerate `ask.requested`), README/handoff
   note. No code; the configured lint/check still runs.

## Research appendix (market leaders)

- **Claude Code `AskUserQuestion`** (v2.1.211, verified against the shipped
  binary): 1–4 questions, each `{header ≤12 chars, question, options[2..4] of
  {label, description, preview?}, multiSelect}`; auto "Other" free-text; answered
  via the `control_request can_use_tool` → `updatedInput.answers` path;
  **suppressed in headless stream-json without a permission-prompt tool.** Cezar's
  `CEZ:ASK` schema is modeled on this so a native bridge can map 1:1 later.
- **Codex app-server**: native EXPERIMENTAL `item/tool/requestUserInput`
  (`{questions:[{id,header,question,isOther,isSecret,options?}]}`, answered
  `{answers:{qid:{answers:[...]}}}`) gated behind the `experimentalApi`
  capability, plus command/patch approvals and MCP `mcpServer/elicitation/request`
  (form/url modes). All server→client JSON-RPC over stdio.
- **opencode**: native `question` tool + permission approve/deny
  (`permission.updated` → `permission.asked` across versions, route + enum
  renamed) over HTTP+SSE; MCP `elicitation` client capability commented out.
- **MCP `elicitation`** (2025-06-18): `elicitation/create` + `requestedSchema` →
  `{action, content}` — codex supports it as an MCP host; opencode does not
  advertise it. Divergent and version-fragile across the three. The `CEZ:ASK`
  marker sidesteps all of it with one uniform, transport-independent path.
