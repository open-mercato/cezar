# A task remembers every PR it has been associated with

## 📝 TLDR

A task's PR association is single-valued today: the newest declaration silently replaces the previous one (`packages/cezar/src/runs/store.ts:862` — `applyMarkerRefs` assigns `run.prNumber = refs.pr` and re-resolves the referenced URL against the new number). A follow-up turn that opens a second PR therefore erases the link to the first, and the original — usually still the main deliverable — becomes unreachable from the cockpit. This spec replaces the single slot with an **ordered, append-only list of PR references** (`prRefs`) on `RunRecord`, keeps `prNumber` / `pullRequestUrl` / `referencedPullRequestUrl` as derived projections so every existing reader, script and hand-edited `runs.json` keeps working, and paints the extra references as additional chips beside the primary one. A second phase hydrates PR state lazily so a closed-and-replaced PR is dimmed and can hand the primary slot to its successor — the one case where today's "last one wins" is the right answer.

## 📝 Problem Statement

Reported as issue #779. The reproduction is two steps long and happens on ordinary days:

1. A task opens PR #A. The cockpit shows a clickable `#A` chip in the sidebar row, the task-thread header and the Tasks overview table.
2. The user sends a follow-up in the same task; the agent opens PR #B and declares `CEZ:PR=B`.
3. `applyMarkerRefs` overwrites `run.prNumber` with `B` and re-resolves `referencedPullRequestUrl` against `B`. The `#A` chip is gone — from every surface at once, because all three read the same accessors (`taskPrUrl` / `taskReference`, `packages/web/src/lib/tasks-table.ts:135` and `:171`). Nothing in `.ai/cezar/runs.json` still names `#A` except the noisy `referencedPrCandidates` scraping set, which is not rendered anywhere.

A task legitimately ends up with more than one PR in three shapes, and only the third is served correctly by replacement:

- **Follow-up** — additional work opened as a separate PR on top of the first. The first PR is still the deliverable; both must stay reachable.
- **Stacked / split PR** — one task, a chain of PRs. All of them matter.
- **Closed and replaced** — the first PR was rejected or superseded. Here "the newest wins" is correct, and the old one should be de-prioritised rather than deleted from view.

There is a second, quieter symptom of the same root cause. Because a declaration *overwrites*, a single mis-declared `CEZ:PR=` (an agent naming a PR it merely compared against) permanently hijacks the task's only chip. With a list, a stray declaration adds an entry instead of destroying the correct one — the failure mode degrades from data loss to noise.

Scale check on this repository's own history: this workflow routinely produces a spec PR and then an implementation PR from the same task, and the `om-auto-*` chain explicitly re-emits `CEZ:PR=` "with the new number if the subject changes" (`packages/cezar/src/handoff.ts:152`). The overwrite is not an edge case; it is the designed path for every chained run.

## 📝 Proposed Solution

Promote the display tier's PR association from a scalar to a **list**, and make the existing scalars derived views of that list:

- `RunRecord` gains one additive optional field, `prRefs` — an ordered array of `{ number, url?, origin, at }`, deduplicated by PR number, capped, never rewritten in place except to enrich an entry with a URL it did not have.
- Writers **append** instead of replacing: the created-PR janitor, `POST /api/runs/:id/pr`, and `applyMarkerRefs`. `markerRefs.pr` keeps its exact current meaning — "the PR the agent most recently declared as the subject" — so no prompt, marker grammar or agent-protocol change is required.
- `prNumber` is written as the **primary** entry's number rather than the last declaration's, which is what makes the fix visible to every existing consumer (title prefixes, `taskReference`, the API DTO, scripts reading `runs.json`) without touching any of them.
- The cockpit renders the primary chip exactly as today, plus the remaining references as additional chips (or a `+N` overflow chip that expands), on all three surfaces.
- Records without `prRefs` — every run written before this change — derive a one-entry list at read time from today's fields. **No migration, no rewrite, no repair step**, per the "state a user must migrate is not state" law in `AGENTS.md`.

