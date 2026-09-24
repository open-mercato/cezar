# Execution plan — repo-scope the referenced PR/issue tier (#945)

Engine: om-auto-create-pr (steps: 9, --loop: no)
Issue: https://github.com/open-mercato/cezar/issues/945
Source doc: `.ai/specs/2026-07-16-pr-autodiscovery.md` (issue tier: `.ai/specs/2026-07-21-report-ref-discovery.md`)

## Goal

Stop a task in project *P* from adopting a pull request or issue that belongs to a **different
repository** as its own reference chip, unless the task prompt itself names that repository.

## Background

`resolveReferencedRef` (`packages/cezar/src/runs/store.ts:444`) implements the spec's referenced
tier: "exactly one distinct candidate → that URL". `PR_URL_RE` / `ISSUE_URL_RE` match
`https://github.com/<any-owner>/<any-repo>/pull|issues/N`, so a research task that cites one
upstream PR — the reported `supabase/cli#6056` on an `oko` task — hands the janitor exactly one
candidate, and it becomes the task's subject. Nothing in the chain ever compares the URL's
`owner/repo` with the project's own.

The existing foreign-number guards (#819/PR #840, #854/PR #864, both landed on `main`) all guard
**synthesis** — a bare number rebuilt as `${repoBase}/pull/${number}` — and deliberately exempt
discovered URLs. Here the wrong link *is* the discovered URL, so every one of them passes it
through. This is the missing third case.

## Scope

- Repo-scope what the referenced tier **promotes**, never what it **collects** (the #526 rule):
  `referencedPrCandidates` / `referencedIssueCandidates` keep recording every URL as evidence.
- The guard is **strictly subtractive** — it vetoes a resolution, so it can only ever turn a value
  into `undefined`. It never adopts a candidate today's rule would not have.
- Corroboration is the module's existing trust boundary: the **task prompt** naming the URL's
  `owner/repo` (or the URL itself) makes a foreign reference legitimate — the #819
  `om-auto-fix-pr https://github.com/open-mercato/open-mercato/pull/1977` case.
- Degrade, never fail (`AGENTS.md` zero config): with no known handle — no `gh`, no remote, a
  non-git root, hosted mode — behavior is exactly today's.
- Heal records already poisoned, one-directionally.

## Non-goals

- Ref-status hydration across repos (`useReferenceStatus` / `GET /github/ref-status` asking the
  project's repo about a legitimately foreign number). Real, different axis — the issue files it as
  out of scope.
- The synthesis guard for bare foreign numbers (#854 — already landed as PR #864).
- Rendering an unlinked `#N` instead of dropping the chip (#819's follow-up note).
- Multi-forge / multi-repo reference modelling (#847).
- Any HTTP route, CLI flag, event-schema or `runs.json` **format** change. Reaching for one is the
  signal the fix has grown past this issue.

## Design

**Where the guard lives.** Inside `resolveReferencedRef`, as a veto on the value it was about to
return — one place, and all four call sites (`trackReferencedPrs`, `trackReferencedIssues`,
`applyMarkerRefs`, and `appendEvent`'s created-tier re-resolve) plus `reconcileLoadedRun` inherit
it. Vetoing the *result* rather than filtering the *candidate list* keeps the change subtractive:
filtering first would let a project-local candidate win a two-candidate race today's rule calls
ambiguous, which is a wider behavior change than the defect warrants.

**How the store learns its repository.** A `setRepoHandle()` setter, not an `open()` option:
`RunStore.open` is synchronous and `resolveRepoHandle` shells out to `gh`, so the handle has to
arrive after load or boot would wait on the network. Both `RunStore.open` call sites that hold a
repo root — `project-context.ts:211` and `openStore()` in `index.ts:656` — arm it in the
background, fire-and-forget, never throwing.

**The heal.** Because the handle arrives *after* `open()`, the load-time heal cannot run inside
`reconcileLoadedRun`. It runs when the handle lands: `setRepoHandle` sweeps every loaded run and
re-applies the veto to both referenced tiers, revoking a janitor-seeded `issueNumber` alongside a
dropped `referencedIssueUrl` exactly as `trackReferencedIssues` already does on ambiguity. Purely
one-directional — it may remove an association, never invent one — so a downgrade and an older
record both stay safe.

**Display layer.** Decided: no mirror (step 3.2 records the reasoning in the doc comment that
already states the #526/#819/#854 rule in one piece). The slim runs-index row does not carry
`task`, so it cannot evaluate corroboration — mirroring there would either need a new field or
would drop the legitimate #819 cross-repo chip. Scoping at the record is the only place with the
corroboration signal. Consequence: no `runIndexEntrySchema` change, so no
`BACKWARD_COMPATIBILITY.md` §1 enumeration churn.

## Implementation Plan

### Phase 1: Repo-scope the referenced tier's promotion

- **1.1** In `packages/cezar/src/runs/store.ts`: add a `RepoHandle` type and a pure
  `isRepoScopedRef(url, task, handle)` corroboration helper (unknown handle or unparseable URL →
  adoptable; own repo → adoptable; foreign → only when `task` names the `owner/repo`,
  case-insensitively). Veto `resolveReferencedRef`'s return value with it, and thread the store's
  handle through all four call sites plus `reconcileLoadedRun`'s heal.
- **1.2** Unit tests in `packages/cezar/src/runs/store.test.ts` for the resolution rule: the
  foreign lone candidate is dropped (PR **and** issue, the issue case also asserting no
  `issueNumber` seed); the corroborated cross-repo prompt keeps its chip; an unknown handle is
  unchanged; a candidate from the project's own repo is unaffected. Each must fail with the guard
  reverted.

### Phase 2: Teach the store its repository and heal poisoned records

- **2.1** `RunStore.setRepoHandle(handle)`: store it and sweep every loaded run, re-applying the
  veto to `referencedPullRequestUrl` / `referencedIssueUrl` and revoking a seeded `issueNumber`
  alongside a dropped issue URL. Touch only records that actually changed.
- **2.2** Arm it in the background from both `RunStore.open` call sites — `project-context.ts`'s
  `build()` and `openStore()` in `index.ts` — via one shared helper so the fire-and-forget and its
  swallowed failure are written once.
- **2.3** Tests: a stored record carrying a foreign `referencedPullRequestUrl` loses it when the
  handle arrives; a corroborated foreign URL survives; a `null` handle changes nothing; the
  `issueNumber` revoke fires only for a janitor-seeded number.

### Phase 3: Documentation

- **3.1** Update `.ai/specs/2026-07-16-pr-autodiscovery.md` ("Referenced detection") and
  `.ai/specs/2026-07-21-report-ref-discovery.md` with the repo clause, citing the existing
  `CREATED_PR_RE` amendment note as the precedent — the same failure, one tier down.
- **3.2** Write the display-layer decision and its reasoning into the `taskReferences` doc comment
  in `packages/web/src/lib/tasks-table.ts`, the one place the whole rule is stated together.

## Risks

- **Dropping a legitimate chip.** A cross-repo task whose prompt does not spell out the repository
  (a bare `#1977` plus a transcript URL) loses a chip it used to show. Accepted: the spec's own
  stated preference is "no chip beats a wrong chip", and the prompt-corroboration escape hatch
  covers the documented #819 shape.
- **`gh` latency / absence.** Mitigated by the background arming and the null-handle no-op path;
  boot never waits and a `gh`-less machine keeps today's behavior. Covered by test 2.3.
- **Older cezar reading the same `runs.json`.** The heal rewrites values, not format, and only ever
  clears a field that is already optional — the `reconcileLoadedRun` precedent.

## Validation

Full gate from `.ai/agentic.config.json`: `npm run typecheck`, `npm test`, `npm run test:unit`,
`npm run build`, `npm run test:package`.

## Progress

PR: #946

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Repo-scope the referenced tier's promotion

- [x] 1.1 Add the repo-handle corroboration helper and veto `resolveReferencedRef` — ac02041f
- [x] 1.2 Unit tests for the repo-scoped resolution rule — ac02041f

### Phase 2: Teach the store its repository and heal poisoned records

- [x] 2.1 `RunStore.setRepoHandle` and the one-directional rescope sweep — 5bca379d
- [x] 2.2 Arm the handle in the background from both `RunStore.open` call sites — 5bca379d
- [x] 2.3 Tests for the sweep, the corroborated survivor, and the null handle — 5bca379d
- [x] 2.4 Review autofix: cover `armRepoHandle`'s degradation path; arm only after a successful build — 1d712bd7

### Phase 3: Documentation

- [x] 3.1 Update the two referenced-detection specs with the repo clause — d09154c4
- [x] 3.2 Record the display-layer decision in the `tasks-table.ts` doc comment — d09154c4
