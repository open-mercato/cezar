# Autosave flush commit clarity + conflict-marker guard

**Issue:** follow-up to #471 / #478
**Branch:** `fix/autosave-flush-commit-clarity`

## Goal

Make the *kept* autosave flushes distinguishable from the *disabled* periodic
autosave timer in `git log`, and stop `autosaveCommit` from committing a
half-resolved merge.

## Background

#471 asked to disable the global task list and autosaves. #478 gated the
periodic 90 s timer behind `CEZ_AUTOSAVE=1` (off by default) but deliberately
left three flush call sites ungated, so a task branch still ends holding the
finished state:

| Call site | Purpose | Gated? |
|---|---|---|
| `run.ts:1653` (`armAutosave` timer) | periodic, every 90 s | **yes** — `CEZ_AUTOSAVE=1` |
| `run.ts:943` | turn-end flush | no, by design |
| `run.ts:1166` | run-finalize flush | no, by design |
| `server/forge/github.ts:534` | pre-PR flush | no, by design |

All four commit with the identical message `cezar autosave`
(`git-worktree.ts:251`). The gate therefore *works*, but is unfalsifiable from
`git log` alone: a user who opted out still sees `cezar autosave` commits and
reasonably concludes the opt-out was ignored. That is exactly what happened —
this run started as a bug report against a correctly-working gate. The only way
to tell the two apart today is commit *spacing* (85–95 s ⇒ timer; minutes-to-
hours ⇒ flush), which is not a reasonable thing to ask of a reader.

Separately, the incident that motivated #471 (recorded in
`.ai/runs/2026-07-17-disable-global-inbox/HANDOFF.md:26-28`) was an autosave
committing a half-resolved merge carrying conflict markers. `autosaveCommit`
does a blind `git add -A` with no unmerged-path or marker check
(`git-worktree.ts:234-254`), so the *ungated* flushes can still do this. #478
narrowed that hazard; it did not remove it.

## Scope

- Label every autosave commit with the reason that produced it.
- Refuse to commit a worktree with unmerged paths or leftover conflict markers.
- Correct docs that describe `cezar autosave` as if it were a CLI subcommand.

## Non-goals

- Changing *which* call sites are gated. The three flushes stay ungated — that
  is the documented #478 contract and the branch must still end complete.
- Touching the follow-up inbox / `CEZ_FOLLOWUPS` gate. Verified correct.
- Anything about `~/HANDOFF.md`, which is written by the user's own
  `~/.claude/CLAUDE.md`, not by cezar.

## Risks

- The commit message is a de-facto interface (log greps, the run retro docs).
  Mitigated by keeping the `cezar autosave` prefix and only appending a
  parenthesised reason, so existing `grep 'cezar autosave'` keeps matching.
- A conflict-marker guard that is too eager could refuse a legitimate flush and
  lose the run's recovery point. Mitigated by scanning only *staged, tracked
  text* files and by logging loudly when the guard trips.

## Implementation Plan

### Phase 1 — label autosave commits by reason

Add an `AutosaveReason` union and thread it through the four call sites so the
message becomes `cezar autosave (turn end)` etc.

### Phase 2 — conflict-marker guard

Refuse the commit when the worktree has unmerged paths or files containing
leftover conflict markers; return `false` and log.

### Phase 3 — docs

Fix `README.md:365` (backticks `cezar autosave` like a subcommand that does not
exist — `src/index.ts:87-118` has no such case) and the stale docstrings.

## Progress

PR: #533

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Label autosave commits by reason

- [x] 1.1 Add `AutosaveReason` and reason-aware message to `autosaveCommit` — 13fb782
- [x] 1.2 Pass the reason at all four call sites — 13fb782
- [x] 1.3 Tests for reason-labelled messages — 13fb782

### Phase 2: Conflict-marker guard

- [x] 2.1 Refuse to autosave unmerged paths / leftover conflict markers — 13fb782
- [x] 2.2 Tests for the guard — 13fb782

### Phase 3: Docs

- [x] 3.1 Correct README and docstrings — fff538b

### Phase 4: Review follow-ups (#533 review)

The guard made `autosaveCommit` fallible in a new way, and the boolean return
could not carry that. The pre-PR flush is the one call site where the "next
flush picks it up" argument does not hold — it is the last one — so a refusal
there was silently publishing a branch missing the run's final state.

- [x] 4.1 `AutosaveResult` union; surface `refused`/`failed` from `createDraftPr`
- [x] 4.2 Require `reason` (drop the `'turn end'` default that could mislabel silently)
- [x] 4.3 Require the full ordered `<<<<<<< / ======= / >>>>>>>` triple, so files
      that merely document conflict markers keep autosaving
- [x] 4.4 Cap the marker scan at 2 MB per file; unescape git's octal path quoting
- [x] 4.5 Tests for the publish-refusal path and the new scan cases
