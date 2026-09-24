# Execution plan — animated top-right toast stack in the cockpit

**Issue:** #818 — Implement: animated top-right toast stack in the cockpit
**Branch:** `feat/animated-top-right-toasts`
**Engine:** `Engine: om-auto-create-pr (steps: 7, --loop: no)`

## Goal

Move the cockpit's toast stack from bottom-centre to the top-right corner and give it a real
enter/exit transition (slide from the right + fade), so a toast no longer lands on top of the
thread's action row and no longer pops in and out with no animation — which today reads as a
rendering glitch rather than a notification.

## Scope

Everything lives in one primitive plus its unit test:

- `packages/web/src/components/ui/toaster.tsx` — the module-level store, `toast()`,
  `resetToasts()`, and the `<Toaster />` renderer.
- `packages/web/src/components/ui/toaster.test.tsx` — the unit suite that locks the new
  lifecycle and the new anchor in place.

No caller changes: `<Toaster />` is mounted once at the app root (`packages/web/src/app.tsx`)
and every `toast(...)` call site keeps its current signature.

### Non-goals

Deliberately untouched, per the issue's own out-of-scope list:

- Swapping the hand-rolled primitive for a toast library (sonner, Radix Toast). The file's
  comment explains the deliberate no-dependency choice and this run does not revisit it.
- New toast features: manual dismiss buttons, action buttons, per-toast durations,
  swipe-to-dismiss, extra tones beyond `default`/`danger`.
- Changing the 5s `TOAST_MS` lifetime, the stack order (oldest first stays), or the wording of
  any existing toast message.
- Any change to `toast()` call sites — the signature stays exactly as it is.

## Implementation Plan

### Phase 1 — Two-phase dismissal in the store

The current `toast()` drops the item from the store the instant the 5s timer fires, so the node
unmounts before any exit animation could run. An exit transition therefore needs a lifecycle
change, not just CSS: at `TOAST_MS` the item is re-published with `exiting: true`, and a second
timer removes it once the exit animation has had time to play. `resetToasts()` must clear both
the queue and every pending timer so one test's toasts cannot leak into the next.

### Phase 2 — Top-right anchor and the enter/exit animation

Re-anchor the `data-slot="toaster"` wrapper to the top-right (respecting the top/right safe-area
insets), cap each item's width so a long message wraps instead of spanning the viewport, and
raise the wrapper above the Radix dialog layer — dialogs do fire toasts, and at an equal
`z-50` the dialog's portal (later in `<body>`) would paint over the toast. Animation uses the
`tw-animate-css` utilities already imported by `packages/web/src/styles/index.css`, gated on
`motion-safe:` so `prefers-reduced-motion: reduce` gets an instant appear/disappear, matching
the rest of the cockpit. The `data-slot`, `data-tone` and `role="status"` hooks stay
byte-identical — three e2e specs and the unit test query them.

### Phase 3 — Tests and the validation gate

Lock the new lifecycle and the new anchor in unit tests, then run the repo's full gate.

## Risks

- **Timer bookkeeping.** Two timers per toast is the easiest thing to get subtly wrong; a leaked
  timer would fire against a later test's store. Mitigated by tracking every handle in a module
  set that `resetToasts()` clears, plus a test asserting two toasts keep independent clocks.
- **Z-order regression.** Raising the toaster above the dialog layer is the intended fix for
  toasts fired from inside a dialog, but it also means a toast now paints over a dialog's top
  edge. That is the accepted trade — a notification the user cannot see is worse than one that
  briefly overlaps a dialog corner — and it stays below the `z-[100]` image lightbox.
- **Intermittent unrelated test.** `packages/cezar/src/server/open-in-app.test.ts` failed once across five full `npm test` runs on this branch (`ENOENT` on the stub call log its `waitFor` polls). The file is byte-identical to `main`, is server-side, and passes 10/10 in isolation — it loses a timing race only under full-suite load. Filed as #823 rather than fixed here, since touching an unrelated server test from a cockpit-UI PR would be scope creep.
- **e2e contract drift.** `packages/web/e2e/{new-task,settings-skills,workflows}.e2e.ts` poll for
  `[data-slot="toast"]` / `[data-slot="toaster"]` text. Keeping those attributes unchanged is an
  explicit step, not a side effect.

## Progress

PR: #820

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Two-phase dismissal in the store

- [x] 1.1 Add an `exiting` flag to `ToastItem` and re-publish instead of dropping at `TOAST_MS` — 7e2558c3
- [x] 1.2 Track pending timers so `resetToasts()` clears the queue and every scheduled handle — 7e2558c3

### Phase 2: Top-right anchor and the enter/exit animation

- [x] 2.1 Re-anchor the toaster wrapper top-right with safe-area insets, `items-end`, and a raised z-layer — 7e2558c3
- [x] 2.2 Emit `data-state` and the `motion-safe:` enter/exit animation classes on each toast, preserving `data-slot`/`data-tone`/`role` — 7e2558c3
- [x] Post-review fix: clear the app shell's mobile header with a `md:` breakpoint pair — the flat 16px anchor covered the run status dot and kebab on phones — 69f27427

### Phase 3: Tests and the validation gate

- [x] 3.1 Update the auto-dismiss test for the two-phase lifecycle (closed, then gone) — 7e2558c3
- [x] 3.2 Add regression tests for the top-right anchor and the open/closed animation state — 7e2558c3
- [x] Post-review fix: pin `motion-safe:duration-200` in the animation test so it cannot drift from `EXIT_MS` — 69f27427
- [x] 3.3 Run the full validation gate (`npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`) — 2ea68071
