# A task remembers every PR it has been associated with

## 📝 TLDR

A task's PR association is single-valued today: the newest declaration silently replaces the previous one (`packages/cezar/src/runs/store.ts:862` — `applyMarkerRefs` assigns `run.prNumber = refs.pr` and re-resolves the referenced URL against the new number). A follow-up turn that opens a second PR therefore erases the link to the first, and the original — usually still the main deliverable — becomes unreachable from the cockpit. This spec replaces the single slot with an **ordered, append-only list of PR references** (`prRefs`) on `RunRecord`, keeps `prNumber` / `pullRequestUrl` / `referencedPullRequestUrl` as derived projections so every existing reader, script and hand-edited `runs.json` keeps working, and paints the extra references as additional chips beside the primary one. A second phase hydrates PR state lazily so a closed-and-replaced PR is dimmed and can hand the primary slot to its successor — the one case where today's "last one wins" is the right answer.

## 📝 Resolved assumptions (autonomous defaults)

This spec was written by an unattended run; the questions below were the gate and each carries the most reversible answer, documented here — before the design that rests on them — for override.

| # | Question | Applied default | Why |
|---|---|---|---|
| Q1 | Is the primary decided by declaration order or by PR state? | Three-tier, phased: **provenance first** (`created` > `marker` > `legacy` > `derived`), **then** declaration order within a tier — persisted and offline in Phase 1; state-based demotion of *closed* PRs is a Phase 2 **display-only** rule fed by hydrated state. | Matches the reporter's own "state first, then declaration order" while keeping Phase 1 shippable with no network dependency. Provenance leads because the alternative — pure first-seen order — lets a regex guess scraped from the task's own text outrank an explicit `CEZ:PR=` declaration, inverting the rule at `store.ts:848-852`. |
| Q2 | Does the `CEZ:PR=` marker protocol change? | The **grammar and parsing** do not change; the marker's **display effect narrows** — a re-declaration adds a reference instead of replacing the shown one, and it takes the primary slot only when no earlier `created`/`marker` entry outranks it. That narrowing is declared in `BACKWARD_COMPATIBILITY.md` §8 and reflected in the handoff instruction text (Phase 1, step 10). | A published protocol every skill emits is the least reversible surface in reach, so the vocabulary stays untouched — but §8 protects *what an emitted marker does*, not just its spelling, so the narrowing has to be written down rather than asserted away. |
| Q3 | Do issues get the same treatment now? | No — PRs only. The schema and selector are shaped so `issueRefs` is a mechanical repeat, listed as demand-gated Phase 3. | The reporter states the issue side "bites much less"; the smallest scope that fixes the reported defect wins, and the generic shape keeps the door open. |
| Q4 | Is PR state persisted in `runs.json`? | No. Hydrated at display time into the query cache only. | A local file cannot be invalidated when a PR merges; a persisted state field would be confidently wrong. Keeps the record a pure association log. |
| Q5 | How is state hydrated in Phase 2 — a new endpoint, or the existing open-PR list? | A new windowed `GET /api/v1/github/pr-states`, mirroring the lazy checks endpoint (#664), with an explicit review checkpoint to share the state helper with spec PR #816 if that lands first. | The existing list fetches only `states: OPEN`, so it cannot tell "merged" from "closed" — the exact distinction the requirement rests on. The windowed sibling is the established pattern and costs the list fetch nothing. |
| Q6 | Do transcript-scraped PR URLs (`referencedPrCandidates`) join the list? | No. Only created, declared and derived associations, and the derived tier is never rendered as an extra chip. | Merging noisy scrapings into a rendered list would rebuild defect #526 (links naming other repositories) at three times the surface. |
| Q7 | What happens at the cap? | Cap 8 (mirroring `MAX_PR_CANDIDATES`); evict the oldest **non-primary** entry, preferring `derived` entries first. | The primary is what the user clicks and the newest is what they just made; a middle entry is the cheapest loss, and 8 matches an existing constant rather than inventing a new budget. |
| Q8 | Does the Phase 2 closed-demotion also move the persisted `prNumber` (and therefore the task title)? | No. `prNumber` stays the **offline** primary; Phase 2 reorders and tints chips only. | A task's title must not silently change because someone closed a PR on GitHub, and a projection fed by hydrated remote state would write un-invalidatable remote truth into a local file — the same reason Q4 says no. The divergence is bounded, visible and documented under **Data Model**. |

None of these carries a `⚠ NEEDS HUMAN CONFIRMATION` marker: every default is additive, display-tier only, and revertible without touching persisted state.

## 📝 Problem Statement

Reported as issue #779. The reproduction is two steps long and happens on ordinary days:

1. A task opens PR #A. The cockpit shows a clickable `#A` chip in the sidebar row, the task-thread header and the Tasks overview table.
2. The user sends a follow-up in the same task; the agent opens PR #B and declares `CEZ:PR=B`.
3. `applyMarkerRefs` overwrites `run.prNumber` with `B` and re-resolves `referencedPullRequestUrl` against `B`. The `#A` chip is gone — from every surface at once, because all three read the same accessors (`taskPrUrl` / `taskReference`, `packages/web/src/lib/tasks-table.ts:135` and `:171`). Nothing in `.ai/cezar/runs.json` still names `#A` except the noisy `referencedPrCandidates` scraping set, which is not rendered anywhere.

A task legitimately ends up with more than one PR in three shapes, and only the third is served correctly by replacement:

- **Follow-up** — additional work opened as a separate PR on top of the first. The first PR is still the deliverable; both must stay reachable.
- **Stacked / split PR** — one task, a chain of PRs. All of them matter. The reporter later sharpened this on #779: the feature is *also* wanted for [GitHub stacked pull requests](https://docs.github.com/en/pull-requests/how-tos/stacked-pull-requests), where "easy browsing through PRs in stack is also important" — i.e. the list is not only a memory, it is a navigation surface. That is served here by the popover listing every reference as a link; modelling a stack's *parent/base* relationship is an explicit non-goal (see **UI/UX → Non-goals**).
- **Closed and replaced** — the first PR was rejected or superseded. Here "the newest wins" is correct, and the old one should be de-prioritised rather than deleted from view.

There is a second, quieter symptom of the same root cause. Because a declaration *overwrites*, a single mis-declared `CEZ:PR=` (an agent naming a PR it merely compared against) permanently hijacks the task's only chip. With a list, a stray declaration adds an entry instead of destroying the correct one — the failure mode degrades from data loss to noise.

Scale check on this repository's own history: this workflow routinely produces a spec PR and then an implementation PR from the same task, and the `om-auto-*` chain explicitly re-emits `CEZ:PR=` "with the new number if the subject changes" (`packages/cezar/src/handoff.ts:152`). The overwrite is not an edge case; it is the designed path for every chained run.

## 📝 Proposed Solution

Promote the display tier's PR association from a scalar to a **list**, and make the existing scalars derived views of that list:

- `RunRecord` gains one additive optional field, `prRefs` — an ordered array of `{ number, url?, origin, at }`, deduplicated by PR number, capped, never rewritten in place except to enrich an entry with a URL it did not have.
- **Every** writer that today assigns `run.prNumber` appends instead of replacing, through one private store helper. That is not three call sites but **six**, and enumerating them is the difference between a projection and a field that drifts: the created-PR janitor (`store.ts:758`), `applyMarkerRefs` (`:862`), the draft-PR path (`server.ts:4127`), the step-0 regex extraction at run creation and on resume (`workflows/run.ts:769`, `:1835`) and the fire-and-forget LLM namer (`workflows/run.ts:3179`). A writer that keeps assigning `prNumber` directly is a writer that desynchronises the projection the first time it fires after an append.
- `markerRefs.pr` keeps its exact current meaning — "the PR the agent most recently declared as the subject" — so no prompt or marker grammar changes. What the marker *does* narrows, and that narrowing is declared in `BACKWARD_COMPATIBILITY.md` §8 rather than asserted away (see **Risks**).
- `prNumber` is written as the **primary** entry's number rather than the last declaration's, which is what makes the fix visible to every existing consumer (title prefixes, `taskReference`, the API DTO, scripts reading `runs.json`) without touching any of them. The primary is chosen by **provenance first, then order** — `created` beats `marker` beats `legacy` beats `derived` — so an explicit declaration still outranks a number the regex or the namer merely guessed from the task's text, exactly as it does today (`store.ts:848-852`).
- The cockpit renders the primary chip exactly as today, plus the remaining references as additional chips (or a `+N` overflow chip that expands), on all three surfaces.
- Records without `prRefs` — every run written before this change — derive a one-entry list at read time from today's fields, **with the provenance those fields actually carry**: `pullRequestUrl` seeds a `created` entry, `referencedPullRequestUrl` a `legacy` one, and a bare `prNumber` with no URL behind it seeds a `derived` one, because on most runs that number came from the regex over the task text or from the namer. **No migration, no rewrite, no repair step**, per the "state a user must migrate is not state" law in `AGENTS.md`.

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
| Persistence | `packages/cezar/src/runs/store.ts` | **New** `prRefSchema` + `prRefs` on `runRecordSchema` (optional, `.catch([])`), `MAX_PR_REFS`, a private `appendPrRef(run, ref)` helper and a public `recordPrRef(runId, ref)` entry point for callers outside the store, plus its in-store call sites: the created-PR janitor (`:758`), `applyMarkerRefs` (`:854`), and the derivation that seeds the list from legacy fields on first append. `trackReferencedPrs` (`:783`) is deliberately **not** a writer. |
| Persistence | `packages/cezar/src/server/server.ts` (`:4118-4127`) | The draft-PR route records the URL `createDraftPr` just returned as a `created` entry, beside its existing `pullRequestUrl: outcome.url` write, through `recordPrRef` — never by writing the array itself. (`packages/cezar/src/server/pr.ts` is a 7-line re-export barrel; `createDraftPr` itself lives at `packages/cezar/src/server/forge/github.ts:1401` and stays a pure forge call that persists nothing.) |
| Persistence | `packages/cezar/src/workflows/run.ts` (`:769`, `:1835`, `:3179`) | **The three writers a "projection" claim stands or falls on.** Step-0 regex extraction (`refineTaskRefs(extractTaskRefs(input.task))`) on create and on resume, and the fire-and-forget namer, all currently `updateRun({ prNumber })` directly. They stop writing the field and call `recordPrRef(runId, { number, origin: 'derived' })` instead; the store recomputes `prNumber` from the primary as it does for every other writer. The namer's existing `run.markerRefs?.pr === undefined` guard is kept — it stops the namer *overwriting a declaration*, which provenance ranking now also enforces structurally. |
| Wire contract | `packages/contract/src/runs.ts` | The same `prRefs` field on the run DTO schema (`:206` neighbourhood), so `contract-parity*.test.ts` and the typed client see it. Additive and optional — an old client ignores it. |
| Selector | `packages/web/src/lib/tasks-table.ts` | **New** `taskPrRefs(run, repoBase?)` — the single place the list is read, ordered, URL-enriched and legacy-derived. `taskPrUrl` and `taskReference` are re-expressed on top of it and keep their exact current signatures and results for one-PR runs. |
| UI | `packages/web/src/components/reference-chip.tsx` | **New** optional `state?: 'open' \| 'merged' \| 'closed'`, `muted?` (Phase 2 tinting) and `accessibleSuffix?` props. The last one is not cosmetic: today's accessible name is `Open the ${kind} for ${taskTitle}` (`:50`) with **no number in it**, so three sibling chips would expose three identical accessible names. The default rendering — and the default accessible name for a lone chip — stays byte-identical to today's. |
| UI | `packages/web/src/components/task-quick-list.tsx` (`:364`), `packages/web/src/routes/task-thread/run-header.tsx` (`:504`), `packages/web/src/routes/tasks-overview.tsx` (`:632`, `:884`) | Render the extra references beside the primary chip, per the density rules in **UI/UX**. |
| Hydration (Phase 2) | `packages/cezar/src/server/forge/github.ts`, `server.ts`, `packages/contract/src/github.ts`, `packages/web/src/api/{client,queries}.ts` | **New** windowed `GET /api/v1/github/pr-states?prs=…`, a structural sibling of the lazy checks endpoint (#664): degrade-in-payload (`{available:false, reason}`), 60s cache, capped list, never a 5xx. |

**Data flow (Phase 1).** Agent turn → `applyTurnMarkers` (`packages/cezar/src/workflows/run.ts:3226`) → `store.applyMarkerRefs` → `appendPrRef` (dedupe, cap) → `prNumber` recomputed from the primary → `touch()` → debounced `runs.json` write + SSE `run` payload → `taskPrRefs(run, repoBase)` → chips.

**Boundaries.** The store stays the only writer of run state; the cockpit stays a pure reader. No cross-module import is added. The Phase 2 endpoint lives in the GitHub family and obeys its law from `AGENTS.md`: no `gh`, no remote, offline ⇒ `{available:false, reason}`, never an error.

**Coordination note.** The pending spec PR #816 (*Linked-PR chips on the GitHub Issues list*) introduces an adjacent `LinkedPr` shape with the same `state: 'open' | 'merged' | 'closed'` vocabulary and the same lazy-window pattern. Whichever lands first owns the state-resolution helper and the chip's state tinting; the second one reuses it rather than defining a parallel shape. This is a review checkpoint, not a blocking dependency — Phase 1 here has no overlap at all.

## 📝 Data Model

One additive optional field on `RunRecord`, in both the persistence schema (`packages/cezar/src/runs/store.ts`) and the wire contract (`packages/contract/src/runs.ts`):

```ts
/** One pull request this task has been associated with (spec 2026-08-10-task-pr-reference-list).
 *  Transcript scrapings never land here — they stay in `referencedPrCandidates`; merging the two
 *  would rebuild the wrong-link defect #526. `origin` separates an authoritative association
 *  (created / declared) from a number the regex or the namer merely inferred, which is what lets
 *  the record hold both without one impersonating the other. */
const prRefSchema = z.object({
  number: z.number(),
  /** Absent when the association arrived as a bare declared or inferred number; the cockpit
   *  synthesizes the link from the PROJECT's repository only (the #526 rule), never from the
   *  transcript. */
  url: z.string().optional(),
  /** Provenance, and the FIRST key of the primary ordering, because these four sources are not
   *  equally trustworthy:
   *  'created' = this run opened it (`pullRequestUrl`, the strongest evidence there is);
   *  'marker'  = the agent declared it via `CEZ:PR=`;
   *  'legacy'  = derived once from an older record's `pullRequestUrl`/`referencedPullRequestUrl`;
   *  'derived' = the step-0 regex over the task's own text or the LLM namer's answer — a GUESS,
   *              which today `applyMarkerRefs` is explicitly allowed to overwrite
   *              (`store.ts:848-852`) and which must therefore never outrank a declaration. */
  origin: z.enum(['created', 'marker', 'legacy', 'derived']),
  /** ISO-8601 first-seen. The stable tiebreak WITHIN a provenance tier, and the list order. */
  at: z.string(),
});

/** Every PR this task has been associated with, oldest first. Append-only and deduplicated by
 *  number; an entry is only ever enriched (a URL added, an origin upgraded), never repointed.
 *  Capped at MAX_PR_REFS; the primary entry is never the one evicted. Absent on every pre-spec
 *  run — the cockpit derives a one-entry view instead, taking the provenance from the field it
 *  came from (`pullRequestUrl` → 'created', `referencedPullRequestUrl` → 'legacy', a bare
 *  `prNumber` → 'derived'), so nothing is migrated and nothing is rewritten. */
prRefs: z.array(prRefSchema).catch([]).optional(),
```

**Invariants.**

- **Append-only, deduplicated by `number`.** Re-declaring a number that is already present enriches it (adds a `url` it lacked, upgrades `origin` `derived → legacy → marker → created`) and leaves `at` and the position untouched. The upgrade direction matters: a number the regex guessed and the agent then *declared* becomes a real association, and gains the rank that comes with it.
- **Ordered by `at`,** which is insertion order. The order is stored, not recomputed on read, so it survives restarts and hand edits. Ordering is *insertion* order, never a claim about a stack's parent/base topology — cezar does not know it and does not pretend to.
- **Capped at `MAX_PR_REFS = 8`,** mirroring `MAX_PR_CANDIDATES` (`store.ts:296`). On overflow the **oldest non-primary** entry is dropped, `derived` entries first — the primary is what the user clicks; the newest is what they just made; an inferred middle entry is the cheapest thing to lose.
- **Primary selection (Phase 1): provenance first, then order.** Rank by `origin` (`created` > `marker` > `legacy` > `derived`), and within the winning tier take the earliest `at`. This preserves both rules that exist today — `pullRequestUrl` wins the display chip (`tasks-table.ts:135-138`), and a marker overwrites the regex/namer number (`store.ts:848-852`) — while giving #779 what it asks for: among equals, the **first** PR keeps priority. Deterministic and offline: no network, no flicker.
- **Primary selection (Phase 2): display only.** Among entries whose hydrated state is known, a `closed` (unmerged) entry loses the *rendered* primary slot to the next non-closed entry by the Phase 1 order. `merged` and `open` rank equally — a merged first PR stays primary over a later open follow-up, which is the reported expectation. Unknown state ranks as non-closed, so a GitHub outage degrades exactly to the Phase 1 order.
- **State is never persisted.** It lives in the query cache with the rest of the GitHub data.
- **`prNumber` is a projection — of the *offline* primary.** Every writer goes through the store helper, and the helper recomputes `prNumber` from the Phase 1 primary; no code path assigns the field directly (see the three `workflows/run.ts` writers in the Architecture table — un-migrated, they are exactly how a "projection" silently becomes a stale field again). Its type, presence rules and meaning to an external reader are unchanged.
- **The one deliberate divergence (Phase 2).** Because the Phase 2 demotion is display-only and `prNumber` is offline, a task whose first PR is closed renders `#B` as its primary chip while `prNumber` — and therefore the task title prefix (`workflows/run.ts:3233`, `auto-name.ts:198`), the run DTO and any script reading `runs.json` — still says `#A`. This is intended, not an oversight: a task's title must not silently rewrite itself because someone closed a PR on GitHub, and a projection fed by hydrated remote state would persist un-invalidatable remote truth into a local file, which is precisely what Q4 rejects. The popover is the reconciling surface — it shows every reference with its state, so the user can see why the chip and the title disagree. If this ever needs to change, it changes in the display tier alone.

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
- **Never rendered as an extra chip:** `derived` entries. They exist so `prNumber` has one owner, not so a regex guess earns a chip; a `derived` entry is painted only when it is the *sole* reference, which is exactly today's behaviour for such a run. The popover lists them last, labelled "inferred from the task text", so the provenance is inspectable without being loud.
- **Accessibility:** every chip stays a real link, but the accessible name must **distinguish siblings**, which today's `ReferenceChip` contract does not do — it renders `aria-label="Open the pull request for <task>"` (`reference-chip.tsx:50`) with no number, so a row of three chips reads as the same link three times. Each chip's accessible name carries its number and role: *"Open pull request #845 (declared) for &lt;task&gt;"*, *"…#812 (primary, opened by this task)…"*. The `+N` control is a button with `aria-expanded`, the popover is keyboard-dismissable, and the muted treatment keeps contrast above 4.5:1 against the row background rather than relying on opacity alone.
- **Non-goals:** cezar does not model a stack's parent/base topology. The stacked-PR ask on #779 is served as *navigation* — every PR in the stack is listed and clickable from one popover, in the order the task met them — not as a rendered dependency graph, which would need base-branch data the record does not hold and the GitHub API would have to supply per PR.
- **Unchanged:** the inert-text degradation for a non-`http(s)` URL (#431) and the "no invented links" rule (#526) — a declared number becomes a link only through the on-screen project's repository base (`useProjectRepoBase()`), never through a transcript-scraped host.

Visuals live beside this spec and are attached to its PR as evidence:

| File | Shows |
|---|---|
| `assets/task-pr-reference-list/current-01-tasks-overview.png` | Today: the Tasks overview Ref column and the sidebar, each with the single `#831` chip — the last declaration, with #812 and #824 from the same task already unreachable. |
| `assets/task-pr-reference-list/current-02-task-thread-header.png` | Today: the task-thread header meta line, same single chip. |
| `assets/task-pr-reference-list/mockup-01-task-thread-header.png` (`.html`) | Proposed: primary + inline chips + `+N`, with the popover listing every PR, its state and its origin. |
| `assets/task-pr-reference-list/mockup-02-sidebar-and-overview.png` (`.html`) | Proposed: the sidebar's count suffix and the overview Ref column's `+N`. |

The current-state captures come from the repository's own shared test environment (`.ai/scripts/test-env-up.sh`, `CEZ_DRY_RUN=1`) seeded with a task that declared three PRs — the reported reproduction, rendered.

## 📝 Edge Cases & Failure Scenarios

| Situation | Behavior |
|---|---|
| Agent re-declares the same number | Entry enriched in place; no duplicate, no reordering, no extra write beyond `touch()`. |
| Agent declares a PR it merely compared against | It becomes a *non-primary* entry. Today it destroys the correct chip — this is a strict improvement, and the popover's origin line makes the stray visible. |
| More than 8 associations | Oldest non-primary evicted, `derived` entries first. The primary and the newest are always present. |
| Task with no PR at all | `prRefs` absent, `taskPrRefs` returns `[]`, no chip — identical to today. |
| Pre-spec record (no `prRefs`) | One seeded entry: `pullRequestUrl` → `created`, else `referencedPullRequestUrl` → `legacy`, else a bare `prNumber` → `derived`. Identical rendering to today. |
| Task text names a PR the run then supersedes | Step 0 records `#A` as `derived`; the agent declares `CEZ:PR=B` → `#B` is a `marker` entry and takes the primary slot, because `marker` outranks `derived`. This is today's behaviour preserved (`store.ts:848-852`), and it is the case a pure first-seen rule would have broken. |
| The namer answers after a PR was created | The namer appends a `derived` entry and can never displace the `created` primary — and, because it no longer assigns `prNumber` directly, it can no longer leave `prNumber` naming a PR that is not in the list. |
| Both `#A` and `#B` declared, `#A` later closed | Phase 1: `#A` stays primary (earliest `marker`). Phase 2: `#B` renders primary and `#A` is muted, while `prNumber` and the task title keep saying `#A` — deliberate, see **Data Model**. |
| Issue-subject run (`CEZ:ISSUE` and no `CEZ:PR`) | Still shows no PR chip: the #526 guard in `taskPrUrl` is carried into `taskPrRefs` verbatim. |
| Declared number, no URL anywhere, no `repoBase` | Inert chip showing `#N` — today's degradation, unchanged. |
| Hand-edited / corrupt `prRefs` | `.catch([])` empties that field only; the run parses and falls back to the legacy derivation. |
| Older cezar rewrites the file | Field stripped; behavior collapses to today's. Documented, not fatal. |
| GitHub unreachable / no `gh` / offline (Phase 2) | `{available:false, reason}`; chips keep declaration order and neutral tint. No dimming, no reordering, no error surface. |
| PR deleted or number belongs to another repo | State comes back `null` ⇒ neutral chip, still clickable if a URL is known. cezar never asserts a state it did not read. |
| Two turns declare different PRs concurrently | The store is single-threaded per project; appends are ordered by arrival, and dedupe makes a replay idempotent. |

## 📝 Risks & Impact Review

- **Blast radius: the display tier of the task record.** Every action gate (`Draft PR`, `Create PR → View PR`, push) keeps reading `pullRequestUrl` directly and is untouched. The riskiest single line is the `prNumber` write becoming a projection — and the risk is not the line, it is the **five other places that also write that field** (`store.ts:758`, `server.ts:4127`, `workflows/run.ts:769`, `:1835`, `:3179`). Migrating them all is a hard requirement of Phase 1, not a follow-up; one left behind reintroduces a `prNumber` that names a PR absent from `prRefs`, and nothing ever repairs it. Covered by the existing marker/namer precedence tests plus new ones asserting the projection holds after each writer fires.
- **`runs.json` (§3):** additive, optional, `.catch`-guarded, no migration. The documented downgrade behavior (field stripped on an older cezar's write) is the only compatibility cost and it is non-destructive.
- **HTTP API (§2):** unchanged in Phase 1. Phase 2 adds one route that must be inventoried in `BACKWARD_COMPATIBILITY.md` §2 (`bc-route-inventory.test.ts` fails otherwise) and must answer identically on its legacy, project-scoped and `/api/v1` spellings (`route-parity.test.ts`, and the `/api/v1` surface suite `versioned-surface.test.ts`).
- **Agent marker vocabulary (§8) — a declared narrowing, not "unchanged".** The grammar, the parser and `markerRefs.pr` are untouched, but §8 protects *what an emitted marker does*, and that does change: after Phase 1, `CEZ:PR=B` adds a reference and takes the primary chip only if no earlier `created`/`marker` entry outranks it, where today it unconditionally becomes the shown PR. Two consequences follow and both are Phase 1 work (step 9): a §8 entry recording the narrowing with #779's argument, and an amendment to the handoff instruction at `packages/cezar/src/handoff.ts:152` — *"Re-emit with the new number if the subject changes"* — which otherwise promises agents an effect they no longer get. No skill or prompt outside that instruction text needs an edit, and older agents stay correct: emitting the marker is still the right thing to do, it simply accumulates.
- **Rollback story:** Phase 1 is revertible by reverting the commits — records that already carry `prRefs` stay parseable by the reverted code (unknown key, ignored) and render from the legacy fields, which the new code kept writing all along. That "keep writing the projections" rule is what makes rollback free, and it is the reason `prNumber` is not dropped in favour of the list.
- **Performance:** at most 8 small objects per run in a file that already holds step arrays; the debounced atomic write is unchanged. Phase 2 adds one cached, windowed request per visible screen, matching the checks-glyph budget.
- **What could still go wrong:** the primary-selection rule is a product judgement, not a fact. Phase 1 ships the offline rule (created, else first-seen); if the Phase 2 state rule turns out to feel wrong, it is a pure display-layer change with no persisted consequence.

## 📋 Phasing

- **Phase 1 — the list and the chips (offline).** `prRefs` in both schemas, append-on-write, `prNumber` as a projection, legacy derivation, all three surfaces rendering every reference. Independently shippable and it alone closes #779's data loss: no PR link ever disappears again.
- **Phase 2 — state-aware priority and tinting.** The windowed `pr-states` endpoint, closed-PR demotion and muting, merged tint. Independently shippable; without it Phase 1 simply shows every PR in declaration order.
- **Phase 3 (optional, demand-gated) — the same primitive for issues.** `issueRefs` reusing `prRefSchema`'s shape and the same selector. Deliberately not scheduled: the reporter notes the issue side "bites much less in practice", and shipping it unasked doubles the surface for no reported pain.

## 📋 Implementation Plan

**Phase 1 — the list and the chips**

1. **Schema + helper.** Add `prRefSchema`, `prRefs`, `MAX_PR_REFS = 8`, the private `appendPrRef(run, {number, url?, origin})` and the public `recordPrRef(runId, ref)` to `packages/cezar/src/runs/store.ts`: seeds the list from the legacy fields on first append (with the provenance those fields carry), dedupes by number, enriches `url` and upgrades `origin`, evicts the oldest non-primary (`derived` first) at the cap, and recomputes `prNumber` from the provenance-ranked primary. Unit tests: fresh append, duplicate enrich, `derived → marker` upgrade, cap eviction keeping primary + newest, seeding provenance per source field. App keeps working — nothing calls it yet.
2. **Wire `applyMarkerRefs`.** Replace `run.prNumber = refs.pr` with an `appendPrRef(..., 'marker')` call; `markerRefs.pr` and the `referencedPullRequestUrl` re-resolution stay exactly as they are. Extend `store.test.ts`: two declarations keep both numbers, the first stays primary, `prNumber` reports the primary, a third declaration of the first number changes nothing, and **a declaration still beats a `derived` number from the task text** (today's `store.ts:848-852` rule, now enforced by rank).
3. **Wire the created tier.** The janitor (`store.ts:758`) and the draft-PR route (`packages/cezar/src/server/server.ts:4118-4127`, beside its existing `pullRequestUrl: outcome.url` write — note that `server/pr.ts` is only a re-export barrel and `createDraftPr` in `forge/github.ts:1401` persists nothing) append a `created` entry. Test: a created PR is primary even when a marker declared a different PR first.
4. **Retire the remaining `prNumber` writers.** `packages/cezar/src/workflows/run.ts:769`, `:1835` (step-0 regex extraction on create and resume) and `:3179` (the fire-and-forget namer) stop calling `updateRun({ prNumber })` and call `recordPrRef(..., 'derived')` instead; the namer keeps its `markerRefs?.pr === undefined` guard. **This step is what makes the projection true** — without it `prNumber` silently drifts out of the list. Regression test: create a run from the task text *"port the fix from pr 441"*, let it open PR #900, then fire the namer with a different number, and assert `prNumber === 900`, that `441` is present as a non-primary `derived` entry, and that no number outside `prRefs` is ever persisted in `prNumber`.
5. **Contract.** Mirror `prRefs` in `packages/contract/src/runs.ts`; run the contract-parity suites. Test: a `RunRecord` carrying the field round-trips through `GET /api/runs/:id` unchanged.
6. **Selector.** Add `taskPrRefs(run, repoBase?)` to `packages/web/src/lib/tasks-table.ts`, re-express `taskPrUrl`/`taskReference` on it, and prove in `tasks-table.test.ts` that every existing case (created wins, #526 issue-subject guard, legacy record, no-PR run) returns byte-identical results. `derived` entries are excluded from the rendered list unless they are the only one.
7. **Task-thread header.** Render primary + 2 inline + `+N` popover in `run-header.tsx`, each chip carrying its own accessible name (number + role) via the new `accessibleSuffix` prop. Component test: three references produce three reachable links with three *distinct* accessible names; one reference renders exactly today's markup and today's `aria-label`.
8. **Tasks overview.** Same treatment in the Ref column and the card view (`tasks-overview.tsx`).
9. **Sidebar.** Count suffix and enumerated `title`/`aria-label` in `task-quick-list.tsx` (no popover).
10. **Docs.** `BACKWARD_COMPATIBILITY.md` §3 bullet for `prRefs` (including the downgrade note); the **§8 entry** recording the narrowing of `CEZ:PR=`'s display effect; the matching amendment to the handoff instruction text at `packages/cezar/src/handoff.ts:152`; a CHANGELOG entry; and the `AGENTS.md` runs-store row if the invariant list there needs the append-only rule.

**Phase 2 — state-aware priority and tinting**

11. **Forge.** `fetchGithubPrStates(repoRoot, numbers, refresh?)` in `packages/cezar/src/server/forge/github.ts`: one aliased GraphQL query, 60 s cache, `CEZ_DRY_RUN` mock branch, `__clear…ForTests` hook — mirroring `fetchGithubChecks`. Reuses the cached `resolveRepoHandle`. Tests: state mapping (open/merged/closed), degradation to `{available:false}`.
12. **Contract + route.** `prStatesDataSchema` in `packages/contract/src/github.ts`; the chained `.get('/github/pr-states', …)` link with the CSV validation and cap of the checks sibling; §2 inventory entry. Tests: `route-parity.test.ts`, the `/api/v1` surface suite `versioned-surface.test.ts`, `bc-route-inventory.test.ts`, 400 on a malformed list.
13. **Client + query.** `getGithubPrStates` and `useGithubPrStates(numbers, enabled)` next to their checks counterparts.
14. **Display rules.** `state`/`muted` props on `ReferenceChip`; ordering and primary demotion applied inside `taskPrRefs` from the hydrated map (never from the record, and never into `prNumber`). Tests: a closed primary hands the *rendered* slot to the next non-closed entry while `prNumber` and the task title are asserted unchanged; unknown state reproduces the Phase 1 order exactly.
15. **Screens.** Wire the on-screen window on the three surfaces; verify against the mockups with a UI pass.

**Phase 3 (only if requested)**

16. `issueRefs` reusing the same schema, writers and selector shape, with the `CEZ:ISSUE` marker semantics left untouched.

## 📝 Testability

Every phase above is verifiable without a live GitHub, which is the property that keeps this
shippable in CI:

- **Store invariants** (`packages/cezar/src/runs/store.test.ts`) — append, dedupe-and-enrich,
  provenance upgrade, cap eviction, seeding provenance per source field, and the invariant that
  matters most: **after every writer fires, `prNumber` equals the primary of `prRefs`, and no
  number outside `prRefs` is ever persisted in it.** That last one is a property test worth
  writing as such — drive the six writers in random order and assert the projection holds.
- **Precedence regressions** — the existing marker/namer precedence cases keep passing unchanged;
  new cases pin the rules this spec preserves rather than invents (`created` beats `marker`,
  `marker` beats `derived`, earliest-within-tier beats later).
- **Backward compatibility** — a fixture `runs.json` written by today's cezar loads with no
  `prRefs`, renders identically, and gains a correctly-provenanced list on its first append; a
  hand-corrupted `prRefs` degrades to `[]` with the record intact.
- **Contract** — `contract-parity.runs.test.ts` and a round-trip through `GET /api/runs/:id`.
- **Phase 2 offline** — `CEZ_DRY_RUN` mock branch in the forge helper, plus an explicit test that
  `{available:false}` reproduces the Phase 1 order and tint exactly.
- **UI** — component tests for one chip (byte-identical markup and accessible name to today) and
  for three (three reachable links, three *distinct* accessible names, `+N` popover keyboard-
  dismissable), and a UI pass against the committed mockups.

Not covered by automated tests, and deliberately so: whether the provenance ranking *feels* right
across a week of real tasks. It is a display-tier rule with no persisted consequence beyond
`prNumber`, so it stays cheap to change after the fact.
