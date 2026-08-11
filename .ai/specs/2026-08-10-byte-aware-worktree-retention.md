# Byte-aware Worktree Retention (#842)

## TLDR

Count-based worktree retention (#483) is working as designed and still misses its
own stated goal on build-heavy repositories: a project sitting **exactly inside**
`keep=10` held **17 GB**, of which 99.8% was regenerable build output. Value and
cost live in disjoint file sets — the checkout is 7 MB, the `.build`/`DerivedData`
trees beside it are 2.9 GB — and a count budget can only evict both at once. This
spec adds a **strip** rung between "keep" and "reclaim": delete the regenerable
artifacts, keep the checkout — locally rebuildable output first, and dependency
trees only when the disk is genuinely short. Budgets then decide only *which rung* a worktree sits
on. No new user-facing settings: the second budget dimension is **discovered from
free disk space**, not configured.

## Resolved assumptions (autonomous defaults)

This spec was written by `om-spec-writing --autonomous`; the Open Questions gate was
resolved with the defaults below rather than stopping. Each is reversible and meant
to be overridden by a human before merge.

| # | Question | Default chosen | Rationale |
|---|---|---|---|
| Q1 | What is the "hot" set that keeps its build cache? | **The 3 most recently finished worktrees *per project*** — internal constant `HOT_KEEP = 3`, not a setting. Per project, matching `keep`, which is already resolved per repo root by `resolveWorktreeRetention(repoRoot)`. | `AGENTS.md` Zero config: "When a feature seems to need configuration, the design is wrong. Discover it, or default it." Three covers the realistic resume window (the task you just finished, plus the two you might bounce back to) without holding a fleet of caches. |
| Q2 | How is the byte budget expressed — a `maxBytes` setting, or discovered? | **Discovered from free disk space** against a flat `DISK_FLOOR` constant; no new config key at all | Zero config again: "Never trade a working default for a knob." A byte ceiling is a number nobody can pick correctly — it depends on the machine, not the repo. Free space is the quantity the original spec's failure mode is actually about ("the disk fills"), and it is already knowable. This also collapses the backward-compatibility surface to additive `RunRecord` fields only. |
| Q3 | Is the artifact allowlist configurable per project? | **No** — an internal constant, extended by PR when a new toolchain appears | Same law. A per-project allowlist is a footgun pointed at a delete path: a typo becomes data loss. The `git check-ignore` half of the safety rule already adapts the behavior per repository without anyone authoring anything. |
| Q4 | Is strip on by default in its first release? | **Yes, on by default** — ⚠ **NEEDS HUMAN CONFIRMATION** | The Zero config law forbids shipping this behind an opt-in flag ("never trade a working default for a knob"), but `AGENTS.md` → "Changing a mechanism that already works" warns that exactly this kind of change leaves the zero-config user quietly worse off (#810/#811 are the named worked examples). What today's behavior is load-bearing **for** is warm build caches on recently finished tasks, and `HOT_KEEP` is what preserves it. The two laws pull in opposite directions here, the surface is `risk-high`, and every user is affected silently — so a maintainer should sign this off rather than an autonomous default. |

## Problem Statement

Each task runs in its own worktree under `.ai/cezar/worktrees/<runId>`. Retention
(#483, `.ai/specs/2026-07-18-worktree-retention.md`) bounds that pool by **count**:
`selectReclaimableWorktrees` (`packages/cezar/src/runs/retention.ts:37`) reduces to
`reclaimable.slice(keep)` at `retention.ts:42`. Its stated goal is:

> the disk fills — at which point new tasks fail to create a worktree and the
> cockpit degrades

Measured across four registered projects on one machine (macOS, M4 Pro). Retention
was **healthy everywhere**: no orphan directories, `worktreeReclaimedAt` stamps
present, every project at or under budget.

| Project | Finished worktrees | Budget | On disk |
|---|---|---|---|
| cezar-app (Swift/Xcode) | 10 | `keep=10` ✅ | **17 GB** |
| pixquest | 1 | `keep=10` ✅ | 1.6 GB |
| tronbalance-web (JS) | 10 | `keep=10` ✅ | 816 MB |

One cezar-app worktree (`e21c070e`), broken down:

```
git-tracked files:      7 MB
total on disk:       2904 MB
build artifacts:     2897 MB   (99.8% — Swift .build, DerivedData)
```

The same satisfied `keep=10` costs 816 MB on a JS repo and 17 GB on a Swift one — a
20× spread behind one identical policy. Free disk at the time of measurement was
**8.8 GB**, i.e. the machine was already inside the failure mode the policy exists
to prevent, while reporting itself healthy.

The mechanism cannot see this because **value and cost live in disjoint file sets**.
The value of a retained worktree is its checkout — 7 MB that answers "show me the
diff", "open the PR", "resume this". The cost is regenerable build output. A count
budget evicts whole directories, so it can only ever trade both away together.

Adding a byte budget alone would not fix it either: it would make the same all-or-
nothing eviction happen *sooner*. The granularity is the defect, not the threshold.

This is not a defect report against #483 — that policy does exactly what it says.
It is a report that the goal needs a second dimension and a finer eviction unit.

## Research

How comparable tools bound regenerable disk:

- **Docker BuildKit** — `docker builder prune --keep-storage <size>`: an explicit
  byte ceiling over a cache whose entries are *all* regenerable. It has no "keep
  the source, drop the cache" tier because it never holds source in the first place.
- **Bazel / Gradle / ccache** — size-capped LRU caches (`--disk_cache`,
  `max_size`). Same shape: one homogeneous, fully regenerable pool.
- **`cargo sweep`, `swift package clean`, `xcodebuild clean`** — per-toolchain
  commands that delete exactly the derived tree and leave the checkout. This is the
  operation this spec generalizes; the strip rung is these commands' portable,
  toolchain-agnostic equivalent.
- **CI runners** — cache the build directory separately from the checkout precisely
  because the two have different lifetimes and different replacement costs.

What they get right that this spec adopts: a regenerable tier is worth evicting
long before the irreplaceable tier, and a size ceiling belongs on the regenerable
tier. What they carry that this spec skips: a content-addressed cache index and
cross-worktree cache sharing — large machinery for a pool that is at most a few
dozen directories, and one that would put cezar in the business of understanding
each toolchain's cache format.

What none of them do, and what makes the naive local approach dangerous:
`git clean -xdf` is the obvious one-liner and it is **wrong** — it deletes ignored
files indiscriminately, including `.env` files and local credentials. That is a
data-loss incident, not a cleanup, and it is the failure mode the safety rule below
is designed around.

## Proposed Solution

A three-rung ladder replaces today's binary threshold.

| Rung | What is removed | What survives | Resume path |
|---|---|---|---|
| **1a. Strip — derived output** *(new)* | `.build`, `DerivedData`, `target`, `dist`, `.next`, `.gradle`, `.turbo` | checkout + `.git` metadata | none needed — `run.ts:2111` still finds a real path; the agent rebuilds locally |
| **1b. Strip — dependency trees** *(new, pressure-only)* | `node_modules`, `.venv` | checkout + `.git` metadata | rebuild **may need network** and a warm package-manager cache — see below |
| **2. Reclaim** *(today)* | the whole directory | the `cez/<id8>` branch | `rematerializeReclaimedWorktree` |
| **3. Delete** *(today, manual)* | directory + branch | nothing | none |

Budgets stop being the eviction mechanism and become **placement**: they decide
which rung a worktree sits on.

- **`keep = 0` disables every rung.** That setting means *"do not manage my
  worktrees"*, not *"do not delete my directories"* — see Edge Cases.
- The `HOT_KEEP` (3) most recently finished worktrees **of that project** are
  untouched — warm caches, instant resume.
- Everything else that is finished has its **derived output** stripped (rung 1a).
- **Dependency trees are stripped only under real disk pressure** (rung 1b), because
  restoring one needs a reachable registry rather than just CPU. cezar's own
  worktrees are the worked example: the validation gate cannot run in one until
  `node_modules` is restored.
- Beyond `keep` (the existing count budget, unchanged) — or under disk pressure —
  worktrees are **reclaimed**, exactly as today.

Projected on the measured machine: cezar-app becomes roughly `3 × 1.7 GB + 7 × 7 MB`
≈ **5.2 GB instead of 17 GB, with all ten worktrees still browsable**. The important
second-order effect: once strip is doing the work, disk pressure stops binding in
normal operation. The byte dimension becomes a backstop, not the primary control —
which is why it does not need to be a setting.

### The strip safety rule

This is the part of the design that most deserves review, because it is a delete
path over user data.

A path is removed **only when both conditions hold**:

1. its basename is on the internal artifact allowlist, which has **two tiers**:
   - **derived output** — `.build`, `DerivedData`, `target`, `dist`, `.next`,
     `.gradle`, `.turbo`: rebuilt locally from CPU alone, stripped whenever a
     worktree falls outside the hot set;
   - **dependency trees** — `node_modules`, `.venv`: restoring these needs a
     reachable registry, so they are stripped **only under real disk pressure**;

   **and**
2. `git check-ignore -q <path>` confirms it is genuinely ignored **in that
   repository**. Invoked **without `--no-index`** — that flag stops `check-ignore`
   consulting the index and silently converts this guard into a data-loss path
   (measured: with `dist/` ignored and `dist/foo.js` force-added, `git check-ignore
   -q dist` exits 1 and protects the directory, while adding `--no-index` exits 0
   and would delete it). The prohibition carries its own regression test.

Two independent conditions, both required. The first bounds *what* may ever be
considered. The second is what makes it safe in a repository that does not match
convention: a repo that tracks `dist/` fails condition 2 and is untouched, with no
allowlist edit and nothing for the user to configure.

`git check-ignore` is already the canonical guard for this exact class of decision
in this codebase — `packages/cezar/src/agent-config/seed.ts` re-checks a
by-convention "gitignored" label against it before trusting it (`catalog.ts:24`).
This spec reuses that mechanism rather than inventing a parallel one.

Explicitly rejected: `git clean -xdf` / `-Xdf`, in any form. Both delete ignored
files wholesale, which includes `.env` and local credentials.

### Where the byte dimension comes from

Not from a setting. Before a retention pass, the enforcer reads free space on the
volume holding `.ai/cezar/worktrees` (`fs.statfs`; this repo already requires Node
≥ 20, `package.json:8`, so availability is not the interesting risk — see the
degradation note below).

`DISK_FLOOR` is a **flat 10 GiB**. An earlier draft used
`max(10 GB, 10% of the volume)` and that is wrong in a way worth recording, because
the percentage term dominates on exactly the machines it was not written for: a 4 TB
volume with a comfortable 300 GB free sits under a 400 GB floor, so the pass is
permanently under pressure and the escalation loop runs to its "nothing reclaimable
is left" exit — emptying the pool on every pass regardless of `keep`. The spec's own
argument settles the shape: once strip is doing the work, the byte dimension is a
**backstop, not a tuning parameter**, and a backstop does not need to scale with the
volume.

The escalation loop therefore has **three** exit conditions, not two:

1. free space clears the floor, or
2. nothing reclaimable is left, or
3. **the deficit is unrelievable** — reclaiming everything outside the hot set still
   would not clear the floor. The pass then performs the strip rungs only, reports
   the condition, and reclaims nothing. Retention must never delete on account of a
   deficit it cannot fix; when 100 GB is missing, deleting worktrees is not the
   answer and cezar should say so rather than thrash.

When `statfs` fails or returns unusable numbers — some filesystems and platforms do —
the pass degrades to count-only behavior: byte-blind, exactly today's semantics, and
rung 1b never fires. This mirrors the existing degradation contract, where a failed
`du` already surfaces as `totalBytes: null` rather than a wrong number
(`server.ts:4401`).

### Eviction order: oldest first, not largest first

Largest-first would free bytes faster and is deliberately **not** chosen. It is
unpredictable in the way that matters: you would lose the one heavy Swift task while
ten trivial JS ones survive, and the rung a worktree lands on would depend on its
toolchain rather than on when you last cared about it. Recency is the property the
user can reason about, and the strip rung already removes the size pressure that
would justify a greedy heuristic.

## Architecture

Two pure decisions, one impure enforcer, one new I/O primitive. The existing split
is preserved: `retention.ts:1-6` states that the selector is pure and unit-testable,
and sizes are I/O.

### `packages/cezar/src/runs/retention.ts` — the planner (pure)

`selectReclaimableWorktrees` is superseded by a planner that returns both rungs:

```ts
export interface RetentionBudget {
  /** Most-recently-finished worktrees left untouched. Internal constant. */
  hotKeep: number;
  /** Existing count budget. 0 = unlimited, unchanged. */
  keep: number;
  /** Bytes that must be freed to clear the disk floor; 0 = no pressure. */
  pressureBytes: number;
}

export function planWorktreeRetention(
  runs: readonly RunRecord[],
  budget: RetentionBudget,
  sizes: ReadonlyMap<string, number>,   // runId → bytes; absent = unknown
): { strip: string[]; reclaim: string[] };
```

Sizes are **injected**, never measured here — that is what keeps the module pure and
its tests free of a filesystem. An absent size counts as **0**, never as a reason to
evict: an unmeasurable worktree must not be deleted on a guess, and the count budget
still governs it.

`selectReclaimableWorktrees` is kept as a thin wrapper over the planner's `reclaim`
output so existing callers and tests keep working.

### `packages/cezar/src/git-worktree.ts` — the strip primitive (I/O)

```ts
export async function stripWorktreeArtifacts(
  worktreePath: string,
): Promise<{ removed: string[]; freedBytes: number }>;
```

Enumerates candidate directories, applies both safety conditions, removes what
passes. Best-effort and never throws, matching `removeWorktree`'s existing
discipline (`git-worktree.ts:238`). Candidate discovery is bounded — it descends
only far enough to find the allowlisted names, never a full walk of a 2.9 GB tree.

### The enforcer — and its two call sites

Retention is enforced from **two** places today, and they do not share an entry point:

- `enforceRetention` (`workflows/run.ts:1502`), behind the terminal-transition hook
  at `run.ts:1170`; and
- **boot**, which calls `reclaimWorktrees(repoRoot, store, keep)` **directly** at
  `index.ts:238` — it does not go through `enforceRetention`.

Wiring only the first would leave a restarted cezar applying the old count-only
behavior at boot, which is the common case on a laptop. **Both call sites are
funnelled through one entry point before the planner is wired in** (plan step 5
below), so there is exactly one place that samples free space, gathers sizes, and
applies the rungs.

**Sizing is measured once, not per pass.** A finished worktree is immutable — nothing
writes to it again — so its size is measured when the enforcer first sees it and is
then persisted on the run record, re-stamped after a strip. That keeps retention
O(1) per pass instead of re-walking `du` over gigabytes on every terminal transition.

**Lazy backfill is required, not optional.** Measuring only at the terminal
transition would leave every run that finished *before* this ships permanently
unmeasured — such a run never transitions again — and an absent size counts as `0`.
On the machine in the Problem Statement that is all ten worktrees holding the 17 GB
reporting zero to the planner, forever: the byte dimension would be inert for exactly
the population that motivated it. The enforcer therefore measures and persists the
size of any finished run whose `worktreeSizeBytes` is absent, once, as part of the
pass. The machinery already exists — `worktreeSizeBytes()` is what `GET /worktrees`
already calls per row.

## Data Model

Additive, optional fields on `RunRecord` (`packages/cezar/src/runs/store.ts`).
`BACKWARD_COMPATIBILITY.md` §3 is explicit that a **required** new field silently
drops every pre-existing run, because the loader `safeParse`s the whole array:

| Field | Type | Meaning |
|---|---|---|
| `worktreeSizeBytes` | `number` (optional) | Last measured size of this run's worktree. Absent = never measured; treated as unknown, not as zero-cost. |
| `worktreeStrippedAt` | `string` (optional) | ISO stamp; set when the strip rung ran. Absent = never stripped. |

Both follow the documented `#737` / `#751` precedent, and this addition gets its own
entry in that section of `BACKWARD_COMPATIBILITY.md` as part of the work.

Interaction with the existing `worktreeReclaimedAt`: the two stamps are independent
and a worktree may carry both over its life (stripped, later reclaimed).
`rematerializeReclaimedWorktree` keys on `worktreeReclaimedAt` alone and is
unaffected — a *stripped* worktree still exists on disk, so resume needs no
re-materialization at all, which is precisely the rung's advantage.

**No new configuration keys.** `worktreeRetention` and `worktreeRetentionDefault`
are untouched.

`keep = 0` deserves a sharper statement than "the semantics are untouched", because
that would be true of the config key while being false of what the user gets. Today
`keep <= 0` makes `selectReclaimableWorktrees` return `[]` (`retention.ts:38`) —
cezar keeps its hands off. Under this spec **`keep = 0` disables the strip rungs
too**, not just reclaim. Someone who set it is asking cezar not to manage their
worktrees at all, and silently removing their build trees would honor the letter of
the setting while breaking its meaning.

## API Contracts

Purely additive; no existing field changes shape or meaning.

- `GET /worktrees` (`server.ts:4382`) — each row gains `strippedAt: string | null`
  and `rung: 'hot' | 'stripped' | 'reclaimable'`, so the panel can explain what it
  is showing instead of the user inferring it from a size. `sizeBytes`, `totalBytes`
  and `keep` are unchanged, including the `totalBytes: null` degradation.
- `POST /worktrees/strip` — the manual counterpart to the existing reclaim-now
  action; strips every finished worktree outside the hot set. Answers
  `{ stripped: string[], freedBytes: number }`. It is idempotent, and safe when it
  overlaps a retention pass triggered by a terminal transition (`run.ts:1170`) while
  the panel is open: both actors target the same regenerable set, so a double removal
  is a no-op rather than a conflict, and neither can remove what the other still
  needs.
- `GET/PUT /api/v1/workspace/config` — **unchanged**. This is a direct consequence
  of Q2: discovering the byte dimension instead of configuring it means the
  protected `resources` shape is not touched at all.

## UI/UX

The Worktrees panel (`packages/web/src/routes/settings/worktrees-panel.tsx`) already
renders per-row `sizeBytes` and a `totalBytes` summary, and already carries a
"Reclaim now" button — the information was never missing, only unused by the policy.

- Each row shows its rung. A stripped row reads as "checkout only" rather than
  looking like a suspiciously small worktree.
- A **"Strip artifacts now"** button sits beside "Reclaim now", with the same
  confirm-dialog pattern, worded so the distinction is unmistakable: stripping keeps
  the worktree and loses only rebuildable output.
- The summary line names what stripping would recover, e.g. *"7 worktrees hold
  15 GB of build artifacts"* — the number that makes the setting self-explanatory.
- Under disk pressure the panel says so plainly, since that is when the ladder
  escalates on its own.

Accessibility and states follow the panel's existing conventions; nothing here is
novel enough to re-specify.

## Edge Cases & Failure Scenarios

| Scenario | Behavior |
|---|---|
| **`keep = 0`** (user opted out of management) | **Every rung is disabled** — no strip, no reclaim. The setting means "do not manage my worktrees"; honoring it only for directory removal would break its meaning while satisfying its letter. |
| **Free space below the floor, and unrelievable** — reclaiming everything outside the hot set still would not clear it | The pass performs the strip rungs only, reports the condition, and **reclaims nothing**. Retention never deletes on account of a deficit it cannot fix. |
| Disk pressure relieved mid-pass | Escalation stops at the first exit condition; rung 1b (dependency trees) does not fire once the floor is clear. |
| `git check-ignore` unavailable or errors | Condition 2 cannot be satisfied → **nothing is stripped**. Failure is closed, never open. |
| Repository tracks an allowlisted directory (`dist/`) | Condition 2 fails → untouched. No configuration required. |
| `fs.statfs` unavailable/fails | `pressureBytes = 0`; pass degrades to count-only, i.e. today's behavior. |
| `du` fails for a worktree | Size absent → counted as 0, never evicted on that basis. Mirrors the existing `totalBytes: null` contract. |
| Run resumes after a strip | Directory exists, so `cwd` resolution at `run.ts:2111` finds it; agent rebuilds. No re-materialization, no repo-root fallback. |
| Strip races a resuming run | Strip only ever targets runs in the finished set; a run leaving that set before the pass is skipped. Partial removal is safe — every target is regenerable by definition. |
| Symlink inside a candidate path | Never followed out of the worktree; resolved paths outside the worktree root are refused. |
| Strip partially fails (permissions, file lock) | Best-effort: what was removed stays removed, `worktreeStrippedAt` is stamped only when the pass completed, so the next pass retries. Same shape as the existing reclaim stamp discipline (`retention.ts:121`). |
| Disk already full when the pass runs | Escalation order is strip-then-reclaim; strip needs no free space to proceed. |
| Dependency tree stripped, then the machine goes offline | Resume needs `node_modules` and cannot restore it without a registry. This is why rung 1b is pressure-only: the trade is disk now against a network dependency later, and it is only worth making when the disk is genuinely short. |

## Risks & Impact Review

**Risk: `risk-high`**, by this repository's own inference rules. `SDLC.md:59` names
*worktree/branch handling* and *the `.ai/cezar/` state file formats* as risk-high
surfaces; this change touches both.

- **Blast radius — the delete path.** Removing the wrong path destroys unrecoverable
  user data. This is the reason for two independent conditions rather than one, for
  the closed-failure behavior when `check-ignore` is unavailable, and for the
  explicit rejection of `git clean`. It is the part of this spec that most deserves
  adversarial review.
- **Blast radius — behavior change.** Q4 ships strip on by default. Resuming a task
  outside the hot set will rebuild where it previously did not. `HOT_KEEP` is what
  keeps the common case unchanged, and this is flagged for human confirmation.
- **Compatibility.** Additive `RunRecord` fields only, both optional, per
  `BACKWARD_COMPATIBILITY.md` §3. API changes are additive. No config keys are added,
  renamed, or re-defaulted.
- **Rollback.** Two independent stages. Disabling the strip rung restores today's
  behavior exactly — the persisted fields become inert and are ignored, not
  migrated away. Already-stripped worktrees are not "rolled back": they rebuild,
  which is the definition of the tier. Reclaim behavior is untouched throughout, so
  a revert cannot strand a worktree in an unrecognized state.
- **Merge risk.** #747 is open and edits `packages/cezar/src/git-worktree.ts` (base-ref
  resolution — `remoteDefaultBranch`, `staleBaseNote`, `resolveBaseRef`). No functional
  overlap with the strip primitive, but the same file: rebase rather than assume.

## Testability

Every step below is verifiable, which is the point of splitting them this way.

- **Planner** — pure, so table-driven unit tests: hot set boundary, `keep=0`
  (unlimited) unchanged, unknown sizes never evicted, pressure escalation order,
  oldest-first ordering. No filesystem.
- **Strip primitive** — fixture repositories: an ignored `node_modules` is removed;
  a **tracked** `dist` is not; an allowlisted name that is not ignored is not; a
  non-allowlisted ignored path (`.env`) is not, which is what proves both conditions
  are load-bearing rather than one implying the other; `check-ignore` unavailable
  removes nothing. This is the regression suite that matters most.
- **`git check-ignore` must be invoked WITHOUT `--no-index`** — its own regression
  test, with the tracked-`dist` fixture as the proof. Measured on a fixture repo
  with `dist/` in `.gitignore` and `dist/foo.js` force-added: `git check-ignore -q
  dist` exits **1** (not ignored → protected), while `git check-ignore -q --no-index
  dist` exits **0** (ignored → the path would be deleted). The entire safety argument
  rests on consulting the index, i.e. on a default that a future refactor could
  plausibly "optimize" away, so the prohibition needs a test and not just a sentence.
- **Rung ordering** — derived output is stripped outside the hot set without
  pressure; dependency trees are stripped only under pressure; `keep = 0` strips
  nothing at all.
- **Store** — a `runs.json` written before these fields still parses and its runs
  survive (the `safeParse` contract).
- **Enforcer** — sizes are measured once and reused; a stripped worktree is
  re-stamped; degradation when `statfs`/`du` fail.
- **API/panel** — additive fields present; existing consumers unaffected.

## Phasing

Two independently shippable phases. Phase 1 delivers the whole disk win headlessly;
Phase 2 makes it visible and manually driveable.

- **Phase 1 — the strip rung and the planner.** Ships the behavior.
- **Phase 2 — panel surfacing and the manual action.** Ships the explanation.

## Implementation Plan

### Phase 1: strip rung + planner

1. Add `stripWorktreeArtifacts()` to `packages/cezar/src/git-worktree.ts` with the
   two-condition safety rule and bounded candidate discovery. Tests: the fixture
   matrix above, including the tracked-`dist` and `.env` negatives. *App works: new
   function, no caller yet.*
2. Add the optional `worktreeSizeBytes` / `worktreeStrippedAt` fields to the
   `RunRecord` schema in `packages/cezar/src/runs/store.ts`, and record the addition
   in `BACKWARD_COMPATIBILITY.md` §3 following the `#737`/`#751` precedent. Test:
   a pre-existing `runs.json` still parses with every run intact. *App works: fields
   unwritten.*
3. Add `planWorktreeRetention()` to `packages/cezar/src/runs/retention.ts` with
   injected sizes, and re-express `selectReclaimableWorktrees` as a wrapper over its
   `reclaim` output. Tests: the pure table-driven set; existing retention tests must
   pass untouched. *App works: planner unused, wrapper preserves behavior.*
4. Add free-space sampling (`fs.statfs`, `DISK_FLOOR`) with count-only degradation
   when unavailable. Test: pressure computed correctly; failure degrades. *App
   works: value unused.*
5. **Funnel both enforcement call sites through one entry point**, changing no
   behavior: `enforceRetention` (`workflows/run.ts:1502`) and the direct
   `reclaimWorktrees(repoRoot, store, keep)` call at boot (`index.ts:238`). Test:
   both paths reach the same function and today's outcomes are unchanged. *App
   works: pure refactor — and it is what stops step 6 from silently skipping boot.*
6. Wire that single entry point to the planner: lazily measure and persist the size
   of any finished run that has none, then apply strip and reclaim. Tests: a
   pre-existing finished run with no recorded size is measured exactly once; sizes
   are not re-measured on later passes; strip precedes reclaim; the hot set is
   untouched; `keep = 0` does nothing; an unrelievable deficit strips without
   reclaiming. *App works — this is the step that turns the behavior on.*

### Phase 2: panel surfacing + manual strip

7. Extend `GET /worktrees` (`server.ts:4382`) with `strippedAt` and `rung`, leaving
   every existing field and the `totalBytes: null` degradation intact. Test: additive
   shape; existing consumers unaffected. *App works.*
8. Add `POST /worktrees/strip`. Test: strips outside the hot set, reports freed
   bytes, is idempotent, and is safe when it overlaps a retention pass. *App works.*
9. Surface the rung per row, the reclaimable-artifact summary, and the "Strip
   artifacts now" action in `worktrees-panel.tsx`, reusing the existing confirm
   dialog. Test: component tests for each state, including the disk-pressure and
   unrelievable-pressure notices. *App works.*
