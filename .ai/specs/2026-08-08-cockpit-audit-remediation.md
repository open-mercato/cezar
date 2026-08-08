# Cockpit audit remediation — state grammar and accessibility

> Source: a four-round evidence-first UX/WCAG audit of the cockpit (2026-08-07/08), run
> against the live app (dry-run fixture server, both themes, desktop / mobile / 320 px,
> axe-core 4 on seven routes, real keyboard, live mock runs incl. review gate, ×2 variants,
> a 250-turn thread and a server-kill resilience test). Findings below carry the audit's
> IDs so the PRs, the commits and this spec stay cross-referencable.

## TLDR

The cockpit's foundations are strong — degradations, empty states, the review-gate loop and
the attention model all hold up under use. What fails is **state communication**: one text
token breaks WCAG AA contrast across ~301 call sites in the light theme, finished sessions
keep dressing as running ones, a dead server is indistinguishable from a healthy one, and a
handful of small accessibility gaps (skip link, Escape, scroll regions, labels) are each a
one-file fix. This spec fixes them in severity × cost order, one commit per finding, so any
single fix can be reverted or shipped alone.

## Findings in scope (phase 1 — this branch)

| ID | Finding | Standard / heuristic | Fix shape |
|----|---------|----------------------|-----------|
| A1 | `--soft-foreground` is `#a3a3a3` in the light theme — 2.52:1 on white at 11–12 px, ~301 usages plus the global `::placeholder`; dark's `#7b7b7b` is 4.08:1 on `--card` | WCAG 1.4.3 | retune the two hex values; no call-site changes |
| X1 | `--input` border `#ebebeb` on a white field ≈ 1.19:1 — the Search box has almost no boundary in light | WCAG 1.4.11 | darken light `--input` to ≥3:1 against `--background` |
| B3 | No skip link — every page starts its tab order in the sidebar (7+ stops) | WCAG 2.4.1 (A) | `sr-only focus:visible` link to `#main` before the sidebar |
| B4 | The "Delete this task?" dialog ignores Escape (two real key presses; focus inside) | platform convention | remove the Escape suppression; safe default focus already guards against slips |
| B5 | Markdown task-list checkboxes render unlabeled (`axe: label`, critical) | WCAG 1.3.1 / 3.3.2 | label them from the list item's text in the markdown renderer |
| B1 | Scrollable regions (markdown tables, code blocks, workflow `pre`) are mouse-only | WCAG 2.1.1 | `tabindex="0"` + `role="region"` + label on the overflow containers |
| A4 | Agent screenshot `alt` is the raw filename (`screenshot-1.png`) | WCAG 1.1.1 | descriptive alt ("Screenshot captured by the agent") |
| A2 | A finished/cancelled/review session still looks mid-run: amber full-width step bar, plan dock stuck at "in progress" (present tense) forever | Nielsen #1 | terminal styling for the step rail + plan dock copy in past tense when `status ∈ {done, review, cancelled}` |

## Explicitly out of scope (follow-up branches, in order)

1. **C1 — silent server death**: offline banner from the health watchdog, error states with
   retry on failed queries, refetch on reconnect. Medium; touches the query layer.
2. **D1 — ×2 compare dead end**: disabled "Pick this one" styled as primary with the reason
   hover-only, and no path to finish waiting variants from the compare view.
3. **B2 — workflow builder palette**: 86 nested-interactive rows (`div role="button"`
   wrapping a real `<button>`).
4. **B6 — aria-live for run status changes** (SSE state transitions are visual-only).
5. Known issues with their own tracks: #741 foldable columns, #793 `/new` worktree copy,
   #765 header disclosure, #784/#794 model discovery.
6. Product decision, owner's call: review gate default (#489) vs the README's
   "ends at a review gate" framing.

## Resolved assumptions

| # | Question | Applied default | Why |
|---|----------|-----------------|-----|
| Q1 | New token values for A1? | light `--soft-foreground: #6f6f6f`, dark `#848484` | Light `#6f6f6f` clears 4.5:1 on every light surface it sits on (white 5.0, `--muted #f7f7f7` 4.69). Dark `#848484` clears the three surfaces soft text actually renders on (`#0d0d0d` 5.5, `--card #171717` 4.79, `--card-2 #1c1c1c` 4.56). Values stay neutral grays — no brand color is touched. |
| Q2 | Where does the skip link land? | `<main>` (`id="main"`) | Every route already renders one `main`; the link is layout-level, one place. |
| Q3 | A2: restyle or restructure? | Restyle + copy only | The step rail and plan dock keep their DOM; terminal state swaps the amber line for the final-status color and the dock's collapsed line for "N of M completed". No data-model change. |
| Q4 | Guardian rule for token contrast? | Not in this branch | A static CSS-var contrast check is a new test category; worth doing, listed as follow-up so this branch stays revertable per-fix. |

## Validation

Per fix: the repo's own gate — `npm run typecheck`, `npm test` (unit + design-guardian) —
plus a live check in the running cockpit in BOTH themes (the audit's measurement script
re-run on the changed element). Full suite (`npm run build`, `npm run test:package`) once at
the branch tip.

## Changelog

- 2026-08-08 — v1, phase-1 scope after audit rounds 1–4 (+ accessibility cross-check).
