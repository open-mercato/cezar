# Periodically wake monitoring sessions

> Issue: #654 · Depends on: `2026-07-24-long-running-waiting-sessions.md`

## TLDR

Durable bounded monitoring can wait indefinitely at zero model cost, but some stabilization workflows need the agent to re-check CI and continue as soon as it changes. Add an optional workspace wake interval that sends the same live agent a backend-neutral follow-up every N minutes after it emits `CEZ:MONITORING`. Parked mode stays the default; interval mode is explicitly cost-bearing, never overlaps turns, and stops after 40 automatic wakeups per monitoring epoch.

## Resolved assumptions (autonomous defaults)

| # | Question | Applied default | Why | Confirm? |
|---|----------|-----------------|-----|----------|
| Q1 | Fixed or adaptive cadence? | Fixed 1–60 minute interval; first opt-in starts at 5 minutes. | It is predictable across backends and easy to explain, test, and budget. | ok |
| Q2 | Default behavior? | `monitoringWakeIntervalMinutes: null` means park until externally resumed. | Zero surprise and zero model spend remain the zero-config behavior. | ok |
| Q3 | Native backend scheduler or cezar timer? | Cezar timer using `AgentSession.sendMessage`. | Claude has `/loop`, but Codex CLI/app-server has no documented equivalent; parity belongs at the runner seam. | ok |
| Q4 | Safety bound? | 40 automatic wakeups per monitoring epoch. | Reuses cezar's existing autonomous continuation ceiling and prevents forgotten loops from spending indefinitely. | ok |

## Problem Statement

The foundational spec keeps agent-declared monitoring sessions alive and bounds their process capacity. A parked session, however, has no event source that tells the agent CI completed. A user can manually reply, and an external integration may eventually steer it, but stabilization workflows commonly need local polling on a modest cadence.

This must remain opt-in. Every wake creates a real model turn, so making it implicit would widen cost and network usage. It must also behave identically across Claude, Codex, and OpenCode rather than exposing a capability only when a backend happens to ship its own scheduler.

## Research

Claude Code's session-scoped [`/loop`](https://code.claude.com/docs/en/scheduled-tasks) is explicitly designed to poll deployments, PRs, and long builds. It supports fixed or adaptive intervals with one-minute minimum granularity, fires only between turns, restores unexpired jobs on resume, and expires recurring loops after seven days. Codex documents [scheduled tasks inside an existing chat](https://learn.chatgpt.com/docs/automations) for checking long-running operations at minute intervals, but that management surface is in ChatGPT web/desktop rather than Codex CLI; cezar drives Codex through app-server. Both validate returning to the same conversation on a cadence, but neither supplies a portable runner contract cezar can delegate to.

The shared subset is small: schedule while idle, send a normal follow-up into the same session, never replay missed ticks, and bound forgotten loops. Cezar can implement that once through `AgentSession.sendMessage` without importing vendor cron state or commands.

## Proposed Solution

Add nullable workspace resource `monitoringWakeIntervalMinutes`:

- `null` (default): durable monitoring remains parked until user/external input;
- integer 1–60: after a turn parks with `CEZ:MONITORING`, schedule a wake after N minutes;
- wake prompt: “Re-check the downstream work you were monitoring. Continue toward the task goal; emit `CEZ:MONITORING` again only if it is still pending.”;
- when the next turn monitors again, schedule one new timer;
- after 40 automatic wakeups in the current monitoring epoch, remain parked and emit a lifecycle note; a real user follow-up starts a new epoch.

Immediate autonomous mode keeps precedence and existing behavior. The timed mode starts only after the run actually parks as monitoring, including after immediate autonomous continuation reaches its own cap.

## Architecture

### Configuration and API

Extend the workspace `resources` schema and existing GET/PUT contract:

```ts
monitoringWakeIntervalMinutes: z.number().int().min(1).max(60).nullable().default(null).catch(null)
```

The key is additive, live-refreshable, `.passthrough()` safe, and requires no migration or environment variable. Invalid/corrupt values become parked mode. API PUT accepts `1..60 | null`; `null` cancels wakeups without ending sessions.

### Wake coordinator

Add one unref'd timer and `monitoringWakeups` counter to each relevant `ActiveRun`:

