# In-band task-reference markers — CEZ:PR / CEZ:ISSUE / CEZ:TITLE

Status: proposed · Date: 2026-07-18 · Owner direction 2026-07-18 · Relates:
spec 2026-07-16-pr-autodiscovery (the fuzzy tier this overrides), spec
2026-07-17-task-auto-naming (the namer this can silence), #347 (`CEZ:DONE`,
the marker this extends)

## Problem

PR-number auto-discovery still mislabels tasks. Real failure from the cockpit
(2026-07-18): a task implementing issue #500 wears a `#777` PR chip. The chain
that produces it:

- The **referenced-PR janitor** (spec 2026-07-16) adopts any
  `github.com/…/pull/N` URL the conversation mentions. One stray URL — a PR the
  agent merely listed, a link inside a fetched issue body — becomes "the PR this
  task is about" the moment it is the only candidate.
- The **LLM namer** (spec 2026-07-17) extracts `pr`/`issue` numbers from the
  *task prompt* with a regex cross-check, so it cannot know about a PR that only
  exists mid-conversation — and it costs one extra model call per refresh.

Both layers are outside observers guessing at what the agent already knows.
The agent *knows* which PR/issue it is working on — it opened it, or was told.

## Owner decision — supersedes a prior rejection

Spec 2026-07-17 §"Rejected: in-band title markers" declined in-band markers for
*titles* (prompt contamination, cross-backend reliability, one-turn latency),
following the surveyed tools. The owner explicitly overrode that on 2026-07-18
for **reference discovery**: the separate-call approach keeps failing on
conversation-borne references and burns tokens; the main thread should declare
its subject the way it already declares completion (`CEZ:DONE`). Titles come
along as an *optional* marker because they share the transport for free — the
namer remains the default title mechanism.

## The protocol

Three new markers join `CEZ:DONE` in the agent's plain-text output. Each stands
on its own line, anywhere in a turn:

```
CEZ:PR=<number>      the GitHub pull request this task is working on / opened
CEZ:ISSUE=<number>   the GitHub issue this task is working on
CEZ:TITLE=<phrase>   optional: a terse task title (≤ ~40 chars, gerund phrase)
```

Rules, mirrored in the handoff system-prompt fragment (`src/handoff.ts`):

- Emit a marker as soon as the subject is known (typically the first turn), and
  again whenever it changes (e.g. the task later opens its own PR). The **last
  occurrence in a turn wins**; later turns win over earlier ones.
- Markers are for the *subject* of the task — never a PR/issue that is merely
  mentioned, compared against, or listed.
- Plain message text only — never inside a code fence, never in tool input.

### Parsing (`src/runs/task-markers.ts`)