**Alternatives considered and why they lost:**

- **Keep the scalar, add `previousPrNumbers: number[]`.** Cheaper to write but it splits one concept across two fields with different lifetimes, and every reader has to remember to union them. The list *is* the model; the scalar is the projection.
- **Render from `referencedPrCandidates`.** The working set already holds every PR URL scraped from the transcript, so "the chips are already in the file" is tempting. Rejected: that set is deliberately noisy — it collects any `github.com/…/pull/N` the agent printed, routinely from other repositories, which is exactly the wrong-link defect #526 was fixed to kill. Authoritative associations (created / declared) and transcript scrapings must not be merged into one rendered list.
- **Ask the agent to declare the relationship** (`CEZ:PR=B replaces A`, or a `CEZ:PR+=` append form). Rejected: it changes a published agent protocol every skill in the collection emits, to obtain information the store can infer from PR state at display time. A protocol change is the least reversible option on the table.
- **Persist each PR's state (open/merged/closed) in `runs.json`.** Rejected: it turns a local association log into a stale cache of remote truth, and cezar has no webhook to invalidate it. State is hydrated at display time, in the query cache, or not at all.
- **Build nothing.** Rejected — the reported behavior is silent data loss of a link the user demonstrably needs, and the workflow that produces it is the product's own recommended chain.

## 📝 Architecture

One vertical slice through the existing tiers; no new module, no new mechanism, nothing reshaped.

**The tiers stay as they are.** cezar already distinguishes the *created* tier (`pullRequestUrl` — the PR this task opened; gates the "Draft PR" / "Create PR → View PR" actions) from the *display* tier (`prNumber`, `referencedPullRequestUrl` — the PR this task is ABOUT; never gates an action). **This spec touches only the display tier.** `pullRequestUrl` keeps first-wins semantics and every action gate keeps reading it directly, so a task that opened PR #A and then reviewed PR #B can still push its own branch.

