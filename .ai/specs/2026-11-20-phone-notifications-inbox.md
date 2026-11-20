# Phone notifications: a stuck icon badge, and a place to handle what it counts

Status: proposal, waiting for the owner's pick (design page: `2026-11-20-phone-notifications-inbox.html`
in the task's Assets). Nothing is implemented.

## Problem

CezarBot's icon shows a red "1" the user cannot act on. Opening the app does not say what it counts,
and nothing clears it.

## Root cause (evidence)

The icon number is computed **on the phone**: `DeviceBook.badge` (iOS `Shell/Switcher/DeviceBook.swift:27`)
is the sum of each saved computer's **last-known** `waiting`. Android does the same through
`ServerListStore.totalNeed()` and `setNumber` on the notification (`push/PushNotifier.java:64`).
`waiting` is written from only two sources:

1. **A relay push.** The relay forwards cezar's `count` as APNs `badge` / FCM `data.count`
   (RELAY_PROTOCOL.md § 7); the Notification Service Extension stores it and rewrites the badge to the sum
   (`NotificationService.swift:18-24`).
2. **A health probe** that returns `attention.waiting` (`server.ts:2121`), which runs only while the
   *Your cezars* screen or the device sheet is open (`CezarList.swift:107`, `DeviceSheetController.swift:97`).

What goes wrong, in order of weight:

| # | Defect | Where | Kind |
| - | --- | --- | --- |
| B1 | **Nothing lowers the count.** cezar pushes only on a *new* attention (`managers/engine.ts:2013-2039`); answering, approving or reading on the desktop sends nothing, and no push ever carries a lower number. App open only re-sums the stale book (`AppDelegate.swift` → `PushNotifier.refreshBadge`, `PushNotifier.swift:104`). Opening a cezar's page directly (the usual path) never probes. The badge stays until the next push or a visit to *Your cezars*. | cezar + app | plain bug |
| B2 | **The badge can count nothing.** `badgeCount` floors at 1 (`push/relay-sink.ts:65`, `Math.max(1, …)`). A push is raised by an important manager message or a newly waiting task (`engine.ts:2022`, `:2038`), but the count it carries is `approvals + live questions` (`server.ts:9126-9129`), which includes neither. Such a push therefore arrives as "1" for an item no list in the app shows. | cezar | plain bug |
| B3 | **Delivered notifications are never removed**, on either platform: there is no `removeDeliveredNotifications`, `setBadgeCount(0)` on handling, or `NotificationManager.cancel` anywhere in `packages/mobile`. On Android the launcher badge follows the shade entry, so it stays until swiped or tapped (`setAutoCancel(true)`). | app | plain bug |
| B4 | Stage 1 in-session signals carry no count (`ServerViewController.swift:332` posts with `count: nil`), so a live phone keeps its old number. | app | gap |
| B5 | Three counts disagree: the desktop Approvals badge sums `pendingActions` over every manager (`manager-index.tsx:52`), the push count skips `notify: false` managers, and the phone's `waiting` excludes the `failed` tasks shown beside it. | cezar + web | inconsistency |

**What the "1" is right now.** Live on this machine (cockpit 0.21.0-dev, one iOS phone with a push grant):
the server's push count is `0 approvals + 3 live questions = 3`, and no manager has an unread important
message. The phone shows **1**: the value the last push or probe left in its book. It no longer matches
anything. Most likely it came from B2 (an important message or a needs-you task pushed with count 0 → 1),
then B1 kept it there.

**Android.** Same book (`ServerListStore.pushedWaiting`) and the same two writers; FCM pushes are data-only,
so the app posts its own notification with `setNumber(total)`. The shade entry is never cancelled when the
item is handled elsewhere (B3), and the number is as stale as on iOS (B1). Launchers that badge by
notification count clear once the entry is swiped; the user has no in-app way to do it.

## Fix first (small PR, no relay change)

1. **cezar** — `badgeCount` allows 0, and the count includes everything that may raise a push: unread important
   manager messages and tasks waiting on the user, from the same list the inbox shows (see *One list*). A
   push whose count is 0 is not sent.
