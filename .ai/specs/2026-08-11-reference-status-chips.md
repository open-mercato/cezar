# Reference status on PR/issue chips

**Date:** 2026-08-11
**Status:** implemented

## The problem

Every task surface already paints the PR or issue a task points at — `#402` in the sidebar row, in
the per-project table's Ref column, on the global Tasks page, in the run header. All of them paint
it identically, because the run record carries a number and a URL and nothing else. So a merged PR,
a PR that has been red for two days, a draft nobody has opened, and a PR that was closed without
merging all look the same: a violet chip with a number in it.

That is the one thing a reader of those tables actually wants to know. "Which of these forty tasks
still needs me?" is answered by the state of the thing each one points at, and today the only way
to find out is to click through, one at a time, to GitHub.

## What ships

A reference chip carries the state of the thing it points at, in three redundant channels:

- **Colour** — done is violet, fine is green, waiting on a reviewer is blue, a running build turns
  the chip amber end to end (not just its dot, which reads as neutral when a table is scanned), and
  anything wrong is red. Two of those needed a new token; see below.
- **An icon** — GitHub's own glyph vocabulary (draft PR, merged, closed PR, check, cross, issue
  dot, slash), so the state is legible before anything is hovered.
- **A tooltip** — the state in words plus a clause of explanation ("Ready to merge — open, checks
  pass, nothing is waiting on a reviewer"), on hover and on keyboard focus.

Three channels rather than one because each fails alone: colour is invisible to a colourblind
reader, an icon is a rebus until it has been learned, and a tooltip is not there until you go
looking. The status also reaches the chip's accessible name, so a screen reader gets what the
colour says.

### The vocabulary

Pull requests: `merged`, `closed` (closed *without* merging), `draft`, `checks-pending`,
`changes-requested`, `checks-failing`, `review-required`, `ready`.
Issues: `open`, `completed`, `not-planned`.

The two kinds share no value on purpose. A closed PR (abandoned) and a closed issue (`completed` —
done) are opposite outcomes wearing the same English word, and collapsing them is how a dropped
task comes to look like a landed one.

Precedence for a PR. Read the ranking as **whose move is it** — which is the question a table is
actually scanned for, and it maps onto the colours: danger is the author's move, info is the
reviewer's, amber is the machine's.

1. `merged` / `closed` — nobody's. Terminal, whatever checks or reviews say.
2. `draft` — the author's, and they have said so themselves.
3. `checks-pending` — the machine's. CI running means a commit was **just pushed**, the newest
   thing that has happened to this PR, so it beats a requested change unconditionally.
4. `changes-requested` — the **author's**, and only while that is still true: the review must be
   about the code that is there now, with no re-review already asked for.
5. `checks-failing` — the author's again. A reviewer cannot approve a red PR anyway.
6. `review-required` — the **reviewer's**: they have been asked, or the author has answered and the
   merge is now blocked on someone coming back to look.
7. `ready` — open, not a draft, nothing failing, nothing running, nobody waited on.

The subtle step is (4) → (6), and it is a data finding rather than a preference. **`reviewDecision`
stays `CHANGES_REQUESTED` after the author has responded** — GitHub does not clear it until a
reviewer submits again — so on its own it points at the author forever. Two signals say the ball
has moved back, and either is enough:

- **A still-standing review request made _after_ the review** (`reviewRequests`, dated by the newest
  `ReviewRequestedEvent` **for a reviewer who is still on the list**) — the author clicking
  re-request. Authoritative, and observed live on a PR whose `reviewDecision` was still
  `CHANGES_REQUESTED` *and* whose `latestReviews` came back **empty**: the case with no other tell.
  The two connections have to be matched by reviewer because they answer about different requests:
  `reviewRequests` is who is on the hook *now* and carries no date, while a `ReviewRequestedEvent`
  carries the date and *survives the request being withdrawn*. Dating the standing request from a
  withdrawn one would hide a live rejection all over again.
- **A _non-merge_ commit newer than the review** — the fallback for an author who pushed without
  clicking anything. Its two timestamps (the head commit's `committedDate`, the last
  changes-requested review's `submittedAt`) ride the same aliased node and cost no extra request.

**A merge is transparent to that second signal, not disqualifying.** GitHub's **Update branch**
button — and this cockpit's own **Resolve conflicts** — writes `Merge branch 'main' into <branch>`
dated *now*: newer than any review, addressing none of it. It is the click people make reflexively
on a stale PR, so counting it as a push let one button wipe a live rejection off the chip.
`parents.totalCount >= 2` on the head commit is what tells that commit apart from work.

But *ignoring* a merge head is equally wrong, and in a more common sequence: request changes → the
author pushes a real fix (chip correctly turns blue) → the base moves on → the author resolves the
conflicts. Discarding the head because it is a merge would throw away the fix underneath it and
flip the chip **back** to red, blaming an author who answered two steps ago — the same
misattribution this whole ranking exists to prevent, pointed the other way.

So the push is judged by the newest commit that is actual *work*: the head, or — when the head is a
merge — its **first parent**, which is the branch's previous tip and therefore what the merge sat on
top of (`parents(first: 1)`, riding the same node at no extra request). A plain "Update branch" on a
PR that was never fixed still reads as unanswered, because that first parent is the pre-review
commit. An absent count reads as an ordinary commit: the push rule is the common path and must not
switch off on a field GitHub declined to send.

This does not cover **Update with rebase**, which rewrites the committer date on every commit and
is indistinguishable from real work. Only an explicit re-request would fix that, at the cost of a
sticky red chip for authors who push a fix without clicking anything — a trade deliberately not
taken.

The **after** in the first one is load-bearing, and leaving it out was a reported bug
(observed live): three reviewers were asked at once, one requested changes the next day,
the other two never looked — so `totalCount` stayed 1 with nothing whatsoever having happened
since. Read as a re-request, that stale entry painted "Waiting for review" over a live rejection,
which is the opposite of whose move it is. `reviewRequests` says only *that* someone is on the
hook, never since when, so the request's own date comes from
`timelineItems(last: 1, itemTypes: [REVIEW_REQUESTED_EVENT])` on the same node.

Absence is conservative: with no re-request and no usable dates, a review counts as current and the
chip keeps pointing at the author. That includes a dated review against an undated request — the
one case where "after" cannot be checked, so it is not assumed.

One more thing falls out of reading `reviewRequests`: a repo with **no review policy at all**
(`reviewDecision` null) but a reviewer explicitly asked reads `review-required` rather than `ready
to merge`, which would have painted over the ask.

With one hard limit, found on a real PR: **`APPROVED` outranks a pending
request.** A reviewer left on the request list after somebody else approved is a courtesy ask, not
an unmet gate — and `reviewDecision` is the forge's own statement that the requirement is met (a
repo needing two approvals reports `REVIEW_REQUIRED` until it has both, so `APPROVED` never arrives
early). Without that, an approved, green, mergeable pull request reads "waiting for review" for as
long as anyone stays listed, which is indefinitely. A red build still outranks an approval, because
the build is the author's move either way.

`ready` is not spelled "approved" because `reviewDecision` is null on a repo with no review policy:
there a green PR IS ready and no approval will ever arrive.

### Two new tokens: `--pending-strong` and `--info`

Amber words needed a token that did not exist. `--pending` (amber-400) is a *fill*: it passes
against the dark theme's near-black and fails badly as ink on the light theme's white, which is
exactly why the design guardian bans `text-pending` outright. So the amber chip writes
`text-pending-strong`, a second token with the same hue and per-theme luminance — amber-400 on
dark, amber-700 (~4.8:1 on white) on light — and the guardian's `no-amber-text` rule now excludes
that one spelling by name. The dot keeps `--pending` in both themes; nothing else changes colour.

`--info` exists because `review-required` and `merged` were both violet, which read as two shades
of *done* — where one of them is the opposite of done: it is waiting on a person. Blue is the only
hue the cockpit does not otherwise use, so it reads as its own thing at a glance, and the value is
not invented: it promotes the syntax theme's existing per-theme blue pair (blue-300 on dark,
blue-700 on light), already tuned for both backgrounds. Ink only, no fill; 10.9:1 and 6.7:1.

