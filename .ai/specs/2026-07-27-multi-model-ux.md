# Multi-Model Harness UI/UX

Status: IMPLEMENTED (2026-07-27) · Branch: `feat/multi-modal`

## TLDR

The harness works; watching it does not. A multi-model run is the longest,
most expensive thing Cezar can start (the reference run: 3 hours, 18 phases,
3 councils, 66.1M tokens, $2.35) and its cockpit gives the transcript ~35% of
the screen, splits its state across three tabs, and reports "approve" on a run
whose publishing is blocked by five major findings.

This document is the fix list, ordered. It changes presentation and layout
only — no harness protocol, ledger shape, or API change is required except
where explicitly marked **(data)**.

## What already changed

The **Execution profile** subtabs (Claude solo / Worker offload / Review
council / Council + worker / High assurance / Custom lineup) are removed from
the composer. Every Multi-model run is now a custom lineup; the lineup *is* the
choice, and a coarser topology picker above it asked the same question twice.

`agentHarness.profiles` still exists in the repo config and Settings → Harness
still reports it, so `HARNESS_PROFILE_OPTIONS` survives as a display-only label
map. The server still accepts `harness.profile` from scripted callers.

**Consequence that needs a decision (see F1):** the Packets tab is gated on
`run.harness.profile === 'high-assurance'` (`run-header.tsx:162`), and a role
lineup resolves to `multi` or `multi-optimized` (`workflows/run.ts:2117`).
Nothing the composer can start is `high-assurance` any more, so the entire
packet / evidence-gate surface is now unreachable from the UI.

## Design principles borrowed from Claude Desktop and the Codex app

1. **One primary surface, one companion rail.** Claude Desktop never makes you
   leave the conversation to see the artifact — it opens beside it. Cezar makes
   you leave the Session tab to learn whether round 3 approved.
2. **Prose gets a reading measure; the shell does not.** Claude caps the *text*
   at ~70ch and lets code, diffs and panels use the window. Cezar caps the
   *whole shell* at 820px and then puts an 1120px panel under it.
3. **One progress affordance.** The Codex app shows a single status line —
   what is running, for how long. Cezar shows four (header `Plan 4/4`,
   `Workflow steps complete · 18 of 18`, the phase rail, and the Plan dock).
4. **Status is a verdict, not a table.** Codex leads with "3 files changed,
   tests passing"; details are one click down. Cezar leads with a 6-column
   matrix and buries the blocking verdict in a paragraph.
5. **Chrome collapses, content does not.** Sticky bars shrink on scroll.

---

## Findings and fixes

Severity: **P0** breaks comprehension or truthfulness · **P1** costs real
screen or time · **P2** polish.

### A. Shell and layout

**A1 — P0. Header and content are misaligned by 150px.**
`task-thread/run-header.tsx:126` caps its inner block at `max-w-[820px]`;
`task-harness/task-harness.tsx:96` caps the page body at `max-w-[1120px]`.
Measured at a 1600px viewport: header block at x=518 w=820, content cards at
x=368 w=1120. The two never line up at any width above 820px.
*Fix:* one shared shell width token used by the header, the rail and the body.

**A2 — P0. The working window is about a third of the screen.**
At 1600×1000 the transcript gets 820 of 1336 available px wide and ~430 of
1000px tall, after four stacked chrome strips (tabs, workflow-steps summary,
take-over command, phase rail) and two docks (Models, Plan) above the composer.
*Fix:* collapse the four strips into one status bar (A3), move Models into the
run rail (B1), and let the shell breathe to the window width with the *message
text* — not the shell — capped at a reading measure.

**A3 — P1. Four competing progress indicators.**
Header `Plan 4/4` · `Workflow steps complete · 18 of 18` · the phase rail ·
the Plan dock. Three of the four say the same thing at different granularities.
*Fix:* one status bar: `● Council review · round 3 of 3 · 2/2 reviewers · 2h 58m`
with the phase timeline one click away.

**A4 — P1. The tab strip overflows at every width.**
`run-tabs` scrollWidth 926 vs clientWidth 812 even at a 1600px viewport, because
five tabs and six action buttons share one horizontal scroller. "Archive"
renders as "Arch".
*Fix:* tabs left, primary action (Finish/Continue) right, everything else in the
kebab that already exists. Never scroll the tab strip.

