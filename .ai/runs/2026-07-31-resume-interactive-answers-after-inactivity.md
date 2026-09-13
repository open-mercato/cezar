# Resume interactive answers after inactivity

## Goal

Make a structured question's option chips reliably resume an agent session after the inactivity timer closes it, including the short teardown interval where the cockpit still has a `waiting` record and the server still considers the old run active.

## Scope

- Keep the existing live-message and closed-session continuation seams.
- Add bounded synchronization for the specific `409 run is still active` teardown response before retrying the same continuation.
- Keep one answer delivery in flight across that retry window so repeated clicks cannot start duplicate continuations.
- Add focused cockpit regression coverage and update the AskUser behavior specification.

## Non-goals

- No HTTP route, contract, persisted run schema, or agent protocol changes.
- No generic retry policy for mutations or unrelated `409` responses.
- No provider fallback or runner-switch behavior changes.
- No changes to the inactivity timeout duration or server session lifecycle.

## Implementation Plan

### Phase 1: Reliable answer delivery

- **Step 1.1 — Synchronize with idle-session teardown.** Update the AskUser delivery hook to retry only a continuation refused because the previous run is still active, use a bounded delay, surface every other error unchanged, and hold a single-flight guard across the complete operation.
- **Step 1.2 — Lock in the race behavior.** Extend focused AskUser tests to reproduce `POST /messages` returning `session closed`, the first `POST /continue` returning `run is still active`, and the later continuation succeeding without duplicate delivery; also pin the bounded/non-retry cases.

### Phase 2: Behavioral documentation

- **Step 2.1 — Document the teardown transition.** Amend the AskUser specification's closed-session edge case to explain that the client briefly waits and retries only while the old engine is settling.

## Risks

- A broad `409` retry could hide real provider or session errors. Mitigation: match the existing `ApiError` status and exact transient server message, and test that other refusals pass through immediately.
- The retry delay creates a window for duplicate clicks. Mitigation: keep a hook-owned single-flight flag from the first message attempt through the final continuation result.
- Teardown could exceed the bounded retry window on an unusually slow worktree. Mitigation: retain the last server error visibly on the card so the action is recoverable instead of silently dropped.

## Progress

PR: #758

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Reliable answer delivery

- [x] 1.1 Synchronize with idle-session teardown. — bc25262c, ed987425
- [x] 1.2 Lock in the race behavior. — bc25262c, ed987425

### Phase 2: Behavioral documentation

- [x] 2.1 Document the teardown transition. — 29d4b2fa
