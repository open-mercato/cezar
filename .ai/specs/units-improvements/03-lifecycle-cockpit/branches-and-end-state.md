# 03 — Branch model, end state, and the missions API

Audit of **how a mission's git branches accumulate, how a mission ends, and what the missions
API does and doesn't let an operator do** in cezar's units feature, against
`.ai/specs/2026-09-08-units-hierarchy.md` and the code at HEAD `076cead2` (branch `cez/a51529ee`,
forked from `cez/5a23b3d1`, which resolves to the same commit — no prior units-audit work is
ahead of this one). Every citation below was read at this HEAD in this worktree; line numbers are
what I actually saw, not carried over from the task order (the order's own line-number hints —
`spawnChildren ~1607`, `POST /missions ~3501`, `requireUnits ~3486` — all matched exactly, cited
below as their real line).

Scope: analysis only. No source, test or other spec file was touched — this file is the only
addition. `.ai/specs/units-improvements/03-lifecycle-cockpit/` did not exist before this audit; it
holds only this file.

---

## 1. The branch mechanism as built

Verified end-to-end, `spawnChildren` → `execute()` → `createWorktree`:

- `spawnChildren` (`packages/cezar/src/workflows/run.ts:1607-1699`) creates each child with
  `this.startRun(...)` and then, at **run.ts:1681-1689**, patches the new child record:
  ```
  ...(parent.branch ? { baseBranch: parent.branch } : {}),
  ```
  `parent.branch` is the parent's OWN `cez/<id8>` branch name (a git ref), not a path into the
  parent's worktree.
- `execute()` (run.ts:3290-3346) is where that seed actually takes effect. At **run.ts:3317-3319**:
  a run that already has a recorded `baseBranch` keeps it (`base = recorded ?? repo.branch`) rather
  than re-resolving the configured base — this is the exact mechanism the code comment at
  run.ts:1684-1686 says it is: "`execute()` already prefers a recorded `baseBranch` over the
  configured one, so seeding it here is the whole of the change."
- `createWorktree` (`packages/cezar/src/git-worktree.ts:136-216`) forks the child's worktree with
  `git worktree add -b <branch> <path> <base>` (git-worktree.ts:211) — a plain `git` positional ref
  argument. `base` here is `parent.branch`, i.e. the branch's current tip **commit**, not the
  parent's live working directory. Git has no notion of "fork from that other worktree's
  uncommitted files"; a ref is the only thing `worktree add` can point at.

**What happens to uncommitted parent work:** it is invisible to the child. If the parent has not
committed at the moment `CEZ:SPAWN` runs, the child's fork point is the parent branch's last
commit, which may be behind what the parent's own worktree currently holds. Nothing in
`spawnChildren` checks working-tree cleanliness before creating children — I read the whole
function (run.ts:1607-1699) and the only git operation in it is the eventual `createWorktree` call
inside `startRun`/`execute`; there is no `git status` check anywhere in the spawn path. The ONLY
place this is enforced is prose, in the role prompts: `CHILD_BRANCH_RULE`
(`packages/cezar/src/units/prompts.ts:31-41`), line 35: *"COMMIT your work before every
CEZ:SPAWN. Anything you left uncommitted does not exist for your children, and they will either
redo it or contradict it."* This is exactly the situation the same file's own doc-comment
(prompts.ts:24-29) predicts: *"Nothing in cezar merges a child branch back: that is the
commander's own work... which is precisely why the rule has to live in the prompt."* The same
applies one level up, symmetrically: an uncommitted merge (or manual edit) the parent makes in
response to a child's report is likewise invisible to any FURTHER child spawned before it's
committed. → **F1**.

**The commander merges by hand**, per `CHILD_BRANCH_RULE:38`: `git merge --no-ff <child branch>`,
run inside the parent's own worktree, one child at a time. No code performs this merge; it exists
only as an instruction the caesar/legate prompts carry (prompts.ts:107, 134, both interpolating
`CHILD_BRANCH_RULE`). A centurion never merges — it has no children (`CHILD_ROLE.centurion ===
undefined`, `packages/cezar/src/units/engine.ts:21-25`).

## 2. Alternatives, judged against AGENTS.md "Changing a mechanism that already works"

**What the manual merge is load-bearing FOR, not what it was designed for.** Reading it only as
"how a child's work gets folded upward" undercounts it. Three things ride on the SAME step
(prompts.ts:36-38):

1. The only assembly mechanism that exists at all — nothing else combines sibling branches.
2. The only VALIDATION checkpoint in the whole tree, because F2/F3 below show the engine-level
   `review` gate never fires for a unit run: `CHILD_BRANCH_RULE:37` — *"VALIDATE it first: read
   that branch's diff, run the tests and commands the child claims to have run. A report is a
   claim until you have checked it."* — is standing in for a review gate that the autonomy setting
   has switched off everywhere else in the tree.
