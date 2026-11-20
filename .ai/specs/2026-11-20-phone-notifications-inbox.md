# Phone notifications: a stuck icon badge, and a place to handle what it counts

Status: accepted 2026-11-20. Design page: `2026-11-20-phone-notifications-inbox.html`, beside this file.

## Decisions (owner, 2026-11-20)

| Question | Decision |
| --- | --- |
| Where the list lives | **Variant D**: the Now tab is the one list, plus C's per-computer count chips on *Your cezars*. No new tab. |
| Review-ready tasks | They count toward the icon, with their own switch, **on** by default. |
| Relay | `kind: "count"` as in § Relay change, built in rome (task `rome/a753ea6e`). |
| Settings | A full page per cezar: which kinds push, which count on the icon, and quiet hours, stored on the computer. |
| Fix first | B1–B3 ship separately (task `cezar/5aeb1ea2`). The D work builds on main and does not repeat them. |

Default kinds are all on, for both push and icon, except **Failed tasks**, which push but do not count on the icon.

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
- Answers as for `attention`. RELAY_PROTOCOL.md § 7 gains the row and both payloads. This adds to v1 and
  does not replace anything: § 7's "`attention` is the only value" becomes "`attention` or `count`", and
  `test-vectors/relay/` gains the `count` cases. The request keeps § 7's six fields, so AGENTS.md's
  phone-push exception still holds.

**Only phones that understand it.** Released Android builds post a notification for *every* data push
(`CezarMessagingService.onMessageReceived` reads only `s` and `count`), so a `count` push would show them
"Cezar needs you", even for a count of 0. The phone therefore declares the push kinds it understands when
it hands over its grant, through the prefs route below (`kinds: ["attention", "count"]`). cezar sends `count` only to a
device that declared it. A device that has not declared it gets no `count` push and relies on the on-open
refresh. Released iOS builds have no background handler and drop the push, but they are gated the same way.

cezar sends one only after an `attention` push went to that grant and the count has since gone down. It sends
at most one per 10 minutes per grant, which fits the relay's 6 an hour. Changes in between are merged, and
the newest count goes out at the next free slot, so the final 0 always gets sent and is never rate-limited
away. A 429 moves the next slot to the `Retry-After` time and leaves the pending value in place. Tests pin
the gate (no `count` push to a device that did not declare it) and the cadence (a falling count ends with one
push of 0). The app, on receipt: store the count, set the badge, remove the delivered notification if 0.

## Design

### One list

The server keeps one attention list per cezar. Every number is a filtered length of it, so nothing counts what
no list shows:

| Kind | In the list while | Handled by |
| --- | --- | --- |
| `question` | a task or manager card is open and not Older | answer, dismiss |
| `approval` | a manager action is pending | approve, reject |
| `task` | sub-kind `needs-you`: waits on the user with no question card; `review`: at the review gate; `failed`: failed and not yet seen | open, mark seen |
| `message` | a manager's important message is unread | open, mark read |

Each switch in § Settings filters one of these: Questions → `question`, Approvals → `approval`, Tasks that
need me → `task/needs-you`, Tasks ready for review → `task/review`, Failed tasks → `task/failed`, Important
manager messages → `message`. "Mark seen" on a task reuses the run's existing read receipt (`RunRecord.seenAt`,
`isUnread()` in `lib/read-state.ts`) and needs no new store.

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
- **C. A + native glue.** The web inbox of A; *Your cezars* rows show each computer's count as a
  chip that opens that cezar's inbox; a tap on the icon-badge push lands there. Cross-computer at a glance,
  one inbox implementation.

