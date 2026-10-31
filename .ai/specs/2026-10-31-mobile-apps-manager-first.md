# iOS and Android apps, Manager first

Refs #1762, #882, PR #1821. Stacked on Manager PR #1880 (see [Dependencies](#dependencies)).

## TLDR

Ship one thin native shell for iOS and Android, built with **Capacitor**, that connects to a user's
hosted cezar and loads that server's own cockpit in a webview. The shell owns only what a web page
cannot: the server list, the login in the OS keychain, and later push. Everything else ships from
`packages/web`, so a UI fix reaches phones through `server-deploy`, not through store review.

- **Shell:** Capacitor. Tauri's webview layer has no HTTP auth hook in the version checked, and basic
  auth is the front door of every documented hosted install. React Native stays out.
- **Connection:** the page loads from the server, so it is same-origin. No CORS, cookie, Host guard
  or Origin guard change is needed.
- **Auth:** native code answers the webview's Basic challenge from the keychain. The password never
  reaches JavaScript or a URL.
- **Manager as default:** the shell starts at `/manager`, and a fresh load of `/` on a phone goes
  there too, in a browser tab or an installed PWA. Desktop browsers and tablets are unchanged.
- **Notifications:** no push in the first TestFlight build. Push is required before a public
  listing on either store, and native push requires a Cloudflare Worker relay the project runs.
- **First installable thing:** the web app manifest from #1762, which needs no store account.

## Evidence and its limits

Each external claim is marked. **[V]** was read in this repository, in a local crate source, or on
Apple's guidelines page. **[M]** is from memory and must be confirmed before anyone relies on it.

The research tools were restricted for this spec: `WebSearch` was denied, and `WebFetch` was denied
for capacitorjs.com, tauri.app and support.google.com. Apple's guidelines page loaded. Apple's and
Android's API reference pages returned no usable body. So **every Capacitor claim is [M]**, and the
spike in task M2 exists to settle them before any shell work is committed.

Corrections to the brief:

| Brief said | Found |
| --- | --- |
| Host guard around `server.ts:1391-1460` | It is at `packages/cezar/src/server/server.ts:1729-1798`, with the WebSocket twin at `:8439` |
| #882 is a blocker candidate | Not for Manager. The chat does not use `/runs/:id/events`. See [#882](#882-and-pr-1821) |
| The mobile composer is a single row | Closed on #1880 by `216f57d48`. See [Composer](#composer) |
| Nothing on the server can trigger a push | Partly out of date: #1880 added a server-side `alert` path. See [Decision 5](#decision-5-notifications) |
| Basic auth covers health | It does: `auth_basic` is at server level in the vhost, so `/api/v1/health` is challenged too. Probe code must expect 401 |

## Problem statement

A manager is the screen you want on a phone: it says what needs you and takes a decision. Today a
phone reaches it only through a browser tab, where basic auth is the browser's prompt, the tab is
not installable (`packages/web/index.html` has no manifest), and nothing reaches you when the tab
is closed. `packages/desktop` does not help: it spawns a local Node sidecar and trusts loopback,
and a phone has neither.

## Goals and non-goals

Goals: an installable app on both platforms, Manager on first launch, approvals usable one-handed,
and credentials held safely across several servers.

Non-goals: running agents on the phone, a local or offline mode, a relay that tunnels traffic to
the server, approving from a notification, a cross-project task list (the Manager's `/tasks`
command is that list), tablets as a designed target, a React Native client, a biometric lock,
shell telemetry for now, and direct APK or F-Droid builds in v1.

## Dependencies

### On the Manager work

Manager lands through its own PR, **draft #1880** from `cez/7c7ed729`, at `a1ebb4f72`: 19 commits on
top of `f25b6b9ad`, the current `origin/main`. This PR is stacked on that branch and carries only
this spec. Tasks M4 to M6 and M10 cannot start until #1880 merges. Manager is on by default.

This spec depends on exactly these items from that branch, re-checked at `a1ebb4f72`:

| Kind | Item | Used for |
| --- | --- | --- |
| Capability | `capabilities.managers` on `/api/v1/health` (optional in `packages/contract/src/health.ts`, set by `CEZ_MANAGERS !== '0'`) | Choosing the start screen |
| Capability | `capabilities.managerSystemNotifications` (false in hosted mode) | Knowing the OS notification path is unavailable on a hosted server |
| Routes | `GET /workspace/managers`, `GET` and `POST /workspace/managers/:id/messages` (`before`, `limit`, default 100), `POST …/stop`, `…/check`, `…/read`, `PATCH /workspace/managers/:id` | The chat |
| Route | `POST /workspace/managers/:id/actions/:actionId/decision` | Approvals |
| Events | `manager-change`, `manager-message` on `/workspace/events` | Live chat |
| Shapes | `managerSummarySchema` (`unread`, `important`, `headline`, `pendingActions`, `notify`), `managerMessageSchema`, `managerActionRequestSchema` (`merge-pr`, `enable-automation`, `add-job`) | Cards, counts |
| Web routes | `/manager`, `/manager/new`, `/manager/:id`, `ManagersGate` | Start URL and fallback |
| Components | `ManagerIndexRoute`, `ManagerListScreen`, `ManagerChat`, `ActionCard`, `Composer` `compact` and `footerEnd`, `ModeSwitch`, the Back to manager link | Layout work |
| Lib | `diffManagerAttention`, `describeManagerNotification`, `orderManagers` | Notifications, list order |
| Engine | `ManagerEngine.alert` (`engine.ts:719`), called for proposals and important replies | The push sink |
| Design | `.ai/specs/2026-10-31-managers.md`, including its approval guard and the rule that only the `decision` route performs a proposal | Safety |

