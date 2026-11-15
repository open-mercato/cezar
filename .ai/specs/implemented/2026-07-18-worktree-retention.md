# Worktree Retention & Management (#483)

## TLDR

cezar leaves one git worktree per task under `.ai/cezar/worktrees/<runId>` and
only reclaims it on startup-orphan prune, a lost variant, or an explicit
delete. Every finished run keeps its worktree — a full checked-out copy of the
repo — indefinitely, so a busy cockpit slowly saturates the disk. This spec
adds an always-on, count-based **retention policy** (keep the last *N* finished
worktrees; reclaim the directory of the rest while keeping their `cez/<id8>`
branch so work stays recoverable), with a zero-config default of 10 and an
optional override in Settings → Resources, plus a management panel to see
per-worktree disk use and reclaim on demand.

## Problem Statement

Each task runs in its own worktree at `.ai/cezar/worktrees/<runId>` on branch
`cez/<id8>` (spec 006, `src/git-worktree.ts`). A worktree is a **full working
copy of the repository** — for a large repo that is tens to hundreds of MB
each. Today a worktree directory is removed in only three places:

- `pruneOrphans(repoRoot, validIds)` at startup (`src/index.ts`) — removes only
  directories whose run id is **no longer in the store**.
- losing-variant cleanup (`server.ts`, spec 010) — removes the discarded
  variant's worktree.
- explicit `POST /api/runs/:id/remove-worktree` and run delete/discard.

