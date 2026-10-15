# Persist the v2 tool items only, not their v1 tool twins

> Slug: `persist-v2-only` · Status: **implemented** · Source: perf audit
> `.ai/analysis/perf-audit-2026-09-30` Tier 2 #10, report C findings 3 and 4.

## TLDR

Every backend frame is mapped twice — the v1 `AgentEvent` (`handleClaudeMessage` / per-backend
dispatch) and the v2 `UiEvent` (`emitUi`) — and both are appended to the run's NDJSON. In a real
transcript 32 % of the bytes are the v1 tool twins the renderer already discards
(`canonicalSessionItems`). The v2 tool item lifecycle carries the same calls, so those twins are
redundant on disk. This change stops writing v1 `tool-call` and `tool-result` to disk, keeps them
on the live in-process bus, and adds a read-side `deriveV1Events` helper that rebuilds them from
the v2 tool items for any consumer that still wants the v1 view. Assistant `text` stays on disk
(Q1). The runner double-mapping itself (finding 4) is untouched and named as a follow-up.

## Resolved assumptions

| # | Question | Applied answer | Why | Confirm? |
|---|---|---|---|---|
| Q1 | Which v1 events lose their disk line? | **`tool-call` and `tool-result` only.** Assistant `text` keeps its line. | The tool twins are the per-tool-call hot path the audit measured (26.3 KiB of 81 KiB in the sample transcript). `text` was in scope at first. The per-backend parity test (Q10) then showed it is not always redundant: a message item that never reaches `item.completed` (opencode `session-error`: the session dies mid-message) has its text only in live deltas, which never persist, so v1 `text` is the only on-disk copy. Keeping it costs little and removes that whole class of risk: never-completed messages, delta-coalescing boundaries, and text dedup across mixed files. | decided |
| Q2 | What about the other v1 events that also have a v2 twin (`session`, `token-usage`, `cost`, `turn-end`, `done`, `error`)? | **Keep them on disk for now.** | They are O(1) per session/turn/step, not O(tool-call). Dropping them saves almost no bytes and needs per-type fidelity work in run-manager lifecycle reading. Follow-up. | reversible |
| Q3 | How does the live bus stay unchanged? | The two tool twins ride `store.emitEphemeral` instead of `store.appendEvent`, with the same `seq`/`ts`/redaction fan-out and no disk write. One seam, `RunManager.emitRunnerEvent`, serves both `onEvent` construction sites. | The change is in what gets WRITTEN, not what gets emitted: SSE consumers, cost accounting and turn-end handlers read the in-process stream. | reversible |
| Q4 | Where does the v1 view come from on read? | **A new pure `deriveV1Events`** (`runs/derive-v1.ts`). It dedups per **session window** (step id + session ordinal; a new window opens at a `session.started` once the current one has items), never per file. A window that already carries v1 tool lines keeps them and gets nothing derived. A v2-only window gets its calls rebuilt. A tool declined before it ran gets no line. A failed tool's result is its `error`, else its `output`. Assistant text is never derived. | Old files come back byte-for-byte. Item ids repeat across sessions (`item_1` again after a continuation or a restart recovery), so a step-wide key would swallow a later session's calls. | reversible |
| Q5 | Does the read path change? | **No.** `store.readEvents` stays the raw persisted lines (`ui-event-sink.test.ts` pins that). No in-repo reader needs the derived view for a new run: `/history`, the cockpit thread and uncursored SSE replay render v2. `/history-context`'s TodoWrite `tool-call` branch matches legacy files only, and new runs get the same plan from the `plan.updated` the mapper emits for that frame. The continuation context reads `text` and v2 messages, both still on disk. Provider-auth reads only `error`/`session.error`/`provider-auth-required`. Auto-name, handoff and the dispatch report read the live bus. The helper is the reference implementation of the v1 view for scripts that read `.ndjson` (`BACKWARD_COMPATIBILITY.md` §3); the package exposes no library subpath for it. | Derived events reuse their source `seq`, so they must never enter a seq-keyed replay. Wiring the helper into a reader that does not need it adds CPU and no behaviour. | reversible |
| Q6 | Are the derived values byte-identical to what the runner used to write? | **Where the runner's v1 line was already normalized (claude, pi, and the plain codex/opencode/cursor cases), yes. Otherwise no.** Codex, cursor and opencode put raw wire JSON in some v1 lines (the whole codex item as `input`/`result`, cursor's `{"success":…}` envelope, opencode's errored-tool state). The derived line carries the v2 item's normalized `name`/`input`/`output`/`error` instead. | Only v2 reaches disk now. No in-repo reader parsed those raw payloads, and the cockpit has rendered the v2 values all along. | reversible |
| Q7 | Remove the runner double-mapping (audit finding 4)? | **No — follow-up.** | Explicitly out of scope; the double mapping is CPU on the live path, unrelated to disk bytes. | follow-up |
| Q8 | Does the seq counter rewind across a restart? | **No: `rehydrateSeq` resumes `SEQ_RESTART_HEADROOM` (10 000) above the file's highest `seq`.** A file with no events still starts at 1. | `emitEphemeral` stamps seqs that never reach disk, and it now does so twice per tool call, on top of the delta flushes. Resuming at file max + 1 would hand a live client a seq it already saw, and its `seq > maxSeq` dedup would drop the resumed events. Gaps are harmless: dedup compares with `>`, and history cursors address byte offsets. #1187 (open) touches the same resume path; whichever lands second keeps the headroom. | reversible |
| Q9 | What does the PR-URL / issue janitor lose? | **The v1 `tool-result.result` no longer reaches `appendEvent`'s haystacks.** | `appendEvent` scans only persisted events. The v2 tool item still feeds its title, input and output to the referenced-URL haystack. What goes away is the v1 `result` in `eventAgentTextFragments`, which let command output promote `issueNumber`, something #538 says must never happen. A failed tool's `item.error` is not scanned either, so a URL printed only on a failing command's stderr no longer feeds the referenced tier. Assistant text is unaffected (Q1). | reversible |
| Q10 | Is "every v1 tool twin has a v2 equivalent" proven? | **Per backend, against the golden fixtures.** `core/v1-derive-parity.test.ts` drives each real runner (claude, codex, opencode, cursor, pi) over each fixture through a stub binary, folds the v2 stream through the real `UiEventSink`, and compares `deriveV1Events(persisted)` with the runner's own live v1 tool events. Of the 28 fixtures, 15 match on `{id, tool, input}` / `{toolCallId, result, isError}`. 4 match on identity only: the runner's v1 line is raw JSON (Q6). 9 disagree on which calls exist. Those are listed with a reason and run as `it.fails`, so a mapper change that closes a gap turns red. | Checking five mappers by eye misses content drift. The fixtures already exist. | reversible |

