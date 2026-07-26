# UI redesign mockups

High-fidelity static HTML mockups for the cockpit UI redesign — spec: [`.ai/specs/2026-07-14-cockpit-ui-redesign.md`](../../.ai/specs/2026-07-14-cockpit-ui-redesign.md).

Built on real cezar data (run `2d012907`'s actual NDJSON events, real skill names, real `src/server/git.ts` content) and a shared token sheet ([`tokens.css`](tokens.css)) implementing the Mercato design system (neutral ramp, lime/violet accents, Inter + JetBrains Mono, shadcn-style primitives). No JavaScript, no external assets besides the fonts import — open any file directly in a browser. Dark is default; add `class="light"` to `<html>` for the light theme.

| Page | Shows | Issues |
|---|---|---|
| [`thread.html`](thread.html) | Task thread: tool cards, context groups, reasoning, plan dock, step rail, composer with Dictation | #381 #382 #380 |
| [`new-task.html`](new-task.html) | Full-screen composer: skill picker dropdown, plan-mode toggle, variants | #386 #383 #377 |
| [`git-changes.html`](git-changes.html) | Session Changes tab: file tree, word-level diff, commit/push/Create PR action bar | #390 |
| [`tasks-home.html`](tasks-home.html) | Task table with editable titles, ± stats, live CPU/Mem; sidebar quick-list with variant groups | #389 |
| [`settings-skills.html`](settings-skills.html) | Settings tab with registry sub-nav; skills project-first/bold | #377 |
| [`harness-thread.html`](harness-thread.html) | Harness run thread: phase rail, readiness table, diagnosis-council card, worker-packet cards, Models dock | spec 2026-07-23-harness-orchestration |
| [`harness-council.html`](harness-council.html) | Review tab: round stepper, reviewer-status table, findings-by-model matrix (`●/◐/—/○/!`), validation gate | spec 2026-07-23-harness-orchestration |
| [`harness-new-task.html`](harness-new-task.html) | Harness start surface: profile segments, probe readiness table with missing-binding reroute, stage-only note | spec 2026-07-23-harness-orchestration |
| [`harness-packets.html`](harness-packets.html) | High-assurance Packets tab: lifecycle strip, packet cards with leases/budgets/lenses, blocked packet + release | spec 2026-07-23-harness-orchestration |

Screenshots (Playwright, 2× scale) in [`screenshots/`](screenshots/): `*-desktop.png` 1440×900 dark, `*-iphone.png` 390×844, `*-light.png` light theme, plus `thread-desktop-tools.png` (tool cards in view) and `new-task-desktop-clean.png` (dropdown closed).

These are design targets for visual approval — the implementation is React + shadcn/ui per the spec, not these static files.
