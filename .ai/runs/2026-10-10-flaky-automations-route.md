# Fix flaky disabled automations route test

Goal: make the disabled-automations route assertions deterministic under full-suite CPU load without extending RTL's assertion timeout.

Scope: `packages/web/src/routes.test.tsx` only.

Implementation plan:

1. Keep the existing suite-level preload of the lazy automations module and restore the assertions to the normal RTL deadline, proving the lazy import is settled before route assertions begin.
2. Run the focused regression, a negative mutation proving the placeholder assertion remains meaningful, and the configured validation gate.

Risks: this is test-only; it does not alter production lazy loading or automations behavior.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Deterministic regression

- [x] 1.1 Remove timeout inflation while retaining lazy-module preload — b92e0f63
- [x] 1.2 Verify focused regression and negative assertion mutation — b92e0f63

### Phase 2: Validation and handoff

- [x] 2.1 Run configured validation gate and review PR — 05e57506