The tones now run: violet = done (`merged`, `completed`), success = fine (`ready`, `open`), info =
waiting on a person (`review-required`), amber = machine busy (`checks-pending`), danger = wrong
(`changes-requested`, `checks-failing`, `closed`), neutral = parked (`draft`, `not-planned`).

### Where the data comes from

`GET /api/v1/p/:projectId/github/ref-status?prs=<csv>&issues=<csv>` — the additive sibling of
`/github/checks`, and shaped like it: one aliased GraphQL query per project (both kinds in the same
query), a bounded server cache keyed by repo root and number (TTL by status — see the refresh
policy below), an in-payload degrade (`{available: false, reason}`) rather than a 5xx, and a cap of
100 numbers per kind.

A number the forge does not know is **absent** from the map rather than present with a fallback.
Absent means "nothing is known" and renders as the neutral pre-status chip. That distinction is the
whole safety property: *we could not ask* must never be paintable as *nothing is wrong*.

Deliberately not `prMergeState`, which answers "may I press Merge on this one" and costs a request
per PR. A table needs a glyph per row, not a merge gate.

### Asking `issueOrPullRequest`, and surviving a partial answer

Two defects found in review, both of which made a live reference report *Not found on this
repository*:

**One alias per NUMBER, not per guessed kind.** A repository numbers its issues and pull requests
from one sequence, so a number is exactly one of the two — and `taskReferences` *infers* which,
from whichever field carried it (a bare `#774` can land in either). Asking `issue(number: 774)`
about a pull request is a question with no answer, and GitHub replies with a NOT_FOUND **error**
rather than a null. `issueOrPullRequest(number:)` is the question that always has an answer, and it
returns `__typename`, so the result is filed under what the number really is. A chip whose kind was
guessed wrong now gets the right status; the client reads both buckets for that reason.