**A5 — P0. The phase rail cannot be read.**
scrollWidth 2620px inside an 820px viewport: 18 phases, no wrap, no auto-scroll
to the active phase, no collapse. The phase you care about — the last one — is
always off-screen.
*Fix:* the status bar shows the current phase; the full timeline opens as a
vertical, grouped list (mockup 04), which is also where retries (`· 3×`) and
per-phase durations belong.

### B. Harness state placement

**B1 — P0. Council state is only on the Review tab.**
The Session tab — the one you actually watch — carries the phase rail and the
Models dock but not the round, the verdict, or reviewer progress.
*Fix:* a **Run rail** on the right of every harness tab (≥1280px; a drawer
below that) holding Phase, Council, Models. The tab then selects the *primary*
surface (transcript / findings / diff), not the *state* you can see.

**B2 — P2. The Models dock truncates the thing it identifies.**
`claude/claude-haiku-4…`, `opencode/opencode/…`.
*Fix:* two-line row — family + short model name on line 1, full binding on
line 2 in mono — or a tooltip. Never truncate the identifier alone.

### C. Review tab truthfulness

**C1 — P0. The screen says "approve" while publishing is blocked.**
"Findings by model" shows 4 MINOR/NIT findings and a green `approve` pill. The
five `[major]` findings that actually gate publishing appear only inside the
contested box, as one semicolon-joined run-on line.
*Fix:* lead with the outcome. A verdict banner states blocked/approved and
*why*; blocking findings render first, as cards, with the reviewer that raised
them; the round verdict pill is subordinate to the run outcome.

**C2 — P0. "Raised by" is duplicated.**
`reviewerFindings()` (`task-harness.tsx:112-123`) seeds the map from
`council.findings` — whose `by` already carries the reviewer id — then appends
`reviewer.id` again from the per-reviewer loop, producing
`opencode/opencode/mimo-v2.5-free, opencode/opencode/mimo-v2.5-free`.
*Fix:* dedupe on a Set of ids.

**C3 — P1. "Reviewer status" is not reviewer status.**
It renders `ledger.models` — orchestrator included — and falls back from
`reviewer.status` to `model.readiness`, so one Status column mixes two state
machines: the orchestrator shows `ready` (a probe result) next to reviewers
showing `completed` (a run result).
*Fix:* split. Council table = reviewers only, with review status, verdict,
findings count, duration and cost. Orchestrator/implementer belong in the run
rail's Models section.

**C4 — P1. The Family column is always "—". (data)**
`ledger.models[].family` is not populated, yet cross-family diversity is the
council's core promise. The composer enforces two families at start and the
review surface cannot show whether that held.
*Fix:* populate `family` in the ledger model records; render it as the primary
grouping of the council table.

**C5 — P2. Model ids are doubled.** `opencode/opencode/mimo-v2.5-free`.
*Fix:* render `runner` and `model` separately; never concatenate a
provider-qualified id onto its runner.