- **D. Now *is* the list (recommended, owner's suggestion 2026-11-20).** No new tab or page: Now's
  *Needs you* section becomes the server's attention list, and every count is a filter of it. Details below.

### Variant D: the Now tab as the one list

**Today.** Now (`routes/now/now.tsx`, spec attention-first cockpit 2026-11-11) is the project home and the
first item on the phone bottom bar (`phone-bottom-bar.tsx`, `item('', 'Now', …)`). It has four sections:
Sign-in needed, **Needs you**, Running and Finished today. Needs you is derived **in the browser** from
**this project's runs** (`now-model.ts` `needsYouRows`). Its reasons are question, review, budget, waiting,
lifecycle and failed, each with one action. It shows no manager items. The Now tab carries no count; the
Manager tab has only a dot.

**What D changes.**
- Needs you reads the server attention list instead of deriving its own. The task rows keep today's reasons
  and their single action, and the list now also holds the task kinds the badge counts. Answering inline
  uses the Questions inbox's answer route.
- A **From managers** group sits at the top of Needs you: manager questions, approvals and unread important
  messages, each naming its manager, with Answer, Approve/Reject, Open chat and Mark read.
- The Now tab on the bottom bar (and Now in the desktop sidebar) gets the count badge. The Manager tab keeps
  its dot.
- Running and Finished today stay below, unchanged, so Now remains the project home.

**Projects versus manager items.** Now is project-scoped (`/p/:projectId/`), but the badge counts the whole
cezar, and a manager's messages belong to no project. So Now gets a scope switch, **This project · All**:
- *This project* shows that project's task rows, plus the manager items of managers connected to that project
  (`connectedProjectIds`). A manager connected to no project shows only under *All*.
- *All* shows every project's task rows, grouped by project, plus every manager item. Its count is exactly the
  icon's number for this cezar.
- A push tap and the badge both land on *All*. The switch remembers the last choice per device.

**Several cezars.** Now lists one cezar's items, because each computer serves its own cockpit. The cross-computer
view stays native: C's per-computer count chips on *Your cezars*, where a tap opens that cezar's Now on *All*.
The icon remains the sum over computers.

**Is a new tab still needed?** No. D removes the Needs-you tab of A and C, and the desktop third entry. The
desktop Questions and Approvals pages stay as they are, as filtered views of the same list: their badges equal
the counts of Now's matching rows.

**Costs and risks.**
- The server list from *One list* is still the main work, and it is shared with A.
- Now's client-side derivation becomes a projection of the server list. `deriveAttention` stays the source of
  task reasons, moved server-side or kept in sync by a parity test.
- Review-gate tasks are already in Now's Needs you, so they join the list as `task` and show as their own
  push/count switch ("Tasks ready for review").
- On the desktop, Now becomes busier for someone with many managers. The From-managers group collapses after
  three rows.

**Recommendation: D, plus C's native chips.** This is one list in a place the user already opens first, adds
no new navigation, and closes the gap that Now's "Needs you" counts different things from the badge.

### Settings

Where the per-cezar **Notify me** switch is today (*Your cezars → cezar → Notifications*), a sub-page:

- **Push me for**: Questions, Approvals, Tasks that need me, Tasks ready for review, Failed tasks, Important
  manager messages.
- **Count on the icon**: the same kinds (defaults: all but failed tasks).
- **Quiet hours** (cheap, server-side): pushes held; a single push at the end if anything is still waiting;
  `count` pushes still go out.

The choice must live on the server, because the relay carries no kind. It has **its own route**,
`GET`/`PUT /api/v1/workspace/phone/push/prefs`, stored per device in `devices.json`:
`{ push: Kind[], icon: Kind[], quiet?: { from: "HH:MM", to: "HH:MM", timeZone: <IANA zone> }, kinds: PushKind[] }`.
Same scope rules as its siblings: 403 outside a relay scope, and it acts only on the device that scope proved.
The time zone is the phone's own, sent with each `PUT`, because the cezar host's clock is wrong for a phone
that is travelling. Prefs do not go on `PUT /workspace/phone/push`: that body is `.strict()` (BACKWARD_COMPATIBILITY.md
§2, "takes exactly `{grant, grantId, expiresAt}`"), so a new phone sending `prefs` to an older cezar would get
a 400 and lose its push grant. On the separate route, an older cezar answers 404. The phone then shows the
settings page read-only with the defaults and keeps its grant. The route gets its BACKWARD_COMPATIBILITY.md §2
line in the code PR. Per-manager "Notify me when important" stays as it is and still gates `message`.

## Delivery

1. Spec (this PR).
2. Fix first: task `cezar/5aeb1ea2`.
3. Relay `kind: "count"`: task `rome/a753ea6e`. cezar's sender lands once the relay accepts the kind.
4. D, in the code PR: the server attention list and its route; Now's Needs you reads it, with a From-managers
   group and the This project · All switch; the Now tab's count badge; the per-phone prefs (push kinds, icon kinds,
   quiet hours, declared push kinds) on `PUT /api/v1/workspace/phone/push/prefs` and their settings page; the count
   chips on *Your cezars*.