**`gh api graphql` exits non-zero on a partial success.** The moment a reply carries an `errors`
array — one number that no longer exists, or never did, having been scraped from a transcript that
named another repository — `gh` exits 1, even though `data` holds every alias that *did* resolve.
`execFile` rejects on a non-zero exit, so a whole batch's worth of good statuses was thrown away
and every reference in it reported as missing. Now a non-zero exit whose stdout still carries a
usable `data.repository` is read as the partial success it is. A null `repository` — the handle
itself failing — still degrades to `available: false`, because reading *that* as a partial success
would report every number as missing when the truth is that we could not ask.

Which is the third fix, and the invariant behind all of them: **a number we could not ask about is
never cached, and never reported, as a number that does not exist.** `fetchRefStatuses` returns its
failures separately from its results, failures are left out of the cache, and a batch with any
failure answers `available: false` — so the cockpit says "GitHub is unreachable" and keeps the last
known statuses, instead of painting "not found" over a perfectly good pull request. The successes
are cached either way, so the retry costs only the numbers that failed.

### Why a chip never blanks once it knows something

The queries are keyed by the **whole batch** (`…/ref-status/40,42/12`), because a batch is what one
request covers. That is the wrong shape for display, and the first cut shipped the bug it causes:
type a letter into the search box, archive a row, switch tabs, or let the global page's 15 s index
poll add a task, and the visible set changes → a different key → a cold cache entry → **every chip
on screen dropped to neutral** until the round trip finished. Nothing about those pull requests had
changed.

So the display layer remembers per REFERENCE, in a module-level map that outlives any one batch,
surface or failure. Nothing is invented: an entry appears only when the forge answered with a
status for that exact number, and any later answer overwrites it. The cost is bounded staleness — a
chip can show the last successful answer while a new one is in flight — which is the same 60 s
staleness the cache already accepts, and strictly better than blanking to a neutral chip that reads
as "nothing to see here". It is shared across surfaces on purpose: the sidebar, the table and the
run header routinely paint the same PR, and learning it three times would mean three flickers.

### A chip with no status says which kind of nothing it is

Four different situations used to render as the same silent violet chip. Each now has a tooltip:

| | Tooltip |
|---|---|
| request in flight | *Checking GitHub… — the status of this reference is on its way* |
| forge unreachable | *Status unavailable — `<the server's own reason>`* |
| answered, number absent | *Not found on this repository — the reference may point at another repo* |
| nothing ever asked | (no tooltip — the plain URL, exactly as before) |

