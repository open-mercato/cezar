# CezarBot: a clearer Devices screen

Status: **design, awaiting approval** (phase 1). Interactive mockup: [2026-11-19-mobile-devices-screen.html](2026-11-19-mobile-devices-screen.html).
Builds on `2026-10-31-mobile-apps-manager-first.md` and `2026-11-01-relay-qr-pairing.md`.

## Problem

The connect page's list (`packages/mobile/connect/connect.js` `drawList`, one web screen for iOS and Android)
shows a row that does not read as tappable, a loose Forget, a Notifications checkbox of unclear scope, a green
"Add a device" stronger than opening the cezar, app-wide settings mixed in, no status and no "current"
mark, and a 28rem column floating on an iPad.

## Design

- **Name.** What the list holds is a cezar, wherever it runs: a laptop, a VPS or a cloud host. "Computer"
  and "device" both name the hardware, and are wrong for a hosted cezar (and "device" also means the phone).
  Proposed: **Your cezars**, "Connect another cezar", "This cezar", "Forget this cezar". The mockup's Name
  control compares Machines, Servers and Connections in every state. The same noun replaces "device" in the
  native switcher's actions and the banner button. "Workspace" is avoided: cezar already uses it for its own
  multi-project registry.
- **Cards.** One card per cezar: avatar (DeviceIdentity colour and initials, as in the switcher), name,
  where (host name, or "Paired with this phone" for relay), status in words with a dot (DeviceSwitch's
  words: Online, Offline since 09:41, Sign in needed…), "N need you", a **Current** pill and a chevron. The
  whole card opens that cezar's `/manager`; on the current one it goes back. Order is `DeviceSwitch.rows`'s.
- **One cezar.** A hero card whose primary button is **Open Manager** (offline: **Try again**, with the
  reason). **Connect another cezar** is a dashed secondary button under the list in every state.
- **Blocked cezars.** The amber reason plus a one-tap fix on the card: Sign in, Pair again, Confirm email,
  Accept terms. The fix leads to today's matching screen. "Removed from this computer" becomes "This phone
  was removed".
- **Per-cezar page** (⋯ on a card): status, primary action, **Notify me** (relay only; was the loose
  checkbox), **Name** (rename), **Connection** (the one place "relay" is said), **Signed in as** (direct),
  **Forget this cezar**.
- **Forget confirm.** Bottom sheet on phones, centred dialog on iPad; names what is deleted; Cancel first in
  focus, destructive button red.
- **App section** at the bottom, grouped: App lock (switch), Notifications (OS permission status, opens
  system settings), Copy startup log, Privacy policy, Version. The page footer's policy link moves here.
- **Empty state.** "Connect your cezar": open cezar wherever it runs, Settings → Connect a phone, scan.
  Scan QR code (primary), Enter code, and "Use a server address instead" (today's Advanced).
- **iPad (≥ 900 pt).** Split view: list and App on the left, the selected cezar's page on the right.
  Narrower windows use the phone layout.
- **Navigation.** Manager → switcher sheet → Manage cezars → Your cezars. The ← carries the name of the
  cezar you came from and returns to it (`cameFrom`); Back and the edge swipe pop one level.

## Decisions (approved 2026-11-19)

The noun is **Your cezars**. Rename ships in this change.

## Native ↔ page contract (phase 2)

Identical on iOS (`ConnectionPlugin.swift`) and Android (`ConnectionPlugin.java`). Additive only: an older
page ignores the new fields, and the page treats every new field as optional (an older app draws today's
"Checking…"-free card with no status line).

**Every listed outcome** (`listed(...)`, so `launch`, `list`, `pushSet`, … alike):

| Field | Shape | Source |
| --- | --- | --- |
| `servers[].initials` | string, may be empty (the page draws a generic glyph) | `DeviceIdentity.initials(label)` |
| `servers[].color` | `#rrggbb` | `DeviceIdentity.color(label)` |
| `servers[].status` | `checking` \| `online` \| `offline` \| `other` | last probe reading, else `checking` |
| `servers[].words` | string | `DeviceSwitch.words` (`Online`, `Offline since 14:02`, `Checking…`, `Sign in needed`, …) |
| `servers[].reason` | for `other` only: `sign-in` \| `removed` \| `email` \| `account` \| `terms` \| `suspended` \| `update-app` \| `update-cezar` \| `quota` \| `broken` | the status's kind |
| `servers[].need` | int or null | reading's attention, else `DeviceBook` |
| `notifications` | `allowed` \| `denied` \| `unknown` | the OS permission for the app |
| `version` | string, e.g. `0.1.1 (87)` | bundle / `BuildConfig` |

**New methods**

- `probe({ current })` → listed outcome. Runs `DeviceProbes` once over every saved server (the one whose id
  is `current` counts online, as in `DeviceSwitch.rows`), resolves when all answered or at
  `DeviceProbes.boundMs`, notes each reading in `DeviceBook` as the switcher does, then releases the warm
  links (`stop()`). Readings are kept in memory so the next `listed` carries them. A second `probe` while one
  runs joins it. The page calls it after drawing the list, on return to the foreground, and every 60 s while
  the list is up.
- `rename({ id, label })` → listed outcome. Trims; 1–60 characters; saves `ServerRecord.label`. Unknown id or
  empty label → listed outcome plus `renameError` (a sentence for the user).
- `notificationSettings()` → `{}`. Opens the OS's notification settings for the app.

**Native copy** (switcher sheet, banner, status words, prompts): "Devices" → "Your cezars", "Add a device" →
"Connect another cezar", "Manage devices" → "Manage cezars", the banner's "Devices" → "Cezars", "Removed
from this computer" → "This phone was removed", and the push prompt's "on the Devices list" → "in Your
cezars".

## Phase 2 split

- iOS native: `packages/mobile/ios/**` and `packages/mobile/test/swift/**`.
- Android native: `packages/mobile/android/**`.
- Page: `packages/mobile/connect/**` and `packages/mobile/test/*.test.mjs` (list, per-cezar page, Forget
  sheet, empty state, iPad split ≥ 900 px, rename, probe loop).