3. The place sibling conflicts are adjudicated (prompts.ts:39) — by the one party (the commander)
   who handed out the scopes and can tell whether an overlap was a mistake or a deliberate
   escalation.

| Alternative | Mechanism | Load-bearing thing it would drop | Default-path impact (knob at its shipped default) | Verdict |
|---|---|---|---|---|
| **As built**: commander merges by hand, own worktree per child | Manual `git merge --no-ff`, prose-enforced | — (baseline) | n/a | Ships today |
| **Engine merges when the child's tree is clean** | Auto-`git merge --no-ff` at settle time when no conflict markers result | Drops #2 (the read-the-diff-before-merge step) for the MAJORITY case — disjoint scopes are required by design (`SPAWN_CONTRACT`, prompts.ts:52), so most merges ARE clean, meaning this alternative silently removes validation on exactly the reports least likely to be scrutinized otherwise | If shipped as an opt-in flag defaulting OFF: default path = today's manual merge, unchanged — satisfies AGENTS.md's "diff the default path" test on its own terms, but then it fixes nothing for the zero-config user. If shipped ON by default: quietly removes the guarantee AGENTS.md warns about — a mechanism (commander-reads-the-diff) that was never coded, only prompted, so its removal leaves no trace in any test that isn't specifically about prompts | Only viable as an explicit, OFF-by-default opt-in; do not ship it as the default |
| **One shared mission branch** (every rank works in one tree) | No per-child worktree; a lease held across parks | Everything `git-worktree.ts` provides to six other consumers (retention.ts, agent-tmpdir.ts, projects.ts, run.ts, server.ts, index.ts — grep-verified, see §Worktrees) — diff-base anchoring, autosave-per-branch, retention-by-directory, the review gate's own `worktreeDiff` call | Already rejected in the spec itself (Q3, `.ai/specs/2026-09-08-units-hierarchy.md`): *"A shared tree needs a lease held across parks (#438), which would block a parent's own children; releasing on park re-derives that guarantee across ~9 resume paths."* Code confirms the rejection was followed: every child gets its own `baseBranch`/worktree (§1) | Correctly not built; re-opening it would be the textbook "replace a mechanism that already works" risk AGENTS.md warns about — the blast radius is six files, not one |
| **Dedicated integration centurion** | A new spawned role whose only job is merging accepted branches | Nothing existing — this is additive, not a replacement | New role = new enum member (`UNIT_ROLES`, `packages/contract/src/units.ts`), new `DEFAULT_UNIT_PROMPTS` entry, new `CHILD_ROLE` mapping decision (who can spawn it, does it count against `MAX_CHILDREN_IN_FLIGHT = 4`, `engine.ts:29`), new budget slice per mission. None of this exists today (grep-verified: no "integrat" hits in `units/` or `contract/src/units.ts`) | Real option, but it is new surface, not a fix to what's built; costs a full role (prompt + schema + tests) for one mission-shaped problem. The spec's own Q8 explicitly cut a comparably-sized addition (Legion) for the MVP on the same reasoning: "adds no mechanism" beyond what two tree shapes already prove |

**Recommendation:** keep manual merge as the default and only path for the MVP. If auto-merge for
clean trees ships at all, ship it OFF by default and require the commander to opt in per-mission
(a `ladder`-shaped flag, not a config default) — the validation step it would remove is currently
the ONLY one the tree has (§2, point 2), and AGENTS.md's standard — *"a replacement that ships OFF
is not a replacement... diff the default path"* — applies directly: with the knob at its shipped
default, the old scenario (commander reads the diff before merging) must still happen, and only an
opt-in preserves that.

## 3. Worktrees per army

**How many.** One worktree per RUN, unconditionally, including every rank: caesar, legates,
centurions, and the mission root itself if it's an ordinary (non-repo-root) checkout. An army with
1 caesar → 3 legates → 3 centurions each is 1 + 3 + 9 = 13 worktrees live at peak, all under
`.ai/cezar/worktrees/<runId>` (`WORKTREES_DIR`, git-worktree.ts:18). Nothing in `spawnChildren`
caps this beyond `MAX_CHILDREN_IN_FLIGHT = 4` **per parent** (engine.ts:29) — the cap bounds
fan-out at each node, not the tree's total worktree count.

**Cleanup/retention — what exists.** Count-based, project-wide, directory-only reclaim
(`packages/cezar/src/runs/retention.ts`), wired at **every terminal transition** for **every**
run in the project — `enforceRetention()` (run.ts:2171-2178) is called unconditionally from
run.ts:1430, right after a settled run releases its slot. `selectReclaimableWorktrees`
(retention.ts:37-43) keeps the `keep` most-recently-finished reclaimable worktrees and reclaims
the rest; `keep` defaults to **10** (`DEFAULT_WORKTREE_RETENTION`, `packages/cezar/src/config.ts:26`)
and is a single number for the whole project, not per mission. `isReclaimable` (retention.ts:25-27)
only excludes runs at `review`, plus non-`done`/`failed`/`cancelled` statuses. Removal keeps the
branch (`removeWorktree(root, path)` with no branch arg, retention.ts:112) so `git merge --no-ff`
still works from any other worktree in the repo (branches and objects are shared across
worktrees) — the commander's merge step is unaffected by reclaim.