2. **app (iOS + Android)** — on foreground, and whenever a relay cezar's page is open, read `attention`
   for every saved cezar (the existing `CezarProbe`), store it, set the badge, and **remove that cezar's
   delivered notification when its count is 0** (iOS `removeDeliveredNotifications(withIdentifiers: [cezarId])`;
   the relay's `apns-collapse-id` is the `cezarId`, so it is the request id; Android `cancel(cezarId, ID)`).
3. **web** — while running inside the app, the cockpit reports its live count (the `questions` topic plus
   approvals) to the shell, so a page that is open keeps the badge right without polling.

This makes the badge right whenever the app has been opened. It does not lower it while the app stays closed:
that needs the relay change below.

## Relay change (task for open-mercato/rome)

Add `kind: "count"` to `POST /v1/push` (protocol `v` stays 1; the relay already rejects unknown kinds):

- Same body and signature as `attention`; `count` 0–99.
- **APNs**: `apns-push-type: background`, priority 5, collapse id `cezarId`, expiry 1 hour,
  payload `{ "aps": { "content-available": 1 }, "s": "<cezarId>", "c": count }`. No alert, no `badge`
  (the app sums over computers itself). iOS may throttle it; the on-open refresh is the backstop.
- **FCM**: data-only, `priority: normal`, `ttl: 3600s`, `collapse_key` `cezarId`,
  `data: { "s": "<cezarId>", "count": "N", "t": "count" }`.
- Its own rate limit: at most 6 per grant per hour, not counted against `attention`'s.
- Answers as for `attention`. RELAY_PROTOCOL.md § 7 gains the row and both payloads.

cezar sends one only after an `attention` push went to that grant and the count has since gone down, at most
one a minute, and a final one when it reaches 0. The app, on receipt: store the count, set the badge, remove
the delivered notification if 0.

## Design

### One list

The server keeps one attention list per cezar. Every number is a filtered length of it, so nothing counts what
no list shows:

| Kind | In the list while | Handled by |
| --- | --- | --- |
| `question` | a task or manager card is open and not Older | answer, dismiss |
| `approval` | a manager action is pending | approve, reject |
| `task` | a task waits on the user with no question card, or failed | open, mark seen |
| `message` | a manager's important message is unread | open, mark read |

- Desktop Questions badge = `question`; Approvals = `approval`; Needs you total = all four.
- Push count for a phone = the kinds that phone counts (settings below). The icon = the sum over computers.
- Handled anywhere (desktop, another phone, the agent closing a card, Older, expiry) → the item leaves the list
  → counts republish → a `count` push if a phone was told a higher number.

### The place in CezarBot: a **Needs you** inbox

Inside each cezar's cockpit, reached from the bottom bar (badge on the tab) and from a push tap. Rows grouped
by kind, each with its project or manager, age, and actions: **Open**, **Answer** inline for questions,
**Approve / Reject** for approvals, **Mark read** / **Dismiss**. **Mark all read** clears `task` and `message`
items only; questions and approvals need a decision and stay (a dismissed question tells the agent, so it is
never bulk). The desktop gets the same list as a third entry beside Questions and Approvals.

Variants (detail and mocks on the design page):

- **A. Web inbox per cezar** (bottom-bar tab). One implementation for phone, desktop and the macOS notch; per
  computer only.
- **B. Native cross-cezar inbox** in the app shell, all computers in one list. Needs each cezar's items over the
  relay on every open, two native implementations, and a new tunnel read.
- **C. A + native glue (recommended).** The web inbox of A; *Your cezars* rows show each computer's count as a
  chip that opens that cezar's inbox; a tap on the icon-badge push lands there. Cross-computer at a glance,
  one inbox implementation.

### Settings

Where the per-cezar **Notify me** switch is today (*Your cezars → cezar → Notifications*), a sub-page:

- **Push me for**: Questions, Approvals, Tasks that need me, Failed tasks, Important manager messages.
- **Count on the icon**: the same kinds (defaults: all but failed tasks).
- **Quiet hours** (cheap, server-side): pushes held; a single push at the end if anything is still waiting;
  `count` pushes still go out.

The choice must live on the server, because the relay carries no kind: the phone sends it with the grant on
`PUT /api/v1/workspace/phone/push` (an added optional `prefs` object, stored per device in `devices.json`).
Per-manager "Notify me when important" stays as it is and still gates `message`.

## Open questions for the owner

1. Variant A, B or C.
2. Ship the *Fix first* PR now, ahead of the rest?
3. Do failed tasks count on the icon by default?
4. Quiet hours in the first cut, or later?