1. Schedule only after a completed turn parks as monitoring and the interval is non-null.
2. At expiry, synchronously verify the run is still monitoring and the session is open.
3. Deliver the fixed prompt through a private internal follow-up helper built on `AgentSession.sendMessage`; reuse state/slot cleanup but do not persist a fake user-authored message.
4. Increment and append an observable `automatic monitoring wake-up (N/40)` note.
5. Schedule the next timer only if that turn ends in monitoring again.
6. Cancel on user follow-up, non-monitoring turn, done, cancel, finish, failure, backend end, recovery cleanup, or config switching to null.

No concurrent turn or catch-up queue exists: a timer is only present between turns, and missed intervals collapse into the next possible single wake. A rejected send follows the existing backend-end path and never retry-spins.

### Compatibility

The backend seam already supports live follow-ups for Claude stream-json stdin, Codex app-server turns, and OpenCode HTTP sessions. No runner-specific API, marker, status, persisted run field, or UI event is added. The in-memory counter intentionally resets after process restart; existing session recovery governs whether a timer can be rebuilt for a genuinely live/recoverable monitor.

## UI/UX

Add a Settings → Resources field below Extra monitoring sessions:

- title: **Monitoring wake-up**;
- mode select: **Park until resumed** or **Re-check on an interval**;
- interval mode reveals a 1–60 minute numeric input and Save button, seeded to 5 on first opt-in;
- hint: **Park uses no model turns. Re-check sends the same agent a follow-up on this cadence until work completes or the 40-wakeup safety cap is reached.**;
- helper: **Claude offers a similar `/loop`; cezar applies this consistently to Claude, Codex, and OpenCode.**

The control uses the existing resource mutation, cache update, toast, keyboard, mobile, and validation patterns. Proposed mockup: `assets/long-running-waiting-sessions/mockup-01-resources-monitoring-capacity.png`.

## Edge Cases & Failure Scenarios

- Enabling interval mode for parked sessions schedules from the config-change time; no retroactive burst.
- Changing N cancels/replaces pending timers using the full new interval.
- Switching to Park cancels timers but leaves sessions alive.
- A slow agent turn cannot overlap the cadence; no timer exists during the turn.
- A timer racing with terminal state re-checks synchronously and becomes a no-op.
- Wake #40 runs normally; if it monitors again, cezar parks it without timer and emits the cap note.
- A user message resets the epoch; a config refresh alone does not.
- Backend disconnect uses the existing visible error/terminal path.
- Cezar restart does not promise vendor-process resurrection or missed-wake replay.

## Risks & Impact Review

- **Cost/network:** each tick is a model request. Default null, explicit UI copy, one-minute floor, and 40-wakeup cap bound surprise.
- **Race risk:** timer/turn lifecycle can double-send if cleanup is scattered. One coordinator/helper and fake-timer tests are mandatory.
- **Parity risk:** direct `/loop` integration would diverge by backend; the common sendMessage seam avoids it.
- **Rollback:** reverting removes timers and ignores the passthrough config key; durable parked monitoring from the foundational spec remains functional.

## Phasing

- **Phase 1 — backend-neutral coordinator:** config, timer lifecycle, synthetic follow-up helper, safety cap.
- **Phase 2 — operator control:** Resources mode/interval UI and live reconfiguration.
- **Phase 3 — verification:** cross-runner fakes, browser persistence flow, docs and screenshots.

## Implementation Plan

1. **Add the resource key.** Extend workspace schema/load/response/input/web types with nullable range 1–60/default null. *Tests:* absent, null, valid boundaries, invalid fallback, merge-write/passthrough, API validation, live refresh.
2. **Extract internal follow-up delivery.** Refactor `RunManager.sendMessage` so user-authored persistence stays at the public boundary while a private system follow-up reuses delivery/state/slot logic. *Tests:* user events remain byte-compatible; synthetic wake text never appears as a user message.
3. **Implement timer lifecycle.** Schedule only for parked monitoring, cancel on every exit/config change, and use unref. *Tests:* fake timers cover fire, cancel, replace, race, no overlap, no catch-up, and closed session.
4. **Enforce the safety epoch.** Count automatic wakes, stop after 40, append lifecycle notes, and reset only on real user input. *Tests:* 40th/41st boundary and config-refresh non-reset.
5. **Prove backend parity.** Run the same manager-level wake contract against Claude, Codex, and OpenCode fake sessions; no vendor scheduler/command is invoked.
6. **Add Resources UI.** Implement mode select, conditional interval editor, validation, Save, helper text, and accessibility. *Tests:* null/interval payloads, cache, pending/error states, boundaries, accessible names.
7. **Add browser evidence and docs.** Persist both modes through reload, capture the control, and document cost/cap semantics. Run the full validation and package gates.
