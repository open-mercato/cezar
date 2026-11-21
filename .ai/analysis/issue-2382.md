Summary: Automation Dispatch off does not deny cezar child creation.

Root cause: startInput omits dispatchIntent when off, which is the ordinary-task default-on shape. RunManager.dispatch checks only global enablement, and prepareDispatchSession teaches child creation to all reachable sessions. Confirmed by inspection at c043cff27 and the issue's runtime reproduction comment 7059741647.

Files to change:
- automations/task-template.ts — set a launch-time authorization for every trigger and variant.
- contract/src/runs.ts and cezar/src/runs/store.ts — optional stored boolean, persisted at creation.
- workflows/run.ts — central early refusal, descendant/session/recovery enforcement, preserve graph internal fan-out and shared transport/reporting.
- Relevant template, engine, recovery, prompt and HTTP tests — denied/allowed/legacy regressions.
- BACKWARD_COMPATIBILITY.md, docs/reference.md, run tracking and tracker descriptor — compatibility and atomic claim evidence.

Approach: Persist authorization independently of dispatch intent before queue admission. Ordinary tasks without it remain allowed. Old automation roots without saved intent fail closed; old explicit intent proves permission. Never infer permission from an edited definition. Use existing 409 error mapping, with no child/tree/budget side effects. Graph fan-out remains an internal workflow operation.

Risks: The optional run schema must survive disk parsing and queued recovery. Continue must omit dispatch instructions including old embedded standard prompts. Tracker, automations and reporting share transport and must stay usable. Global disable, paused automation gates, limits and ordinary defaults must remain intact.
