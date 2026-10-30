# Queue fixes from issue rows (#1621)

Source doc: .ai/specs/2026-10-30-issue-1621-issue-actions.md (design PR #1846)
Status: in-progress
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
- [ ] 1.2 Accessible row controls, selected-count toolbar and confirmation; wire ordinary/search/virtualized issue rows without PR/navigation regressions.
- [ ] 2.1 Prove original-code regression failure, run configured gate and code-review/autofix until source and exact-head CI pass.
- [ ] 2.2 Real-browser QA/state matrix, inline screenshots/report, owner-review handoff: non-draft/unassigned/review/needs-qa, no author QA approval.