A remembered status shown while the forge is down keeps its colour and says *last known — GitHub is
unreachable*, so a dated answer is never mistaken for a fresh one. Every tooltip also carries the
reference's URL, which the native `title` used to and which is the only thing that reveals a
reference pointing at a *different* repository (#526).

### How often a status is rechecked

The first cut answered this badly: with `refetchInterval`, `refetchOnWindowFocus` and
`refetchOnReconnect` all off by cockpit default, a status refreshed only when its query key changed
(a search keystroke, a filter, a poll that added a reference) or the surface remounted. On a table
you left open and did not touch, **never** — while a merged pull request, which cannot change
again, was re-asked every 60 s. Both ends backwards.

**Where the responsibility lies: the server decides, the cockpit obeys.** Nothing on the server
ever wakes up — there is no scheduler behind this route, so if no tab is open, nothing is ever
checked. The cockpit is therefore the only thing with a clock. But *when* a status could differ is
forge semantics, and those already live server-side, in the same function that decides how long the
answer may be cached. A first cut had both sides holding a table of "which statuses are settled",
with two different sets of constants and nothing making them agree — too eager on the client and it
burns requests the cache can only answer identically, too lazy and a chip goes stale under a cache
that would gladly have told it otherwise.

So the answer carries `recheckAfterMs`: how long it holds, or `null` for "nothing here can change".
It comes off the same table as the cache TTL, per reference, and the batch takes the soonest:

| status | cache TTL | `recheckAfterMs` |
|---|---|---|
| `merged` | 24 h (capped only so a long-lived server eventually re-reads) | **`null`** — GitHub has no un-merge |
| `closed` / `completed` / `not-planned` | 10 min | 10 min — reopening is possible, just rare |
| anything still moving | 60 s | 60 s |
| a number the repository does not have | 60 s | 60 s — usually a wrong number, but also what a not-yet-pushed PR looks like |
| forge unreachable | (not cached) | 5 min — retry, but do not hammer a workspace with no `gh` |

The cockpit's whole refresh policy is then two lines: `staleTime` and `refetchInterval` are
`recheckAfterMs`, and `null` means an infinite staleTime and no interval.
`refetchIntervalInBackground` stays at its default, so a hidden tab schedules nothing;
`refetchOnWindowFocus` is on for this family alone — coming back to the tab is the strongest "is
this still true?" signal there is, and the staleTime rate-limits it to the same cadence, so an
immutable answer ignores focus too.

The result: a table of finished work costs nothing on a loop, and the one PR whose CI is running is
rechecked every minute until it stops. This is the second of exactly two query families that
override the cockpit's no-polling doctrine (the other is the cross-project run index), for the same
reason: the data lives somewhere that cannot tell us it changed.

### One fetcher, and no flash on reload

Two things the first cut got wrong for the same underlying reason — every surface acted alone.

**Requests.** The sidebar, the task table and an open run header each fetched for themselves. A
six-project sidebar plus a table plus a header was eight requests on load, several about the *same*
pull requests: the server's per-number cache absorbed the forge cost, but the round trips were real
and the chips lit up in waves. A `ReferenceStatusRegistry` at the app root now collects what every
mounted surface is painting and unions it, so it goes out as **one request per project** however
many surfaces contributed. A surface with no registry above it still fetches for itself, so
mounting it is an optimisation and never a requirement.

**The flash.** Statuses are remembered per reference for the tab (see above), which covers
navigation — but a *reload* repainted every chip neutral and coloured them in a beat later, for
statuses already sitting on this machine. The memory is now mirrored into `sessionStorage`, so a
refresh paints what it knew immediately. `sessionStorage` and not `localStorage` is the safety
bound: it dies with the tab, so the oldest thing it can paint is from earlier in the same sitting,
never a status from last week shown with confidence on a cold morning. Writes are coalesced behind
a timer, and every part of it degrades to the pre-persistence behaviour on a quota error, a
disabled store or a payload from another version.

What remains is the very first load of a fresh tab, where the cockpit genuinely does not know yet —
and says so: the chip is neutral and its tooltip reads *Checking GitHub…*.

### The one change we do not have to poll for

GitHub cannot push to a cockpit with no public endpoint, so a status changed by anyone else is
found by asking. But cezar changes pull requests **itself**, in exactly two places, and those it
knows about the instant they happen:

- `POST /github/prs/:number/merge` — on a successful merge only. A refused merge changed nothing,
  so nothing cached about it became wrong.
- `POST /runs/:id/pr` — the review gate's draft PR. The number is read back out of the URL the
  forge returned; an unrecognised URL shape invalidates nothing rather than evicting a guess.

Both call `forgetRefStatus(repoRoot, number)`, which deletes that one cache entry so the next read
asks the forge. Without it the merge case is self-inflicted staleness: for up to a minute every
chip keeps showing the PRE-merge status of a pull request the user just watched this server merge.

Deleting rather than writing `merged` directly: a mutation reporting success is not the same as
having read the result, and the forge stays the authority on what a reference IS. The knock-on
makes it cheaper than doing nothing — once the fresh read says `merged`, `recheckAfterMs` goes
`null` and the cockpit stops polling that batch entirely.

### Statuses ride the rows

The cockpit asked for statuses in a request of their own, a beat after the table had already
painted — which is both a round trip and a visible flash of un-coloured chips. But the thing that
knows which references exist is the same thing that serves the rows.

So `GET /workspace/runs-index` now answers with `referenceStatuses` too: a `{projectId: {prs,
issues}}` map of whatever the server ALREADY had cached. Read from cache only, so the route never
touches `gh` and never gets slower; a reference nothing has looked up yet is simply absent, and
`/github/ref-status` stays the route that actually goes and asks.

Being free is what lets it be a SUPERSET. The server looks up every number a run mentions rather
than re-deriving which one the cockpit will display — that rule (#407, #526) lives client-side, and
a second copy is how the two would drift. A cache read costs nothing per number, so asking about
one the client will not paint is harmless, and the client applies its own rule to whatever it gets.

The client seeds the same remembered map every chip already reads, so there is still one place to
look and one precedence: a later real answer overwrites a seeded one exactly as it overwrites any
other. What this removes is the WAIT before first paint — the refresh cadence that keeps a status
current is unchanged.

### One project, one name

A reference is remembered under `projectId + kind + number`, and the project half has to be the
same word everywhere or the memory silently splits in two.

It did. The global Tasks page keys each chip by its run's real `projectId` (its rows span the
registry), while every unscoped surface — the sidebar, the run header, the per-project table — used
`'default'`, the alias the project-scoped routes accept. The same pull request was therefore
remembered twice under two names: a status learned on one surface never reached the other, both
fetched it separately, and the index seeding (which uses real ids) never reached the sidebar at
all. Reported as "the ref updated in All tasks but the sidebar still holds the old status".

`useReferenceProjectId()` resolves the one name: the mounted scope, else the boot project health
names. Undefined until health answers — a neutral chip for that moment is better than an entry
written under a name nothing else uses.

### Why not webhooks, or something that pushes

GitHub can push, but only to a public endpoint. A webhook needs inbound network, which is the one
thing a local-first cockpit with no daemon, no port and no account cannot have without becoming a
different product (see AGENTS.md § Zero config: prefer a proxy-free, daemon-free mechanism, and
anything that widens exposure is opt-in behind a `CEZ_*` flag).

Nothing in `gh` subscribes either. `gh run watch` exists but watches ONE Actions run to completion
and is itself a poll; there is no "tell me when these forty pull requests change". The documented
"listen" mechanism is polling `/notifications` with `If-Modified-Since` and obeying
`X-Poll-Interval` — but that covers only what the authenticated user is subscribed to, not
arbitrary references, so it cannot answer for a task table.

What GitHub does offer, and what this design leans on instead:

- **`Cache-Control: max-age=60` on a pull request.** GitHub's own answer to "how fresh is this",
  and exactly the live TTL here — the 60 s was picked to match rather than invented.
- **ETag / `If-None-Match`.** Verified: a conditional REST request answers `304 Not Modified`.
  Tempting, but it is REST-only — GraphQL has no conditional requests — and swapping one batched
  GraphQL call for N conditional REST calls trades a single subprocess for one per reference. (The
  rate-limit counter was also observed to decrement on a 304, so the saving is bytes, not budget.)
  Batching wins for a table.

Which leaves the cheapest possible poll as the honest answer, and the work goes into asking as
rarely as the data allows: nothing for what cannot change, one request per project, and only the
numbers whose cache entry has actually expired.

### Where it is mounted

`ReferenceStatusProvider` wraps a surface, collects that surface's references, and batches them into
one request per project; `ReferenceChip` reads its own status from that context. The split follows
where the two halves of the problem live — the request list is only knowable at the top of a
surface (it alone can see that forty rows belong to six repos), the consumer is a chip four
components down — and it makes the feature opt-in by mounting: a surface without the provider gets
exactly the chip the cockpit painted before this existed.

Mounted on: the global Tasks page (no default project — every chip there names its own, because
adjacent rows belong to different repositories), the per-project Tasks route, the sidebar quick-list
and each multi-project sidebar group, and the run header.

## Deliberately not done

- **No extra "PR status" column on the global Tasks page.** That table already has a Status column,
  for the *task's* status, and a second one a few columns away holding a different subject's status
  is a column you have to read the header of every time. The Ref cell is where a reference's own
  state belongs — it is attached to the thing it describes, it costs no horizontal space in a table
  that is already fighting for it, and the tooltip is the place with room for words. Filtering or
  sorting *by* reference status is a separate feature and would need the status on the index row,
  not in a lazily-hydrated client cache.
- **No blanket polling.** See the refresh policy above: the interval is read from the answer, so a
  settled batch schedules nothing. What is deliberately absent is a fixed interval for everything.
- **`checks-pending` has no icon** — it keeps the pulsing `StatusDot`, which is this design
  system's own mark for a state that is still moving, inside its amber chip.