**What retention does NOT know about, verified:**
- It is not mission-aware: `selectReclaimableWorktrees` (retention.ts:37-43) sorts ALL finished
  runs in the store by recency and keeps the top `keep`, with no grouping by `unit.missionId`. A
  single busy army (13 worktrees above) can by itself exceed the default keep=10, reclaiming its
  own earlier-finished siblings' directories while later siblings of the SAME mission are still
  running.
- Because every unit run is `autonomous: true` (§2 below, F2) it never parks at `review`, so it
  becomes reclaim-eligible the instant it settles — sooner than an ordinary reviewed task would.
- The three cockpit read routes that need a live worktree — `GET /runs/:id/diff`
  (server.ts:4186-4194), `GET /runs/:id/changes` (server.ts:4196-4211), and (by the same
  `workingDirectoryOf`/`worktreeOf` helpers, server.ts:4557-4563) `GET /runs/:id/commits`
  (server.ts:4214+) — all gate on a bare `existsSync(run.worktreePath)` check and return the SAME
  string, `NO_WORKTREE = 'no worktree — this task ran directly in the repo working tree'`
  (server.ts:4563), for a run whose worktree was genuinely never created AND for one whose
  directory was reclaimed by retention (`run.worktreeReclaimedAt` set, `retention.ts:26`). The
  message is simply wrong in the reclaimed case. → **F4**.
- Rematerializing a reclaimed worktree (`rematerializeReclaimedWorktree`, retention.ts:68-82) has
  exactly one call site in the whole codebase — grep-verified — `run.ts:2833`, inside
  `runContinuation`, i.e. only when THAT SAME run's own session is resumed. None of the three read
  routes above call it, so a reclaimed child's diff stays unreadable via the cockpit until either
  its own session is continued or it is merged (by branch name, not by directory) from the parent.

## 4. The end state — who opens the draft PR, from which branch, when

Traced fully; nothing was found that does this automatically.

