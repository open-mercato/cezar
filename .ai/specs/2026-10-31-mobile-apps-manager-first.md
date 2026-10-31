# iOS and Android apps, Manager first

Refs #1762, #882, PR #1821. Depends on the unmerged Manager work (see [Dependencies](#dependencies)).

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
- **Manager as default:** the shell and an installed PWA start at `/manager`. A browser tab on a
  phone keeps today's behaviour.
- **Notifications:** no push in the first TestFlight build. Push is required before a public App
  Store listing, and native push requires a relay the project runs.
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
command is that list), tablets as a designed target, and a React Native client.

## Dependencies

### On the Manager work

Manager mode is **not on `main`, has no PR, and is not on `origin`** (`git ls-remote` finds no
branch). It exists only as the local branch `cez/7c7ed729` at `d70ddc04f`, 17 commits on top of
`f25b6b9ad`, the current `origin/main`. All seven child branches are merged into it. Reviewers of
this spec cannot read that branch until it is pushed. Tasks M4 to M6 and M10 cannot start until it
lands, and its default-on flag still awaits owner ratification in its own AGENTS.md entry.

This spec depends on exactly these items from that branch:

| Kind | Item | Used for |
| --- | --- | --- |
| Capability | `capabilities.managers` on `/api/v1/health` (optional in `packages/contract/src/health.ts`, set by `CEZ_MANAGERS !== '0'`) | Choosing the start URL |
| Routes | `GET /workspace/managers`, `GET` and `POST /workspace/managers/:id/messages` (`before`, `limit`, default 100), `POST …/stop`, `…/check`, `…/read`, `PATCH /workspace/managers/:id` | The chat |
| Route | `POST /workspace/managers/:id/actions/:actionId/decision` | Approvals |
| Events | `manager-change`, `manager-message` on `/workspace/events` | Live chat |
| Shapes | `managerSummarySchema` (`unread`, `pendingActions`), `managerMessageSchema`, `managerActionRequestSchema` (`merge-pr`, `enable-automation`, `add-job`) | Cards, counts |
| Web routes | `/manager`, `/manager/new`, `/manager/:id`, `ManagersGate` | Start URL and fallback |
| Components | `ManagerIndexRoute`, `ManagerListScreen`, `ManagerChat`, `ActionCard`, `Composer` `compact`, `ModeSwitch`, the Back to manager link | Layout work |
| Lib | `diffManagerAttention`, `describeManagerNotification`, `orderManagers` | Notifications, list order |
| Design | `.ai/specs/2026-10-31-managers.md`, including its approval guard and the rule that only the `decision` route performs a proposal | Safety |

Manager's own "Not in v1" list stands: no attachments in the composer, no autonomous merges.

### On a hosted server

A phone needs an `https://` cezar in hosted mode. Both installers set `CEZ_REMOTE=1`
(`ubuntu-vps.ts:851`, `macosx-ngrok.ts:248`). A loopback cockpit tunnelled by hand without that flag
answers 403 "unexpected Host header", including on health (`server.ts:1736`), and the shell must
say so plainly.

### #882 and PR #1821

Neither blocks the Manager screens. The chat pages through `/workspace/managers/:id/messages` and
listens on `/workspace/events`. The task thread already pages history with a cursor and `afterSeq`
(`packages/web/src/api/run-history.ts`, `run-events.ts`), and #1821 bounds the remaining cursorless
fallback. It is open, mergeable and labelled `do-not-merge`, `needs-qa`, `risk-high`.

Long task threads opened from a card are the exposed path, so M2 measures one on a real device over
a tunnel. If the phone still stalls there, #1821 blocks the M9 test builds. Otherwise it stays independent.

## Decision 1: the shell

**Recommendation: Capacitor, loading the server's cockpit from the server.**

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

**HTTP is refused in v1.** iOS blocks cleartext by default and credentials must not cross it.
Tailscale users can use `tailscale serve` for HTTPS [M].

## Decision 3: Manager as default

**Default means the start URL the shell opens on a cold launch.** It does not change what `/` does
on any server.

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
shell and an installed PWA, add a bottom bar with three items:

| Item | Goes to | Note |
| --- | --- | --- |
| Manager | `/manager` | Carries the existing attention dot |
| Tasks | The last project's index, which is `TasksOverviewRoute` | The drawer's project list switches project |
| More | Opens the existing drawer | Settings, GitHub, automations, Servers |