A normal finished run stays in `runs.json`, so its worktree is **never**
reclaimed automatically. Nothing bounds the total. On an active machine that
runs dozens of tasks a day, `.ai/cezar/worktrees/` grows without limit until
the disk fills — at which point new tasks fail to create a worktree and the
cockpit degrades. The user asked (#483) for management/rotation that keeps "up
to X" worktrees, configurable, "so old WTs don't saturate full disk space".

## Proposed Solution

An always-on **count-based retention policy** layered on the existing
`removeWorktree` primitive:

- Keep the **N most-recently-finished** reclaimable worktrees materialized on
  disk; reclaim the rest. Default `N = 10`. `N = 0` means "unlimited — never
  auto-reclaim".
- **Reclaimable** = a run whose status is `done`, `failed`, or `cancelled`
  (the same "finished" set `archiveFinished` already uses) **and** whose worktree
  directory still exists. `running`, `queued`, and `waiting` are live work;
  **`review` is deliberately excluded** — a run at the review gate still needs
  its worktree to render the diff and open a draft PR. Reclaiming it would
  break the gate.
  **Two later exclusions (as built):** a **pinned** run (`run.pinned`, the user
  saying "keep this one") is never reclaimable and does not count toward N;
  and a worktree a running cezar or node process uses (`inUse`, #2021/#2074) is
  never selected and does not count toward N either (`runs/retention.ts`).
- **Reclaim = directory only.** Call `removeWorktree(repoRoot, path)` *without*
  the branch argument, so the `cez/<id8>` branch (and every autosave commit on
  it) survives. The work is fully recoverable — re-materialize with
  `git worktree add`. Autosave already commits all worktree changes to the
  branch, so nothing is lost.
- **Enforced** after every terminal transition and at startup, plus a manual
  "Reclaim now" button in the management panel (Phase 2).

Alternatives considered:

- **Age-based (older than D days)** — rejected as the primary knob: the issue
  says "keeping up to X", and a count directly bounds the worst-case
  directory count regardless of task cadence. Age is a natural future add-on
  (documented under Risks/Future).
- **Size-based (cap total MB)** — rejected as primary: measuring directory
  size on every transition is I/O-heavy, and a per-repo byte budget is a knob
  users can't intuit. Total size is *shown* in the panel, not the trigger.
- **Delete branch too** — rejected (Q2): full reclaim loses local-only work;
  keeping the branch reclaims essentially all the disk (the working tree, not
  the tiny packed objects) while staying recoverable.

## Architecture

**What is reused, not rebuilt:**

- `removeWorktree(repoRoot, worktreePath)` — already reclaims a directory and
  keeps the branch when the branch arg is omitted. No change to its signature.
- `runs/store.ts` as the source of truth for run status/timestamps and the
  in-process event bus.
- `PUT /api/config` merge-into-raw-file semantics for the new knob.
- `POST /api/runs/:id/remove-worktree` for per-item manual delete in the panel.

**What is new:**

1. **Config key** — `worktreeRetention` on `CezConfig` (`src/config.ts`):
   `z.number().int().min(0).max(1000).default(10).catch(10)`. Additive and
   default-safe, exactly like `maxParallel` / `memoryLimitMb`.

2. **Pure selector** — `selectReclaimableWorktrees(runs, keep)` in a new
   `src/runs/retention.ts` (pure, unit-testable, no I/O):
   - filter runs to `{done, failed, cancelled}` with a set `worktreePath`,
     no `worktreeReclaimedAt`, not `pinned`, and not in the `inUse` set;
   - sort by recency key `finishedAt ?? createdAt`, descending;
   - keep the newest `keep`; return the run ids of the remainder.
   - `keep === 0` → return `[]` (disabled).

3. **Enforcer** — `reclaimWorktrees(repoRoot, store, keep)` (thin I/O wrapper):
   runs the selector, calls `removeWorktree` per selected run (branch kept),
   stamps `worktreeReclaimedAt` via `store.updateRun`. Never throws (helper
   discipline). Returns the reclaimed run ids for logging/SSE.
   - **Called** from (a) the terminal-transition path in the workflow runner
     (after a run reaches `done`/`failed`/`cancelled`), and (b) startup in
     `src/index.ts`, right after `pruneOrphans`.
   - **Idempotent under races:** `removeWorktree` is `--force` + `prune`, and a
     repeated `updateRun` stamp is harmless, so two runs finishing at once that
     both select the same path cause no corruption.

3a. **Stamp-clear on re-materialization (required — prevents a disk leak).**
   The selector filters out any run that already carries `worktreeReclaimedAt`.
   So when a reclaimed run is later **resumed/continued** and `createWorktree`
   re-materializes its directory, the stamp MUST be cleared
   (`store.updateRun(id, { worktreeReclaimedAt: undefined })`) at the
   re-creation site. Without this, a reclaimed → resumed → re-finished run keeps
   its directory on disk *and* stays invisible to the enforcer forever — a leak
   in exactly the recover-and-continue flow this spec sells as safe.

4. **Read route** — `GET /api/worktrees`: lists materialized worktrees with
   `{ runId, title, status, branch, sizeBytes | null, finishedAt, reclaimable }`.
   Size via `du -sk` (execFile, degrades to `null` on failure — never throws,
   never blocks). Powers the management panel.

5. **Bulk reclaim route** — `POST /api/worktrees/reclaim`: force-runs the
   enforcer now (respecting the same reclaimable rule) and returns the reclaimed
   ids. The panel's "Reclaim now" button.

6. **UI** — (as built: project settings → **Worktrees**, `worktrees-section.tsx`, not
   Settings → Resources; see § UI/UX) Settings → Resources gains a **Keep last N worktrees** field
   (0 = unlimited) and a **Worktrees** management panel: a table of worktrees
   with size, age, status, a per-row Delete (existing `remove-worktree` route),
   total-disk summary, and "Reclaim now". This is the surface the requested
   HTML mockups depict.

**Data flow:** terminal transition → `reclaimWorktrees` → `removeWorktree`
(dir gone, branch kept) → `updateRun({ worktreeReclaimedAt })` → store emits
`run` over SSE → cockpit patches the cache; the diff/PR views already guard on
a missing worktree dir (they read from the branch / degrade), and now also on
`worktreeReclaimedAt`.

## Data Model

Additive optional field on `RunRecord` (`src/runs/store.ts`), safe per the
"new fields must be optional so old files parse" rule:

```ts
/** Set when retention reclaimed this run's worktree directory (branch kept).
 *  Presence = "materialized dir gone, recoverable via `git worktree add`". */
worktreeReclaimedAt: z.string().optional(),
```

New config key (`src/config.ts`):

```ts
/** Count-based worktree retention (#483): keep the last N *finished*
 *  worktrees on disk; reclaim older ones (directory only — branch kept).
 *  0 = unlimited (never auto-reclaim). Default 10. `.catch(10)` keeps it
 *  additive-safe: a bad value degrades to the default. */
worktreeRetention: z.number().int().min(0).max(1000).default(10).catch(10),
```

No migration: absent field/key both resolve to their defaults on read.

## API Contracts

All additive (compat-safe; `/api/config` and the runs namespace already take
new optional fields / routes).

- `GET /api/config` / `PUT /api/config` — gain `worktreeRetention: number`
  (0–1000). `PUT` merges into raw `config.json` like the other knobs.
- `GET /api/worktrees` →
  `{ worktrees: Array<{ runId, title, status, branch, sizeBytes: number|null,
  finishedAt: string|null, reclaimable: boolean }>, totalBytes: number|null,
  keep: number }`. Never errors; degrades to `sizeBytes: null` when `du` is
  unavailable — including **all of Windows** (`du -sk` is POSIX-only), where the
  panel simply shows "—" for size. Retention is count-based, so Windows keeps
  working; only the size column degrades.
- `POST /api/worktrees/reclaim` → `{ reclaimed: string[] }`. Zod-validates an
  empty/`{}` body; runs the enforcer once; 200 always (best-effort).
- `POST /api/runs/:id/remove-worktree` — **unchanged**, reused for per-row
  manual delete.

## UI/UX

> **As built:** the field lives in the project's settings → **Worktrees**
> (`routes/settings/worktrees-section.tsx`, project-scoped). The default N is a
> layer: the repo's own `worktreeRetention`, else the workspace's
> `resources.worktreeRetentionDefault` (`~/.cezar/config.json`), else 10
> (`DEFAULT_WORKTREE_RETENTION`, `config.ts`). The original design follows.

Settings → Resources (`resources-section.tsx`), matching the existing `Field`
chassis so Settings reads as one surface:

- **Keep last N worktrees** — number input (0–1000), `0` = unlimited, hint
  "Older **finished** worktrees are reclaimed to free disk; their branch is kept
  so the work stays recoverable." The label/hint say *finished* deliberately:
  because in-review and live runs are excluded from the budget, the on-disk
  directory count can legitimately exceed N. Saves through `PUT /api/config`
  like `maxParallel`.
- **Worktrees panel** — a table (runId/title, status badge, branch, size, age)
  with a per-row **Delete**, a footer showing **total disk used** and count vs.
  keep-limit, and a **Reclaim now** button. Empty state when none exist.
  Live-updates from the `run` SSE stream. Reclaimed rows show a "branch kept"
  affordance rather than vanishing, so users trust the work is recoverable.

Accessibility: table has a caption and row headers; Delete/Reclaim buttons have
explicit `aria-label`s and a confirm step; respects existing light/dark theming.

## Edge Cases & Failure Scenarios

- **Run at `review`** — never auto-reclaimed (would break diff/PR). It counts
  toward disk in the panel but not toward the `keep` budget.
- **Worktree with un-pushed local-only commits** — safe: reclaim keeps the
  branch, so the commits survive; the panel labels it recoverable.
- **`removeWorktree` fails** (locked dir, permission) — helper never throws;
  the run is *not* stamped `worktreeReclaimedAt`, so the next pass retries. No
  crash, no false "reclaimed" state.
- **`du` missing / slow / huge tree** — `sizeBytes` degrades to `null`; the
  panel shows "—", retention still works (it is count-based, not size-based).
- **Concurrent reclaim + task start** — the enforcer skips any run not in the
  finished set, so a just-started run's dir is never taken mid-flight.
- **User sets N below current count** — next transition (or "Reclaim now")
  reclaims down to N oldest-first; no data loss (branches kept).
- **Reclaimed run is resumed/continued** — `createWorktree` re-materializes the
  dir and MUST clear `worktreeReclaimedAt` (Architecture 3a). Otherwise the run
  is exempt from retention forever and leaks disk. This is the one behavior the
  implementation must not miss.
- **`worktreeReclaimedAt` set but dir re-materialized out-of-band** (user ran
  `git worktree add` manually) — panel reflects on-disk truth from
  `GET /api/worktrees`; a stamped-but-present dir is shown as present.
- **Two runs finish simultaneously** — both may select the same over-limit
  path; `removeWorktree` (`--force` + `prune`) and a repeated stamp are
  idempotent, so no corruption results.

## Risks & Impact Review

- **Blast radius:** additive config key + optional RunRecord field + two new
  additive routes + one Settings surface. No existing route/field/shape
  changes → **not** a breaking change under `BACKWARD_COMPATIBILITY.md`.
  Suggested labels: `risk-medium` (it deletes files on disk, even if
  recoverable), `priority-medium`.
- **Data-loss risk:** the one real hazard is deleting a worktree a user still
  wanted materialized. Mitigations: branch always kept (recoverable);
  `review`/live runs excluded; default is generous (10); `0` fully disables.
- **Zero-config compliance:** ships on with a working default; the setting is
  an optional override, never required (AGENTS.md).
- **Default-on deletion is intentional.** This is a behavioral change — cezar
  keeps every worktree today; this ships auto-deleting directories at N=10 by
  default. It is deliberately default-on (owner call on #483: "so old WTs don't
  saturate disk"), made safe by keeping the branch (recoverable), excluding
  in-review/live runs, a generous default, and `0` as a full opt-out. Flagged
  here so review treats the default-on behavior as a decision, not an accident.
- **Rollback:** revert the PR — the optional field/key simply stop being read;
  existing `runs.json`/`config.json` remain valid. No migration to undo.
- **Future (out of scope, noted):** age-based and size-based triggers as
  additional optional knobs; a global disk-budget guard.

## Phasing

- **Phase 1 — Retention engine (independently shippable):** config key,
  selector, enforcer, startup + terminal-transition wiring, `worktreeReclaimedAt`
  field, Settings "Keep last N" input. Delivers the disk-saturation fix with no
  panel.
- **Phase 2 — Management panel (independently shippable):** `GET /api/worktrees`,
  `POST /api/worktrees/reclaim`, the Settings worktrees table with per-row
  delete and "Reclaim now". Delivers the visibility/manual-control UI the
  mockups depict.

## Implementation Plan

Each step leaves the app working and is unit-testable.

### Phase 1: Retention engine

- 1.1 Add `worktreeRetention` to `CezConfig` (`src/config.ts`) with default 10
  and `.catch(10)`; extend `configAnswer` + `PUT /api/config` validation in
  `server.ts`. Tests: default when absent, clamp/catch on bad value, round-trip
  through `PUT`.
- 1.2 Add optional `worktreeReclaimedAt` to `runRecordSchema`
  (`src/runs/store.ts`). Test: old `runs.json` without the field still parses;
  `updateRun` sets it.
- 1.3 Write `selectReclaimableWorktrees(runs, keep)` in `src/runs/retention.ts`
  (pure). Tests: keeps newest N, excludes `review`/live/reclaimed, `keep=0`
  returns none, recency ordering by `finishedAt ?? createdAt`.
- 1.4 Write `reclaimWorktrees(repoRoot, store, keep)` (I/O wrapper over the
  selector + `removeWorktree` dir-only + stamp). Test with a temp git repo:
  dir removed, branch present, field stamped, failure leaves field unset.
- 1.5 Call `reclaimWorktrees` at startup after `pruneOrphans`
  (`src/index.ts`) and on terminal transitions in the workflow runner. Tests:
  finishing a run past the limit reclaims the oldest; a `review` run is spared.
- 1.5a **Clear `worktreeReclaimedAt` on re-materialization** at the
  `createWorktree` call site (resume/continue path). Test: reclaim a run, resume
  it (dir + stamp-cleared), finish it again — it is once more eligible for
  retention (no permanent exemption / disk leak).
- 1.6 Settings → Resources "Keep last N worktrees" input
  (`resources-section.tsx`) with 0=unlimited, wired to `PUT /api/config`.
  Component tests: renders value, saves, rejects non-integers/negatives.

### Phase 2: Management panel

- 2.1 `GET /api/worktrees` in `server.ts` — list + `du -sk` sizes (degrade to
  null) + `reclaimable`/`totalBytes`. Tests: shape, size-null degradation,
  reclaimable flag matches the selector.
- 2.2 `POST /api/worktrees/reclaim` — force-run the enforcer, return
  `{ reclaimed }`. Test: reclaims to the limit, 200 on empty state.
- 2.3 Worktrees table in Settings → Resources: rows with size/age/status,
  per-row Delete (existing `remove-worktree`), total-disk footer, "Reclaim now",
  empty state, SSE live-update. Component tests: renders rows, delete calls the
  route, reclaim calls the route, empty state.
- 2.4 Docs: note the knob in the README env/settings table and cite `#483` +
  this spec where the code touches worktree lifecycle.