- **`settleSuccess`** (run.ts:4152-4176) is the ONLY place a successful run is offered the
  `review` checkpoint that exists to precede a draft PR. At **run.ts:4159**:
  ```
  review = hasDiff && reviewGateEnabled(config) && run.autonomous !== true;
  ```
  Every unit run is created with `autonomous: true` — the mission root at
  `packages/cezar/src/server/server.ts:3529`, every spawned child at `run.ts:1671` — with no
  exception anywhere for the root. So `run.autonomous !== true` is `false` for every node in
  every mission, and `review` is `false` unconditionally, **even when a repository has explicitly
  turned the review gate on** (`CEZ_REVIEW_GATE`/`reviewGateEnabled`, default OFF per #489). A
  finished mission root settles straight to `done` with the plain lifecycle note "run finished"
  (run.ts:4174), never the review-branch's "changes ready for review — send feedback, open a draft
  PR, or finish" (run.ts:4173). `engine.ts`'s own `TERMINAL_STATUSES` (engine.ts:42) and
  `statusToReportStatus` (engine.ts:141-146) still branch on `'review'` for a settling child — dead
  code for the units feature, since no unit run can ever reach it. → **F2**.
- **`POST /runs/:id/pr`** (server.ts:4344-4382) is the only PR-creation code path in the
  repository (see §5 for the grep). It requires `!manager.isActive(id)` and an existing
  `worktreePath`/`branch` (server.ts:4349-4357) — it does NOT require `status === 'review'`, so it
  is callable on a `done` run too. I grepped every caller of `createDraftPr` — the only import is
  `packages/cezar/src/server/pr.ts` re-exporting `packages/cezar/src/server/forge/github.ts`, and
  the only call site of the imported function is this one route. Nothing in `run.ts`, no
  automation, and no other route ever calls it. → **F3**.
- **Which branch, targeting what**: `packages/cezar/src/server/forge/github.ts:2439-2484` — `--head
  <run.branch>` against `--base <run.baseBranch>` (falling back to the repo default when
  `baseBranch` is a bare commit sha, github.ts:2481-2482). For a mission root that is NOT itself a
  spawned child, `run.branch`/`run.baseBranch` are whatever the ordinary `execute()` worktree path
  assigned it (run.ts:3290-3346) — the mission's own `cez/<rootid8>` branch against the
  project's configured base branch. That branch is exactly "the mission root's branch accumulates
  the result," per the spec's own Q3 language — but ONLY what the root itself committed or merged
  onto it; a child's work is only on that branch after the commander's manual `git merge --no-ff`
  (§1) actually happened.
- **Who, when**: the role prompts state the human does it, in prose only —
  `CHILD_BRANCH_RULE:41`: *"Never merge into the repository's base branch... yourself, and never
  push to it. Your branch is where the mission's result accumulates; a human opens the pull
  request."* Caesar's own finishing instructions (`CAESAR_PROMPT`, prompts.ts:113) say to *write a
  mission report and end with `CEZ:DONE`* — there is no instruction anywhere to call the PR route,
  consistent with the Guard rule's "never merge" bullet (`GUARD_RULE`, prompts.ts:83). So the
  intended end state (a human opens exactly one draft PR from the root's branch, after inspecting
  it) is a *convention told to the agent*, with **no code trace connecting "mission settled" to
  "a human was told to open a PR."**

**Explicit recommendation:** the human operator opens the single draft PR, from the mission root's
own branch (`cez/<rootid8>`) against the project's configured base branch, via the existing
`POST /runs/:id/pr` — no new route is needed for the ACT of opening it. What's missing is the
NUDGE: apply **P2** below (extend the `review` gate to the mission root's own terminal settle,
root-only, still gated behind `reviewGateEnabled`) so a repository that has opted into review-then-PR
for ordinary tasks gets the identical checkpoint for a mission's accumulated result, instead of a
silent `done` that gives no signal a PR is expected.

## 5. The missions API — confirm POST /missions is the only endpoint

Commands run, verbatim:

```
$ grep -n "requireUnits\|/missions\|/units\b\|units/prompts" packages/cezar/src/server/server.ts
53:} from '../units/prompts.ts';
3465:  const requireUnits = async (c: Context, next: Next) => {
3484:  // the role prompts are per-repo files under that project's `.ai/cezar/units/`.
3486:    .use('/missions', requireUnits)
3487:    .use('/missions/*', requireUnits)
3488:    .use('/units', requireUnits)
3489:    .use('/units/*', requireUnits)
3501:    .post('/missions', jsonZodValidator(startMissionInputSchema), async (c) => {
3544:    .get('/units/prompts', async (c) => {
3549:      '/units/prompts/:role',
3569:    .delete('/units/prompts/:role', ...)
```

```
$ grep -rn "'/missions\|\"/missions\|missions/:" packages/cezar/src/server/*.ts packages/cezar/src/**/*.ts 2>/dev/null | grep -v test
packages/cezar/src/server/server.ts:3486:    .use('/missions', requireUnits)
packages/cezar/src/server/server.ts:3487:    .use('/missions/*', requireUnits)
packages/cezar/src/server/server.ts:3501:    .post('/missions', jsonZodValidator(startMissionInputSchema), async (c) => {
```

```
$ grep -rn "get('/missions\|get(\"/missions\|/missions/:id\|missions.*cancel\|missions.*pause\|missions.*resume" packages/ apps/ 2>/dev/null | grep -v node_modules | grep -v "\.git/"
(no output)
```

**Confirmed: `POST /api/v1/p/:projectId/missions` is the only route under `/missions`.** The
`unitsRoutes` sub-app (server.ts:3485-3577) has exactly four handlers total:
`POST /missions`, `GET /units/prompts`, `PUT /units/prompts/:role`, `DELETE /units/prompts/:role`
— none of the last three touch a mission's lifecycle. `missions-api.test.ts` (215 lines, read in
full) tests only `POST /api/v1/missions`, confirming no other route was ever meant to exist yet.

**The gaps, and their cost to an operator:**

| Gap | Verified absence | What it costs |
|---|---|---|
| No `GET /missions` (or `/missions/:id`) | Grep above; only route is `POST` | Low in-cockpit — `packages/web/src/routes/missions/missions.tsx:38` derives the whole tree from `useRuns()` + `unit.missionId`/`parentRunId` grouping client-side, so the web UI never needed this route. Real cost falls on any OTHER consumer (a CLI, a status script, a second front end) — it must fetch and filter the entire run list itself to answer "what does mission X look like." |
| No mission-scoped cancel | Only `POST /runs/:id/cancel` exists (server.ts:3821); nothing resolves a `missionId` to its root | An operator who wants to stop mission X must first find and remember which run id is its root, then cancel that specific id — an easy target to get wrong (cancelling a legate cascades to its own centurions but leaves siblings and Caesar running; only cancelling the true root stops the whole tree). |
| No pause/resume for a unit run | `POST /automations/:id/pause` (server.ts:3363) exists but is for scheduled automations, an unrelated feature; grep found no run-level pause/resume | A mission that needs a temporary hold (an external decision pending, a cost freeze while someone reviews progress) has only two options: let it keep spending, or cancel it outright and lose the tree's live state. There is no middle ground — real cost, not a convenience gap. |
| No mid-flight budget change | `body.budgetUsd` is written exactly once, at creation (server.ts:3537); grep found no other write site for `unit.budgetUsd` | A mission that is proving valuable and about to hit `remainingBudgetUsd <= 0` (`engine.ts:67-72`) cannot be topped up. `carveChildBudgets` (run.ts:1713-1739) refuses further spawns once the ceiling is reached (run.ts:1720-1723), forcing the commander to report early even if a human watching would gladly extend it — this directly undercuts the "cost-safe AND functional" balance the spec's own Q6 demands of the budget brake. |

