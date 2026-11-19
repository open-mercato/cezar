# CezarBot: the Devices list becomes "Computers"

Status: **design, awaiting approval** (phase 1). Interactive mockup: [2026-11-19-mobile-computers-screen.html](2026-11-19-mobile-computers-screen.html).
Builds on `2026-10-31-mobile-apps-manager-first.md` and `2026-11-01-relay-qr-pairing.md`.

## Problem

The connect page's list (`packages/mobile/connect/connect.js` `drawList`, one web screen for iOS and Android)
shows a row that does not read as tappable, a loose Forget, a Notifications checkbox of unclear scope, a green
"Add a device" stronger than opening the computer, app-wide settings mixed in, no status and no "current"
mark, and a 28rem column floating on an iPad.

## Design

- **Name.** "Computers" everywhere: the title, the native switcher's actions ("Connect another computer",
  "Manage computers") and the banner button. "Device" leaves the user-facing copy.
- **Cards.** One card per computer: avatar (DeviceIdentity colour and initials, as in the switcher), name,
  where (host name, or "Paired with this phone" for relay), status in words with a dot (DeviceSwitch's
  words: Online, Offline since 09:41, Sign in needed, Removed from this computer…), "N need you", a
  **Current** pill and a chevron. The whole card opens that computer's `/manager`; on the current one it
  goes back. Order is `DeviceSwitch.rows`'s.
- **One computer.** A hero card whose primary button is **Open Manager** (offline: **Try again**, with the
  reason). **Connect another computer** is a dashed secondary button under the list in every state.
- **Blocked computers.** The amber reason plus a one-tap fix on the card: Sign in, Pair again, Confirm
  email, Accept terms. The fix leads to today's matching screen.
- **Per-computer page** (⋯ on a card): status, primary action, **Notify me** (relay only; was the loose
  checkbox), **Name** (rename), **Connection** (the one place "relay" is said), **Signed in as** (direct),
  **Forget this computer**.
- **Forget confirm.** Bottom sheet on phones, centred dialog on iPad; names what is deleted; Cancel first in
  focus, destructive button red.
- **App section** at the bottom, grouped: App lock (switch), Notifications (OS permission status, opens
  system settings), Copy startup log, Privacy policy, Version. The page footer's policy link moves here.
- **Empty state.** "Connect your computer" with three steps, Scan QR code (primary), Enter code, and "Use a
  server address instead" (today's Advanced).
- **iPad (≥ 900 pt).** Split view: list and App on the left, the selected computer's page on the right.
  Narrower windows use the phone layout.
- **Navigation.** Manager → switcher sheet → Manage computers → Computers. The ← carries the name of the
  computer you came from and returns to it (`cameFrom`); Back and the edge swipe pop one level.

## Phase 2 work (after approval)

- Native `list` rows add `status`, `words`, `need`, `initials`, `color`, `current`, `relay`, computed by the
  existing `DeviceSwitch.rows` (iOS `Shell/Switcher/`, Android `shell/`), plus a pushed redraw when a probe
  answers; new `rename` method; the outcome adds `notificationsAllowed` and `version`.
- `connect.js`/`screens.js`/`connect.css`: the list, detail, sheet and empty state; `nav.js` gains a
  `computer` level. Native switcher and banner strings renamed.
- Tests in `packages/mobile/test` (screens, nav, connect) and the native plain-class tests; before/after
  screenshots on phone and tablet.

## Open questions

1. Title: "Computers" (proposed) or "Your cezars"?
2. Rename: ship in this change, or leave the row out until a later one?
