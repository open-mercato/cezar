# Execution plan — arm automations for projects registered out of process (#2041)

Goal: a project registered while the server runs (`cez projects add`, a config edit) gets its automations armed without a restart, and a project that still cannot be scheduled is logged, never skipped silently.

Scope: `automations/scheduler.ts` (lazy `resolveHandle` on reschedule, one-time `warn` on a miss), `automations/coordinator.ts` (`root()` accessor), `server/server.ts` (wire both; give the coordinator a `warn`).

Non-goals: registry file watcher, CLI→server HTTP notification, changing the cockpit's `scheduler.state` derivation.

Risks: a handle resolution failing every reschedule — logged per reschedule, the scheduler keeps arming every other project.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Fix and regression tests

- [x] 1.1 Resolve a missing automation handle on reschedule and warn on a miss
- [x] 1.2 Regression tests proven red without the fix
