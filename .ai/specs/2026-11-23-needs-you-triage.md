# Needs you triage: dismiss, snooze and "probably done" (2026-11-23)

Design page (approved, variant A): the task's `needs-you-design.html` artifact. Builds on
`2026-11-20-phone-notifications-inbox.md` (the attention list) and `2026-11-17-questions-inbox.md`.

## Problem

Needs you kept items that no longer needed the user: manager questions about PRs that had merged,
tasks paused for days, cards the conversation had moved past. Nothing dismissed them, and card
text showed raw `[[pr:…]]` markers.

## Decisions (owner, 2026-11-23)

- Variant A: a ✕ and a ⋯ menu on every row; settled items fold into a collapsed **Probably done** group.
- Phone: a swipe left only REVEALS Snooze and Dismiss; a tap acts. A grip on the row's edge and a
  one-time peek of the first row show that rows slide.
- "Gone quiet" reuses the Questions page's Older days (`questions.olderAfterDays`, default 7; 0 = off).
- ✕ on a question also closes the card (`dismissed`), after the Questions page's 6 s undo window.

## Server

- `AttentionItem.settled?: { why, detail }` — `why` ∈ `pr-merged | pr-closed | work-ended | overtaken | quiet`.
  A settled item stays in `items`, is never counted (`counted: false`, no per-kind count, no phone badge)
  and sorts last.
- Rules (`attention/list.ts`), all from state cezar already holds, no new forge calls:
  - a question's `stale` flag: `mentioned-work-ended` → `work-ended`, any other reason → `overtaken`;
  - an Older question → `quiet` (it used to be dropped from the list entirely);
  - a task item, or a task's own question, whose own PR (created, or declared with `CEZ:PR`) the
    forge cache knows is merged or closed → `pr-merged` / `pr-closed`;
  - a question card whose declared `about: {pr}` or mentioned `[[pr:<project>/N]]` the forge cache knows
    is merged or closed. A declared `{pr}` is looked up in the project of a mention of the same number,
    else of the tasks the card is about or came from; a bare `#N` names no project and is not read;
  - a paused task (`kind: task`) waiting longer than the Older days → `quiet`.
  Cards whose declared `about` ended, and replaced cards, already close and leave the list.
- Order: tiers — blocking decisions (approvals, questions, messages), the review gate, waits, failures.
  Within a tier an item past half the Older days sorts below the fresh ones, then by kind, newest first.
  `GET /workspace/attention` returns `olderAfterDays` so Now orders its own task rows, merged with the
  manager items, the same way.
- Overrides, `~/.cezar/attention-overrides.json` (`{ key, mode: dismiss|keep, at, until? }`): `dismiss`
  drops the item from `items` (until `until`, a snooze); `keep` clears `settled`. Keyed by item key, so
  a re-raised wait shows again. Entries expire after 30 days, at most 500 are kept, and deleting the
  file only brings items back. `GET /workspace/attention` returns the active `overrides`; a dismissal
  that hid a task's item carries that item's `projectId`/`runId`, so Now hides its own row for the run.
- Routes: `POST /workspace/attention/overrides` and `POST /workspace/attention/overrides/clear`, both
  answering `{ overrides }`. A PR closing (`onPrClosed`) and a snooze ending poke the list.

## Cockpit

- Now's own task rows borrow the server's item (by project and run) for its key, question and
  verdict. A row the server does not list is keyed `now:<project>:<run>:<since>`.
- Menu: Open, Still needs me (settled only), Dismiss, Snooze ›, Mute / Unmute this manager (the
  manager's own Notify switch, with undo) for a manager's items, Copy link, and for this project's runs
  Mark done (`/finish`), Archive task (with undo) and Stop task (the same Stop confirm the thread uses).
- Card titles render `[[pr:…]]`/`[[task:…]]` through the manager chat's reference renderer, against
  the projects health lists.

## Limits

- PR state comes only from the in-process forge cache, never a new `gh` call. It is filled whenever
  anything reads the PR: a chip on screen (Now paints a card's PR chips, so showing the row warms it),
  the GitHub tab, the per-project PR poller, a manager's merge card. A PR nothing has read is unknown,
  so its card stays live until something does. A merged answer is kept 24 h, a closed one 10 min, so on
  a long-idle server with no cockpit open a closed PR's card can come back until the next read.
