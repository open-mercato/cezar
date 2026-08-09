# Checkpoint 1 — UI launch surfaces

**Completed through:** Phase 3, Step 3.3 (`97cdbfd4`)
**Date:** 2026-08-09T11:11:01Z

## Automated verification

- `npm run typecheck:web` — passed.
- `npx vitest run packages/web/src/api/client.test.ts packages/web/src/components/engine-pills.test.ts packages/web/src/routes/task-thread/follow-up-engine.test.tsx packages/web/src/routes/inbox.test.tsx packages/web/src/routes/github/github.test.tsx packages/web/src/routes/github/hand-to-agent-draft.test.ts --reporter=dot` — passed: 6 files, 249 tests.

The test set covers the shared picker and wire payload for Inbox and GitHub handoff, an untouched Continue preserving a persisted Codex effort, an explicit Continue override, native-settings locking, and auto/default omission.

## Browser evidence

Started the local cockpit with `npm run dev`; the service discovered Codex and Vite reported a local dev URL. The configured browser provider was not available to this run, so no interactive browser session or screenshot could be captured. A follow-up shell probe could not reach the dev ports from its isolated execution process. The dev process was stopped cleanly.

This is an environment limitation, not an observed product failure. The final gate will repeat browser/integration verification if a provider becomes available; otherwise the final handoff will retain this limitation alongside the automated evidence.
