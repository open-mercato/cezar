# Plan-limit usage by task and manager

Approved design: `session-usage-design.html` rev 3 (task e80fe6b3, 2026-11-19). Approval choices:
design approved; local history on by default; main view in Dashboard → Usage & cost; main
figure is the marked estimate (`≈`); the "used only by cezar" switch is skipped.

## What it answers

"How much of my Claude/Codex plan limit did this task (or manager) take?" Providers report
usage per account (Claude `rate_limit_event`, Codex `account/rateLimits/updated`), never per
session, so every task/manager share is an estimate tied to one account and one window.

## Decisions

1. **Local ledger, on by default.** `~/.cezar/usage-ledger/<UTC day>.ndjson`, append-only, kept
   90 days (pruned on write). Metadata only: readings (used %, reset, status, source), activity
   spans per agent turn, the cost (Claude) or token (Codex) weight each turn reported, and
   failed-check markers. No prompts, paths or code. `CEZ_USAGE_LOG=0` turns writing off on the
   machine; Settings → Agent accounts has a per-account switch (`~/.cezar/usage-tracking.json`
   stores only opt-outs).
2. **Main view**: Dashboard → Usage & cost, a "Plan limits" card first, details in a side panel.
3. **Main figure**: `≈ N%` for every task/manager share, also when it ran alone (your own CLI
   sessions on the same login are invisible). No confidence score: nothing calibrates one.
4. **No dedicated-account switch.**

## Attribution (`packages/cezar/src/usage-ledger/compute.ts`)

Per account and window (5-hour, weekly; Codex primary/secondary mapped by duration), readings
are sorted by time and walked with a high-water mark, so each rise is allocated exactly once
however many parallel sessions reported it:

- no cezar turn running in the slice → **outside cezar**;
- one consumer running → its share, marked **alone**;
- several → split by the weight each reported inside the slice (Claude USD, Codex tokens,
  spread evenly over the turn); time no report covers yet (a turn still running, one that
  stopped mid-reply) → **couldn't be split**;
- the part of a slice no cezar turn covers → outside cezar (time-proportional);
- a reading lower than an earlier one → **provider correction**, shown, never re-counted;
- the first reading → **before cezar's first reading**.

Invariant, pinned by tests: before + Σ consumers + outside + unsplit − correction = last reading.

A reset is a new window (readings cluster by `resetsAt` ±10 min); a newer window whose first
reading predates the older one's reset (an early reset, another login) ends the older one.
Accounts are keyed `provider:<cezar account id>`. Retries: a failed check marks everything the
task spent since its previous failed check as `retryWasteEstimatePp`. Tasks a manager starts
count on the task; manager turns are their own consumer with chat/watch/job parts, per-reply
estimates and quiet-watch counts.

## Surfaces

- Dashboard → Usage & cost: Plan limits card (5 hours / Week, one bar per account) and details
  panel (chart of readings, consumer table, hints).
- Task page: chip in the usage line "This task ≈ N% of 5h" with a breakdown popover.
- Tasks list: optional "Plan limit" column; "not reported" for tools without limits.
- Manager chat: header chip "Today ≈ N% of 5h" (chat/watch/job, tasks it started counted on
  them) and a per-reply footnote.
- Settings → Agent accounts: 5-hour and weekly lines and the tracking switch.
- `cez usage [--json]`: human summary or the versioned JSON (`schema: cezar.usage-ledger`,
  `version: 1.0.0`), the same report `GET /api/v1/workspace/plan-usage` returns.

## Hints (`report.ts`)

retry waste ≥ 1pp; several tasks hit an account's limit while another account of the same tool
sat under 50%; every watch check of a manager quiet (≥ 3). Each carries its evidence.

## Provider limitations

Claude reports utilization in whole percent and usually once per turn, so short turns read as
0–1% steps. Codex reports tokens but no cost, so Codex shares split by tokens. API-key logins
and every other runner report no plan limits ("not reported"). Claude has no login identity on
the stream, so a re-login inside the same account folder is only told apart by a new reset.
