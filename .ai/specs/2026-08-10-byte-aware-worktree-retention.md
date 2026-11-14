# Byte-aware Worktree Retention (#842)

## TLDR

Count-based worktree retention (#483) is working as designed and still misses its
own stated goal on build-heavy repositories: a project sitting **exactly inside**
`keep=10` held **17 GB**, of which 99.8% was regenerable build output. Value and
cost live in disjoint file sets — the checkout is 7 MB, the `.build`/`DerivedData`
trees beside it are 2.9 GB — and a count budget can only evict both at once. This
spec adds a **strip** rung between "keep" and "reclaim": delete the locally
regenerable build output, keep the checkout.

**Phase 1 ships the strip rung on recency alone.** The entire measured win —
17 GB → ≈ 5.2 GB — comes from stripping derived output outside a hot set of three,
with no byte accounting whatsoever. The byte dimension the title promises
(free-space sampling, disk-pressure escalation, stripping dependency trees) is
specified in **Phase 3 and deliberately deferred** until Phase 1 has been
re-measured on the same machines — see Q5. What lands first is the half that fixes
the measured problem, on the smallest possible blast radius over a delete path.

## Resolved assumptions (autonomous defaults)

This spec was written by `om-spec-writing --autonomous`; the Open Questions gate was
resolved with the defaults below rather than stopping. Each is reversible and meant
to be overridden by a human before merge.

| # | Question | Default chosen | Rationale |
|---|---|---|---|
| Q1 | What is the "hot" set that keeps its build cache? | **The 3 most recently finished worktrees *per project*** — internal constant `HOT_KEEP = 3`, not a setting. Per project, matching `keep`, which is already resolved per repo root by `resolveWorktreeRetention(repoRoot)`. | `AGENTS.md` Zero config: "When a feature seems to need configuration, the design is wrong. Discover it, or default it." Three covers the realistic resume window (the task you just finished, plus the two you might bounce back to) without holding a fleet of caches. |
| Q2 | How is the byte budget expressed — a `maxBytes` setting, or discovered? | **Neither, in Phase 1** (there is no byte budget at all). When Phase 3 lands it is **discovered from free disk space** against a flat `DISK_FLOOR` constant; no new config key in any phase. | Zero config: "Never trade a working default for a knob." A byte ceiling is a number nobody can pick correctly — it depends on the machine, not the repo. Free space is the quantity the failure mode is actually about ("the disk fills"), and it is already knowable. Deferring it per Q5 means Phase 1 adds no config surface *and* no sampling surface. |
| Q3 | Is the artifact allowlist configurable per project? | **No** — an internal constant, extended by PR when a new toolchain appears | Same law. A per-project allowlist is a footgun pointed at a delete path: a typo becomes data loss. The `git check-ignore` half of the safety rule already adapts the behavior per repository without anyone authoring anything. |
| Q4 | Is strip on by default in its first release? | **Yes, on by default** — ⚠ **NEEDS HUMAN CONFIRMATION** | The Zero config law forbids shipping this behind an opt-in flag ("never trade a working default for a knob"), but `AGENTS.md` → "Changing a mechanism that already works" warns that exactly this kind of change leaves the zero-config user quietly worse off (#810/#811 are the named worked examples). What today's behavior is load-bearing **for** is warm build caches on recently finished tasks, and `HOT_KEEP` is what preserves it. The two laws pull in opposite directions here, the surface is `risk-high`, and every user is affected silently — so a maintainer should sign this off rather than an autonomous default. **Q5 shrinks what is being signed off:** with dependency trees deferred, the default-on behavior is "rebuild from CPU", never "re-download from a registry". |
| Q5 | Does the byte dimension ship in the first release? | **No — deferred to Phase 3**, gated on re-measuring Phase 1 on the same four projects | The projection in Problem Statement is `3 × 1.7 GB + 7 × 7 MB`: every byte of the measured win comes from stripping derived output on recency. `pressureBytes`, `DISK_FLOOR`, `fs.statfs`, the escalation loop, persisted sizes and their backfill would all serve a rung that frees **nothing** in the case this document was written about, and they would add a cold `du` to the boot path. A backstop that has not been observed to fire is YAGNI. The counter-argument is real and recorded: on a JS repo the dependency trees *are* the bulk (tronbalance-web holds 816 MB, mostly `node_modules`), so Phase 3 is not pointless — it is unmeasured, and the Acceptance Criteria below turn Phase 1's re-measurement into its go/no-go input. Overridable: a maintainer who wants the byte dimension in release one can flip this, at the cost of the surface Phase 3 enumerates. |

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
nothing eviction happen *sooner*. The granularity is the defect, not the threshold —
which is also why Phase 1 needs no byte accounting to collect the whole measured win.

This is not a defect report against #483 — that policy does exactly what it says.
It is a report that the eviction unit is too coarse.

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
  toolchain-agnostic equivalent. Note what they *do not* do: none of them consults
  free disk space before cleaning. Recency and an explicit request are enough.
- **CI runners** — cache the build directory separately from the checkout precisely
  because the two have different lifetimes and different replacement costs.

What they get right that this spec adopts: a regenerable tier is worth evicting
long before the irreplaceable tier. What they carry that this spec skips: a
content-addressed cache index and cross-worktree cache sharing — large machinery for
a pool that is at most a few dozen directories, and one that would put cezar in the
business of understanding each toolchain's cache format.

What none of them do, and what makes the naive local approach dangerous:
`git clean -xdf` is the obvious one-liner and it is **wrong** — it deletes ignored
files indiscriminately, including `.env` files and local credentials. That is a
data-loss incident, not a cleanup, and it is the failure mode the safety rule below
is designed around.

## Proposed Solution

A ladder replaces today's binary threshold. **Phase 1 ships rung 1 and nothing else.**

| Rung | What is removed | What survives | Resume path | Phase |
|---|---|---|---|---|
| **1. Strip — derived output** *(new)* | `.build`, `DerivedData`, `target`, `dist`, `.next`, `.gradle`, `.turbo` | checkout + `.git` metadata | none needed — `run.ts:2111` still finds a real path; the agent rebuilds from CPU alone | **1** |
| **1b. Strip — dependency trees** *(pressure-only)* | `node_modules`, `.venv` | checkout + `.git` metadata | rebuild **may need network** and a warm package-manager cache | **3** |
| **2. Reclaim** *(today)* | the whole directory | the `cez/<id8>` branch | `rematerializeReclaimedWorktree` | shipped |
| **3. Delete** *(today, manual)* | directory + branch | nothing | none | shipped |

Placement on the ladder is decided by **recency and count only**:

- **`keep = 0` disables every rung.** That setting means *"do not manage my
  worktrees"*, not *"do not delete my directories"* — see Edge Cases.
- The `HOT_KEEP` (3) most recently finished worktrees **of that project** are
  untouched — warm caches, instant resume.
- Everything else that is finished has its **derived output** stripped.
- Beyond `keep` (the existing count budget, unchanged) worktrees are **reclaimed**,
  exactly as today. Strip runs before reclaim in the same pass; a worktree that is
  about to be reclaimed is not stripped first.

Projected on the measured machine: cezar-app becomes roughly `3 × 1.7 GB + 7 × 7 MB`
≈ **5.2 GB instead of 17 GB, with all ten worktrees still browsable** — and that
projection uses rung 1 alone, which is the whole argument for Q5.

The important second-order effect is the same one that justified the byte dimension
and now justifies deferring it: once strip is doing this work, disk pressure stops
binding in normal operation. A control that a working Phase 1 is expected to keep
idle is a backstop, and a backstop should be specified against a measured number
rather than a projected one.

### The strip safety rule

This is the part of the design that most deserves review, because it is a delete
path over user data.

A path is removed **only when both conditions hold**:

1. its basename is on the internal artifact allowlist. Phase 1 ships **one tier**:
   - **derived output** — `.build`, `DerivedData`, `target`, `dist`, `.next`,
     `.gradle`, `.turbo`: rebuilt locally from CPU alone.

   The **dependency tree** tier (`node_modules`, `.venv`) is defined in Phase 3 and
   is **not in the Phase 1 allowlist at all** — not gated behind a flag, absent. A
   tier that cannot fire in release one must not be present in a delete path's
   constant, where it would be one condition away from firing;

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
in this codebase — `packages/cezar/src/agent-config/seed.ts:80` re-checks a
by-convention "gitignored" label against it before trusting it (`catalog.ts:24`).
This spec reuses that mechanism rather than inventing a parallel one.

Explicitly rejected: `git clean -xdf` / `-Xdf`, in any form. Both delete ignored
files wholesale, which includes `.env` and local credentials.

### Candidate discovery: the walk, stated as a rule

"Bounded discovery" is a goal, not a rule, and the difference decides whether the
feature works on a workspace repo at all. The rule is:

1. Walk directories from the worktree root. The root's children are **depth 1**.
2. **Prune on match.** A directory whose basename is on the allowlist is a
   candidate, at any depth; the walk **never descends into it**. This is what makes
   the walk cheap rather than a traversal of a 2.9 GB tree — the gigabytes live
   *inside* the allowlisted directories, so pruning on match means only source
   directories are ever visited.
3. **Never descend into** `.git`, or into any symlink. Any resolved path that
   escapes the worktree root is refused outright.
4. **Hard depth cap: 4.** A backstop against pathological trees, not the primary
   bound — rule 2 is. Four is chosen from real layouts rather than taste; see below.

A depth-1 or root-only implementation is the failure this rule exists to forbid.
cezar's own checkout — the spec's own worked example — holds, right now:

```
node_modules                      depth 1   (Phase 3 tier)
packages/cezar/node_modules       depth 2   (Phase 3 tier)
packages/cezar/dist               depth 2   ← Phase 1 candidate
packages/cezar/web/dist           depth 3   ← Phase 1 candidate
```

A root-level scan finds neither `dist`. Every npm/yarn workspace, every Cargo
workspace and every Gradle multi-project build has this shape, so the nested case is
the normal case, not an exotic one. Depth 4 covers all of them with one level of
headroom; a layout that buries derived output deeper is out of scope for Phase 1 and
is a Phase 3 input, not a silent miss — see Observability.

The Testability fixture matrix carries a **nested-workspace fixture**
(`packages/a/dist`, `packages/a/web/dist`) precisely so that a depth-1 implementation
fails the suite instead of passing it green.

### Eviction order: oldest first, not largest first

Largest-first would free bytes faster and is deliberately **not** chosen. It is
unpredictable in the way that matters: you would lose the one heavy Swift task while
ten trivial JS ones survive, and the rung a worktree lands on would depend on its
toolchain rather than on when you last cared about it. Recency is the property the
user can reason about. Phase 1 has no byte accounting at all, so this is not merely
the preferred ordering — it is the only ordering available, and Phase 3 must not
quietly replace it.

### What Phase 3 would add, and the trap it must avoid

Recorded here so that deferring it does not also lose what the design already
learned. Nothing in this section ships in Phase 1.

Phase 3 samples free space on the volume holding `.ai/cezar/worktrees` (`fs.statfs`;
this repo requires Node ≥ 20, `package.json:8`), derives `pressureBytes` against a
**flat 10 GiB `DISK_FLOOR`**, and unlocks the dependency-tree tier plus a
pressure-driven escalation loop.

`DISK_FLOOR` must stay **flat**. An earlier draft used `max(10 GB, 10% of the
volume)` and that is wrong in a way worth preserving: the percentage term dominates
on exactly the machines it was not written for: a 4 TB volume with a comfortable
300 GB free sits under a 400 GB floor, so the pass is permanently under pressure and
the escalation loop runs to its "nothing reclaimable is left" exit — emptying the
pool on every pass regardless of `keep`. A backstop does not scale with the volume.

The escalation loop would need **three** exit conditions, not two: free space clears
the floor; nothing reclaimable is left; or **the deficit is unrelievable** —
reclaiming everything outside the hot set still would not clear the floor, in which
case the pass strips only, reports the condition and reclaims nothing. Retention must
never delete on account of a deficit it cannot fix.

Phase 3 also needs persisted sizes to stay O(1) per pass, and therefore a lazy
backfill for runs that finished before it ships. **That backfill is the reason Phase
3 must not be bolted onto the boot path** — see Architecture: a cold `du` over every
unmeasured worktree is 17 GB of walking on the machine in the Problem Statement. The
entry point Phase 1 establishes already runs off the critical path, which is what
makes Phase 3 safe to add later.

## Architecture

One pure decision, one impure enforcer, one new I/O primitive. The existing split is
preserved: `retention.ts:1-6` states that the selector is pure and unit-testable, and
sizes are I/O.

### `packages/cezar/src/runs/retention.ts` — the planner (pure)

`selectReclaimableWorktrees` is superseded by a planner that returns both rungs:

```ts
export interface RetentionBudget {
  /** Most-recently-finished worktrees left untouched. Internal constant. */
  hotKeep: number;
  /** Existing count budget. 0 = unlimited, unchanged. */
  keep: number;
}

export function planWorktreeRetention(
  runs: readonly RunRecord[],
  budget: RetentionBudget,
): { strip: string[]; reclaim: string[] };
```

No sizes, no filesystem, no clock — the plan is a function of the run list and two
integers, which is as testable as this gets. (Phase 3 would add `pressureBytes` to
the budget and an injected `sizes` map; the signature is shaped so that addition is
additive.)

`selectReclaimableWorktrees` is kept as a thin wrapper over the planner's `reclaim`
output so existing callers and tests keep working.

### `packages/cezar/src/git-worktree.ts` — the strip primitive (I/O)

```ts
export async function stripWorktreeArtifacts(
  worktreePath: string,
): Promise<{ removed: string[]; freedBytes: number; guardUnavailable: boolean }>;
```

Applies the discovery rule, then both safety conditions, then removes what passes.
`removed` holds worktree-relative paths and `freedBytes` the total actually freed, so
the caller can log what it did without re-walking. `guardUnavailable` is true when
`git check-ignore` could not be run at all — the closed-failure branch, which is
otherwise indistinguishable from "nothing to strip" and must not be silent.
Best-effort and never throws, matching `removeWorktree`'s existing discipline
(`packages/cezar/src/git-worktree.ts:239`).

### The enforcer — its two call sites, and the boot ordering

Retention is enforced from **two** places today, and they do not share an entry point:

- `enforceRetention` (`packages/cezar/src/workflows/run.ts:1502`), behind the
  terminal-transition hook at `run.ts:1170`, already fire-and-forget (`void`), with
  the comment stating retention must never delay the lifecycle; and
- **boot**, which calls `reclaimWorktrees(repoRoot, store, keep)` **directly and
  `await`s it** at `packages/cezar/src/index.ts:238`, inside `serveCommand`, under a
  comment reading *"Best-effort; never blocks boot."* — and **before**
  `startServer(...)` at `index.ts:276` binds the port.

Wiring only the first would leave a restarted cezar applying the old count-only
behavior at boot, which is the common case on a laptop. So **both call sites are
funnelled through one entry point** (plan step 4), and that entry point has one
further requirement:

**The boot pass runs off the critical path.** The awaited call at `index.ts:238`
becomes a fire-and-forget pass scheduled *after* the server binds, mirroring
`run.ts:1170`. Today's `await` is cheap because `reclaimWorktrees` does no sizing;
strip is not free (an `rm -rf` over 1.7 GB is seconds, not milliseconds) and Phase 3's
backfill would be far worse. Putting retention in front of the port contradicts the
comment that is already written above it, and cezar's whole value is being instantly
there.

The visible consequence, stated rather than discovered: the existing
`reclaimed N old worktree(s)` line, and the new stripped line beside it, are printed
when the pass finishes — which may now be after the listening banner rather than
before it. That reordering is the intended trade and the boot-ordering test pins it.

**No sizing in Phase 1.** The planner needs no sizes, so the enforcer measures
nothing: no `du`, no persisted `worktreeSizeBytes`, no backfill. `freedBytes` comes
back from the strip primitive as a by-product of removal, for logging only.

### Observability

The defining risk of this rung is "removing the wrong path destroys unrecoverable
user data", and a log naming what was deleted is the cheapest possible trust
mechanism. Beside the existing boot line, the pass emits:

- one line per stripped worktree naming the removed paths and the bytes freed —
  e.g. `stripped e21c070e: .build, packages/cezar/web/dist (1.7 GB)`;
- a pass summary in the shape of the existing one — `stripped N worktree(s), freed
  X GB`, suppressed when N is 0;
- one line when a pass stripped nothing because `guardUnavailable` was true, so a
  feature that has silently degraded to a no-op is diagnosable rather than
  indistinguishable from a clean machine.

`POST /worktrees/strip` returns the same information in its response body, so the
panel and the log agree.

## Data Model

**One** additive, optional field, and it must land in **two** files in lockstep.

| Field | Type | Meaning |
|---|---|---|
| `worktreeStrippedAt` | `string` (optional) | ISO stamp; set when the strip rung completed for that worktree. Absent = never stripped. |

- **Persistence:** `RunRecord` in `packages/cezar/src/runs/store.ts` (beside
  `worktreeReclaimedAt` at `store.ts:260`).
- **Wire twin:** `runRecordSchema` in `packages/contract/src/runs.ts` (beside
  `worktreeReclaimedAt` at `runs.ts:232`).

These are not alternatives. `packages/cezar/src/server/contract-parity.runs.test.ts`
asserts `Exact<z.infer<typeof runRecordSchema>, RunPatch200>` and four siblings
(`:77-82`); adding the field to the store alone turns `npm run typecheck` red, and
adding it to the contract alone means the persisted record never carries it.
`worktreeReclaimedAt` — this feature's direct precedent — lives in both, which is the
pattern to follow.

`BACKWARD_COMPATIBILITY.md` §3 is explicit that a **required** new field silently
drops every pre-existing run, because the loader `safeParse`s the whole array; this
field is optional and follows the documented `#737` / `#751` precedent, and the
addition gets its own entry in that section as part of the work.

**`worktreeSizeBytes` is deliberately not added.** Q5 defers the only consumer of a
persisted size, and adding an unread field to a protected state-file surface is
exactly the kind of speculative shape §3 exists to discourage. It arrives with
Phase 3, which is also when the size question below has a real answer.

**One source of truth for size, in Phase 1.** `GET /worktrees` continues to compute
`sizeBytes` live per row (`server.ts:4395`) and there is nothing persisted to
disagree with it — a stripped worktree simply reports a smaller live number, which is
the correct answer. Phase 3 introduces a second source and owes a reconciliation rule
then: live for display, persisted for planning, panel prefers live.

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
cezar keeps its hands off. Under this spec **`keep = 0` disables the strip rung
too**, not just reclaim. Someone who set it is asking cezar not to manage their
worktrees at all, and silently removing their build trees would honor the letter of
the setting while breaking its meaning.

## API Contracts

Purely additive; no existing field changes shape or meaning. Since #695
(`b47d507b`, 2026-07-27) split this repo into `packages/{contract,api-client,cezar,web}`,
each route change is a lockstep edit across schema, handler, typed client and panel,
with type-level `Exact<>` parity assertions enforcing it at `npm run typecheck`.

**`GET /worktrees`** — each row gains **`strippedAt: string | null`** and nothing
else. Touches, in lockstep:

- `worktreeInfoSchema` (`packages/contract/src/repo.ts:168`), inside
  `worktreesResponseSchema` (`repo.ts:181`);
- the handler at `packages/cezar/src/server/server.ts:4382`;
- the typed accessor `getWorktrees` (`packages/web/src/api/client.ts:1763`);
- the panel.

Pinned by `Assert<Exact<z.infer<typeof worktreesResponseSchema>, Worktrees200>>`
(`contract-parity.github.test.ts:113`). `sizeBytes`, `totalBytes`, `keep` and
`reclaimable` are unchanged, including the `totalBytes: null` degradation
(`server.ts:4401`).

**No `rung` enum.** An earlier draft added `rung: 'hot' | 'stripped' | 'reclaimable'`
beside the existing `reclaimable: boolean` (`server.ts:4397`, `repo.ts:175`), which
already means *finished, has a directory, not yet reclaimed*. Two adjacent fields
where one word means "eligible under the count rule" and the same word means "the
rung it currently sits on" is a bug waiting to happen in the panel and a poor shape
to freeze onto a protected surface. The panel derives what it displays from
`strippedAt` plus the existing `reclaimable`, and the wire stays one field smaller.

**`POST /worktrees/strip`** — the manual counterpart to the existing reclaim-now
action; strips every finished worktree outside the hot set. Answers
`{ stripped: string[], freedBytes: number }`. It requires:

- a response schema beside `reclaimWorktreesResponseSchema`
  (`packages/contract/src/repo.ts:189`) and its own parity assertion in
  `contract-parity.github.test.ts`;
- a body validator following the reclaim route's pattern —
  `jsonZodValidator(() => reclaimBodySchema, { absent: ({}), message: 'invalid body' })`
  (`server.ts:4407`, schema at `server.ts:4415`);
- a typed accessor beside `reclaimWorktrees` (`packages/web/src/api/client.ts:1775`);
- an entry in the `BACKWARD_COMPATIBILITY.md` §2 route list — line 47,
  `Worktrees: GET /api/v1/worktrees, POST /api/v1/worktrees/reclaim` — which is
  machine-enforced by `packages/cezar/src/server/bc-route-inventory.test.ts`. A route
  absent from that prose list fails the drift guard.

Route **aliasing is free** and needs no attention: `worktreesRoutes` is a chained
sub-app (`server.ts:4381`, mounted at `:5208`), so `projectRouteManifest`
(`server.ts:408`) picks a new registration up and the alias-parity suite covers it.
Worth stating because it is the part of this that looks like it should need work.

It is idempotent, and safe when it overlaps a retention pass triggered by a terminal
transition (`run.ts:1170`) while the panel is open: both actors target the same
regenerable set, so a double removal is a no-op rather than a conflict, and neither
can remove what the other still needs.

**`GET/PUT /api/v1/workspace/config`** — **unchanged**. A direct consequence of Q2
and Q5: with no byte budget in Phase 1 and a discovered one thereafter, the protected
`resources` shape is never touched.

## UI/UX

The Worktrees panel (`packages/web/src/routes/settings/worktrees-panel.tsx`) already
renders per-row `sizeBytes` and a `totalBytes` summary, and already carries a
"Reclaim now" button — the information was never missing, only unused by the policy.

- A stripped row (`strippedAt` set) reads as **"checkout only"** rather than looking
  like a suspiciously small worktree, with the stamp as its title.
- A **"Strip artifacts now"** button sits beside "Reclaim now", with the same
  confirm-dialog pattern, worded so the distinction is unmistakable: stripping keeps
  the worktree and loses only rebuildable output.
- After the action, the panel reports what the route returned — *"stripped 7
  worktrees, freed 12 GB"* — the number that makes the rung self-explanatory.

Accessibility and states follow the panel's existing conventions; nothing here is
novel enough to re-specify.

## Edge Cases & Failure Scenarios

| Scenario | Behavior |
|---|---|
| **`keep = 0`** (user opted out of management) | **Every rung is disabled** — no strip, no reclaim. The setting means "do not manage my worktrees"; honoring it only for directory removal would break its meaning while satisfying its letter. |
| `git check-ignore` unavailable or errors | Condition 2 cannot be satisfied → **nothing is stripped**, and `guardUnavailable` makes the pass say so once. Failure is closed, never open. |
| Repository tracks an allowlisted directory (`dist/`) | Condition 2 fails → untouched. No configuration required. |
| Workspace repo with `packages/*/dist` | Found: the walk prunes on match rather than stopping at depth 1, up to the depth-4 cap. This is the normal case, and the nested fixture enforces it. |
| Derived output nested deeper than depth 4 | Not stripped, and not silently: the worktree simply keeps its artifacts. Out of scope for Phase 1; a real layout that needs it is a Phase 3 input. |
| Symlink inside a candidate path | Never followed; resolved paths outside the worktree root are refused. |
| Run resumes after a strip | Directory exists, so `cwd` resolution at `run.ts:2111` finds it; the agent rebuilds from CPU. No re-materialization, no repo-root fallback, no network. |
| Strip races a resuming run | Strip only ever targets runs in the finished set; a run leaving that set before the pass is skipped. Partial removal is safe — every target is regenerable by definition. |
| Strip partially fails (permissions, file lock) | Best-effort: what was removed stays removed, `worktreeStrippedAt` is stamped only when the pass completed, so the next pass retries. Same shape as the existing reclaim stamp discipline (`retention.ts:121`). |
| Disk already full when the pass runs | Order is strip-then-reclaim; strip needs no free space to proceed. |
| A worktree is both outside `keep` and outside the hot set | It is reclaimed, not stripped-then-reclaimed. Stripping a directory that is about to be removed wholesale is wasted I/O. |
| Boot pass still running when the first request arrives | Expected: the pass no longer precedes `listen`. `GET /worktrees` may briefly show a row whose artifacts are being removed; `sizeBytes` is live and self-corrects on the next poll. |
| `du` fails for a worktree | Only affects the panel's live `sizeBytes` (`totalBytes: null`, existing contract). The Phase 1 planner never reads sizes, so it cannot be misled by one. |

## Acceptance Criteria

The problem statement is a measurement, so the acceptance criterion is the same
measurement repeated.

1. **The measured win.** On the same machine and the same four projects, after Phase 1
   has run: cezar-app's 10 finished worktrees total **≤ 6.5 GB** (from 17 GB), and all
   ten remain browsable and resumable. Failing this, Phase 1 has not delivered.
2. **Nothing else was deleted.** Across the fixture matrix, no path that
   `git check-ignore` does not confirm as ignored is ever removed — proven by tests,
   not by the absence of complaints.
3. **Boot is not slower.** `cezar serve` binds its port with no retention work
   awaited before `startServer`; pinned by the boot-ordering test.
4. **Phase 3's go/no-go input.** The same re-measurement records the post-strip total
   for the JS projects, where the residual is mostly `node_modules` (tronbalance-web:
   816 MB before). That number, against the machine's free space, decides whether
   Phase 3 is built at all — which is what makes Q5 a deferral rather than a guess.

## Risks & Impact Review

**Risk: `risk-high`**, by this repository's own inference rules. `SDLC.md:59` names
*worktree/branch handling* and *the `.ai/cezar/` state file formats* as risk-high
surfaces; this change touches both. (This spec PR itself is `risk-low` — it ships a
document.)

- **Blast radius — the delete path.** Removing the wrong path destroys unrecoverable
  user data. This is the reason for two independent conditions rather than one, for
  the closed-failure behavior when `check-ignore` is unavailable, for the explicit
  rejection of `git clean`, and for keeping the dependency-tier names out of the
  Phase 1 constant entirely. It is the part of this spec that most deserves
  adversarial review.
- **Blast radius — behavior change.** Q4 ships strip on by default. Resuming a task
  outside the hot set will rebuild where it previously did not. `HOT_KEEP` keeps the
  common case unchanged, and Q5 bounds the worst case to a local rebuild — never a
  registry fetch. Flagged for human confirmation.
- **Compatibility.** One additive optional `RunRecord` field, in both the store and
  the contract, per `BACKWARD_COMPATIBILITY.md` §3. API changes are additive, with
  the new route added to the §2 inventory. No config keys are added, renamed, or
  re-defaulted.
- **Rollback.** Disabling the strip rung restores today's behavior exactly — the
  persisted stamp becomes inert and is ignored, not migrated away. Already-stripped
  worktrees are not "rolled back": they rebuild, which is the definition of the tier.
  Reclaim behavior is untouched throughout, so a revert cannot strand a worktree in an
  unrecognized state. The boot reordering reverts independently of the rung.
- **Merge risk.** Re-check at implementation time what is in flight over
  `packages/cezar/src/git-worktree.ts`, `packages/cezar/src/server/server.ts` and the
  contract package; #747, cited in an earlier draft, is **closed** and no longer
  relevant. The contract/parity lockstep in API Contracts is the more likely source of
  conflict than any single PR.

## Testability

Every step below is verifiable, which is the point of splitting them this way.

- **Planner** — pure, so table-driven unit tests: hot set boundary, `keep = 0` does
  nothing at all, `keep` unlimited semantics unchanged, oldest-first ordering, a
  worktree past both budgets is reclaimed rather than stripped. No filesystem, no
  sizes, no clock.
- **Strip primitive — the fixture matrix.** An ignored `dist` is removed; a
  **tracked** `dist` is not; an allowlisted name that is not ignored is not; a
  non-allowlisted ignored path (`.env`) is not, which is what proves both conditions
  are load-bearing rather than one implying the other; `check-ignore` unavailable
  removes nothing and reports `guardUnavailable`; `node_modules` — Phase 3's tier — is
  **not** removed in Phase 1 even when ignored.
- **Nested-workspace fixture** — `packages/a/dist` (depth 2) and `packages/a/web/dist`
  (depth 3) are both found and removed, and a `.git` directory and a symlink pointing
  outside the worktree are not traversed. A depth-1 implementation fails this test;
  that is its whole purpose.
- **`git check-ignore` must be invoked WITHOUT `--no-index`** — its own regression
  test, with the tracked-`dist` fixture as the proof. Measured on a fixture repo with
  `dist/` in `.gitignore` and `dist/foo.js` force-added: `git check-ignore -q dist`
  exits **1** (not ignored → protected), while `git check-ignore -q --no-index dist`
  exits **0** (ignored → the path would be deleted). The entire safety argument rests
  on consulting the index, i.e. on a default that a future refactor could plausibly
  "optimize" away, so the prohibition needs a test and not just a sentence.
- **Store and contract** — a `runs.json` written before this field still parses and
  its runs survive (the `safeParse` contract); `contract-parity.runs.test.ts` stays
  green, which it only does if both halves of the field landed.
- **Enforcer** — both call sites reach the one entry point; strip precedes reclaim;
  the hot set is untouched; `keep = 0` does nothing; the stamp is written only on a
  completed pass.
- **Boot ordering** — `serveCommand` binds the port without awaiting a retention pass;
  the reclaim/strip log lines still appear.
- **API/panel** — additive shape, parity assertions, the new route present in the §2
  inventory (`bc-route-inventory.test.ts`), existing consumers unaffected.

## Phasing

Three phases, each independently shippable, the third conditional.

- **Phase 1 — the strip rung and the planner.** Ships the entire measured win.
- **Phase 2 — panel surfacing and the manual action.** Ships the explanation.
- **Phase 3 — the byte dimension** (`fs.statfs`, `DISK_FLOOR`, `pressureBytes`, the
  escalation loop, persisted sizes with lazy backfill, and the dependency-tree tier),
  specified against Phase 1's re-measurement per Q5 and the Acceptance Criteria. Not
  scoped here beyond the constraints recorded above.

## Implementation Plan

### Phase 1: strip rung + planner

1. Add `stripWorktreeArtifacts()` to `packages/cezar/src/git-worktree.ts` with the
   discovery rule (prune on match, no `.git`, no symlinks, depth cap 4), the
   two-condition safety rule, and the derived-output allowlist only. Tests: the full
   fixture matrix, the nested-workspace fixture, the tracked-`dist` and `.env`
   negatives, the `--no-index` prohibition, and `node_modules` surviving. *App works:
   new function, no caller yet.*
2. Add the optional `worktreeStrippedAt` field to **both** `RunRecord` in
   `packages/cezar/src/runs/store.ts` and `runRecordSchema` in
   `packages/contract/src/runs.ts`, beside `worktreeReclaimedAt` in each, and record
   the addition in `BACKWARD_COMPATIBILITY.md` §3 following the `#737`/`#751`
   precedent. Tests: a pre-existing `runs.json` still parses with every run intact;
   `contract-parity.runs.test.ts` green (it is red if either half is missed). *App
   works: field unwritten.*
3. Add `planWorktreeRetention()` to `packages/cezar/src/runs/retention.ts` and
   re-express `selectReclaimableWorktrees` as a wrapper over its `reclaim` output.
   Tests: the pure table-driven set; existing retention tests must pass untouched.
   *App works: planner unused, wrapper preserves behavior.*
4. **Funnel both enforcement call sites through one entry point, and move the boot
   pass off the critical path**: `enforceRetention`
   (`packages/cezar/src/workflows/run.ts:1502`) and the direct
   `reclaimWorktrees(repoRoot, store, keep)` at `packages/cezar/src/index.ts:238`,
   which becomes a fire-and-forget pass scheduled after `startServer` (`index.ts:276`)
   binds. Tests: both paths reach the same function; today's outcomes are unchanged;
   the boot-ordering test pins that nothing retention-related is awaited before the
   port. *App works: behavior-preserving refactor — and it is what stops step 5 from
   silently skipping boot or delaying it.*
5. Wire that entry point to the planner and the strip primitive, stamp
   `worktreeStrippedAt`, and emit the log lines from Observability. Tests: strip
   precedes reclaim; the hot set is untouched; `keep = 0` does nothing; a worktree past
   both budgets is reclaimed rather than stripped; `guardUnavailable` is reported.
   *App works — this is the step that turns the behavior on.*

### Phase 2: panel surfacing + manual strip

6. Extend `GET /worktrees` with `strippedAt`, in lockstep across
   `packages/contract/src/repo.ts` (`worktreeInfoSchema`), the handler at
   `packages/cezar/src/server/server.ts:4382`, and the typed accessor `getWorktrees`
   (`packages/web/src/api/client.ts:1763`). Test: additive shape; parity assertion at
   `contract-parity.github.test.ts:113` green; the `totalBytes: null` degradation
   intact. *App works.*
7. Add `POST /worktrees/strip`: response schema beside
   `reclaimWorktreesResponseSchema` (`repo.ts:189`) with its parity assertion, the
   `jsonZodValidator(() => reclaimBodySchema, …)` body pattern (`server.ts:4407`), the
   typed accessor beside `reclaimWorktrees` (`client.ts:1775`), and the route added to
   the `BACKWARD_COMPATIBILITY.md` §2 list at line 47. Tests: strips outside the hot
   set, reports freed bytes, is idempotent, is safe when it overlaps a retention pass,
   and `bc-route-inventory.test.ts` is green. *App works.*
8. Surface the stripped state per row and the "Strip artifacts now" action in
   `packages/web/src/routes/settings/worktrees-panel.tsx`, reusing the existing confirm
   dialog, deriving display from `strippedAt` + the existing `reclaimable`. Test:
   component tests for each state. *App works.*

### Phase 3: the byte dimension — conditional, specified separately

Deferred by Q5, gated on Acceptance Criterion 4. Not planned here; the constraints it
must honor (flat `DISK_FLOOR`, three escalation exits, backfill off the boot path,
oldest-first ordering preserved, dependency tier added to the allowlist only then) are
recorded above so they are not rediscovered.
