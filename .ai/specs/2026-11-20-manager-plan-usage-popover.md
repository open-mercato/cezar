# Manager plan-limit popover and current-session usage

Status: **design, awaiting the owner's pick** (2026-11-20). Follows the plan-limit usage feature (#2337).
Mock: the task's Assets page `manager-plan-usage-design.html`.

## What exists today

| Surface | Task view | Dashboard / Settings → Accounts | Manager chat |
| --- | --- | --- | --- |
| Own share, 5h + week | `PlanUsageChip` popover: total, alone, shared ("while N other tasks and M managers ran"), failed attempts, earlier windows, Approximate note, "See all tasks on this account" | Consumer table per window | Header chip "Today ≈ N% of 5h" with chat / watch / jobs; **hidden on phones** (`max-md:hidden`); no week, no alone/shared, no link |
| Per reply | — | — | "This reply ≈ 0.8% of 5h": a `title` tooltip only — no keyboard, no touch, no breakdown |
| Account used now (`usedPercent.last`, reset, week) | — | Plan limits card, Accounts row ("63% used · resets 21:30 …") | **nothing** |

## Part 1 — one popover for task, reply and manager

- Extract the body of `PlanUsageChip` into `PlanUsageDetails` (`components/plan-usage-details.tsx`); the task
  chip, the reply footnote and the manager chip all render it. Subject-specific strings come from one
  table: title "Plan limit used by this task / reply / manager", alone row "While it was the only cezar
  task / While the manager ran alone", link "See all tasks and managers on this account".
- The reply footnote becomes a `PopoverTrigger` button (Tab/Enter/Space, Esc closes, focus returns),
  styled as today's grey text; the `title` goes.
- Manager popover = shared body for the newest 5-hour window + "Earlier 5-hour limits today", then a
  manager-only section (chat / watch checks / jobs, tasks it started) below the breakdown.
- The manager chip stops hiding on phones: icon + % only below `md`.
- **API (additive, optional):** `consumer.messages[]` items gain `aloneInferredPp`, `sharedEstimatePp`
  and `ranTogetherWith`, computed in `usage-ledger/compute.ts` from the same shares. Weekly entries
  already carry `messages`, so a reply's week share needs nothing new. Per-manager figures already exist.

## Part 2 — current session in the manager view (pick one)

- **A. Account meter in the manager chip (recommended).** Chip reads `63% · 5h` with a thin bar,
  coloured at ≥ 80 % (amber) and ≥ 95 % / blocked (red). Popover opens with an "Account now" block
  (5-hour used, resets in, week used) above the shared "this manager" body. One place, works on phones,
  no new row.
- **B. Status strip above the composer.** `Claude · Default · 5h 63% used · resets 21:30 (2h 10m) · week
  29% · this manager ≈ 6%`, clickable into the same popover. Always visible while writing; costs a line
  on phones (truncates to `5h 63% · resets 21:30`).
- **C. Header sub-line + sidebar meter.** The header's sub line gets `5h 63% · resets 21:30`; each manager
  row in the sidebar shows a 2-px meter. Ambient, but the sidebar is collapsed on phones and the header
  sub line already carries status text.

Hybrid recommended: **A**, plus B's strip appearing only at ≥ 80 % as a warning.

Data: `usePlanUsage({ kind, window: 'current', account })` already returns `usedPercent.last`, `resetsAt`,
`leftPp`, `limitReachedAt`. The manager's account comes from its runner + account profile.

Non-plan runners (OpenCode, Cursor, Pi, …): no chip, no footnote, no strip — as today; the manager
settings line says "OpenCode doesn't report plan limits". Codex: same as Claude, wording "tokens"
instead of "cost".

## Open questions for the owner

1. Session view: A, B, C or A + warning strip?
2. Manager chip headline: keep "Today ≈ N% of 5h" (sum of today's windows) or switch to the current
   window like the task chip?
