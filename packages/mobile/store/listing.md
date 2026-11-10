# Store listing, English (en-US)

Paste these into Play Console (**Grow > Store presence > Main store listing**) and App Store Connect
(**App Information** and the version page). Character limits are each store's; the counts are checked
by `test/store.test.mjs`.

## Both stores

| Field | Value |
| --- | --- |
| App name | `cezar` |
| Category | Developer Tools (App Store: *Developer Tools*; Play: *Tools*) |
| Price | Free, no in-app purchases, no ads |
| Support URL | https://github.com/open-mercato/cezar/issues |
| Marketing URL | https://cezar.run |
| Privacy policy URL | https://cezar.run/mobile/privacy (host `store/privacy-policy.html` there first, see RELEASING-MOBILE.md) |
| Contact email | [YOUR SUPPORT EMAIL] (required by Play; shown publicly) |

## Google Play

**Short description** (80 max):

<!-- play-short -->
Your cezar coding agents in your pocket: see what needs you, decide on the go.
<!-- /play-short -->

**Full description** (4000 max): the shared full description below.

## App Store

**Subtitle** (30 max):

<!-- ios-subtitle -->
Your coding agents, on the go
<!-- /ios-subtitle -->

**Promotional text** (170 max):

<!-- ios-promo -->
Pair your phone with cezar on your computer in seconds by scanning a QR code. See what your coding agents need, answer them and get notified, end-to-end encrypted.
<!-- /ios-promo -->

**Keywords** (100 max, comma separated, no spaces after commas):

<!-- ios-keywords -->
coding agent,AI,developer,claude,codex,git,pull request,terminal,remote,orchestrator,devtools
<!-- /ios-keywords -->

**Description** (4000 max): the shared full description below.

## Full description (both stores)

<!-- full-description -->
cezar runs AI coding agents (Claude Code, Codex, OpenCode and others) in parallel on your own computer or server, each task in its own git worktree, and stops at a review gate before anything is merged. This app is cezar's companion for your phone.

Open the app, and cezar's Manager tells you what needs you: a task waiting for a decision, a review that is ready, an agent that is stuck. Answer it, look at the changes, start a new task or check on a running one, all from the cockpit you already know, sized for a phone.

PAIR IN SECONDS
On your computer, open cezar, go to Settings, then Connect a phone, and scan the QR code. No account, no sign-up, no port forwarding. If you cannot use the camera, type the short code instead.

END-TO-END ENCRYPTED
The phone and your computer talk through a small relay. Everything you see and send, from code and tasks to messages and passwords, is encrypted end to end with the Noise protocol. The relay passes the traffic along but never has the keys, so it cannot read it.

OR CONNECT DIRECTLY
Running cezar on a server with HTTPS? Add its address and sign in. Your password is kept in the phone's secure storage and is never shown to the web page.

STAY IN THE LOOP
Turn on notifications for a server and the phone tells you when cezar needs you. A notification says only that cezar needs you; it never contains your code or messages.

YOUR PHONE, YOUR RULES
- Several servers in one app, each with its own login
- Optional app lock with your fingerprint, face or screen lock
- Remove a server and its keys and saved password are deleted from the phone
- No analytics, no ads and no tracking in the app

WHAT YOU NEED
cezar running on a computer or server you control. cezar is free and open source (MIT): https://cezar.run

The app does not run agents itself. It shows and controls the cezar you connect it to.
<!-- /full-description -->

## Release notes for the first version

<!-- whats-new -->
First release: pair with cezar by QR code or typed code, connect directly to a hosted cezar, Manager first, notifications and an optional app lock.
<!-- /whats-new -->

## Checks before pasting

- Notifications while the app is closed need Firebase on Android (`GOOGLE_SERVICES_JSON`) and push on
  iOS. If a build ships without them, change "the phone tells you" to "the app tells you while it is
  open", or Apple's guideline 2.3.1 (accurate metadata) applies.
- The iOS app has no relay client until #1901's iOS half lands. Do not submit this text for an iOS
  build that cannot pair by QR code.
