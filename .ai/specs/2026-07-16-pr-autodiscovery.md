# PR auto-discovery from the conversation (#407)

Status: IMPLEMENTED 2026-07-16 · Fixes: #407 · Extends: the `#fake-pr` janitor guard in `src/runs/store.ts`, spec 009 (review gate / draft PR)

## Problem

The task list's PR chip is driven by one field, `RunRecord.pullRequestUrl`,
with exactly two writers: the cockpit's own Draft-PR flow (authoritative) and
the transcript janitor in `RunStore.appendEvent`. The janitor has two gaps:

1. **It never sees protocol-v2 (ACP-style) events.** It scans only the
   top-level v1 fields `text` / `result` / `message`; v2 events carry all
   content nested under `item.*` (`item.text`, `item.title`, `item.input`,
   `item.output`). A PR URL that only ever appears in a v2 item is persisted
   to the NDJSON but never spotted.
2. **A task that works ON an existing PR gets no chip at all.** The
   `CREATED_PR_RE` guard (the `#fake-pr` rule) adopts a URL only when the
   agent *created* the PR. That guard is correct — a reviewer must not be
   mislabeled as the PR's author — but it leaves review/continue/merge tasks
   (`om-auto-review-pr 4170`, …) with no PR association whatsoever, which is
   issue #407.

## Model: two tiers of PR association

| Tier | Field | Meaning | Writers |
|---|---|---|---|
| created | `pullRequestUrl` | The PR this task **opened** | Draft-PR flow; janitor with the `CREATED_PR_RE` guard (unchanged semantics) |
| referenced | `referencedPullRequestUrl` | The PR this task is **about** | janitor, from PR URLs referenced anywhere in the conversation |

The created tier always wins. Both fields are additive and optional — old
`runs.json` files keep parsing (store rule in `AGENTS.md`).

## Discovery rules (janitor, `RunStore`)

- **Sources scanned**, per persisted event: the v1 fields `text` / `result` /
  `message`, plus for v2 events `item.text`, `item.title`, `item.output` and
  `item.input` (stringified when not a string). `kind: 'reasoning'` items are
  skipped — thinking text speculates about PRs it never touches. The initial
  task prompt is scanned once at `createRun`, so a prompt that pastes a PR
  URL gets its chip before the first event.
- **Created detection (unchanged rule, wider sources):** a PR URL adopted
  into `pullRequestUrl` only when the same event also matches
  `CREATED_PR_RE`. Scanning v2 sources fixes creation detection for backends
  that report `gh pr create` through tool items.
  - **Amendment — where the claim may come from.** Matching `CREATED_PR_RE`
    against *everything* an event carried made tool OUTPUT able to claim
    authorship: a task that printed a log, a stored transcript or a test
    fixture containing someone else's `gh pr create` line adopted their PR —
    in another repository — and, because the first adoption freezes the tier,
    never looked at the one it really opened. The claim is now read from
    `eventCreationClaimFragments` (the agent's own turn text, an assistant
    message item, and the tool TITLE cezar renders from the command it saw
    run) while the URL is still taken from the whole event, since `gh` prints
    it in the output. The referenced tier is untouched by this: it may be
    wrong about a *subject*, never about *authorship*.
- **Referenced detection:** every distinct PR URL spotted accumulates into
  `referencedPrCandidates` (capped at 8 — beyond that the conversation is a
  survey, not a subject). `referencedPullRequestUrl` is then resolved:
  - exactly **one** distinct candidate → that URL;
  - several candidates → the one whose PR **number appears in the task
    prompt** (`om-auto-review-pr 4170` + `…/pull/4170`), and only when
    exactly one candidate matches;
  - otherwise → unset. Ambiguity **clears** a previously resolved value —
    a wrong chip is worse than no chip.
  - and finally, whatever the rules above produced is **repo-scoped**: a
    winner whose `owner/repo` is not the project's own resolves only when the
    **task prompt** names that `owner/repo` (a pasted URL does inherently).
    Otherwise → unset.
  - **Amendment — the resolution is repo-scoped (#945).** The rules above were
    text-scoped but never repo-scoped: `PR_URL_RE` matches *any*
    `github.com/<owner>/<repo>/pull/N`, so "exactly one distinct candidate"
    adopted a pull request the project has nothing to do with. A research task
    is exactly that shape — an `oko` task that read about migration safety,
    cited one upstream `supabase/cli` PR, and wore `#6056` as its subject.
    This is the `CREATED_PR_RE` amendment above one tier down: the same
    failure (a URL from another repository adopted as this task's), and the
    same remedy (ask where the claim came from before believing it). The
    prompt is the corroborating source because it is the trust boundary this
    module already uses, and it preserves the legitimate cross-repo case
    (#819 — `om-auto-fix-pr https://github.com/other/repo/pull/1977` started
    from a different project). Candidates are still **collected** unscoped:
    the guard changes what is *promoted*, never what is *recorded*. With no
    known repository — no `gh`, no remote, a non-git root — behavior is
    exactly the pre-#945 rules, and the guard is strictly subtractive, so it
    can only ever lose a resolution, never gain one. The project's handle
    arrives asynchronously (`RunStore.setRepoHandle`), and its arrival also
    heals records the un-scoped rule already poisoned.
- Once `pullRequestUrl` (created tier) is set, all discovery stops.
- Candidates persist on the record so a restart/resume re-evaluates from the
  same working set instead of re-adopting the next URL as "the only one".

## UI

- **Display chips** read `pullRequestUrl ?? referencedPullRequestUrl` via the
  `taskPrUrl()` helper (`web/app/src/lib/tasks-table.ts`): the sidebar
  quick-list chip, both Tasks-table chips, and the thread footer's `PR ↗`.
- **Action gates stay created-tier only**: the review panel's Draft-PR button
  (`review-panel.tsx`) and the git-panel's Create-PR→View-PR flip
  (`git-actions.ts`) still read `pullRequestUrl` alone — a task that reviewed
  PR X must still be able to open its own PR from its branch.

## Out of scope

- Building a PR URL from a bare number in the prompt (needs remote inference;
  the conversation reliably echoes the full URL anyway).
- Parsing `todos.json` / handoff files for PR URLs — separate channels with
  their own consumers.
- A dedicated ACP metadata side-channel for the agent to *declare* its
  subject PR. If discovery-by-reference proves too fuzzy, that is the next
  step; the two-tier record model already accommodates it (the declaration
  would simply write the referenced tier).

> **That next step landed (2026-07-18):** discovery-by-reference did prove too
> fuzzy (wrong-chip reports, e.g. #777 on an issue-#500 task). Spec
> `2026-07-18-task-ref-markers.md` adds the in-band `CEZ:PR=<n>` declaration;
> when present it owns the referenced tier's resolution (a candidate URL must
> end in the declared number). The created tier and this spec's janitor rules
> are unchanged for runs without markers.