The bar hides while the keyboard is open and inside a task thread, where the existing Back to
manager link is the way home. Android's back button walks webview history, then leaves the app.

### Shell only, or mobile web too

- **Start at `/manager`:** shell and installed PWA only (manifest `start_url`, falling through
  `ManagersGate` to `/` when managers are off). A browser tab's bare `/` keeps restoring the last
  project page. That behaviour works today and existing phone users rely on it.
- **Bottom bar:** shell and PWA only, detected by the User-Agent token or `display-mode: standalone`.
- **Chat layout and cards:** every phone width. Those are defects, not preferences.

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
│ │ Chron 15  Opus Med   🎙 ➤│ │  row 2: pickers, mic, send
│ └──────────────────────────┘ │
├──────────────────────────────┤
│  Manager    Tasks     More   │  hidden while typing
└──────────────────────────────┘
```

### Header

The QA screenshot `shots/mobile.png` spends 134pt on a top bar plus a two-line chat header. Merge
them into one row at about 52pt.

### Composer

The gap is real. `composer-reference.png` shows two rows, text above controls. The branch ships
`compact`, one row of an inert `+`, the text, mic and send, with the pickers in a separate footer
below. Below `md`, `compact` becomes the stacked layout:

- Row 1 is the textarea at full width, capped at about 35dvh so it cannot push the chat off screen.
- Row 2 holds the Chron and model pickers on the left, and mic, Stop and Send on the right.
- The inert `+` is dropped on phones. It does nothing until attachments exist.
- Send stays in place, disabled when empty, so the row does not shift.
- Controls grow from `size-8` to 44pt on coarse pointers.
- Desktop keeps the one-row layout from the Manager design.

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
| Approve opens a bottom sheet restating what will happen; Reject acts at once | A mis-tap while scrolling must not merge or start unattended work |
| Sheet by type: **merge** shows project, PR, title, method, head sha and a link to the PR; **automation** shows name, revision and summary; **job** shows name, interval and full prompt | The sheet is where the user reads the pinned facts |
| Job prompt and automation summary collapse to three lines, expanding in the sheet | `pre max-h-40` is a scroll trap inside a scrolling chat, and a prompt can be 20,000 characters |
| `deciding` moves from the chat to each card | Today one decision disables every card |
| A refused decision writes its reason on the card, not only a toast | A toast is easily missed on a phone |
| A sticky "N approvals waiting" pill jumps to the oldest pending card | A card can scroll out of the 100-message page |

The pill needs one additive server change: `pending=1` on `GET /workspace/managers/:id/messages`,
returning only pending `action` messages, with the schema added to the contract first.

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
- Attention is computed in the browser (`diffManagerAttention`), so **nothing on the server knows
  when to push**. Any push option needs new server detection.
- Outbound webhooks reach Slack and Discord for `task.attention_required` and similar, but they are
  per-project, behind `CEZ_WEBHOOKS=1`, and have no Manager event.

| Option | Reaches closed app | Needs | Ongoing cost |
| --- | --- | --- | --- |
| None | No | Nothing | None. Testers can use webhooks for tasks |
| Web Push to installed PWA | Yes [M, iOS 16.4+ for installed apps] | Service worker, VAPID keys the server generates itself, server detection | None. No relay [M] |
| Native push | Yes | Relay, APNs key, FCM service account, server detection, native code | See below |
| Background polling | Unreliable. iOS schedules it at its own discretion [M] | Native code | Battery, missed approvals |

**The relay is unavoidable for native push.** APNs and FCM credentials belong to the app's publisher.
A self-hosted server cannot hold them without shipping a secret in an npm package.

Relay cost: one small Cloudflare Worker, likely within free or $5/month tiers [M]; an APNs `.p8` key
and FCM service account in its secrets; rate limiting and token handling; on-call ownership of a
service, which this project does not have today; and a privacy policy that names it.

**Order:**

1. Server detection for new pending approvals and needs-you tasks, emitting to a small sink
   interface in `packages/cezar/src/push/`.
2. Web Push sink. It reaches installed PWAs at no cost and proves detection. M1 must first check
   that a service worker registers behind Basic auth.
3. Relay sink plus native registration.

**Payload rules:** text is generic ("Cezar needs you") with an opaque server key and nothing else.
No prompt, title, project, PR number or path reaches Apple, Google or the relay. This matches the
telemetry rule. The tap opens that server's `/manager`, where the real content loads over the
user's own authenticated connection. The badge is the sum of `pendingActions`.

**Never approve from a notification.** A lock-screen action skips the pinned card the guard relies on.

**Consent:** a push leaves the machine, so AGENTS.md § Zero config applies. The server contacts the
relay only after a device registers through an in-app toggle, and `CEZ_PUSH=0` blocks it regardless.
This is default-off in effect, but it has no env opt-in, so it needs a recorded decision (Q9).

## Decision 6: distribution

| Item | Decision |
| --- | --- |
| Identifiers | `com.openmercato.cezar.mobile` on both stores. Desktop keeps `com.openmercato.cezar`. Treat these as permanent once published |
| Display name | Cezar, subject to store availability |
| Versioning | Independent of the server, like the desktop shell's 0.1.x. Build number comes from the CI run |
| iOS signing | App Store distribution certificate and an App Store Connect API key in new secrets. The existing `APPLE_*` secrets are Developer ID, for desktop |
| Android signing | Upload key in secrets, with Play App Signing holding the release key [M] |
| CI check | `mobile-check.yml`, path-filtered on `packages/mobile/**`, unsigned builds only, modelled on `desktop-check.yml` |
| CI release | `mobile-release.yml` on a `mobile-v*` tag, version matched against the manifest, skipping signing when secrets are absent, modelled on `desktop-release.yml`. Maintainers only |
| Runners | macOS for iOS, Linux for Android. The repository is public, so hosted runners should be free [M] |
| iOS testing | TestFlight internal first, which needs no App Review [M]. External testers need a beta review [M] |
| Android testing | Play internal testing. A new **personal** account must pass a 12-tester, 14-day closed test before production; organisation accounts are exempt [M] |
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

The demo must be a `CEZ_DRY_RUN=1` cockpit on an isolated VM, reset nightly, with a throwaway Basic
login, because a real cockpit gives shell access to anyone holding the password. Apps with a
user-entered server URL are an established category (Home Assistant, Nextcloud) [M], but a rejection
under 4.2 is still plausible. A rejection does not affect TestFlight or the PWA.

Play's data safety form and any webview-app policy are [M]. Review them in task M9.

## Phased plan

Sizes: **S** up to 2 days, **M** up to a week, **L** two weeks or more. Each task is one PR unless noted.

| # | Task | Ships | Depends on | Size |
| --- | --- | --- | --- | --- |
| M1 | **Installable cockpit (#1762).** Manifest with `crossorigin="use-credentials"` so it loads behind Basic auth, icons, no `/api` caching. Check iOS install behind Basic auth and service worker registration | **First thing a user can install** | None | S |
| M2 | **Shell spike.** Throwaway build proving every item below | Go or no-go report | None | M |
| M3 | **Land Manager.** Push the branch, open the PR, ratify the flag | Manager on `main` | Maintainer | Outside this work |
| M4 | **Phone chat.** One-row header, stacked composer, keyboard inset, chips, measure streaming | Better chat in every phone browser | M3 | M |
| M5 | **Phone approvals.** Sheet, 44pt buttons, per-card state, refusal on card, pill, `pending=1` | Safe approvals on phones | M3 | M |
| M6 | **Manager first.** One-manager chat, pending-first order, PWA `start_url`, bottom bar | PWA opens to Manager | M1, M3 | S to M |
| M7 | **Shell v0.1.** `packages/mobile`, connect screen, keychain, challenge handling, health routing, server list, external links | Debug builds | M2 | L |
| M8 | **Mobile CI.** `mobile-check.yml`, `mobile-release.yml`, signing | Automated test builds | M7, Q3 | M |
| M9 | **Test tracks.** TestFlight internal and Play internal, privacy policy draft, store metadata | **First native install for testers** | M8, M4 to M6 | S |
| M10 | **Server push detection and Web Push.** `push/` sink, device registry in `~/.cezar/`, routes, in-app toggle | PWA notifications | M3, M1, Q9 | M |
| M11 | **Relay and native push.** Worker, keys, native registration | Native notifications | M10, M9, Q6 | L |
| M12 | **Public release.** Demo server, submission, review responses | Public listings | M11, Q7, Q10 | M, plus review time |

M1 and M2 can start now. M4, M5 and M7 can run in parallel with disjoint files. M4 and M5 both touch
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
| Manager branch changes shape before landing | Medium | Dependency table goes stale | Re-check the table at M3 |
| [M] Capacitor claims turn out wrong | Medium | Shell plan changes | M2 runs first; fallback is plain native |
| Page script reaches the keychain | Low | Credential theft by agent output | No bridge on server pages, plus a test |
| Apple rejects under 4.2 | Medium | No public iOS listing | Push first; TestFlight and PWA unaffected |
| Relay becomes an unowned service | Medium | Push outage | Stateless design; Q6 names an owner |
| Mis-tapped merge | Low | Unwanted merge | Sheet, plus server pins |
| Hosted cockpit password shared with a phone that is lost | Medium | Shell access to the server | This-device-only keychain; Q12 adds a biometric lock |

## Backward compatibility

- Additive only: `pending=1`, push routes, manifest route, User-Agent handling. New routes go through
  the contract, the chained family and the BACKWARD_COMPATIBILITY.md §2 inventory.
- `/` is unchanged for browsers. Desktop keeps the one-row composer.
- New env var `CEZ_PUSH` goes into `.env.example` and `docs/reference.md` in the commit that adds it.
- Any `~/.cezar/` device registry is rebuildable: deleting it only means re-enabling push on devices.
- A user-visible change updates its page under `docs/site` and `docs/server-install`.

## Testing

- Unit: start-URL routing, health-answer mapping, card and sheet behaviour, the empty-input case for
  `pending=1` (spec rule: a pass-through needs a test on empty input), and sink payloads carrying no
  user text.
- E2E: the existing dry-run Manager walk at a phone viewport, extended for the sheet and bottom bar.
- Native: Basic challenge against a local nginx, wrong password, foreign-host challenge cancelled,
  plugin refused from a server origin, forget-server clearing everything.
- Manual on devices for each test-track build, since emulators do not prove keychain, suspension or
  keyboard behaviour.

## Open questions for the maintainer

| # | Decision | Recommended answer |
| --- | --- | --- |
| Q1 | When does Manager land, and is its default-on flag ratified? | Push and open the PR now. M4 to M6 and M10 wait on it |
| Q2 | Accept Capacitor? | Yes, conditional on M2 |
| Q3 | Which legal entity owns the Apple and Google accounts, and who pays? | The Open Mercato organisation, using the Apple team that signs desktop, and a Google organisation account to avoid the closed-test rule |
| Q4 | Accept `com.openmercato.cezar.mobile`? | Yes. It is permanent, so decide before M7 |
| Q5 | Allow plain HTTP for LAN or Tailscale addresses? | No in v1 |
| Q6 | Will the project run a push relay, and who owns it? | Yes, a stateless Cloudflare Worker, with a named owner before M11 |
| Q7 | Is push required before a public listing? | Yes, on both stores for one consistent product |
| Q8 | Should a phone browser tab also start at `/manager`? | No. Revisit with usage data |
| Q9 | Does an in-app toggle plus `CEZ_PUSH=0` satisfy the network opt-in rule, or must push need `CEZ_PUSH=1`? | In-app toggle, recorded in AGENTS.md as an owner-approved exception, as telemetry consent works |
| Q10 | Will the project host a dry-run demo server for reviewers? | Yes, an isolated VM reset nightly |
| Q11 | What becomes of PR #1821's `do-not-merge`? | Decide after M2's measurement. It is not a Manager blocker |
| Q12 | Add an optional Face ID or fingerprint lock? | Yes, as a setting after M9, off by default |
| Q13 | Confirm every approval, or merges only? | All three types: each is irreversible or runs unattended |
| Q14 | Send shell telemetry? | None in the shell for v1. The cockpit's existing consent still applies inside it |
| Q15 | Offer a direct Android APK or F-Droid build? | Not in v1 |
| Q16 | Is "Cezar" the public store name? | Yes if available, otherwise "Cezar Cockpit" |
| Q17 | May public listings wait on M12, leaving PWA and TestFlight as the only channels until then? | Yes |

## Changelog

- 2026-10-31: Initial design.
