# Queue fixes from issue rows (#1621)

Source doc: .ai/specs/2026-10-30-issue-1621-issue-actions.md (design PR #1846)
Status: implementation and browser QA complete; final review handoff
Engine: om-auto-create-pr (4 steps; no loop)

## Goal

Issue-only Queue fix and bounded selected-row launch through the installed fix skill and existing scheduler, with captured project/engine, cost confirmation, local duplicate prevention and partial failure evidence.

## Ownership and risks

- Wait for #1620's source settlement before editing github.tsx; keep its independent metadata changes on integration. Unique issue-fix modules/tests are independent meanwhile.
- Parent owns web api/client.ts centrally; the optional explicit scope argument is additive. #1700 owns engine/body plumbing, reused here rather than duplicated.
- No public wire/state changes or new scheduler. UI duplicate prevention is not durable idempotency; never automatically retry an ambiguous request.
- Local Windows full-suite and node:test POSIX failures were reproduced on unchanged source. Execute all configured gates honestly and require exact-final-head supported CI; never call local full gate green when it fails.

## Implementation Plan / Progress

- [x] 1.1 Scoped creator, selection/launch controller and exact-request/partial-result tests (7 focused cases; web typecheck passes).
- [x] 1.2 Accessible row controls, selected-count toolbar and confirmation; wire ordinary/search/virtualized issue rows without PR/navigation regressions (10 focused cases pass; existing page plus controller 151 pass; web typecheck passes).
- [x] 2.1 Original-route regression fails without wiring; 12 focused tests and final full typecheck pass. Source e7bee6a3 has green exact-head CI41135383711, all three full Vitest shards and verify/platform/package checks. Author code review found and fixed access-mode guidance, test typing and short-screen dialog clipping.
- [x] 2.2 Real-browser state matrix and inline report published: https://github.com/open-mercato/cezar/pull/1847#issuecomment-6534501975 . Evidence-only owner handoff retains review/needs-qa and no author QA approval; final tracking-head CI and fresh read-only review are checked before lock release.

## Validation and limits

Row/bulk/scoping tests12/12 pass; existing page/controller151 passed. Three actual native API task creations used only a private DRY_RUN fixture. Browser matrix covers cancel, partial403/manual retry, locks, missing/loading/error skill, unavailable/empty GitHub,300 rows/two cursor pages/virtualization/20-cap, search, long text, light/dark,390px, project navigation and final rebuilt320x568. The short-screen geometry check fails before the fix and passes after; all confirmation buttons remain visible while the issue list scrolls.

All five local commands were executed in order. Final full typecheck passes65s; build/check:pack passes16s; package33/33 passes55s. Full local Vitest hit300s bound with baseline Windows failures; node:test45pass/2baseline POSIX ENOENTfail/1skip. The local full gate is not green. A test-only partial-mock typing error from the follow-up pass was corrected before final typecheck; exact supported-platform source CI is green. No unrelated test was weakened.

Public API/state/configuration/defaults are unchanged. The private optional createRun scope preserves old callers. Duplicate prevention is transient UI state, not durable idempotency: ambiguous failures require checking Tasks before retrying. Controlled browser data/errors are documented, no paid turn or real user task action occurred. A browser-level follow-up scenario is posted separately; React tests do not count as E2E. Final tracking-only commit receives its own CI check before publication is declared complete.
