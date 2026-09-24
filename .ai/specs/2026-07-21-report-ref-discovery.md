# Report-tier reference discovery — skill report lines and issue links

Status: implemented · Date: 2026-07-21 · Relates: spec 2026-07-18-task-ref-markers
(the CEZ:* tier above this one), spec 2026-07-16-pr-autodiscovery (the fuzzy URL
tier below it), open-mercato/skills#38 (the emitter-side contract change)

## Problem

The open-mercato pipeline skills changed their chaining hand-off format
(open-mercato/skills#38): instead of the env-style `PR_URL=` / `PR_NUMBER=` /
`SPEC_PATH=` markers, every PR-producing skill now ends its report with fixed,
human-friendly reference lines:

```
Issue: #433 (link: https://github.com/owner/repo/issues/433)
PR: #442 (link: https://github.com/owner/repo/pull/442)
Spec: .ai/specs/2026-07-21-foo.md
```

cezar discovered PR numbers from those sessions only via the fuzzy URL janitor
(spec 2026-07-16) or an explicit `CEZ:PR` declaration — the report lines
themselves were invisible, and **issue** links in conversation were never
discovered at all (only the task prompt's issue reference seeded
`issueNumber`).

## The change

### 1. Report-tier marker parsing (`src/runs/task-markers.ts`)

`parseTaskMarkers` now also recognizes, line-anchored and exact-shape, in the
accumulated turn text (the agent's own words — same trust boundary as `CEZ:*`):

- `PR: #<n> (link: <url>)` and `Issue: #<n> (link: <url>)` — the new skill
  report lines;
- `PR_NUMBER=<n>`, `PR_URL=<…/pull/n>`, `ISSUE_NUMBER=<n>` — the legacy
  markers older skill versions still emit.

Precedence inside one turn: `CEZ:PR`/`CEZ:ISSUE` (explicit declaration) >
report line > legacy marker; last occurrence wins within each tier, later
turns win over earlier ones — all through the existing `applyMarkerRefs`
pipeline, so a recognized report line behaves exactly like a `CEZ:*`
declaration (owns the display tier, filters the referenced-URL candidates,
silences the namer for that kind).

`stripTaskMarkers` is unchanged: only `CEZ:*` control lines are stripped from
display — the report lines are human-readable by design and stay visible.

### 2. Referenced-issue janitor (`src/runs/store.ts`)

A mirror of the referenced-PR tier for `github.com/…/issues/N` links spotted
in event text (issue links in conversation are unambiguous URLs — "links are
pretty distinguished"):

- New optional record fields `referencedIssueUrl` + `referencedIssueCandidates`
  (additive — old `runs.json` files keep parsing).
- Same resolution rule via the now-shared `resolveReferencedRef`: a declared
  issue number filters candidates outright; otherwise one distinct URL is the
  subject; several resolve only when the task prompt names exactly one;
  ambiguity clears the chip; and the winner is **repo-scoped** — a foreign
  `owner/repo` resolves only when the task prompt names it.
- **Amendment — the issue tier is repo-scoped too (#945).** Sharing
  `resolveReferencedRef` meant sharing its hole: an issue link to another
  repository, spotted once in a transcript, became the task's subject. It now
  shares the repo-scope guard as well — see the amendment in
  `2026-07-16-pr-autodiscovery.md` for the rule, the corroboration source, and
  why an unknown repository keeps the pre-#945 behavior. The issue side had
  one extra edge the PR side does not: a vetoed URL must not seed
  `issueNumber` either. It cannot — the seed below is gated on a resolution
  existing — and when the heal drops a stored foreign URL it revokes the
  number alongside it, but only when `referencedIssueNumberSeeded` says the
  janitor is the one who wrote it.
- An unambiguous resolution seeds `issueNumber` when nothing owns that field;
  the persisted `referencedIssueNumberSeeded` provenance bit lets ambiguity
  take back only the janitor's own seed, including after a restart. Prompt,
  marker, and namer writes clear that provenance and are never revoked merely
  because their number equals the previous fuzzy resolution.
- Issue tracking runs regardless of the created-PR state — a task that opened
  a PR can still be *about* an issue.

## Degradation & compatibility

- Additive only: no marker/report line → every existing layer behaves as
  before. The `CEZ:*` vocabulary and the handoff instruction fragment are
  untouched — `CEZ:PR`/`CEZ:ISSUE` remain the explicit override.
- Sessions running **older** skill versions keep working via the legacy
  `PR_URL=`/`PR_NUMBER=` parsing; sessions running the new skills work with
  **older** cezars through the URL janitor (the report line contains the URL).
- The cockpit renders the strongest known task reference in the tasks table:
  PR first, otherwise issue. Issue URLs are seeded from the prompt at run
  creation, so an issue-driven run has its linked issue chip while queued
  (#554), before the first agent event.

## Test plan

- `task-markers` matrix: report lines parse; CEZ outranks report outranks
  legacy within a turn; last-wins; line-anchoring (prose mentions, list
  markers, decorated/suffixed lines, skill-doc placeholders are inert);
  CRLF tolerance; strip leaves report lines visible.
- Store: single-link adoption + `issueNumber` seed; independence from the
  created-PR tier; ambiguity clearing the chip and a persisted janitor seed;
  ambiguity preserving an equal prompt-owned number; task-prompt
  disambiguation; declared-issue candidate filtering; marker-owned
  `issueNumber` never overwritten by stray links.