## 6. Is an on-disk mission ledger worth it?

**No — not for the MVP.** Verified there is none today:

```
$ grep -rn "ledger" packages/cezar/src packages/contract/src 2>/dev/null | grep -v node_modules
packages/cezar/src/server-install/... (all unrelated — server-install's own artifact ledger)
```

No hit anywhere under `units/` or `contract/src/units.ts`. And `runs.json` (via `RunStore`)
already carries everything a mission ledger would want to record on its own: `unit.missionId`,
`unit.parentRunId`, `unit.report`, `unit.pendingReports`, `branch`, `baseBranch`, `costUsd`,
`diffStat` — every field the cockpit's own tree view needs, confirmed by
`packages/web/src/routes/missions/missions.tsx:38` deriving its whole tree from `useRuns()` alone,
nothing else. `archiveFinished()` (`packages/cezar/src/runs/store.ts:977-990`) only ever stamps
`archived: true` — it never deletes a run record — so the "ledger" already survives indefinitely
in the exact file the tree view reads.

**Concrete shape it would need, if built anyway** (for the sake of judging it, not recommending
it): `.ai/cezar/missions/<missionId>.json` — `{ missionId, rootRunId, createdAt, tree: [{ runId,
role, parentRunId, branch, baseBranch, status, mergedAt? }], finalReport? }`. **Who would write
it**: nothing today; it would need a NEW write site at every spawn (run.ts:1607-1699) and every
settle (run.ts:1756+), duplicating exactly the data `runs.json` already persists at those same two
call sites via `store.updateRun`. That duplication is the whole argument against it: AGENTS.md's
"find every construction site of a shared... object" warns about exactly this shape of bug — two
write paths for the same fact (a run's mission membership, its status) will drift the first time
one of the two call sites is touched and the other isn't. The only thing a separate ledger would
buy over `runs.json` is a smaller, mission-scoped file to hand to something outside cezar's own
store (e.g. embedding a manifest in the draft PR body) — and that need is better served by
rendering the SAME derivation `missions.tsx` already does (`unit.missionId`/`parentRunId` grouping
over `listRuns()`) into the PR body at `createDraftPr` time, which is what **P3**'s `GET
/missions/:id` route would expose for exactly this purpose, with no second on-disk copy.

---

## Findings

### F1 — HIGH — uncommitted parent work is silently invisible to a spawned child, and nothing checks for it

- Evidence: `packages/cezar/src/workflows/run.ts:1607-1699` (`spawnChildren`, no git-status check
  anywhere in the function), `run.ts:1688` (`baseBranch: parent.branch`), and
  `packages/cezar/src/git-worktree.ts:211` (`git worktree add -b <branch> <path> <base>` — a ref,
  not a working-tree path). Enforcement is prose only:
  `packages/cezar/src/units/prompts.ts:35`.
- Why it matters: a commander that forgets to commit before `CEZ:SPAWN` hands its children a
  stale fork point with no refusal, no note, and no recovery — the children "will either redo it
  or contradict it" (prompts.ts:35's own words), and the commander has no code-level signal that
  this happened.

### F2 — CRITICAL — every unit run is unconditionally autonomous, so no mission run can ever reach the `review` gate

- Evidence: `packages/cezar/src/server/server.ts:3529` (mission root, `autonomous: true`, no
  exception), `packages/cezar/src/workflows/run.ts:1671` (every spawned child, same, no
  exception), `run.ts:4159` (`review = hasDiff && reviewGateEnabled(config) && run.autonomous !==
  true` — always `false` for a unit run). `packages/cezar/src/units/engine.ts:42,141-146` still
  branches on `'review'` as a live settle status — dead code for units.
- Why it matters: even a repository that has explicitly turned the review gate on
  (`CEZ_REVIEW_GATE`) gets NONE of that protection for missions specifically — the one feature
  built to slow a human down before a diff disappears into `done` is bypassed by construction for
  the very feature (autonomous, multi-rank delegation) that most needs a checkpoint before its
  accumulated result ships.

### F3 — CRITICAL — nothing in the codebase ever opens the mission's draft PR; the only mechanism is a manual, non-mission-aware route with no trigger

- Evidence: `packages/cezar/src/server/server.ts:4344-4382` (`POST /runs/:id/pr`, the only
  PR-creation route in the repo — grep-verified, `createDraftPr`'s only caller). No import of
  `createDraftPr`/`pr.ts` outside this one route (`workflows/run.ts` never imports it). The
  intended human trigger exists only in prose: `packages/cezar/src/units/prompts.ts:41`.
- Why it matters: combined with F2, a finished mission gives the operator literally no signal —
  no note, no distinct status, no cockpit badge — that a draft PR is expected. The plain lifecycle
  note is "run finished" (run.ts:4174), identical to any ordinary task that never had a mission
  attached to it.

### F4 — MEDIUM — worktree retention is project-wide and mission-blind, and misreports the reclaimed case to the cockpit's own read routes

- Evidence: `packages/cezar/src/runs/retention.ts:37-43` (`selectReclaimableWorktrees`, no
  `unit.missionId` grouping, sorted purely by recency across ALL finished runs),
  `packages/cezar/src/config.ts:26` (`DEFAULT_WORKTREE_RETENTION = 10`, one number for the whole
  project), `packages/cezar/src/workflows/run.ts:1430` + `run.ts:2171-2178`
  (`enforceRetention()` fires on every terminal transition, for every run). The misreport:
  `packages/cezar/src/server/server.ts:4557-4563` (`worktreeOf`/`workingDirectoryOf`, a bare
  `existsSync` check) feeding the identical `NO_WORKTREE` string
  (server.ts:4563) into `GET /runs/:id/diff` (4186-4194), `/changes` (4196-4211), and `/commits`
  (4214+), for both "never had a worktree" and "worktree reclaimed" — `run.worktreeReclaimedAt`
  (set at retention.ts:26) is never consulted by any of the three. `rematerializeReclaimedWorktree`
  (retention.ts:68-82) has exactly one call site in the whole codebase — `run.ts:2833`, inside
  `runContinuation` — grep-verified.
- Why it matters: because every unit child settles straight to a reclaim-eligible status the
  instant it finishes (F2), a single busy army can push its own not-yet-merged siblings' worktrees
  past the default keep=10 while the mission is still in flight. The commander's own merge is
  unaffected (branches persist, and are readable from any worktree in the repo), but a human
  inspecting the SAME child through the cockpit's diff/changes/commits tabs gets a message that
  falsely claims the task "ran directly in the repo working tree."

### F5 — MEDIUM — the missions API has one route; no GET, no mission-scoped cancel, no pause/resume, no mid-flight budget change

- Evidence: full route inventory in §5, commands and output quoted verbatim. `unit.budgetUsd`
  written exactly once, at `server.ts:3537`, no other write site (grep-verified).
- Why it matters: table in §5 — the two real (not merely inconvenient) costs are no pause/resume
  (only "let it spend" or "cancel and lose the tree" exist) and no mid-flight budget top-up (a
  mission proving its worth is force-stopped early rather than extended).

### F6 — LOW — no on-disk mission ledger exists; `runs.json` already serves that purpose

- Evidence: grep for `ledger` under `units/`/`contract/src/units.ts` (no hits);
  `packages/cezar/src/runs/store.ts:977-990` (`archiveFinished` never deletes a record);
  `packages/web/src/routes/missions/missions.tsx:38` (tree derived from `useRuns()` alone).
- Why it matters: recorded for completeness (§6) — building a separate ledger file would
  duplicate `runs.json`'s own fields across two write paths, the exact drift risk AGENTS.md
  singles out. Not worth it; see §6 for the alternative (derive the same tree for a PR body via
  **P3**'s route instead of a second on-disk copy).

---

## Proposals

### P1 — for F1: autosave the parent's worktree before seeding a child's fork point

**Problem.** A commander that forgets to commit before `CEZ:SPAWN` hands its children a stale
base with zero code-level signal.

**Concrete change.** In `spawnChildren` (run.ts:1607), before creating any child, call the
existing `autosaveCommit(parent.worktreePath, 'turn end')` (`git-worktree.ts:320-349`) — the same
helper already invoked at other lifecycle points, reusing its existing conflict-detection guard
(git-worktree.ts:316-331: refuses to autosave a worktree mid-merge or carrying conflict markers).
On `'refused'`, refuse the spawn with a note explaining why (mirrors every other spawn refusal's
shape, run.ts:1616-1639); on `'committed'`/`'nothing-to-do'`, proceed as today.

**Default-path impact.** A parent that already commits before spawning (as the prompt instructs)
sees `autosaveCommit` return `'nothing-to-do'` — a true no-op. Only a parent that forgot to commit
changes behavior, and only by making the previously-silent loss either committed or refused
outright — no existing passing scenario regresses.

**Transitions.** None new — the spawn either proceeds (autosaved or already clean) or is refused
exactly like any other malformed/over-budget spawn, with no new run state.

**Tests to pin.** New case in `run.test.ts`'s spawn suite: "spawnChildren autosaves uncommitted
parent work before seeding a child's baseBranch" (dirty tree → child forks from a commit
containing the uncommitted file); "a mid-merge parent refuses to spawn rather than autosaving a
broken tree" (reuses the `unresolvedConflicts` fixture pattern from `git-worktree.test.ts`).

**Effort:** S. **Risk:** low — reuses an already-tested helper; the only new logic is the
refusal branch.

### P2 — for F2/F3: let the mission ROOT's terminal settle reach `review`, gated behind the existing opt-in

**Problem.** No unit run — root included — can ever park at `review`, so a mission's finished
diff never gets the one checkpoint that nudges a human toward `POST /runs/:id/pr`.

**Concrete change.** In `settleSuccess` (run.ts:4152-4176), widen line 4159 from
`run.autonomous !== true` to `run.autonomous !== true || (unit exists and this run IS its own
mission root)` — i.e. `run.unit?.missionId === run.id`. Only the root is exempted; every legate
and centurion beneath it keeps `autonomous: true` behaving exactly as it does today (they still
report to a parent and must keep running unattended — this proposal does not touch that).

**Default-path impact.** `reviewGateEnabled(config)` defaults OFF (#489) — with the knob at its
shipped default, `review` stays `false` for everyone, root included: **zero change** to today's
behavior. Only a repository that has already opted into the review gate for ordinary tasks gets
the same protection extended to a mission's terminal settle.

**Transitions out of the new root-`review` state.** Identical to any other `review` run today:
send feedback (reopen the session), or call `POST /runs/:id/pr` (unchanged) — no new mechanism,
this only widens which runs are eligible for the one that exists.

**Tests to pin.** "An autonomous mission ROOT with the review gate on and a non-empty diff parks
at `review`, not `done`"; "a mission CHILD (centurion/legate) with the review gate on still
settles straight to `done` — the exception is root-only"; "with the review gate off (default), a
mission root's terminal settle is byte-identical to before this change."

**Effort:** S. **Risk:** low-medium — `isTerminalStatus` (`engine.ts:44-46`) already includes
`'review'`, so `reportSettledChildToParent` (run.ts:1756) is unaffected; a root has no
`parentRunId` to report to regardless, so this change only ever touches the ROOT's own settle, not
the child-report path. Needs a test proving that isolation explicitly, since it's the whole safety
argument for the change.

### P3 — for F5 (GET, mission-scoped cancel): two thin, additive routes over the existing store/cancel logic

**Problem.** No way to ask "what is in mission X" or "cancel mission X" without knowing its root
run id and re-implementing the grouping the web cockpit already has.

**Concrete change.** `GET /api/v1/p/:projectId/missions/:id` — filter `store.listRuns()` by
`unit.missionId === :id`, return `{ root, runs }`; port the grouping
`packages/web/src/lib/missions.ts` already implements (or expose it as a shared, testable pure
function both sides import, matching the `engine.ts` pure/stateful split this codebase already
uses). `POST /missions/:id/cancel` — resolve the mission's root (`unit.missionId === unit.role
=== root's own id`, i.e. the run with `parentRunId` absent and `missionId === id`) and delegate
to the SAME cascade `POST /runs/:id/cancel` already runs (server.ts:3821) — no new cancellation
logic, only a lookup wrapper.

**Default-path impact.** Purely additive; both new routes sit behind the existing `requireUnits`
gate (server.ts:3465-3468), so a repo with units off gets the same 409 it already gets for every
other units route.

**Transitions.** None new — `POST /missions/:id/cancel` produces exactly the cascade
`/runs/:id/cancel` already produces.

**Tests to pin.** "GET returns every run whose `unit.missionId` matches, root first"; "cancel by
mission id cascades identically to cancel by root run id on the same fixture tree" (assert the
resulting statuses are the same set either way).

