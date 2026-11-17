# Lessons

## 2026-11-17 — Carry work admission across asynchronous boundaries

A parked task may reacquire its repository lease asynchronously. A technical message can change its waiting flags before the accepted payload is sent; reclassifying that payload then loses the continuation count. Reserve admission once at acceptance and carry it through delivery. For graph child waits, admit only the report that releases the wait, rather than each partial report.

Evidence: commit e78fc0a650e5a3db266571de21d3c158ec4ee6cb, `packages/cezar/src/workflows/thread-hygiene.test.ts` (lease reservation, all-child release and gated next release). Independent review reproduced both bypasses; the P1 re-review confirmed their closure. Existing safety-brake tests keep their original limits under a test-local raised thread threshold; the default decision gate has separate unmocked tests.

## 2026-11-17 — Apply store transition rules before recovery markers

RunStore.updateRun retires an old idle marker when a record enters waiting. Recovery must first transition into waiting and then stamp the new idle park; combining both writes removes the marker and prevents explicit Continue after restart. Evidence: the real startup-recovery regression in `packages/cezar/src/workflows/thread-hygiene.test.ts` fails before this ordering repair and passes after it. The owning recovery code and hygiene specification document the ordering.