| Layer | File | Change |
|---|---|---|
| Persistence | `packages/cezar/src/runs/store.ts` | **New** `prRefSchema` + `prRefs` on `runRecordSchema` (optional, `.catch([])`), `MAX_PR_REFS`, a private `appendPrRef(run, ref)` helper, and its three call sites: the created-PR janitor (`:758`), `applyMarkerRefs` (`:854`), and the derivation that seeds the list from legacy fields on first append. `trackReferencedPrs` (`:779`) is deliberately **not** a writer. |
| Persistence | `packages/cezar/src/server/pr.ts` | The draft-PR creation path records the URL it just created as a `created` entry (through the same store helper — never by writing the array itself). |
| Wire contract | `packages/contract/src/runs.ts` | The same `prRefs` field on the run DTO schema (`:206` neighbourhood), so `contract-parity*.test.ts` and the typed client see it. Additive and optional — an old client ignores it. |
| Selector | `packages/web/src/lib/tasks-table.ts` | **New** `taskPrRefs(run, repoBase?)` — the single place the list is read, ordered, URL-enriched and legacy-derived. `taskPrUrl` and `taskReference` are re-expressed on top of it and keep their exact current signatures and results for one-PR runs. |
| UI | `packages/web/src/components/reference-chip.tsx` | **New** optional `state?: 'open' \| 'merged' \| 'closed'` and `muted?` props (Phase 2 tinting); the default rendering is byte-identical to today's neutral chip. |
| UI | `packages/web/src/components/task-quick-list.tsx` (`:364`), `packages/web/src/routes/task-thread/run-header.tsx` (`:504`), `packages/web/src/routes/tasks-overview.tsx` (`:632`, `:884`) | Render the extra references beside the primary chip, per the density rules in **UI/UX**. |
| Hydration (Phase 2) | `packages/cezar/src/server/forge/github.ts`, `server.ts`, `packages/contract/src/github.ts`, `packages/web/src/api/{client,queries}.ts` | **New** windowed `GET /api/v1/github/pr-states?prs=…`, a structural sibling of the lazy checks endpoint (#664): degrade-in-payload (`{available:false, reason}`), 60s cache, capped list, never a 5xx. |

**Data flow (Phase 1).** Agent turn → `applyTurnMarkers` (`packages/cezar/src/workflows/run.ts:3226`) → `store.applyMarkerRefs` → `appendPrRef` (dedupe, cap) → `prNumber` recomputed from the primary → `touch()` → debounced `runs.json` write + SSE `run` payload → `taskPrRefs(run, repoBase)` → chips.

**Boundaries.** The store stays the only writer of run state; the cockpit stays a pure reader. No cross-module import is added. The Phase 2 endpoint lives in the GitHub family and obeys its law from `AGENTS.md`: no `gh`, no remote, offline ⇒ `{available:false, reason}`, never an error.

**Coordination note.** The pending spec PR #816 (*Linked-PR chips on the GitHub Issues list*) introduces an adjacent `LinkedPr` shape with the same `state: 'open' | 'merged' | 'closed'` vocabulary and the same lazy-window pattern. Whichever lands first owns the state-resolution helper and the chip's state tinting; the second one reuses it rather than defining a parallel shape. This is a review checkpoint, not a blocking dependency — Phase 1 here has no overlap at all.

## 📝 Data Model

One additive optional field on `RunRecord`, in both the persistence schema (`packages/cezar/src/runs/store.ts`) and the wire contract (`packages/contract/src/runs.ts`):

```ts
/** One pull request this task has been associated with (spec 2026-08-10-task-pr-reference-list).
 *  Authoritative associations only — the PR the run CREATED and the PRs the agent DECLARED via
 *  `CEZ:PR=`. Transcript scrapings stay in `referencedPrCandidates`; merging the two would
 *  rebuild the wrong-link defect #526. */
const prRefSchema = z.object({
  number: z.number(),
  /** Absent when the association arrived as a bare declared number; the cockpit synthesizes the
   *  link from the PROJECT's repository only (the #526 rule), never from the transcript. */
  url: z.string().optional(),
  /** 'created' = this run opened it; 'marker' = the agent declared it; 'legacy' = derived once
   *  from the pre-list fields of an older record. Provenance, not priority. */
  origin: z.enum(['created', 'marker', 'legacy']),
  /** ISO-8601 first-seen. The stable tiebreak for the primary slot and the list order. */
  at: z.string(),
});

/** Every PR this task has been associated with, oldest first. Append-only and deduplicated by
 *  number; an entry is only ever enriched (a URL added), never repointed. Capped at MAX_PR_REFS;
 *  the primary entry is never the one evicted. Absent on every pre-spec run — the cockpit derives
 *  a one-entry view from `pullRequestUrl` / `referencedPullRequestUrl` / `prNumber` instead, so
 *  nothing is migrated and nothing is rewritten. */
prRefs: z.array(prRefSchema).catch([]).optional(),
```

**Invariants.**

- **Append-only, deduplicated by `number`.** Re-declaring a number that is already present enriches it (adds a `url` it lacked, upgrades `origin` `legacy → marker → created`) and leaves `at` and the position untouched.
- **Ordered by `at`,** which is insertion order. The order is stored, not recomputed on read, so it survives restarts and hand edits.
- **Capped at `MAX_PR_REFS = 8`,** mirroring `MAX_PR_CANDIDATES` (`store.ts:296`). On overflow the **oldest non-primary** entry is dropped — the primary is what the user clicks; the newest is what they just made; a middle entry is the cheapest thing to lose.
- **Primary selection (Phase 1):** the `created` entry if the run has one (preserving today's `pullRequestUrl`-wins rule), otherwise the first entry. Deterministic and offline — it needs no network and cannot flicker.
- **Primary selection (Phase 2):** among entries whose hydrated state is known, a `closed` (unmerged) entry loses the primary slot to the earliest non-closed entry. `merged` and `open` rank equally — a merged first PR stays primary over a later open follow-up, which is the reported expectation. Unknown state ranks as non-closed, so a GitHub outage degrades exactly to the Phase 1 order.
- **State is never persisted.** It lives in the query cache with the rest of the GitHub data.
- **`prNumber` is a projection.** Every write path that touches the list recomputes `prNumber` from the primary. It is not an independent field any more, but its type, presence rules and meaning to an external reader are unchanged.

**Compatibility with `runs.json` (§3 of `BACKWARD_COMPATIBILITY.md`).**

- Additive and optional ⇒ every pre-spec record parses unchanged; no run is dropped by the whole-array `safeParse`.
- `.catch([])` on the array means a hand-edited or corrupt `prRefs` degrades that one field to empty — the record survives and falls back to the legacy derivation. This is stricter than the surrounding fields on purpose: a hand-editable file gets a hand-edit failure mode.
- **Downgrade round-trip is lossy but safe:** an older cezar reading the file strips the unknown key on its next write, and the task collapses to today's single-PR behavior. Nothing becomes unreadable, no run is lost — worth one line in the CHANGELOG.
- No field is removed, renamed, or made required. §2 (HTTP API) is untouched in Phase 1; Phase 2 adds one route and its inventory entry.

## 📝 API Contracts

**Phase 1 — no route changes.** `prRefs` rides along on every payload that already carries a `RunRecord`: `GET /api/runs`, `GET /api/runs/:id`, the SSE `run` event on `/api/events` and `/api/workspace/events`. Adding an optional response field is explicitly additive under §2; the legacy `/api/events` payload shape is *widened*, not stamped or restructured, which is the one thing that stream forbids.

**Phase 2 — one new windowed endpoint**, registered in the chained GitHub family so it is mounted at `/api/github/pr-states`, `/api/p/:projectId/github/pr-states` and `/api/v1/…` twins (route parity and v1 parity are enforced by existing suites), and inventoried in §2:

```
GET /api/v1/github/pr-states?prs=<csv of positive ints, cap 100>
  200 { available: true,  states: Record<number, 'open' | 'merged' | 'closed' | null> }
  200 { available: false, reason: string }
  400 { error }                       // malformed list, per the /github/checks precedent
```

An absent or `null` entry means "unknown" and renders as today's neutral chip. Only the numbers currently on screen are requested, exactly as `GET /api/github/checks` does for CI glyphs (#664), so the fast list fetch keeps its cost.

## 📝 UI/UX

The chip's visual language does not change; what changes is that there can be more than one, and that the extra ones must not crowd out the title. Density rules per surface:

- **Sidebar quick list** (`task-quick-list.tsx`, a 264 px column): the primary chip only, with a count suffix when the task has more — `PR ·3` in compact mode. The chip's `title` and `aria-label` enumerate all of them ("3 pull requests: #779 (primary), #816, #830"). No popover: a 264 px row has no space for one, and the sidebar's job is to say *which* task, not to browse its PRs.
- **Task-thread header** (`run-header.tsx`): the primary chip plus up to two more inline, then a `+N` chip that opens a popover listing every reference — number, state dot, origin ("opened by this task" / "declared"), each a link. This is the screen a user is on when they ask "where did my first PR go?", so it is the one that shows everything.
- **Tasks overview** (`tasks-overview.tsx`, the Ref column and the card view): the primary chip plus a `+N` chip with the same popover. The column keeps its current width; `+N` is two characters.
- **Phase 2 tinting:** `merged` keeps full weight in the merged tint, `open` keeps today's neutral violet, `closed` (unmerged) renders muted with reduced opacity and sorts after the others. Unknown state = today's appearance. Colour is never the only signal — the popover spells the state out, and the chips' order carries it too.
- **Accessibility:** every chip stays a real link with a descriptive `aria-label` (the existing `ReferenceChip` contract); the `+N` control is a button with `aria-expanded`, the popover is keyboard-dismissable, and the muted treatment keeps contrast above 4.5:1 against the row background rather than relying on opacity alone.
- **Unchanged:** the inert-text degradation for a non-`http(s)` URL (#431) and the "no invented links" rule (#526) — a declared number becomes a link only through the on-screen project's repository base (`useProjectRepoBase()`), never through a transcript-scraped host.

Mockups of the proposed chip rows and screenshots of the current single-chip surfaces are attached to this spec's PR as evidence (see the PR's evidence comment).

## 📝 Edge Cases & Failure Scenarios

| Situation | Behavior |
|---|---|
| Agent re-declares the same number | Entry enriched in place; no duplicate, no reordering, no extra write beyond `touch()`. |
| Agent declares a PR it merely compared against | It becomes a *non-primary* entry. Today it destroys the correct chip — this is a strict improvement, and the popover's origin line makes the stray visible. |
| More than 8 associations | Oldest non-primary evicted. The primary and the newest are always present. |
| Task with no PR at all | `prRefs` absent, `taskPrRefs` returns `[]`, no chip — identical to today. |
| Pre-spec record (no `prRefs`) | One derived entry from `pullRequestUrl ?? referencedPullRequestUrl ?? prNumber`. Identical rendering to today. |
| Issue-subject run (`CEZ:ISSUE` and no `CEZ:PR`) | Still shows no PR chip: the #526 guard in `taskPrUrl` is carried into `taskPrRefs` verbatim. |
| Declared number, no URL anywhere, no `repoBase` | Inert chip showing `#N` — today's degradation, unchanged. |
| Hand-edited / corrupt `prRefs` | `.catch([])` empties that field only; the run parses and falls back to the legacy derivation. |
| Older cezar rewrites the file | Field stripped; behavior collapses to today's. Documented, not fatal. |
| GitHub unreachable / no `gh` / offline (Phase 2) | `{available:false, reason}`; chips keep declaration order and neutral tint. No dimming, no reordering, no error surface. |
| PR deleted or number belongs to another repo | State comes back `null` ⇒ neutral chip, still clickable if a URL is known. cezar never asserts a state it did not read. |
| Two turns declare different PRs concurrently | The store is single-threaded per project; appends are ordered by arrival, and dedupe makes a replay idempotent. |

## 📝 Risks & Impact Review

- **Blast radius: the display tier of the task record.** Every action gate (`Draft PR`, `Create PR → View PR`, push) keeps reading `pullRequestUrl` directly and is untouched. The riskiest single line is the `prNumber` write becoming a projection; it is covered by the existing marker/namer precedence tests plus new ones.
- **`runs.json` (§3):** additive, optional, `.catch`-guarded, no migration. The documented downgrade behavior (field stripped on an older cezar's write) is the only compatibility cost and it is non-destructive.
- **HTTP API (§2):** unchanged in Phase 1. Phase 2 adds one route that must be inventoried in `BACKWARD_COMPATIBILITY.md` §2 (`bc-route-inventory.test.ts` fails otherwise) and must answer identically on its legacy, project-scoped and `/api/v1` spellings (`route-parity.test.ts`, `v1-parity.test.ts`).
- **Agent protocol:** unchanged. `CEZ:PR=` keeps meaning "the PR this task is currently about"; only the store's reaction to it changes. No skill, prompt or handoff text needs an edit.
- **Rollback story:** Phase 1 is revertible by reverting the commits — records that already carry `prRefs` stay parseable by the reverted code (unknown key, ignored) and render from the legacy fields, which the new code kept writing all along. That "keep writing the projections" rule is what makes rollback free, and it is the reason `prNumber` is not dropped in favour of the list.
- **Performance:** at most 8 small objects per run in a file that already holds step arrays; the debounced atomic write is unchanged. Phase 2 adds one cached, windowed request per visible screen, matching the checks-glyph budget.
- **What could still go wrong:** the primary-selection rule is a product judgement, not a fact. Phase 1 ships the offline rule (created, else first-seen); if the Phase 2 state rule turns out to feel wrong, it is a pure display-layer change with no persisted consequence.

## 📋 Phasing

- **Phase 1 — the list and the chips (offline).** `prRefs` in both schemas, append-on-write, `prNumber` as a projection, legacy derivation, all three surfaces rendering every reference. Independently shippable and it alone closes #779's data loss: no PR link ever disappears again.
- **Phase 2 — state-aware priority and tinting.** The windowed `pr-states` endpoint, closed-PR demotion and muting, merged tint. Independently shippable; without it Phase 1 simply shows every PR in declaration order.
- **Phase 3 (optional, demand-gated) — the same primitive for issues.** `issueRefs` reusing `prRefSchema`'s shape and the same selector. Deliberately not scheduled: the reporter notes the issue side "bites much less in practice", and shipping it unasked doubles the surface for no reported pain.

## 📋 Implementation Plan

**Phase 1 — the list and the chips**

1. **Schema + helper.** Add `prRefSchema`, `prRefs`, `MAX_PR_REFS = 8` and the private `appendPrRef(run, {number, url?, origin})` to `packages/cezar/src/runs/store.ts`: seeds the list from the legacy fields on first append, dedupes by number, enriches `url`/`origin`, evicts the oldest non-primary at the cap, and recomputes `prNumber` from the primary. Unit tests: fresh append, duplicate enrich, cap eviction keeping primary + newest, legacy seeding. App keeps working — nothing calls it yet.
2. **Wire `applyMarkerRefs`.** Replace `run.prNumber = refs.pr` with an `appendPrRef(..., 'marker')` call; `markerRefs.pr` and the `referencedPullRequestUrl` re-resolution stay exactly as they are. Extend `store.test.ts`: two declarations keep both numbers, the first stays primary, `prNumber` reports the primary, a third declaration of the first number changes nothing.
3. **Wire the created tier.** The janitor (`store.ts:758`) and the draft-PR path (`packages/cezar/src/server/pr.ts`) append a `created` entry alongside their existing `pullRequestUrl` write. Test: a created PR is primary even when a marker declared a different PR first.
4. **Contract.** Mirror `prRefs` in `packages/contract/src/runs.ts`; run the contract-parity suites. Test: a `RunRecord` carrying the field round-trips through `GET /api/runs/:id` unchanged.
5. **Selector.** Add `taskPrRefs(run, repoBase?)` to `packages/web/src/lib/tasks-table.ts`, re-express `taskPrUrl`/`taskReference` on it, and prove in `tasks-table.test.ts` that every existing case (created wins, #526 issue-subject guard, legacy record, no-PR run) returns byte-identical results.
6. **Task-thread header.** Render primary + 2 inline + `+N` popover in `run-header.tsx`. Component test: three references produce three reachable links; one reference renders exactly today's markup.
7. **Tasks overview.** Same treatment in the Ref column and the card view (`tasks-overview.tsx`).
8. **Sidebar.** Count suffix and enumerated `title`/`aria-label` in `task-quick-list.tsx` (no popover).
9. **Docs.** `BACKWARD_COMPATIBILITY.md` §3 bullet for `prRefs` (including the downgrade note), a CHANGELOG entry, and the `AGENTS.md` runs-store row if the invariant list there needs the append-only rule.

**Phase 2 — state-aware priority and tinting**

10. **Forge.** `fetchGithubPrStates(repoRoot, numbers, refresh?)` in `packages/cezar/src/server/forge/github.ts`: one aliased GraphQL query, 60 s cache, `CEZ_DRY_RUN` mock branch, `__clear…ForTests` hook — mirroring `fetchGithubChecks`. Reuses the cached `resolveRepoHandle`. Tests: state mapping (open/merged/closed), degradation to `{available:false}`.
11. **Contract + route.** `prStatesDataSchema` in `packages/contract/src/github.ts`; the chained `.get('/github/pr-states', …)` link with the CSV validation and cap of the checks sibling; §2 inventory entry. Tests: route parity, v1 parity, BC inventory, 400 on a malformed list.
12. **Client + query.** `getGithubPrStates` and `useGithubPrStates(numbers, enabled)` next to their checks counterparts.
13. **Display rules.** `state`/`muted` props on `ReferenceChip`; ordering and primary demotion applied inside `taskPrRefs` from the hydrated map (never from the record). Tests: a closed primary hands the slot to the next non-closed entry; unknown state reproduces the Phase 1 order exactly.
14. **Screens.** Wire the on-screen window on the three surfaces; verify against the mockups with a UI pass.

**Phase 3 (only if requested)**

15. `issueRefs` reusing the same schema, writers and selector shape, with the `CEZ:ISSUE` marker semantics left untouched.

## 📝 Resolved assumptions (autonomous defaults)

This spec was written by an unattended run; the questions below were the gate and each carries the most reversible answer, documented here for override before merge.

| # | Question | Applied default | Why |
|---|---|---|---|
| Q1 | Is the primary decided by declaration order or by PR state? | Both, phased: declaration order (with the created PR winning) is the persisted, offline rule in Phase 1; state-based demotion of *closed* PRs is a Phase 2 display rule fed by hydrated state. | Matches the reporter's own "state first, then declaration order" while keeping Phase 1 shippable with no network dependency, and keeps a GitHub outage from reshuffling chips. |
| Q2 | Does the `CEZ:PR=` marker protocol change? | No. It keeps meaning "the PR this task is currently about"; only the store's reaction changes from replace to append. | A published protocol every skill emits is the least reversible surface in reach; the store can infer everything it needs without touching it. |
| Q3 | Do issues get the same treatment now? | No — PRs only. The schema and selector are shaped so `issueRefs` is a mechanical repeat, listed as demand-gated Phase 3. | The reporter states the issue side "bites much less"; the smallest scope that fixes the reported defect wins, and the generic shape keeps the door open. |
| Q4 | Is PR state persisted in `runs.json`? | No. Hydrated at display time into the query cache only. | A local file cannot be invalidated when a PR merges; a persisted state field would be confidently wrong. Keeps the record a pure association log. |
| Q5 | How is state hydrated in Phase 2 — a new endpoint, or the existing open-PR list? | A new windowed `GET /api/v1/github/pr-states`, mirroring the lazy checks endpoint (#664), with an explicit review checkpoint to share the state helper with spec PR #816 if that lands first. | The existing list fetches only `states: OPEN`, so it cannot tell "merged" from "closed" — the exact distinction the requirement rests on. The windowed sibling is the established pattern and costs the list fetch nothing. |
| Q6 | Do transcript-scraped PR URLs (`referencedPrCandidates`) join the list? | No. Only created and declared associations. The scraping set keeps feeding the single-valued `referencedPullRequestUrl` fallback exactly as today. | Merging noisy scrapings into a rendered list would rebuild defect #526 (links naming other repositories) at three times the surface. |
| Q7 | What happens at the cap? | Cap 8 (mirroring `MAX_PR_CANDIDATES`); evict the oldest **non-primary** entry. | The primary is what the user clicks and the newest is what they just made; a middle entry is the cheapest loss, and 8 matches an existing constant rather than inventing a new budget. |

None of these carries a `⚠ NEEDS HUMAN CONFIRMATION` marker: every default is additive, display-tier only, and revertible without touching persisted state.