**Effort:** S. **Risk:** low.

### P4 — for F5 (mid-flight budget): a validated top-up route that also clears the existing over-budget park

**Problem.** `unit.budgetUsd` is writable exactly once, at creation; a mission that proves its
worth cannot be extended, only restarted with a bigger number.

**Concrete change.** `PATCH /missions/:id/budget { budgetUsd }` on the resolved root — reject a
new ceiling below `costUsd + Σ children.budgetUsd` (reuse `remainingBudgetUsd`'s arithmetic,
`engine.ts:67-72`, solved for the ceiling instead of the remainder, so it can never retroactively
under-fund work already promised). If the root is currently parked with `unit.overBudget: true`
(set at `enforceUnitBudget`, run.ts:1578-1593), clear the flag AND re-arm whatever exit that state
disarmed — the wake timer specifically, since `enforceUnitBudget`'s whole job (run.ts:1569-1577)
is closing all three of a run's wake sources when budget hits zero; a top-up that clears the flag
but leaves the timer disarmed would leave a mission that looks funded but never wakes again.

**Default-path impact.** Purely additive; a mission that never calls it behaves exactly as today.

**Transitions out of `overBudget`.** Today there is exactly one, informal exit: a human sends the
run a message (the note at run.ts:1588 says as much), which gives the run a turn but — verified by
reading `enforceUnitBudget` (run.ts:1578-1593) — does NOT itself clear `unit.overBudget`, since
nothing but this function writes that field, and it never turns `overBudget` back to `false`. This
proposal adds a second, explicit exit (the PATCH) and, in fixing it, must ALSO fix the first exit's
same gap in the same change, or the flag becomes permanently sticky once set.