## Default-path diff

With every knob at its shipped default (no `CEZ_*` flag is added or changed):

| Scenario | Before | After |
|---|---|---|
| Disk: a dry-run turn with 2 tool calls + 2 assistant texts | 2× `tool-call` + 2× `tool-result` + 2× `text` + the v2 `item.*` twins (+ lifecycle) | 2× `text` + the v2 `item.*` twins (+ lifecycle); no v1 tool twins |
| Live SSE while the run executes | v1 `run-event` frames + v2 `ui-event` frames | unchanged |
| Cockpit thread render | `canonicalSessionItems` suppresses the v1 twins and renders v2 | unchanged (same items) |
| `store.readEvents` on a new run | v1 + v2 lines | no v1 `tool-call`/`tool-result` lines |
| `store.readEvents` on a legacy run | v1 + v2 lines | unchanged (byte-for-byte) |
| `deriveV1Events(...)` on a new run | n/a | rebuilds the v1 `tool-call`/`tool-result` lines from the v2 tool items (normalized values, Q6) |
| Same on a legacy run continued after the upgrade | n/a | old sessions as stored, new sessions derived, no duplicates |
| SSE replay of a new run for an external `run-event` consumer | replay carried v1 `tool-call`/`tool-result` | replay carries the v2 tool items only; live frames unchanged |
| Server restart mid-run, then new events | seq resumes at file max + 1 (could repeat a seq a live client saw on an ephemeral event) | seq resumes at file max + 10 000 |
| Janitor on a tool call | v1 `tool-result.result` in the agent haystack (could promote `issueNumber`) | tool output reaches the referenced-URL haystack only, via v2 `item.output` |
| In-process cost / turn-end handlers | read v1 events off the bus | unchanged |