Manager's own "Not in v1" list stands: no attachments in the composer, no autonomous merges.

### On a hosted server

A phone needs an `https://` cezar in hosted mode. Both installers set `CEZ_REMOTE=1`
(`ubuntu-vps.ts:851`, `macosx-ngrok.ts:248`). A loopback cockpit tunnelled by hand without that flag
answers 403 "unexpected Host header", including on health (`server.ts:1736`), and the shell must
say so plainly.

### #882 and PR #1821

#882 does not block the Manager screens. The chat pages through `/workspace/managers/:id/messages` and
listens on `/workspace/events`. The task thread already pages history with a cursor and `afterSeq`
(`packages/web/src/api/run-history.ts`, `run-events.ts`), and #1821 bounds the remaining cursorless
fallback. It is open, mergeable and labelled `do-not-merge`, `needs-qa`, `risk-high`.

Long task threads opened from a card are the exposed path, so M2 measures one on a real device over
a tunnel. What happens to #1821 is open: see [Q11](#q11-what-becomes-of-pr-1821s-do-not-merge).

## Decision 1: the shell

**Recommendation: Capacitor, loading the server's cockpit from the server.** Still open: see
[Q2](#q2-accept-capacitor).

| | Tauri 2 mobile | Capacitor |
| --- | --- | --- |
| Basic auth challenge | **No hook.** wry 0.55.1 has no `didReceiveAuthenticationChallenge` in `wry_navigation_delegate.rs` and no `onReceivedHttpAuthRequest` in `RustWebViewClient.kt` [V] | App owns the view controller and can subclass the web view client [M] |
| Reuse from `packages/desktop` | The CLI and config style only. All 3,828 lines of Rust are sidecar, updater and desktop window work [V] | None |
| Native push | No official plugin in the local registry, which holds only `tauri-plugin` itself plus updater and window-state. Maturity otherwise unknown [M] | Official push plugin [M] |
| Build toolchain | Rust, plus Android NDK and iOS targets, on top of Xcode and Gradle | Node, Xcode and Gradle |
| Runtime server URL | `load_url` exists [V] | Stock `server.url` is build-time, so native code must load the URL [M] |
| Bridge on remote pages | Explicit capability allowlist, as desktop uses [V] | May be injected into remote pages, so it needs a test [M] |

The first row decides it. Basic auth is the identity gate of both documented installs. Under Tauri
we would have to fork wry, or replace a navigation delegate that wry owns, and carry that across
every Tauri upgrade. Caveat: desktop's lockfile pins wry 0.57.1 and only 0.55.1 was in the local
cache, so M2 re-checks the current version. If a hook has landed, Capacitor still wins on push and
on not needing a Rust mobile toolchain, but the margin shrinks.

If M2 finds that Capacitor cannot keep its bridge out of remote pages, fall back to the same two
native classes with no framework. The shell's native surface is small enough that this costs little.

**Why not bundle the UI into the app.** A bundled page has an origin like `capacitor://localhost` [M],
so every write fails at `server.ts:1777` and every read fails CORS, which is open on health alone.
Fixing that means widening the guard from #426 and the "never widen" CORS rule. It would also
create a version matrix between app and server. Loading from the server avoids both.

**Why not React Native.** No hard reason appeared. Nothing here needs native rendering, the cockpit
is DOM throughout, and `paseo-ui.md` records what the dual-platform route costs. A rewrite would
also add a second client to keep in step with every server version.

**Layout:** `packages/mobile`, outside the npm workspaces for the same reason as `packages/desktop`,
holding `connect/` (a small bundled page, like `packages/desktop/ui`), `ios/` and `android/`.

## Decision 2: connection and auth

### Adding a server

1. The user enters a URL on the bundled connect screen. It must be `https://`.
2. Native code sends `GET <url>/api/v1/health` with no credentials and acts on the answer:

| Answer | Meaning | Shell does |
| --- | --- | --- |
| 200, cezar JSON | No Basic gate (VPN, or proxy already satisfied) | Save and open |
| 401 with `WWW-Authenticate: Basic` | nginx or ngrok gate | Ask for username and password, retry, then save |
| 403 with `{ error }` naming the Host header | Local-mode cockpit | Explain that it needs `server-install` or `CEZ_REMOTE=1` |
| 302 or HTML | A login page in front (oauth2-proxy, Access) | Open in the webview and let the page handle it |
| TLS failure | Bad certificate | Refuse. There is no bypass |
| Anything else | Not a cezar server | Say so, with the status |

Health is a stable surface (BACKWARD_COMPATIBILITY.md §2) and answers without a same-origin check.

### Getting through Basic auth

Native code answers the webview's challenge: `webView(_:didReceive:completionHandler:)` on iOS with
a `URLCredential` of `.forSession` persistence, `onReceivedHttpAuthRequest` with `handler.proceed`
on Android. Both are long-standing platform APIs [M, the reference pages did not load].

Storage: iOS Keychain with `WhenUnlockedThisDeviceOnly`. On Android, a Keystore key encrypting a
blob in app-private storage, excluded from backup.

Rules:

- Answer only for the exact scheme, host, port and realm saved with that server. Cancel any other
  challenge, so a redirect cannot collect the password.
- After a failed attempt, do not retry. Return to the connect screen with "password rejected".
  This also covers a password rotated on the server.
- Never put credentials in a URL, never inject them through JavaScript, and never use
  `WebViewDatabase.setHttpAuthUsernamePassword` or `.permanent` persistence.
- **No native bridge on server pages.** The cockpit renders agent output, and page script must have
  no path to the keychain. The page learns about the shell from a User-Agent token only:
  `CezarMobile/<version> (ios|android)`. It asks the shell for things by navigating to `cezar://…`,
  which the shell intercepts and never registers with the OS. A test asserts that the connection
  plugin refuses a call from a server origin.
- **Forget server** deletes the keychain item and that origin's website data.

M2 must prove that the challenge handler also covers `fetch` and `EventSource`, and that it survives
a killed web content process.

### CORS, cookies, Host and Origin

**No server change is needed for connection or auth.** Each check passes because the page is
same-origin with the server:

| Check | Result |
| --- | --- |
| Host allowlist (`server.ts:1736`) | Skipped in hosted mode |
| Origin equals Host on writes (`:1762`) | Equal, provided the proxy forwards the public host. The vhost uses `$http_host` |
| `Sec-Fetch-Site: cross-site` rejection (`:1788`) | Same-origin, so not triggered |
| CORS | Not involved |
| Cookies | cezar sets none. Identity is the proxy's Basic gate |
| WebSocket | Not opened on a remote cockpit: `useHealthSubscription` fails closed to HTTP because a browser WebSocket cannot carry proxy credentials. SSE sends `withCredentials: true` |
| `fetch` | Already `credentials: 'include'` (`api/client.ts:463`) |

The shell's native health probe sends no Origin, which the guard already treats as a non-browser
client.

Known gaps to check in M2: ngrok's free-tier interstitial may need a non-browser User-Agent [M].
`--external-proxy` installs with an SSO proxy use cookies, which the webview should keep unaided.

### Multiple servers

The shell keeps a list of `{ id, label, url, username }`, with each password stored under `id`. One
webview shows one server at a time, and switching loads the other origin. Per-origin storage keeps
theme, device id and telemetry consent separate. There is no merged view across servers in v1.

Switching is reachable from three places, so that an old server cannot trap the user: a Servers
link in the cockpit's More menu (`cezar://servers`, shown only with the User-Agent token), a home
screen quick action, and the shell's connection-error screen.

**HTTP is refused in v1.** iOS blocks cleartext by default, and credentials must not cross it. Users
without a public server reach cezar over HTTPS through ngrok, a Cloudflare Tunnel or `tailscale serve`.
Tailscale cannot be made invisible to the user: it needs its own app and sign-in on the phone, and
the shell cannot do that for them. The connect screen's error for an `http://` URL names these three.

## Decision 3: Manager as default

**Default means where a fresh start lands on a phone.** There are two entry points with one target:
the shell's cold launch, and a fresh page load of the bare `/` in a phone browser, whether a tab or
an installed PWA. Desktop browsers and tablets keep today's behaviour.

### In the shell

| Situation | Shell opens |
| --- | --- |
| Cold launch, `capabilities.managers === true` | `/manager` |
| Return from background | Wherever the user was, reconnected |
| Push tap (later phase) | That server's `/manager` |
| `capabilities.managers` false (`CEZ_MANAGERS=0`) | `/`, with a one-time native note |
| `capabilities.managers` absent (older server) | `/`, with a one-time note naming the version and `server-deploy` |
| Server unreachable | Connection-error screen with Retry and Servers |

Native code reads health before loading a page. An old server has no `/manager` route, so a blind
load would land on its legacy redirect. Capability, not version number, decides this.

### In a phone browser

The decision is made in the page, in the bare-root branch of `LegacyPathRedirect`
(`packages/web/src/routes.tsx`), because the server sends every client the same document.

**How a phone is detected:**

```ts
const isPhone = () =>
  matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600
```

| Part | Why |
| --- | --- |
| Primary pointer is coarse | A narrow desktop window has a fine pointer, so it stays unchanged. So does a touchscreen laptop |
| Short side of the **screen**, not the viewport | Rotating or resizing changes nothing, and a large phone in landscape still counts |
| 600, not the `md` breakpoint of 768 | 600 is Android's own phone and tablet line, and an iPad mini is about 744 wide [M]. Using `md` would catch it |
| No User-Agent sniffing | It is brittle, and the screen and pointer say what matters |
| No `matchMedia` means not a phone | Same stance as `useDesktopViewport` |

**The redirect fires only when all of these hold:**

1. The path is exactly `/` with no query or hash. The existing rule that query or hash makes `/`
   explicit still applies.
2. This is the first location of this page load, read once from a one-shot flag set at boot.
3. `isPhone()` is true.
4. Health has settled and `capabilities.managers === true`.
5. First-run setup is finished. `FirstRun` renders on the tasks overview
   (`tasks-overview.tsx:1714`), so an unfinished setup must land there.

Otherwise the existing restore runs unchanged. It stores and validates the last project page as it
does today.

Condition 2 is load-bearing. `ModeSwitch`'s Code link and several "Back to tasks" links point at
`/`. Without the flag they would bounce back to Manager and a phone user could never reach tasks.

| Server | Phone browser gets |
| --- | --- |
| Has Manager, managers exist | `/manager` |
| Has Manager, no managers yet | `/manager`, showing first-manager setup. The drawer's Code link leaves it |
| `CEZ_MANAGERS=0` | The existing restore, with no note. `ManagersGate` still sends a pasted `/manager` to `/` |
| Older server | Its own older cockpit, which has no such rule. An absent capability reads as false in any case |
| Health request fails | The existing restore |

**What this replaces.** `/` restored your last page on a fresh load. On a phone, that no longer
happens at `/`: the restore moves one tap away, behind Code in the drawer. Reopening a deep link or
a tab the browser restored keeps its URL, so only someone opening the bare root is affected.

The manifest keeps `start_url: "/"`, so one rule covers tabs and PWAs. A phone PWA reaches Manager
through the rule, and a PWA installed on a desktop or tablet keeps restoring its last page.

What `/manager` shows on a phone:

| Managers | Screen |
| --- | --- |
| None | The existing first-manager setup |
| One | That chat. **Change:** `ManagerIndexRoute` shows a list today |
| Several | The list. **Change:** managers with `pendingActions > 0` sort first, since `orderManagers` sorts by activity only |

A server with no project or no signed-in agent gets its existing onboarding and turn errors. M6
checks that `/manager/new` does not dead-end there.

### Navigation

Below `md` the sidebar is a drawer, so reaching tasks takes two taps through `ModeSwitch`. In the
shell and a phone PWA, add a bottom bar with three items:

| Item | Goes to | Note |
| --- | --- | --- |
| Manager | `/manager` | Carries the existing attention dot |
| Tasks | The last project's index, which is `TasksOverviewRoute` | The drawer's project list switches project |
| More | Opens the existing drawer | Settings, GitHub, automations, Servers |

The bar hides while the keyboard is open and inside a task thread, where the existing Back to
manager link is the way home. Android's back button walks webview history, then leaves the app.

### What applies where

| Behaviour | Shell | Phone PWA | Phone browser tab | Tablet and desktop |
| --- | --- | --- | --- | --- |
| Start at `/manager` | Yes | Yes | Yes | No |
| Bottom bar | Yes | Yes | No. The browser's own bottom bar is there, and the drawer reaches tasks | No |
| Chat layout and cards | Yes | Yes | Yes | Layout by width. Confirmation applies at every width |

## Decision 4: Manager chat on a phone

```text
┌──────────────────────────────┐
│ ←  Watch my repositories   ⚙ │  one row; projects line moves to settings
├──────────────────────────────┤
│  Ran 1 command ›             │
│  PR #12 is ready.            │
│ ┌──────────────────────────┐ │
│ │ Merge #12 Fix login      │ │  full width
│ │ meblohand · squash · 3fa9│ │  head sha shown
│ │ All checks passed.       │ │
│ │ [ Reject ]   [ Approve ] │ │  44pt, equal width
│ └──────────────────────────┘ │
│    ( 1 approval waiting ↓ )  │  shown when the card is off screen
│ [status] [attention] [prs]   │  shown when the draft is empty
│ ┌──────────────────────────┐ │
│ │ Type / for commands      │ │  row 1: text, full width
│ │ Opus Med        🎙 [Send]│ │  row 2: model, mic, send
│ └──────────────────────────┘ │
│              Refresh: 15 min │  hidden while typing
├──────────────────────────────┤
│  Manager    Tasks     More   │  hidden while typing
└──────────────────────────────┘
```

### Header

The QA screenshot `shots/mobile.png` spends 134pt on a top bar plus a two-line chat header. Merge
them into one row at about 52pt.

### Composer

The single-row gap is closed on #1880. Commit `216f57d48` makes `compact` wrap below `md`: the text
takes its own row, with the `+`, a model pill, mic, Stop and an always-present Send pill below it,
matching `composer-reference.png`. Desktop keeps one row.

Left for M4:

- Remove the inert `+` on phones. It does nothing until attachments exist.
- Cap the textarea at about 35dvh. Its fixed `max-h-[220px]` can fill the space above a keyboard.
- Grow the round controls from 40px (`size-10`) to 44pt on coarse pointers.
- Hide the Refresh footer while the keyboard is open.

The chat does not call `useKeyboardInsetVar`, while the task thread does (`task-thread.tsx:333`).
Add it. `interactive-widget=resizes-content` alone is not honoured by WebKit [M].

Typing `/` is slow on a phone, so an empty draft shows chips for `status`, `attention` and `prs`
from `MANAGER_COMMANDS`. `SpeechRecognition` is probably missing in webviews [M]. The existing
`dictation.supported` check hides the mic, and the keyboard's own dictation remains.

### Approval cards

The guard does not change: only the `decision` route acts, and pinned cards refuse after a change.

| Change | Why |
| --- | --- |
| Card fills the column, with equal 44pt buttons | `size="sm"` is too small for a thumb |
| Approve opens a confirmation sheet restating what will happen, subject to the setting below; Reject acts at once | A mis-tap while scrolling must not merge or start unattended work |
| Sheet by type: **merge** shows project, PR, title, method, head sha and a link to the PR; **automation** shows name, revision and summary; **job** shows name, interval and full prompt | The sheet is where the user reads the pinned facts |
| Job prompt and automation summary collapse to three lines, expanding in the sheet | `pre max-h-40` is a scroll trap inside a scrolling chat, and a prompt can be 20,000 characters |
| `deciding` moves from the chat to each card | Today one decision disables every card |
| A refused decision writes its reason on the card, not only a toast | A toast is easily missed on a phone |
| A sticky "N approvals waiting" pill jumps to the oldest pending card | A card can scroll out of the 100-message page |

The pill needs one additive server change: `pending=1` on `GET /workspace/managers/:id/messages`,
returning only pending `action` messages, with the schema added to the contract first.

### Confirmation setting

A user setting chooses which approval types need the confirmation step. **All three are on by
default: merges, automations and jobs.**

| Item | Decision |
| --- | --- |
| Place | A new global Manager section in Settings (`routes/settings/registry.tsx`), hidden when `capabilities.managers` is not true |
| Controls | Three switches: Merges, Automations, Jobs |
| Storage | `managerConfirm` in `workspaceUiStateSchema`, keyed by action type (`merge-pr`, `enable-automation`, `add-job`), with the contract changed first |
| Reach | One value per server, for every device on it. Two servers mean two settings. It applies at every width, as a sheet on phones and a dialog on desktop |
| Fails safe | A missing key, a missing or loading state, or an unknown future action type all confirm |
| Off | Approve sends the decision directly. The card still appears and still needs that tap |

The setting removes a step in the cockpit and nothing else. The `decision` route, the head sha and
revision pins, and the rule that only a person approves all stay as they are. It is not an autonomy
setting, and no value of it lets a manager act alone.

### Reconnecting and data use

iOS suspends the webview in the background and SSE dies with it. On return the cockpit's existing
reconnect path invalidates `managerKeys.all`. A stale card that is tapped anyway is refused by the
pin, so that is safe.

`manager-message` re-sends the whole message, command output included, up to every 100ms
(`STREAM_THROTTLE_MS`). M4 measures this over a tunnel. If it is heavy, extend the existing `slim=1`
opt-in on `/workspace/events` (#1848) to drop `commands[].output` from streaming frames.

### Other shell behaviour

Links off the server's origin open in the system browser. `window.open` in the task palette and
transcript must be routed there. Safe areas are already handled by `viewport-fit=cover`.

## Decision 5: notifications

**Push is needed for the product, but not for the first TestFlight build.** A manager's value is
telling you something while you are away. Without push, an approval waits until you happen to open
the app. Testers can live with that for a while. A public release should not.

What exists today:

- `run-notifications.tsx` needs an open page and the `Notification` API. That API is probably absent
  in both webviews [M], in which case `notificationSupport()` reports `unsupported` and degrades cleanly.
- #1880 adds a server-side trigger: `ManagerEngine.alert` fires for a new proposal (`engine.ts:1098`)
  and an important reply (`:715`, `:789`), and it respects `notify: false` and read state. It only
  reaches `notifySystem`, the OS notification, which is off in hosted mode. So **a hosted server
  detects these events but has nowhere to send them**.
- Needs-you tasks have no such trigger outside the browser (`describeRunNotification`) or webhooks.
- Outbound webhooks reach Slack and Discord for `task.attention_required` and similar, but they are
  per-project, behind `CEZ_WEBHOOKS=1`, and have no Manager event.

| Option | Reaches closed app | Needs | Ongoing cost |
| --- | --- | --- | --- |
| None | No | Nothing | None. Testers can use webhooks for tasks |
| Web Push to installed PWA | Yes [M, iOS 16.4+ for installed apps] | Service worker, VAPID keys the server generates itself, a server sink | None. No relay [M] |
| Native push | Yes | Relay, APNs key, FCM service account, a server sink, native code | See below |
| Background polling | Unreliable. iOS schedules it at its own discretion [M] | Native code | Battery, missed approvals |

**The relay is unavoidable for native push.** APNs and FCM credentials belong to the app's publisher.
A self-hosted server cannot hold them without shipping a secret in an npm package.

Relay cost: one small Cloudflare Worker, likely within free or $5/month tiers [M]; an APNs `.p8` key
and FCM service account in its secrets; rate limiting and token handling; on-call ownership of a
service, which this project does not have today; and a privacy policy that names it. The relay is a
stateless Cloudflare Worker owned by Open Mercato, which must hold the APNs and FCM keys, so neither
the keys nor the relay can live in the app.

**Order:**

1. A small sink interface in `packages/cezar/src/push/`, fed from `ManagerEngine.alert`, plus a new
   server-side trigger for needs-you tasks.
2. Web Push sink. It reaches installed PWAs at no cost and proves the path. M1 must first check
   that a service worker registers behind Basic auth.
3. Relay sink plus native registration.

**Payload rules:** text is generic ("Cezar needs you") with an opaque server key and nothing else.
`alert`'s body can quote a pull request title, so the sink discards it. No prompt, title, project, PR number or path reaches Apple, Google or the relay. This matches the
telemetry rule. The tap opens that server's `/manager`, where the real content loads over the
user's own authenticated connection. The badge is the sum of `pendingActions`.

**Never approve from a notification.** A lock-screen action skips the pinned card the guard relies on.

**Consent:** a push leaves the machine, so AGENTS.md § Zero config applies. The server contacts the
relay only after a device registers through an in-app toggle, and `CEZ_PUSH=0` blocks it regardless.
That in-app toggle plus `CEZ_PUSH=0` is the accepted control. There is no env opt-in, so M10 records
it in AGENTS.md § Zero config as an owner-approved exception, in the same commit.

## Decision 6: distribution

| Item | Decision |
| --- | --- |
| Accounts | Open Mercato owns the Apple and Google accounts |
| Identifiers | `com.openmercato.cezar.mobile` on both stores, accepted. Desktop keeps `com.openmercato.cezar`. This cannot change once published |
| Store name | Cezar if available, otherwise Cezar Cockpit. Unlike the bundle ID, the store name can change later |
| Channels | The stores only. No direct APK or F-Droid build in v1 |
| Shell telemetry | None now, planned for later. The cockpit's existing consent still applies inside the webview |
| Versioning | Independent of the server, like the desktop shell's 0.1.x. Build number comes from the CI run |
| iOS signing | App Store distribution certificate and an App Store Connect API key in new secrets. The existing `APPLE_*` secrets are Developer ID, for desktop |
| Android signing | Upload key in secrets, with Play App Signing holding the release key [M] |
| CI check | `mobile-check.yml`, path-filtered on `packages/mobile/**`, unsigned builds only, modelled on `desktop-check.yml` |
| CI release | `mobile-release.yml` on a `mobile-v*` tag, version matched against the manifest, skipping signing when secrets are absent, modelled on `desktop-release.yml`. Maintainers only |
| Runners | macOS for iOS, Linux for Android. The repository is public, so hosted runners should be free [M] |
| iOS testing | TestFlight internal first, which needs no App Review [M]. External testers need a beta review [M] |
| Android testing | Play internal testing. A new **personal** account must pass a 12-tester, 14-day closed test before production; organisation accounts are exempt [M], so an Open Mercato organisation account should avoid it |
| Fees | Apple $99/year, Google $25 once [M]. The Apple membership that signs desktop should cover iOS |

### Version compatibility

The server serves its own UI, so app and cockpit cannot drift. The shell's contract with a server
is small, and the implementing PR adds it to BACKWARD_COMPATIBILITY.md:

- `/api/v1/health` with `version` and `capabilities.managers` (already protected)
- `/manager` as a route
- the `CezarMobile/` User-Agent token and `cezar://servers`
- Basic auth answered at the HTTP layer

New server features are detected through capabilities. The shell does not force updates and has no
minimum server version. An old server still works, without Manager.

### App Store review

**Risk: medium to high for a public listing without push. Low for internal TestFlight.**

| Guideline | Text | Exposure | Mitigation |
| --- | --- | --- | --- |
| 4.2 Minimum Functionality [V] | Apps should "elevate it beyond a repackaged website" | The main risk: this is a webview | Native server management, keychain login, quick actions, **push**, native error screens. Add push before submitting |
| 2.5.2 [V] | Apps may not "download, install, or execute code which introduces or changes features" | The UI comes from the server | The app shows the user's own server, like a browser. It does not change the app's own features. Say so in review notes |
| 2.1 [V] | Include a demo account "and turn on your back-end service!" | A reviewer has no server | Run a demo cockpit, below |
| 5.1.1 [V] | A privacy policy link in metadata and in the app | None exists for an app | Write one, naming the relay once it exists |

**Demo server.** Host it on a small Ubuntu VPS under Open Mercato, with the existing `ubuntu-vps`
install. Cloudflare does not fit, because cezar needs a long-running Node process. The Worker relay
is separate. The provider, and whether the demo is reviewers-only, are still open: see
[Q10](#q10-where-does-the-demo-server-run-and-who-may-use-it).

The demo must run with `CEZ_DRY_RUN=1`, because a real cockpit gives shell access to anyone holding
the password. The installer has no flag for this, so a systemd drop-in adds `CEZ_DRY_RUN=1` and
`CEZ_TERMINAL=0`. The box holds nothing else, resets nightly and uses a throwaway Basic login.

Apps with a user-entered server URL are an established category (Home Assistant, Nextcloud) [M], but
a rejection under 4.2 is still plausible. A rejection does not affect TestFlight or the PWA.

Play's data safety form and any webview-app policy are [M]. Review them in task M9.

## Phased plan

Sizes: **S** up to 2 days, **M** up to a week, **L** two weeks or more. Each task is one PR unless noted.

| # | Task | Ships | Depends on | Size |
| --- | --- | --- | --- | --- |
| M1 | **Installable cockpit (#1762).** Manifest with `start_url: "/"` and `crossorigin="use-credentials"` so it loads behind Basic auth, icons, no `/api` caching. Check iOS install behind Basic auth and service worker registration | **First thing a user can install** | None | S |
| M2 | **Shell spike.** Runs first. Throwaway build on the team's own devices with local signing and no store accounts, proving every item below | Go or no-go report, which decides Q2 | None | M |
| M3 | **Land Manager.** PR #1880, on by default | Manager on `main` | Maintainer | Outside this work |
| M4 | **Phone chat.** One-row header, composer leftovers, keyboard inset, chips, measure streaming | Better chat in every phone browser | M3 | M |
| M5 | **Approvals.** Confirmation sheet and dialog, the Settings section with one switch per type (default all on), 44pt buttons, per-card state, refusal on card, pill, `pending=1` | Safer approvals at every width, on phones first | M3 | M |
| M6 | **Manager first.** `isPhone`, the bare-`/` redirect with its five conditions, one-manager chat, pending-first order, bottom bar for shell and phone PWA | Every phone browser and phone PWA opens to Manager. Desktop unchanged | M3, M1 for the bar | S to M |
| M7 | **Shell v0.1.** `packages/mobile`, connect screen, keychain, challenge handling, health routing, server list, external links | Debug builds | M2 | L |
| M8 | **Mobile CI.** `mobile-check.yml`, `mobile-release.yml`, signing | Automated test builds | M7, Open Mercato accounts | M |
| M9 | **Test tracks.** TestFlight internal and Play internal, privacy policy draft, store metadata | **First native install for testers** | M8, M4 to M6 | S |
| M10 | **Server push detection and Web Push.** `push/` sink, device registry in `~/.cezar/`, routes, in-app toggle | PWA notifications | M3, M1 | M |
| M11 | **Relay and native push.** Worker, keys, native registration | Native notifications | M10, M9 | L |
| M12 | **Public release.** Demo VPS, submission, review responses. Public listings may wait until here | Public listings | M11, Q10 | M, plus review time |

Native push is required before M12 on both stores. M2 runs first, and M1 can start alongside it. M4, M5 and M7 can run in parallel with disjoint files. M4 and M5 both touch
the Manager routes but different components.

**M2 must answer, on real iOS and Android devices:**

1. Does the challenge handler cover page load, `fetch` and `EventSource`, behind nginx and ngrok?
2. Does it recover after the web content process is killed?
3. Can server pages be kept from calling the native plugin?
4. Does a runtime URL load without `allowNavigation` weakening link handling?
5. Does a long task thread stay usable over a tunnel (#882)?
6. Does `wry` at the version desktop pins still lack an auth hook?
7. Are `Notification` and `SpeechRecognition` absent as assumed?
8. Does the ngrok interstitial appear?

## Risks

| Risk | Likelihood | Effect | Response |
| --- | --- | --- | --- |
| #1880 changes shape before landing | Medium | Dependency table goes stale | Re-check the table at M3. It already moved once, closing the composer gap |
| Phone rule catches the wrong device or traps a user | Low | Wrong landing, or no way to tasks | Tests for each device case and for the Code link |
| [M] Capacitor claims turn out wrong | Medium | Shell plan changes | M2 runs first; fallback is plain native |
| Page script reaches the keychain | Low | Credential theft by agent output | No bridge on server pages, plus a test |
| Apple rejects under 4.2 | Medium | No public iOS listing | Push first; TestFlight and PWA unaffected |
| Relay fails or is neglected | Medium | Push outage | Stateless design, owned by Open Mercato |
| Mis-tapped merge | Low | Unwanted merge | Confirmation on by default, plus server pins |
| Hosted cockpit password shared with a phone that is lost | Medium | Shell access to the server | This-device-only keychain. A biometric lock is deferred |

## Backward compatibility

- Additive only: `pending=1`, push routes, manifest route, User-Agent handling. New routes go through
  the contract, the chained family and the BACKWARD_COMPATIBILITY.md §2 inventory.
- On a phone, a fresh load of the bare `/` now opens `/manager` when the server has Manager mode, and
  the implementing PR records that in BACKWARD_COMPATIBILITY.md. Desktop browsers, tablets, in-app
  links to `/`, `/` with a query or hash, and deep links are unchanged. Desktop keeps the one-row
  composer.
- `managerConfirm` is an optional ui-state key. An older cockpit ignores it and keeps it.
- New env var `CEZ_PUSH` goes into `.env.example` and `docs/reference.md` in the commit that adds it.
- Any `~/.cezar/` device registry is rebuildable: deleting it only means re-enabling push on devices.
- A user-visible change updates its page under `docs/site` and `docs/server-install`.

## Testing

- Unit: start-URL routing, health-answer mapping, card and sheet behaviour, the empty-input case for
  `pending=1` (spec rule: a pass-through needs a test on empty input), and sink payloads carrying no
  user text.
- Phone rule, each pinned: phone, landscape phone, narrow desktop window, tablet, no `matchMedia`,
  managers false, absent, health failed, unfinished first run, `/?x`, and the Code link not bouncing
  back. Prove the Code-link test fails without the one-shot flag.
- Confirmation setting: absent and unknown types confirm, a switched-off type sends directly, and the
  `decision` request is identical either way.
- E2E: the existing dry-run Manager walk at a phone viewport, extended for the sheet and bottom bar.
- Native: Basic challenge against a local nginx, wrong password, foreign-host challenge cancelled,
  plugin refused from a server origin, forget-server clearing everything.
- Manual on devices for each test-track build, since emulators do not prove keychain, suspension or
  keyboard behaviour.

## Open questions for the maintainer

These three stay open. The decisions already taken follow in the [Decisions](#decisions) table.

### Q2: Accept Capacitor?

**Pending the M2 spike. Recommended: yes, if M2 passes.** M2 runs first, built with Capacitor on the
team's own devices with local signing and no store accounts. The shell work in M7 starts only if it
passes.

The question comes down to one fact: which framework lets native code answer a Basic auth challenge
inside the webview. Tauri cannot in wry 0.55.1 [V]. That Capacitor can is [M], from memory only.

| Option | For | Against | What it changes |
| --- | --- | --- | --- |
| Capacitor | Native code is reachable. Official push plugin [M]. No Rust mobile toolchain | Every claim is [M]. Its bridge may reach server pages. Its server URL is build-time [M] | New JS and native dependency in `packages/mobile` |
| Plain Swift and Kotlin | Full control, no bridge at all, no framework upgrades | Two small codebases with no sharing, and the connect screen is written twice | No bundled page. Push written by hand |
| Tauri with a patched wry | Matches the desktop toolchain | A fork to carry across upgrades, plus an NDK build. Sharing is config only | A Rust mobile build in CI |

M2's questions 1 to 4 and 6 settle it. If question 3 fails, the choice moves to plain native, not to
Tauri. If question 6 finds a hook in current wry, Tauri needs a second look, though Capacitor would
still lead on push.

Accepting now costs nothing if M2 fails, since M2 is throwaway. The bundle ID and accounts do not
depend on this choice.

### Q10: Where does the demo server run, and who may use it?

**Recommended: reviewers only, on a small Ubuntu VPS under Open Mercato.** The `ubuntu-vps` install is
decided. The provider is unconfirmed, and so is whether the demo is reviewers-only. A public demo
would need its login published, and a shared dry-run cockpit would need more than a nightly reset to
stay presentable. M12 cannot finish until this is answered.

### Q11: What becomes of PR #1821's do-not-merge?

**Recommended: keep `do-not-merge`, and fix the client gap before merging.** This replaces the earlier
answer of waiting for M2, because the review finding below hits phones in particular. It still does
not block the Manager screens.

State: the PR is open and mergeable, last updated 2026-10-30, and its final review on that date says
changes are needed. `useRunEvents` (`packages/web/src/api/run-events.ts`) reconnects with `afterSeq`
and no cursor, which takes the new tail path. If more than 1.5 MB was missed, the server sends
`history-truncated`, no web code listens for it, and **the transcript silently has a hole**.

That is the normal phone case. iOS suspends the webview in the background, a long task keeps writing,
and the app reconnects after more than 1.5 MB was missed. A silent gap in a transcript the user is
reading to make a decision is worse than a slow load.

| Option | For | Against | What it changes |
| --- | --- | --- | --- |
| Fix the client: handle `history-truncated` by paging the gap | Bounded replay and a complete transcript | The most work, and it needs its own test | Client change in #1821 |
| Read in full when `afterSeq > 0` | Small, as the review suggests | Reconnect cost stays high on a long gap, the phone case | Server change in #1821 |
| Park #1821 until M2 measures | No work now | #882 stays open. If M2 stalls, M9 waits on this | Nothing yet |

If M2 shows long threads stalling on a phone, #1821 blocks the M9 test builds. If they do not, it stays
an independent fix and M9 proceeds. #1821 is unrelated to #1880 and does not need to wait for it.

## Decisions

| # | Decision | Answer |
| --- | --- | --- |
| Q1 | How does Manager land, and is it on by default? | Through its own PR, #1880, with the mobile work stacked on it. On by default |
| Q3 | Who owns the store accounts? | Open Mercato |
| Q4 | Bundle ID | `com.openmercato.cezar.mobile` accepted |
| Q5 | Allow plain HTTP for LAN or Tailscale addresses? | No in v1. Users without a public server use HTTPS through ngrok, a Cloudflare Tunnel or `tailscale serve`. Tailscale cannot be made invisible to the user |
| Q6 | Does the project run a push relay, and who owns it? | Yes, as a Cloudflare Worker owned by Open Mercato, which must hold the APNs and FCM keys, so it cannot live in the app |
| Q7 | Is push required before a public listing? | Yes |
| Q8 | Should a phone browser tab also start at `/manager`? | Yes, changed from the original recommendation. See [In a phone browser](#in-a-phone-browser) |
| Q9 | Does an in-app toggle satisfy the network opt-in rule? | Yes: in-app toggle plus `CEZ_PUSH=0` |
| Q12 | Optional biometric lock | Deferred, out of the current plan |
| Q13 | Which approvals need confirmation? | Changed: a user setting per type, default on for merges, automations and jobs. See [Confirmation setting](#confirmation-setting) |
| Q14 | Shell telemetry | None now, planned for later |
| Q15 | Direct APK or F-Droid build | Not in v1 |
| Q16 | Public store name | Cezar if available, otherwise Cezar Cockpit. It can change later, unlike the bundle ID |
| Q17 | May public listings wait on M12? | Yes |

## Changelog

- 2026-10-31: Initial design.
- 2026-11-01: Stacked on #1880 and re-checked against it. Recorded maintainer decisions. A phone browser now starts at `/manager`, and confirmation became a per-type setting. Expanded Q2, Q5 and Q11.
- 2026-11-01: Closed Q1, Q5 and Q6. Q2 now waits on M2, which runs first on the team's own devices. Reopened Q10 for the provider and audience.
