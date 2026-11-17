# Lessons

## 2026-11-17 — Carry work admission across asynchronous boundaries

A parked task may reacquire its repository lease asynchronously. A technical message can change its waiting flags before the accepted payload is sent; reclassifying that payload then loses the continuation count. Reserve admission once at acceptance and carry it through delivery. For graph child waits, admit only the report that releases the wait, rather than each partial report.

Evidence: commit e78fc0a650e5a3db266571de21d3c158ec4ee6cb, `packages/cezar/src/workflows/thread-hygiene.test.ts` (lease reservation, all-child release and gated next release). Independent review reproduced both bypasses; the P1 re-review confirmed their closure. Existing safety-brake tests keep their original limits under a test-local raised thread threshold; the default decision gate has separate unmocked tests.
