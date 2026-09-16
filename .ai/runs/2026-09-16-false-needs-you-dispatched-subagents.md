# Execution plan — #933: a task shows "needs you" while the agent is only waiting on its own dispatched subagents

- Issue: open-mercato/cezar#933
- Engine: om-auto-create-pr (steps: 9, --loop: no)
- Branch: `fix/false-needs-you-dispatched-subagents`
- Base: `main`

## Goal

A turn that ends because the agent is still working on its OWN downstream work — subagents it
dispatched, a command it is monitoring — parks as `status: 'running', activity: 'monitoring'`
(non-attention) rather than `status: 'waiting'` ("needs you" + a browser notification), at BOTH
turn-end call sites.

## Step 1 evidence — which branch the transcripts put this on

The issue prescribes reproducing first: find an affected run transcript and check whether the final
assistant turn literally contains `CEZ:MONITORING`.

All 142 local transcripts under `.ai/cezar/runs/*.ndjson` were scanned, reconstructing `turnText`
exactly the way `run.ts` builds it (`appendTurnText` over the turn's raw assistant text blocks) and
testing `MONITORING_MARKER_RE = /CEZ:MONITORING\s*$/` against `turnText.trimEnd()`.

**Result: every turn that genuinely ended still-working AND emitted the marker was detected
correctly — 9 of 9.** (`094388f3` turns 1–8, an `om-auto-review-pr` run fanning out to 7 subagents,
and `5ccac582` turn 1, a dispatcher run that created 4 child tasks.) The persisted v1 `text` events
show no marker, which is by design — `stripMonitoringMarker` runs on the persisted copy while
detection runs on the raw accumulation.

=> **Branch: marker MISSING (behavioral), not detection of a present marker.** Corroborated by the
reporter's own screenshot on the issue: the thread shows an `Agents · 2/2` panel
(`Skill: om-auto-fix-issue`, `Skill: om-verify-in-repo`) and then, with no trailing assistant prose
in between, `The agent is paused, waiting for your reply` — a turn that ended right after subagent
work with no marker at all.

Two secondary findings that shape the fix:

1. The `.ai/specs/2026-07-18-subagent-monitoring-status.md` "rejected approach" premise —
   *"no turn ever ended with an open sub-agent tool-use"* — no longer holds: `094388f3` turn_1
   ended with an open `Read` and turn_2 with an open `Bash`. Recorded here; the tool-event backstop
   itself stays out of scope (the issue files it as an explicit follow-up).
2. The web layer is already correct. `deriveAttention` maps `running`/`monitoring` into the
   `running` bucket (label `monitoring`, no notification), `wantsAttention` follows it, and
   `threadFooter('running')` returns `null`. The whole defect is upstream, in the run record.

## Scope

- `packages/cezar/src/handoff.ts` — the `Still-working marker` paragraph of
  `HANDOFF_ONLY_INSTRUCTIONS` (the evidence-backed fix).
- `packages/cezar/src/workflows/run.ts` — monitoring-marker detection only, routed through one
  shared helper both turn-end sites call.
- `packages/cezar/scripts/mock-claude.mjs` — a dry-run variant for the regression test.
- Tests: `packages/cezar/src/handoff.test.ts`, `packages/cezar/src/workflows/run.test.ts`.

## Non-goals

- The durable-monitoring lifecycle and `maxMonitoringSessions` (closed #654).
- `CEZ:ASK` / `CEZ:MONITORING` / `CEZ:DONE` precedence.
- Any new `CEZ:*` marker.
- The tool-event backstop from the issue's step 4 (explicitly a follow-up, not a requirement).
- `packages/web/**` — verified correct above, so it needs no change.
- Anything in `automations`, `server-install` or the forge modules.

## Compatibility

`CEZ:MONITORING` is a protected in-band agent marker (`BACKWARD_COMPATIBILITY.md` §8). Every change
here is additive: the marker keeps its spelling, and detection becomes a strict SUPERSET of what it
matched before — any text that parked as `monitoring` before still does.

## Implementation Plan

### Phase 1: Agent-contract wording (the evidence-backed fix)

Rewrite the `Still-working marker` paragraph so the dispatched-subagent case is unambiguous:
name the asynchronous/background subagent that reports back later through its own completion
notification (not just one that resolves inside the turn), and carry a concrete worked example.
Pin it with a test so the contract cannot silently regress.

### Phase 2: Detection hardening, one helper for both turn-end sites

The handoff contract also tells agents to emit `CEZ:PR=` / `CEZ:ISSUE=` / `CEZ:TITLE=` "as soon as
you know", with no rule about where those sit relative to the turn-end markers. An agent that
declares its PR right after `CEZ:MONITORING` buries the marker: the `$`-anchored test fails and the
still-working turn parks as `waiting`. Tolerate trailing task-reference marker lines, through ONE
exported helper that `runContinuation` and `runAgentStep` both call — AGENTS.md's rule for the two
near-identical turn-end handlers ("route both sites through one helper"), so a future change cannot
ship half a fix. Also strip task markers before the turn-end markers on the display path, so the
same ordering cannot leak `CEZ:MONITORING` into the transcript.

### Phase 3: Regression coverage

### Phase 4: Validation gate and PR

## Risks

- **Widening detection could park a run that should ask for the user.** Mitigated by keeping the
  widening to whole `CEZ:(PR|ISSUE|TITLE)=` lines only: nothing that parked `waiting` for prose
  reasons changes, and the new match set is a strict superset of the old one.
- **Prompt wording is not a guarantee.** An agent that never emits the marker still parks
  `waiting`. That is the spec's design (marker-based by construction); the tool-event backstop is
  the issue's own named follow-up.
- **Diff collision.** Sibling runs are touching other parts of `workflows/run.ts` (Codex compaction
  lifecycle, the Continue `startSession` tool-policy call site). This diff stays inside the
  marker-detection constants and the two `monitoring` expressions.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Agent-contract wording

- [ ] 1.1 Rewrite the `Still-working marker` paragraph in `HANDOFF_ONLY_INSTRUCTIONS` with the async-subagent case and a worked example
- [ ] 1.2 Pin the contract in `handoff.test.ts`

### Phase 2: Detection hardening

- [ ] 2.1 Add the shared `turnEndMarkerText` / `endsWithMonitoringMarker` helper in `run.ts`
- [ ] 2.2 Route both turn-end sites (`runContinuation`, `runAgentStep`) through it, and strip task markers first on the display path
- [ ] 2.3 Add the `mock:monitoring-refs` dry-run variant to `mock-claude.mjs`

### Phase 3: Regression coverage

- [ ] 3.1 Unit tests for the detection helper (incl. the cases that must still park `waiting`)
- [ ] 3.2 Integration regression at BOTH turn-end sites in `run.test.ts`
- [ ] 3.3 Prove the new tests fail without the fix

### Phase 4: Validation and PR

- [ ] 4.1 Full validation gate, PR body with `Fixes #933`, labels
