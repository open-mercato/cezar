# Phone notifications through ntfy for local and hosted cockpits

- Date: 2026-10-23
- Category: feature
- Priority signal: medium — the README promises "start and review tasks from your phone", yet nothing ever arrives on a phone today
- Risk signal: medium — a new outbound network path, a new persisted secret (the topic), and a server-side transition detector fed by two event sources
- Routing: Next: om-auto-write-spec "Phone notifications through ntfy for local and hosted cockpits (waiting, review, failed, automation health) — brief: .ai/specs/briefs/2026-10-23-phone-notifications-ntfy.md"

## Problem

The user runs cezar both locally on a Mac and hosted over HTTPS, and wants the phone to tell them when something is not done: a run waiting on them, a run ready for review, a run that failed, an automation that did not run. Today nothing reaches a phone. `run-notifications.tsx` raises a page-context browser `Notification` only while a cockpit tab is alive and hidden. Chrome on Android throws on page-context construction because it requires a ServiceWorker, and iOS shows nothing. So the attention signals cezar already computes never leave the browser tab.

## Agreed direction

cezar sends notifications to the phone through **ntfy**: the ntfy app on the phone plus an ntfy server, by default the public ntfy.sh. This works from the local instance and from the hosted one.

**Transition detection moves to the server.** Today the transitions are diffed only in the browser, from the cached run list. The server must own one source of truth for "this run just entered a state that needs the user" so a notification fires with no tab open. The cockpit's rule lives in `deriveAttention` (`packages/web/src/lib/attention.ts`), and the server needs the same definition. Sharing it, for example through `packages/contract`, is the spec's call; a second hand-written copy is not acceptable. The spec must also define dedupe against the existing page notification when a desktop tab is open.

**Sending is fire-and-forget.** A publish is bounded, never blocks a run, never fails a run, and degrades to a logged warning when ntfy is unreachable.

**Enabling and setup.**
- A `CEZ_*` flag unlocks the feature, following AGENTS.md's rule that features widening network exposure are opt-in behind a `CEZ_*` flag, off by default. `notify.webhook` behind `CEZ_WORKFLOW_WEBHOOKS=1` is the precedent. The flag goes into `.env.example` and the README env table. The exact name is the spec's call.
- In Settings → Notifications, cezar generates an unguessable topic and shows a QR code. One scan in the ntfy app subscribes the phone.
- The server defaults to ntfy.sh and also accepts a self-hosted ntfy server URL.

**Payload.**
- The message carries the task title, the project and the status.
- The Settings UI must say plainly that the ntfy.sh operator can read message contents and that the topic acts as the password.
- With several instances (local and hosted), each notification names its instance or project.

**Tap target.**
- On a hosted cockpit, a tap opens the task, using ntfy's click URL.
- On a local cockpit, the phone cannot reach `127.0.0.1`, so the notification is informational only.
- How a hosted instance learns its public origin is the spec's call. One option is the origin of the browser that enabled the feature.

**Events, in two phases.**
- **Phase 1, run attention:** waiting for the user (question or approval), ready for review, failed. A failure caused by a usage limit that already has an auto-resume booked (`autoResumeAt` in `packages/contract/src/runs.ts`) does not count as "needs you".
- **Phase 2, automation health:** an occurrence skipped, the three-strike auto-pause (`packages/cezar/src/automations/schedule-runner.ts`), a schedule that did not run. These are automation-store outcomes, not run transitions: a second event source with its own payload and link.

**Rejected:**
- **Web Push from cezar, now.** It only works on a hosted HTTPS origin, so it gives nothing to the local instance. On iOS it needs a Home Screen web app whose manifest `display` is `standalone` or `fullscreen` (WebKit, iOS 16.4), while the approved spec PR #944 deliberately ships `display: "minimal-ui"`. It is also untested behind the installer's basic-auth proxy: an iOS Home Screen app keeps its own credential and cookie store. Web Push stays a later, separate spec, preceded by a one-hour iPhone spike: a standalone manifest, a SW push handler and `npx web-push`, behind `ngrok --basic-auth`.
- **Telegram, Slack or email bridges.** Each needs an account or a token, so they are not one-scan.
- **Build nothing.** GitHub's mobile notifications cover only "ready for review", and only when cezar opened a draft PR. Waiting, failed and automation health would stay invisible on the phone.
- **A service worker on `localhost`.** Rejected for the reasons #944 records: it outlives the process, intercepts the next dev server on port 4321, and serves a stale shell after an `npx` upgrade.

## Resolved unknowns

| Question | Answer (from the conversation) |
|----------|--------------------------------|
| How is cezar reached from the phone? | Both: a local instance on a Mac and a hosted instance over HTTPS. |
| Which phones? | iPhone and Android. |
| Which channel first? | ntfy. Web Push in the app comes later, as its own spec, after an iPhone spike. |
| Is an external service acceptable? | Yes. The user accepted the ntfy app plus an ntfy server once told that every phone push transits Apple's or Google's push service anyway. |
| Setup UX | The cockpit generates the topic and shows a QR code: one scan, no account, no keys. |
| Opt-in gate | A `CEZ_*` flag unlocks the feature (AGENTS.md network rule) and Settings enables and configures it. Confirmed over the alternative of Settings only, which would need an owner exception. |
| Which ntfy server? | ntfy.sh by default; a self-hosted server URL is allowed. |
| Message content | Task title, project and status, accepting that the ntfy.sh operator can read it. The UI must warn about this. |
| Which events? | All four: waiting, review, failed, automation health. Phase 1 covers runs, phase 2 covers automations. |
| What does a tap do? | On a hosted cockpit it opens the task. On a local one the notification is informational only. |
| Who receives? | Single-tenant by design: every subscribed device gets every project's notifications from that instance. |

## Non-goals

- Web Push, service workers, app badges. All of these belong to the later Web Push spec.
- Changes to PR #944, the installable manifest.
- Mobile "native app feel" polish of the cockpit. This is a separate brief later.
- Notification action buttons, such as approving from the notification.
- Telegram, Slack and email channels.
- Per-user routing on a shared hosted instance.

## Affected areas (if known)

- `packages/web/src/components/run-notifications.tsx`: today's client-only transition notifications.
- `packages/web/src/lib/attention.ts` (`deriveAttention`): the attention rule the server must share.
- `packages/web/src/routes/settings/notifications-section.tsx` and the `notifications` field of the workspace ui-state in `packages/contract/src/workspace.ts`: the existing Settings section and the global toggle.
- `packages/cezar/src/workflows/graph.ts` (`notify.webhook`) and `packages/cezar/src/workflows/run.ts` (the `CEZ_WORKFLOW_WEBHOOKS` gate): precedent for opt-in outbound network.
- `packages/cezar/src/automations/schedule-runner.ts`: the source of phase-2 automation outcomes.
- `.env.example`, the README env table, `BACKWARD_COMPATIBILITY.md`: the new env var and any new routes.