**C6 — P1. The findings matrix does not scale.**
One column per reviewer, headed by the full model id. At three reviewers it
already overflows and clips "Raised by"; at five it is unusable.
*Fix:* severity-grouped cards with reviewer *chips* (agreement is "2 of 3
raised this", shown as filled chips), not a column per reviewer.

**C7 — P1. There is no way to read a review.**
You learn that a reviewer completed and what it titled, never what it said, how
long its transport took, whether it retried, or what it cost.
*Fix:* a reviewer detail drawer: verdict, raw review body, transport, attempts,
tokens, cost.

### D. Composer

**D1 — P0. The block reason hijacks the prompt placeholder.**
With a failing binding, the task textarea's placeholder becomes *"one or more
required model bindings could not be verified"* — an error rendered as
instructions, 700px above the readiness card that explains it.
*Fix:* placeholder stays a placeholder. Blocking reasons render on the Start
button's tooltip and inline next to the offending model pill.

**D2 — P1. Readiness dumps raw CLI stderr.**
codex/auto's failure printed ~300 characters of raw JSON — twice, the same
error nested — right-aligned in the widest column, with no remedy affordance.
*Fix:* one-line human summary + a "details" disclosure holding the raw text +
a "Fix this" action routing to `cez-setup-harness`.

**D3 — P1. Readiness is 700px below the models it judges.**
*Fix:* a readiness dot on each model pill; the card becomes the summary, not
the only source.

**D4 — P1. No cost or duration expectation.**
The most expensive action in the product starts with no estimate. The reference
run: 3 councils, 66.1M tokens, $2.35, 2h58m.
*Fix:* a live estimate line under the lineup, derived from this project's prior
harness runs — `≈ 2–4h · ≈ $2–5 at this lineup (median of 6 prior runs)`.

**D5 — P2. Presets are opaque.** A chip shows a name; the lineup it holds is
invisible until applied (and applying destroys the current one).
*Fix:* hover/focus preview of the three roles; apply is undoable.

**D6 — P2. The reviewers row is pills-of-pills.**
Each reviewer is model pill + effort pill + remove button, wrapping freely.
*Fix:* one row per reviewer in a 3-row role grid, with effort as a compact
segmented control.

### E. Session tab

**E1 — P1.** Same rail as B1; additionally, phase transitions and council
rounds should appear as slim dividers *in* the transcript ("— Council review,
round 2 — 3 reviewers dispatched —") so the log reads chronologically without
the reader reconstructing it from the rail.

### F. Open decisions

**F1 — Packets.** The high-assurance packet surface is now unreachable
(see "What already changed"). Options:
 (a) expose "Bounded work packets + evidence gates" as a switch in the lineup,
     which sets `packetized` independently of the profile name — recommended,
     it preserves the capability without reviving the topology picker;
 (b) keep it reachable only for scripted callers and hide the tab entirely;
 (c) delete `TaskHarnessPacketsRoute`.
This is a product call, not a layout one — flagged, not assumed.

**F2 — Rail vs. tab at narrow widths.** Below 1280px the rail becomes a
bottom drawer. Confirm that is preferred over keeping the Review tab.

---

## Sequencing

| Step | Scope | Findings | Status |
|---|---|---|---|
| 1 | Shell width + status bar + tab strip | A1, A3, A4 | done — `run-shell.ts`, `harness-status-bar.tsx` |
| 2 | Run rail (Phase / Council / Models) on all harness tabs | A2, A5, B1, B2 | done — `harness-rail.tsx` |
| 3 | Review tab rebuild: verdict banner, finding cards, reviewer drawer | C1, C2, C3, C6, C7 | done — `task-harness.tsx` |
| 4 | Ledger `family` + id rendering **(data)** | C4, C5 | done — `driver.ts` roster, `types.ts` `runner`/`model` |
| 5 | Composer: inline readiness, error handling | D1, D2, D3 | done — `sendBlockedReason`, `humanReadinessError` |
| 6 | Composer polish: preset preview | D5 | done — hover/focus preview on the chip |
| 7 | Packets decision | F1 | OPEN — product call |
| — | Cost/duration estimate | D4 | deferred — needs a prior-run aggregate the API does not expose |
| — | Transcript phase dividers | E1 | deferred — the rail and status bar cover the need |

### Notes on the delivered behaviour

- `family` is populated going FORWARD. A ledger written before this change has
  no family on its roster rows, so the Review tab shows `unknown` for those runs
  rather than inventing one — the honest answer for data that was never recorded.
- The composer no longer disables the textarea for a harness precondition. Typing
  stays available while a probe is in flight; only the send button blocks, with
  the reason on its tooltip. This also fixed a stuck setup dialog: the effect
  opened it on the first (always-blocked) render and never closed it once the
  model catalogs arrived.
- The horizontal phase rail is gone. `data-slot="harness-phase-rail"` no longer
  exists; `harness-status-bar` and `harness-timeline` replace it.

### Backend findings fixed alongside (from the same review)

| Finding | Fix |
|---|---|
| Reviewer's self-declared `approve` outranked its own blocker findings | verdict derived mechanically per reviewer + a pre-stage invariant (`driver.ts`) |
| Cancel stopped reaching the harness runtime after the first agent phase | `ActiveRun.interruptHandlers` set (`run.ts`) |
| Runtime executed from the model-writable worktree, no integrity check | sealed out of the worktree + sha256 re-verified before every op (`runtime.ts`) |
| `councilFamilyOf` over-counted family diversity | one shared `providerFamilyOf` (`model-family.ts`) across driver, server and web |
| Unhandled stdin EPIPE killed the whole server | `stdin.on('error')` on both agent transports |
| SIGKILL escalation cancelled by the group leader's exit | escalation now asks whether the GROUP is alive (`process-tree.ts`) |
| Accepting a contested result never unlocked publishing | server returns `decisions`; client patches both halves |
| Presets holding an advisor reviewer were silently discarded | `isModelRefShape` accepts `runner: 'harness'` with a family |
| Setup dialog claimed "no models available" when advisors existed | runner families and advisor families counted separately |
