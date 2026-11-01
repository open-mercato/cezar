# Desktop notch

A cezar-only island around the MacBook camera, for Managers (spec `2026-10-31-managers`). macOS
only, in `packages/desktop`. It shows who is active and takes you to their chat. Approvals stay in
the cockpit: the notch has no approve control and cannot reach the `decision` route.

The owner's two reference screenshots had not arrived when this was built. Every size is in
`ui/notch/layout.json`, and the shell and the page both read it, so the layout changes in one file.

## What counts as active

`notch_model.rs`, pinned as portable input/output pairs in `fixtures/notch-model.json`.

| A manager is active when | Face | Why |
| --- | --- | --- |
| `pendingActions + pendingQuestions > 0` | needs-you | Waiting on the user, whatever else it is doing |
| `status: error` and `lastActivityAt` in the last 30 minutes | error | `error` sticks until the next turn, so a stale one would pin the notch open for days |
| `status: working` | working | A turn is running or queued |

Nothing else is active. The error row is an addition to the brief: without it the error face could
never appear. `idle` is never active, so the idle face shows only in the fold-away.

**Running tasks need a new field.** `status` follows the manager's own turn, so a manager idling
while its tasks run reads as idle. `ManagerSummary` carries no count of them, and `snapshot()`
cannot stand in: it makes GitHub calls per project, per manager. A `runningTasks` count on the
summary would need the engine to track which tasks each manager started. Left out here.

`important` unread messages do not count either: the brief starts from pending items, and an
unread message is already the OS notification's job.

## Which manager shows

Order, from `ManagerSummary` alone so that a widget computes the same answer:

1. face: needs-you, error, working
2. more pending first
3. oldest `createdAt`, then `id`

`lastActivityAt` is left out on purpose: it moves on every message, and two working managers would
keep swapping pills. Pill 1 is the first. Pill 2 is the next four, never repeating pill 1, so it
needs at least two active. Beyond those, `overflow` is the `+N`. Five active managers show pill 1
and four minis with no count; six show `+1`.

## Layout

The shape a widget should mirror. `model` is `null` for the third state, where nothing shows.

```
primary  { id, name, avatar, face, text, badge? }   pill 1
minis    [{ id, name, avatar, face }]  (0–4)        pill 2, absent when empty
overflow number                                     pill 2's "+N"
active   [same as primary]                          the open list, primary first
```

- **Pill 1**: joins the camera housing. Left wing is the face, right wing is `text` (`preview`, one
  line, 48 characters at most, `[[task:…]]` tokens removed; a status sentence when there is none).
  The camera stays centred, so the wings differ in width.
- **Pill 2**: a detached capsule to the right of pill 1, like the Dynamic Island's second bubble.
  `pill2.placement: "below"` hangs it under pill 1 instead.
- **Open**: one sheet grows out of the housing, 440 wide, up to six rows of face, name, text and
  badge or status, then scrolls. Pill 2 folds into it.
- **No notch**: the same shapes float as capsules at top centre, 6 below the menu bar.

Screenshots: `assets/notch/`, one per state.

## Faces

Built from the cockpit's avatar (`faces.js`; a test fails if it drifts from `manager-avatar.tsx`).

| State | Pose | Motion |
| --- | --- | --- |
| idle | dimmed | a blink every 6s |
| working | | looks side to side, gentle bob |
| needs-you | wide eyes, amber ring | bounces, the ring pulses |
| error | crossed eyes, desaturated, red ring | shudders twice |

Reduce Motion stops all of it and keeps every pose, and replaces the spring with a fade.

## Panel

A Tauri webview window, swapped to an `NSPanel` subclass (`notch.rs`). tao builds plain windows, and
only an `NSPanel` honours `NonactivatingPanel`. `canBecomeKey` and `canBecomeMain` are false.

- **Focus**: never key, never main; a click does not activate cezar. Opening a chat activates the
  main window, on purpose.
- **Clicks**: the panel is 1000×400 and mostly nothing, with `ignoresMouseEvents` on except while
  the pointer is over a shape the page reported. Corners of a shape's bounding box count as shape.
- **Hover**: WebKit gives a window that can never be key no hover, so a thread samples
  `NSEvent.mouseLocation` every 70ms while the panel shows. 140ms of dwell opens, 380ms off it
  closes, and row highlight is forwarded to the page.
- **Displays**: the panel lives on the display the pointer is on, checked once a second, which also
  catches displays coming and going. An open list stays put until it folds.
- **Spaces**: `canJoinAllSpaces`, `fullScreenAuxiliary`, `stationary`, `ignoresCycle`, level 25 (over
  the menu bar, under its open menus).

**No `macOSPrivateApi`.** `background_color` with alpha 0 reaches wry's transparent path with no
Tauri flag, and the window is cleared with public AppKit calls. wry still sets the private
`drawsBackground` key underneath, as it does for any background colour. Notarisation does not check
for that, and it would only matter for the Mac App Store, which cezar does not use. The class swap
is ordinary Objective-C runtime. No entitlement, signing, notarisation or updater change.

## Cost

Everything is lazy: no panel and no web process until a manager is first active.

| State | Work |
| --- | --- |
| Toggle off | no polling, threads parked |
| Nothing active | one loopback GET every 30s; pointer thread parked; panel ordered out, animations off |
| Someone active | one loopback GET every 4s; pointer sample every 70ms; face animations |
| `CEZ_MANAGERS=0` or an older sidecar | one GET every 5 minutes |

Polling, not `/workspace/events`: that stream carries every task's frames and usage, so it would wake
the shell constantly for nothing. Two failed polls are tolerated so a busy sidecar does not blink
the notch. A manager that turns active with nothing else active can take up to 30s to appear.

Nothing leaves the machine: the only request is to the sidecar on `127.0.0.1`. The page has a CSP,
runs bundled files only, and sets manager text with `textContent`, because that text is agent
output that may quote anyone.

## Settings

Settings → Notifications → Manager notch. On by default, because with no active manager nothing
shows. The shell owns the answer in `~/.cezar/desktop-notch.json` (missing or corrupt means on), so
it holds whichever managed cezar version is active; the row appears only when the shell stamps
`__CEZ_DESKTOP__.notch`, so a browser, Windows, Linux and an older shell never see it.

## Trying it

`scripts/notch-fixture-sidecar.mjs` stands in for cezar and serves a managers file you can edit;
its header has the command. `scripts/notch-snapshots.mjs` regenerates the screenshots.