Line-anchored, case-sensitive: `/^CEZ:PR=(\d+)\s*$/m`,
`/^CEZ:ISSUE=(\d+)\s*$/m`, `/^CEZ:TITLE=(.+)$/m` (title trimmed, clipped to the
namer's `TITLE_MAX` budget by the shared post-validation). Numbers share
`task-refs.ts`'s `MAX_REF` sanity bound. The instruction text's own
`CEZ:PR=<number>` placeholder is non-numeric and can never parse — a literal
echo of the contract is inert.

Parsing input is the **accumulated turn text** the engine already collects for
`CEZ:DONE` (`turnText` in `run.ts`) — the main thread's own words. Tool
results, tool inputs and reasoning text are never scanned, so an agent *reading*
this spec or `handoff.ts` cannot poison its own record via tool output echoes.

## Precedence — who owns each field

| Field | marker | namer (LLM) | janitor (regex) | user |
|---|---|---|---|---|
| `prNumber` / `issueNumber` | **wins** | only while no marker of that kind | seed at creation (task prompt regex) | — |
| `referencedPullRequestUrl` | marker number filters candidates — only a URL ending in the declared number resolves; no match → unset (no chip beats a wrong chip). Exception: a number equal to the created PR's is ignored here — see the amendment below | — | fuzzy resolution only while no `CEZ:PR` marker | — |
| `pullRequestUrl` (created tier) | untouched — `CREATED_PR_RE` / cockpit draft-PR flow stay authoritative | — | unchanged | — |
| `titleSummary` | `CEZ:TITLE` wins over namer | only while `titleOrigin` is unset/`auto` | — | **PATCH rename always wins** (`titleOrigin: 'user'`) |

### Amendment — a declaration naming the PR the run CREATED

The instruction fragment asks the agent to re-emit `CEZ:PR` when it opens a PR later in the task,
so on such a run the LAST declaration is the number of the run's OWN PR — not the PR it is about.
Fed to the referenced tier that declaration erased the subject: no candidate ends in the created
number, and "no match → unset" cleared the chip (seen on a task started on open-mercato#4326 that
pushed a follow-up as #5366 and dropped from two chips to one).

So a declaration equal to the number in `pullRequestUrl` is read as a statement about the
**created** tier, which already carries it, and the referenced tier resolves as if it had not been
made (`referencedPrDeclaration`, `src/runs/store.ts`). `prNumber` follows the same rule: such a
declaration only FILLS it, never overwrites the about-number the task came in with. Both writers
(`applyMarkerRefs`, and the janitor at the moment it adopts a created URL) go through the one
helper, so the marker and the creation evidence may arrive in either order. Records already
written the old way are healed on load by `reconcileLoadedRun` — one-directional, so it can only
restore a chip, never remove one.

### Amendment — an uncorroborated declaration leads the chips

`taskReferences` (cockpit) orders references created-PR first, then about-PR, then issue. One thing
now sits ahead of all of them: a `CEZ:PR` number that **no** scraped URL on the record carries.
Normally there is none — the agent re-declares with the PR it opened, so the declaration IS the
created URL and the order is unchanged. When there IS one, the URL tier is naming something the
agent never did, and that tier is the one built from transcript guesses: a task that quoted
another run's `gh pr create` line was credited with that run's PR and it led every list, hiding
the PR the task had actually opened behind it. A statement the agent made outranks a line a
janitor found.

Record model (additive, old `runs.json` files keep parsing):

- `markerRefs?: { pr?: number; issue?: number }` — what the agent declared;
  presence of a kind blocks the namer from writing that kind.
- `titleOrigin` gains `'marker'`: precedence `user > marker > auto`.

### Token optimization

Once a run holds a `titleOrigin: 'marker'` title, the live-refresh namer call
(`maybeRefreshTitle`, one cheap-model call per turn end) is **skipped** for that
run — the main thread has taken ownership and can re-emit `CEZ:TITLE` any time.
Creation-time naming is untouched (it races the first turn and still provides
the instant-quality title for agents that never emit markers). Runs without
markers behave exactly as today — markers are a fast path, not a dependency.

## Display

Marker lines are stripped from rendered transcript text, exactly like
`CEZ:DONE`: the server strips complete marker lines from v1 `text` events
before persisting; the cockpit's `thread-state.ts` strips them from v2 message
items at display time (v2 persists raw — the store's NDJSON is the honest
record). A marker split across v1 text chunks may transiently render; the
parse itself always runs on the whole turn text, so state is never affected.

## Degradation & safety

- No marker → no change: every existing discovery layer keeps running.
- Markers only steer **display tiers**. Action gates (Draft PR button,
  Create-PR→View-PR flip) keep reading `pullRequestUrl` — an agent cannot
  claim authorship of a PR it didn't open.
- Zero-config: no new env var, no toggle. Parsing is free; the instruction
  fragment costs ~70 tokens per run — the calls it saves cost more.
- Dry-run: `scripts/mock-claude.mjs` answers `mock:refs` with a canned
  marker block so the wiring is testable offline.

## Compatibility

The marker vocabulary (`CEZ:DONE`, `CEZ:PR`, `CEZ:ISSUE`, `CEZ:TITLE`) is an
agent-facing contract: **additive-only**. Removing or renaming a marker, or
changing what an emitted marker does, follows the deprecation path in
`BACKWARD_COMPATIBILITY.md`. New markers may be added freely — unknown
`CEZ:*` lines are inert prose to older cezars, which is the property that makes
the protocol forward-compatible.

## Test plan

- `task-markers` unit matrix: each marker, last-wins, line anchoring, code-fence
  text is still matched only when line-anchored (documented residual), the
  `<number>` placeholder never parses, `MAX_REF` bound, title clipping.
- Store: marker-aware referenced resolution (declared number picks among
  candidates; contradiction clears; created tier untouched).
- Engine integration (dry-run pattern of `run.test.ts`): a turn carrying
  markers sets `prNumber`/`issueNumber`/`markerRefs`/title; namer results no
  longer override marker-owned kinds; live refresh skipped after a marker
  title; user rename still beats everything.
- Web: marker lines invisible in rendered v2 message text.
