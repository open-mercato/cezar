# Keep attachments when discarding a plan

Goal: Fix issue #1094 so planned-task discard restores the attachment chip shape and a successfully started plan consumes attachments exactly once without leaking them into the next task.

Scope: `packages/web/src/routes/new-task.tsx` and its route tests. Add focused regression coverage for attachment restoration, post-start cleanup, rejected-plan retry, and the exact-once plan payload. Browser QA is required by the issue order; use the configured browser provider when available and document environment limits honestly.

Non-goals: No changes to the server plan/run API, attachment encoding, composer internals, tracker state, or the parent audit record.

Root cause: `Composer` clears its controlled attachment state optimistically before posting. The plan success path restores only draft text, so Discard loses the pre-plan `PendingAttachment` chip. Restoring the route state on plan success preserves the chip, but a successful `startPlanned` must then clear that state because the attachment has been consumed.

Risks: The route state and wire attachment types differ; the submit parameter must not shadow the `PendingAttachment[]` route state. Tests must distinguish rejected-plan retry (which already restores through Composer) from successful-plan discard and must assert one planned-run payload.

## Progress

PR: #1229

> Convention: `- [x]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Reproduce and implement

- [x] 1.1 Add failing regression coverage for plan attachment restoration and post-start cleanup — 8b208fe0
- [x] 1.2 Restore the route attachment chips after successful planning and clear consumed attachments after Start — dad2012d

### Phase 2: Validate and ship

- [x] 2.1 Run focused tests, prove red without the fix, then prove green with it — 8b208fe0
- [x] 2.2 Run the ordered repository validation gate and browser QA evidence — 8b208fe0
- [x] 2.3 Review the PR, finalize labels/body, and report the verified result — 8b208fe0


## Final verification

All configured commands passed. Clean full `npm test -- --maxWorkers=2`: 507 files / 8588 tests passed. Test subprocesses removed inherited `CEZ_*` values and used `/tmp`; earlier environment/timing failures are superseded by this green run. Independent final review found no code defects on this implementation. Evidence: https://github.com/open-mercato/cezar/pull/1229#issuecomment-5944195873.
Browser QA passed; screenshots: https://github.com/open-mercato/cezar/pull/1229#issuecomment-5943896589. Repository QA approval remains a merge gate.
