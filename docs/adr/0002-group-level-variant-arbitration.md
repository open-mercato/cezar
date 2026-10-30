# Group-Level Variant Arbitration & 4-Act Decision Synthesis

- **Status:** Proposed
- **Relates to:** Issue #1157

## Context

Cezar provides parallel task execution via `variants: 1..3` on `POST /runs` (`.ai/specs/010-parallel-variants.md`). This spawns N independent sibling tasks in isolated worktrees grouped by `groupId`, which are compared side-by-side in `packages/web/src/routes/compare-variants.tsx`.

Line 45 of `.ai/specs/010-parallel-variants.md` explicitly reserved this capability for v2:
> *"Auto-ocena wariantów przez AI-sędziego (kusi, ale to v2 — najpierw człowiek)"*

Now that human review of variants is battle-tested, tech leads face high cognitive load comparing raw multi-file diffs across 2 or 3 variants. Furthermore, `packages/cezar/src/server/server.ts:5000` synchronously deletes losing worktrees and branches upon picking a winner, while `runs/retention.ts` reclaims finished worktree allocations. Therefore, comparative arbitration must operate independently of the live, fragile filesystem.

## Decision

### 1. Unified Settlement via `reportSettledChildToParent`
Rather than enumerating disparate call sites or implementing database drivers, arbitration settlement hangs off Cezar's existing single-funnel lifecycle hook:
- **Existing Hook Integration:** `reportSettledChildToParent` (`packages/cezar/src/workflows/run.ts:2237`) already captures all terminal transitions: normal `dropActive`, queued cancellation via `cancelOne` (:2822), and restart recovery settling (:1582, :1693, :1809).
- **In-Memory Settlement Trigger:** When `reportSettledChildToParent` determines that all siblings in a group are terminal, it invokes `reconcileGroupArbitration(groupId)`.
- **Viability Predicate:** The hook launches evaluation **only when at least 2 siblings have reached `completed` or `review`** (with valid code). If fewer than 2 candidates survive (e.g. sibling cancelled in queue), arbitration transitions immediately to `skipped(insufficient_candidates)`.
- **File-Backed Idempotency:** The settlement key is `group-arbitration:<groupId>:<revisionHash>`, where `revisionHash` is the canonical SHA-256 of sorted variant snapshot hashes. Before launching an evaluation, the host checks whether a valid `.ai/cezar/groups/<groupId>/synthesis.json` matching `revisionHash` already exists on disk. If present, duplicate execution is skipped.

### 2. Host-Side Bounded Immutable Evidence Snapshot Pattern
Comparative arbitration evaluates structured, bounded evidence compiled by the Cezar host process prior to worktree deletion.
- **Snapshot-Before-Delete Invariant:**
  Evidence snapshots are captured via an idempotent function `snapshotStore.ensure(variantId)` as soon as each variant reaches a terminal state. Both the human Pick handler (`server.ts:5000`) and retention sweeps (`runs/retention.ts`) invoke `ensure` prior to unlinking worktree directories. If a worktree is missing and no snapshot exists, arbitration safely records `skipped: evidence_unavailable`.
- **Host Compilation Procedure:**
  Before dispatching the evaluator, the host executes the snapshot build:
  1. Computes task-relative diffs via `resolveTaskDiffBase` (`packages/cezar/src/git-diff-base.ts`), ensuring committed changes are not omitted.
  2. Binds diffs to a strict budget of 500 lines per variant (sorted by churn; omitted files listed in `omittedFiles` with `truncated: true`).
  3. Extracts exact test commands, `exitCode` (0/1), execution duration, and truncated output tail (max 80 lines / 8 KB) from runner transcripts.
  4. Scans evidence through `detectSecrets()`: if raw credentials are found, arbitration is skipped (`skipped: credential_in_evidence`).
  5. Writes snapshot JSON to `.tmp/snapshot-<id>.tmp` and executes an atomic `fs.rename` to `.ai/cezar/groups/<groupId>/evidence/<variantId>.json`.
- **Hard Drift Abort (`EVIDENCE_DRIFT`):**
  If any step detects a hash mismatch against the snapshot manifest, arbitration aborts with `EVIDENCE_DRIFT` rather than operating on corrupted or modified inputs.

### 3. Race Resolution: Authoritative Human Pick vs AI Evaluator
Pick by the human reviewer is authoritative, non-blocking, and terminal. The AI judge is purely advisory.
- **In-Memory State Machine (`RunManager`):**
  ```
  GROUP_ACTIVE -> (all terminal) -> GROUP_PENDING_ARBITRATION
  GROUP_PENDING_ARBITRATION -> (judge finished) -> GROUP_ARBITRATED
  GROUP_PENDING_ARBITRATION -> (user Pick)      -> GROUP_PICKED   [judge aborted]
  GROUP_ARBITRATED          -> (user Pick)      -> GROUP_PICKED   [card archived as history]
  ```
