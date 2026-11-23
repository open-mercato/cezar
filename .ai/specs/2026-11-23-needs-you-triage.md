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
  A settled item stays in `items`, is in no count (total, per kind, phone badge, notch) and sorts last.
  Its `counted` keeps what it would be once live, so "Still needs me" restores the right count.
- Rules (`attention/list.ts`), all from state cezar already holds, no new forge calls:
  - a question's `stale` flag: `mentioned-work-ended` → `work-ended`, any other reason → `overtaken`;
  - an Older question → `quiet` (it used to be dropped from the list entirely);
  - a task item, or a task's own question, whose CURRENT PR (the newest it created or declared; never a
    superseded one, never one it only mentions) the forge cache knows is merged or closed → `pr-merged` /
    `pr-closed`;
  - a question card whose declared `about: {pr}` or mentioned `[[pr:<project>/N]]` the forge cache knows
    is merged or closed. A declared `{pr}` is looked up in the project of a mention of the same number,
    else of the tasks the card is about or came from; a bare `#N` names no project and is not read;
  - a paused task (`kind: task`) waiting longer than the Older days → `quiet`, its detail the real age.
  A PR settles an item only when it ended AFTER the item began (`mergedAt`/`closedAt`, read by the same
  ref-status query cezar already runs): a PR that ended before the task asked again says nothing about
  the new wait, and an unknown end time settles nothing. What cezar has seen end is kept in
  `~/.cezar/attention-pr-ends.json` (`{ root, number, state, endedAt }`, at most 2,000), so a verdict
  outlives the forge cache's 10 min / 24 h TTL and a restart; a fresh read that finds the PR open again
  drops it. On a tie in time (legacy refs), a created PR outranks a declared one, and declaring a PR
  again (`CEZ:PR`) makes it the newest.
  Cards whose declared `about` ended, and replaced cards, already close and leave the list.
- Order: tiers — blocking decisions (approvals, questions, messages), the review gate, waits, failures.
  Within a tier an item past half the Older days sorts below the fresh ones, then by kind, newest first.
  `GET /workspace/attention` returns `olderAfterDays` so Now orders its own task rows, merged with the
  manager items, the same way.
- Overrides, `~/.cezar/attention-overrides.json` (`{ key, mode: dismiss|keep, at, until?, projectId?, runId? }`): `dismiss`
  drops the item from `items` (until `until`, a snooze); `keep` clears `settled`. Keyed by item key, so
  a re-raised wait shows again. Entries expire after 30 days, at most 500 are kept, and deleting the
  file only brings items back; a store re-reads the file when its stamp changes, so another cezar
  process's write shows. On a home cezar cannot write, this process's changes are kept in memory and laid
  over the file on every read, so none is lost and another writer's still show (`attention/keyed-store.ts`). `GET /workspace/attention` returns the active `overrides`. A dismissal stores
  its task (`projectId`/`runId`, sent by the cockpit) and also covers that run's items that began before
  it: when a dismissed question's card closes, the run's wait comes back under a task key and stays
  hidden. A wait that began after the dismissal shows again.
- Routes: `POST /workspace/attention/overrides` and `POST /workspace/attention/overrides/clear`, both
  answering `{ overrides }`.
- Live: the workspace stream carries `attention-change` (`{}`) whenever the list may have changed with no
  run, manager or question frame saying so: an override write (a phone's included), a snooze ending or a
  dismissal reaching its 30-day TTL (one timer for the soonest, armed on every read and write), a PR
  closing. Once per change: when a phone listens, the recount announces it; otherwise the change itself.
  The cockpit re-reads the list on it.
- `GET /workspace/managers` adds `needsYou: { approvals, questions }` per manager, what Now still lists.
  The notch shows it; the manager heads count from the attention list itself. A muted manager's cards
  stay there (Notify off takes them out of the Now and phone badges only, as its toast says).

## Cockpit

- Now's own task rows borrow the server's item (by project and run) for its key, question and
  verdict. A row the server does not list is keyed `now:<project>:<run>:<since>`.
- Menu: Open, Still needs me (settled only), Dismiss, Snooze ›, Mute / Unmute this manager (the
  manager's own Notify switch, with undo) for a manager's items, Copy link, and for this project's runs
  Mark done (`/finish`), Archive task (with undo) and Stop task (the same Stop confirm the thread uses).
- Undo: a question's card closes 6 s after ✕; the toast offering Undo leaves after 5 s and, while hovered
  or focused, holds both its own clock and the close. An Undo that came after the close was sent says
  so. Override writes for one key go out in click order, so an Undo never lands before its dismiss.
- A question whose close failed (not a 409) shows again with the reason, as on the Questions page. The
  recovery rides the pending close itself (`scheduleDismiss`'s `onFailed`), so it runs after Now unmounts.
- Card titles render `[[pr:…]]`/`[[task:…]]` through the manager chat's reference renderer, against
  the projects health lists.

## Limits

- PR state comes only from the in-process forge cache, never a new `gh` call. It is filled whenever
  anything reads the PR: a chip on screen (Now paints a card's PR chips, so showing the row warms it),
  the GitHub tab, the per-project PR poller, a manager's merge card. A PR nothing has read is unknown,
  so its card stays live until something does. A merged answer is kept 24 h, a closed one 10 min, so on
  a long-idle server with no cockpit open a closed PR's card can come back until the next read.
