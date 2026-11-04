# Repo git sync — Source Control for the main checkout

Status: implemented (2026-10-19). Server: `packages/cezar/src/server/repo-sync.ts`; cockpit:
`packages/web/src/routes/repo-git/repo-sync-bar.tsx`.

## Problem

`/git` showed the local `git log` of `HEAD` and nothing about the remote. Whether a commit was
pushed, whether `origin` had moved, which upstream the branch tracked: none of it was visible,
and the only way to sync was a terminal. An in-place task (worktree off) could only run on
whatever branch was checked out.

## Shape

- **Status, offline.** `GET /repo/sync` reports the current branch, its upstream, ↑ahead ↓behind,
  the outgoing commits (`@{u}..HEAD`; for an unpublished branch, `HEAD --not --remotes`), the
  incoming ones (`HEAD..@{u}`, capped at 50), every local branch's tracking
  (`%(upstream:track)`, including `gone`), and `lastFetchedAt` (`FETCH_HEAD`'s mtime). It never
  touches the network, so it is cheap to refetch on focus.
- **Network only on a click.** `POST /repo/{fetch,pull,push,sync}`. Nothing fetches in the
  background, so this adds no default-on network traffic (§ Zero config). Every network call runs
  with `GIT_TERMINAL_PROMPT=0`, `credential.interactive=false` and a 60 s timeout. Under
  `CEZ_DRY_RUN=1`, fetch and push are skipped.
- **Pull is fast-forward only.** A diverged branch is a 409 that says so. cezar never picks merge
  or rebase for the user's own checkout. Sync = pull, then push (VS Code's Sync).
- **One mutation per checkout** at a time (an in-process queue), so a double-clicked Sync cannot
  race its own pull.
- **Cockpit.** The `/git` header carries `→ origin/main ↑1 ↓2 · fetched 5 min ago` plus Fetch /
  Pull / Push / Sync, or Publish branch when there is no upstream. Commits lists the incoming
  commits on top and marks local ones `↑ local`. Branch rows show their tracking state (counts,
  `local only`, `remote only`, `upstream gone`).

## In-place task on a new branch

`POST /runs` takes `newBranch` (+ optional `branch`) next to `worktree: false`. The run records
`inPlaceBranch: true` and the branch name up front, so a requeue or restart keeps it. **After** the
repo-root lease is granted, it switches the checkout with `createOrSwitchBranch(name, base)`; the
base comes from `chooseForkBase`, the same fetch-first choice a worktree uses. Doing it after the
lease means a queued in-place run can never switch the branch under one that is still running.
The name comes from the user, else the branch namer, else `cez/<id8>`. If the branch already
exists, the run switches to it. If the switch fails, the run fails before any agent starts.
`baseBranch` is pinned to the post-switch HEAD, as for every in-place run.

The branch is the user's: deleting the task never deletes it (`removeWorktree` only runs for runs
with a `worktreePath`), and the Branches list keeps showing it.

## Not in this change

- Stage/commit from Changes.
- A draft PR from an in-place run (the PR route still requires a worktree).
- Background auto-fetch. It would widen default network traffic and needs an explicit decision.