- **Cooperative Abort + In-Memory CAS:**
  When a user clicks Pick:
  1. An immediate `AbortController.abort('picked')` halts active model streaming.
  2. `RunManager` transitions the in-memory group state to `GROUP_PICKED` via compare-and-swap.
  3. Worktree directories of losing variants are unlinked immediately without waiting for model termination.
  4. Any late-arriving evaluation result is rejected by the CAS check, marked `stale: true`, and archived in the run audit trail without overwriting the human decision.

### 4. Background Evaluator Resource & Safety Contract

| Parameter | Specification | Rationale |
|---|---|---|
| **Activation** | Strictly opt-in (workspace config / `--arbitrate` flag) | Default off; zero unsolicited API costs |
| **Runner** | Omit `runner` property (parent task's runner is used) | Reuses existing runner credentials; avoids shadow runner pools |
| **Model** | Lightweight Tier-2 reasoning class (`arbitration.model`, e.g. Haiku / Flash-mini) | Fast structural synthesis; requires structured JSON output |
| **Timeout** | 45–60 seconds hard kill (`AbortSignal.timeout`) | Design target: typical evaluation completes under 25s |
| **Token Limits** | Bounded snapshot: Input ~12–15k tokens, Output max 1500–2000 tokens | Budget ceiling: ~$0.008 per evaluation |
| **Concurrency** | Low-priority slot / out-of-band semaphore (max 2 concurrent global) | Never starves interactive developer tasks |
| **Tool Access** | `tool-free` (zero shell, filesystem, or network capabilities) | Immune to prompt-injection tool exploits |
| **Deterministic Rule** | A variant with failing tests (`exitCode != 0`) cannot beat a green variant | Hard validation gate enforced by host post-processing |
| **Fail-Safe Fallback** | Timeout or model error degrades to manual diff view | UI is never blocked; surfaces clear status with manual retry |

### 5. Delivery via Existing Group Route (Zero New Protocols)
Rather than introducing new endpoints, WebSocket channels, or reconnect protocols:
- **Additive Field on Existing Route:**
  `GET /api/v1/groups/:groupId` (already implemented and protected in `packages/cezar/src/server/server.ts:4934–4958`) is extended additively to include an optional `arbitration` payload:
```ts
export const groupResponseSchema = z.object({
  groupId: z.string(),
  runs: z.array(groupVariantSchema),
  arbitration: variantSynthesisSchema.optional(),
});
```
- **Cockpit Refresh:** The web cockpit in `packages/web/src/routes/compare-variants.tsx` already refreshes `GET /api/v1/groups/:groupId` on member state transitions via `memberStates` query invalidation. When arbitration finishes, an invalidation event triggers a seamless re-fetch.
- **Contract Schema (`packages/contract`):**
```ts
export const variantSynthesisSchema = z.object({
  groupId: z.string(),
  status: z.enum(['pending', 'evaluating', 'completed', 'skipped', 'failed', 'stale']),
  winnerVariantId: z.string().nullable(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  acts: z.object({
    scenario: z.string(),
    valueAtRisk: z.string(),
    tradeoffs: z.array(z.object({
      dimension: z.string(),
      variants: z.record(z.string(), z.string()), // variantId -> summary (1..3 columns)
    })),
    recommendation: z.string(),
    verificationSummary: z.string(),
  }),
  inputRevisionId: z.string(),
  createdAt: z.string(),
});
```

## Alternatives Considered

1. **Comparing via `mtime` and live files:**
   - *Rejected:* File timestamps are altered unpredictably by git checkouts, branch switches, and local linters. Additionally, `server.ts:5000` deletes losing worktrees immediately on Pick, triggering fatal `ENOENT` crashes.
2. **File watching / `inotify`:**
   - *Rejected:* Not portable across Linux, macOS, and containerized Docker environments; introduces race windows between watch registration and write completion.
3. **Filesystem File Locks (`flock`) or SQL Database:**
   - *Rejected:* Cezar is a single-process Node.js daemon using file-backed JSON storage (`runs/store.ts`); introducing SQL primitives or persistent lockfiles adds fragile external dependencies and risk of stale lockouts after daemon restarts.
4. **Separate Dedicated WebSocket / HTTP Routes:**
   - *Rejected:* Adding `GET /api/v1/groups/:groupId/synthesis` and new WebSocket topics creates redundant network protocols and complex reconnect handling. Delivering an additive `arbitration` field on the existing `GET /api/v1/groups/:groupId` endpoint reuses battle-tested caching and remote-mode infrastructure.
5. **Blocking Pick until Evaluation Finishes:**
   - *Rejected:* Human decisions must never be held hostage by third-party LLM latency. Human pick is always authoritative and immediate.

## Consequences

- Tech leads receive a structured, 60-second comparison matrix across surviving variants (2 or 3).
- Worktrees are safely unlinked or cleaned up without causing `ENOENT` or broken evaluator reads.
- Zero race conditions: early picks cleanly abort evaluation and discard or archive stale data.
- Full idempotency across server restarts, queue cancellations, and concurrent terminal transitions without SQL overhead.