**Tests to pin.** "PATCH budget rejects a ceiling below what's already spent/promised"; "PATCH
budget on an over-budget root clears `unit.overBudget` and re-arms the wake timer so the next turn
actually fires"; "a plain human message to an over-budget run — the pre-existing exit — still does
NOT clear `overBudget` on its own, pinning today's actual (arguably buggy) behavior before this
change touches it."

**Effort:** S–M. **Risk:** medium — this touches the budget brake, which the spec's own Q6 calls a
hard requirement ("a cost feature with no working brake fails the 'cost-safe AND functional'
review"); needs a regression test proving the ORIGINAL over-budget park still fires unchanged and
is not weakened by adding the escape hatch.

### P5 — for F4: tell the truth about a reclaimed worktree on the three read routes; do not touch the retention policy itself

**Problem.** `GET /runs/:id/diff`, `/changes`, and `/commits` return the same message for "never
had a worktree" and "worktree reclaimed by retention," and the second case is far more likely to
occur for a mission's children (F2 removes the delay `review` would otherwise add).

**Concrete change.** Branch `worktreeOf`/`workingDirectoryOf` (server.ts:4557-4563) — which
already have the run record in hand — on `run.worktreeReclaimedAt`: when set and the directory is
missing, return a distinct `409 { error: 'worktree reclaimed — reopen this run to restore it',
reclaimed: true }` instead of the generic `NO_WORKTREE` string, on all three routes. Do NOT change
`selectReclaimableWorktrees`'s policy (count, project-wide scope) in the same change — that is a
mechanism that already works for the non-units case, and AGENTS.md's own standard applies:
name what it is load-bearing for (bounding total disk use with zero configuration) before
touching it for one feature's convenience.

**Default-path impact.** Default-on, changes nothing for a run that was never reclaimed; a
reclaimed run's error message changes from misleading to accurate — a strict improvement, not a
knob.

**Transitions.** None new.

**Tests to pin.** "`GET /runs/:id/diff` on a reclaimed run returns the reclaimed-specific message,
not `NO_WORKTREE`"; same assertion for `/changes` and `/commits`.

**Effort:** S. **Risk:** low. (Making retention mission-aware — e.g., never reclaiming a child
until `git merge-base --is-ancestor <child-branch> <parent-branch>` proves it was actually merged
— is a bigger, cross-cutting change to a working mechanism; left as a deliberate follow-up, not
bundled here, pending evidence that P5's message fix alone doesn't already resolve the operator
confusion.)

---

## Claims verified by running a command

- `git rev-parse HEAD` / `git branch --show-current` — confirmed HEAD `076cead2785891af80b9ea7440bf3be973c0bbfe`
  on `cez/a51529ee`; `git rev-parse cez/5a23b3d1` resolves to the same commit (the fork point is
  HEAD itself).
- `grep -n "requireUnits\|/missions\|/units\b\|units/prompts" packages/cezar/src/server/server.ts`
  — full route inventory quoted in §5.
- `grep -rn "'/missions\|\"/missions\|missions/:" packages/cezar/src/server/*.ts
  packages/cezar/src/**/*.ts | grep -v test` — only the three lines quoted in §5 (all `POST
  /missions` and its middleware).
- `grep -rn "get('/missions\|get(\"/missions\|/missions/:id\|missions.*cancel\|missions.*pause\|missions.*resume" packages/ apps/ | grep -v node_modules | grep -v "\.git/"`
  — no output. Proves no GET, cancel, pause or resume route exists anywhere for missions.
- `grep -rn "createDraftPr" packages/cezar/src` — one route caller (`server.ts:4358`), one
  re-export (`pr.ts:6`), one implementation (`forge/github.ts`) — no automatic caller.
- `grep -rn "rematerializeReclaimedWorktree" packages/cezar/src --include="*.ts" | grep -v test`
  — exactly one call site, `run.ts:2833`, inside `runContinuation`.
- `grep -n "enforceRetention()" packages/cezar/src/workflows/run.ts` — one definition, one call
  site (`run.ts:1430`), fired unconditionally on every terminal transition.
- `grep -n "DEFAULT_WORKTREE_RETENTION" packages/cezar/src/config.ts` — confirms the default is
  `10` (`config.ts:26`).
- `grep -n "budgetUsd" packages/cezar/src/server/server.ts` — confirms the only write to
  `unit.budgetUsd` is at mission creation (`server.ts:3537`); no other route touches it.
- `grep -rn "ledger" packages/cezar/src packages/contract/src | grep -v node_modules` — every hit
  is in `server-install/`, unrelated to units; none under `units/` or `contract/src/units.ts`.
- Read `packages/cezar/src/server/missions-api.test.ts` in full (215 lines) — confirms the test
  suite exercises `POST /api/v1/missions` only; no test for any other mission route exists.

---

*Audited by a centurion under task order from the legate on run
`5a23b3d1-140c-4f52-8df5-545488bc5bc1`. Read-only: no source, test, or other spec file was
touched.*