## What stays on disk (explicit list)

| v1 event | v2 twin | Disk action |
|---|---|---|
| `tool-call` | tool `item.started` (and `item.updated`) | **dropped** |
| `tool-result` | tool `item.completed` (`output` / `error`) | **dropped** |
| `text` | message `item.completed` — absent when the message never completes | kept (Q1) |
| `image` | `image` (v2) — dropped by the sink, never persisted | kept |
| `token-usage` | `usage.updated` (raw counts; v1 carries the cost-weighted total) | kept (Q2) |
| `cost` | `turn.completed.costUsd` / `usage.updated.costUsd` | kept (Q2) |
| `session` | `session.started` | kept (Q2) |
| `turn-end` | `turn.completed` | kept (Q2) |
| `done` | `session.ended` | kept (Q2) |
| `error` | `session.error` | kept (Q2) |
| `note` | none (run-manager notes) | kept |

`provider-auth-required`, `ask.requested`, `plan.updated` and every run-manager event
(`step-start`, `step-end`, `lifecycle`, `user-message`, `check-output`, `image`) are not runner v1
events and are unaffected.

## Implementation

- **`workflows/run.ts`**: `EPHEMERAL_V1_TYPES = {tool-call, tool-result}` and one
  `emitRunnerEvent` seam used by both `onEvent` handlers (`runAgentStep` and the `execute` `emit`
  closure behind `runContinuation`, the paired construction sites AGENTS.md warns about), so a
  future type cannot half-migrate.
- **`runs/derive-v1.ts`** (new): `deriveV1Events(events)` returns the transcript with the v1 tool
  lines rebuilt (Q4). Derived events reuse the source line's `seq`/`ts` and are not seq-unique.
- **`runs/store.ts`**: `rehydrateSeq` resumes `SEQ_RESTART_HEADROOM` above the file max (Q8).
- **`runs/event-history.ts`**: a comment on the TodoWrite `tool-call` branch says it is
  legacy-only (Q5).
- **Docs**: `AGENT_PROTOCOL.md` §§2, 8 and `BACKWARD_COMPATIBILITY.md` §§3, 7 describe the new
  writer. `CHANGELOG.md` has no unreleased section; the release changelog picks this up from the PR.

## Out of scope / follow-ups

- **Runner double-mapping (finding 4)** — derive v1 from the v2 stream in the runners and emit one
  normalised stream. CPU on the live path; not touched here.
- **Lifecycle twins (Q2)** — `session`, `token-usage`, `cost`, `turn-end`, `done`, `error` still
  have a v1 disk line beside their v2 twin.
- **Never-completed message items** — the sink persists no snapshot for a message that dies
  mid-stream, so the v2 lines on disk lack its text (v1 `text` still has it). Worth a sink
  fix before `text` can ever leave the disk.
- **The 9 identity divergences in `v1-derive-parity.test.ts`** — mapper/runner disagreements about
  which tool calls exist (codex collab/review/todo/sub-agent folding, opencode patch/subtask parts).
  Pre-existing; the derived view follows v2.
- **`item.delta` in `readEvents`** stays impossible by design (only snapshots persist).
