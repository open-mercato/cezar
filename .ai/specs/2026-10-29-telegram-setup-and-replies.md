# Telegram setup wizard and task replies

This is the canonical design for the Telegram integration. Telegram is configured
from Settings → **External integrations** → **Telegram** (**Connect Telegram**, or
**Add a chat** once a bot is connected). The wizard owns bot connection, notifications
and optional task control; Webhooks serves Slack, Discord and custom receivers only.
The user guide is `docs/site/content/docs/03-features/settings-and-projects/send-to-telegram.mdx`
and `telegram-replies.mdx`.

## Intent

Make Telegram usable without knowing receiver fields, chat IDs, pairing revisions or
permission generations. One guided flow connects a bot and a chat, chooses what an
approved person may do and activates the connection. A task started from Telegram
reports its progress and final reply in the same chat, under the existing account,
provider, authorization, redaction and delivery guarantees.

## Non-goals

- Arbitrary Telegram chats as task sources without pairing and grants.
- Creating Cezar accounts from Telegram or bypassing cockpit account/provider policy.
- Bot-token rotation, project selection or global policy outside the cockpit.
- A second Telegram integration or a second source of truth for permissions.
- Sending unredacted prompts, local private paths (home, user, temp, cezar-home and
  project roots, drive-letter, UNC and `file://` paths), secrets or raw provider output.
- Per-tool Allow/Deny buttons: tool-permission prompts are answered in the cockpit.

## Invariants

- A chat command never becomes an unaudited shell or account-control channel.
- No success message is sent for an effect that was not durably claimed and authorized.
- A transient Telegram, vault, disk or provider failure never revokes a valid pairing.
- A disabled, damaged, orphaned or conflicted bot is always shown with its recovery action.
- Nothing contacts Telegram or polls before dedicated-bot consent and **Continue**. Setup
  may acknowledge **Start** before activation; notifications and task control each need
  their explicit activation.

## Approach

The wizard is a UI orchestration layer over validated routes on the existing receiver
registry, vault, ownership lease, inbound state store and grant model. A Telegram-started
task is an ordinary run with an optional source attribution, not a separate executor.

## Availability

- Notifications and the token-led setup that discovers their chat need `CEZ_WEBHOOKS=1`.
  Task control (approving people, replies, commands, `/task`) also needs
  `CEZ_CHAT_INBOUND=1`. Telegram is local-only: a hosted cockpit offers none of it.
- With the inbound flag off the bot polls only while a setup waits for its `/start`, and no
  grant authorizes anything. Task-control activation, approving a person on an existing
  receiver and editing or revoking people answer `503 flag_off`.
- `GET …/telegram` keeps `available`/`reason` for task control and adds `notifications`
  and `taskControl` (each `{ available, reason? }`). The setup status names a discovered
  group (`candidate.chatTitle`); the state names each bot (`username`) and why Telegram
  suspended a receiver (`suspendedReason`).
- The cockpit explains a hosted or webhooks-off cockpit before the wizard opens; with
  `CEZ_WEBHOOKS=1` alone the wizard and the Telegram tab show task control as needing
  `CEZ_CHAT_INBOUND=1`.

## Setup wizard

1. The operator enters a bot token, confirms the bot is dedicated to this project and
   chooses **Continue**. This verifies the token with Telegram and starts polling for
   setup messages.
2. The wizard offers two links built from one setup code: **Private chat with the bot**
   (`?start=`) and **Add to a group** (`?startgroup=`; forum groups unsupported). A
   private **Start** discovers the chat and is the single proof of the person's identity;
   a group Start discovers the group, and the wizard names it.
3. A group needs the operator's consent that all members can read project messages
   (`groupVisibilityAccepted`), a plain (non-forum) group and the bot a member of it,
   checked on the server before any receiver exists.
4. Task control shows the shell-access warning. Replying is always allowed; **Start tasks**
   (`/task`, private chats only), **Cancel tasks** and **Continue tasks** are separate
   opt-ins, off by default. One note under the permissions says that answering, starting
   and continuing runs the agent and may incur provider costs; the `/task` and `/continue`
   previews in Telegram repeat it before **Confirm**. A private chat can enable task control in the
   same activation. A group activates notifications first; task control then needs the
   person's private Start and a confirmed comparison code (`comparisonVerified`).
5. Completion shows what is active. Errors map to actionable states: invalid token, bot
   conflict, blocked bot, chat not found, link expired, vault unavailable, damaged state
   or insufficient permission.

Setup sessions live in memory: at most three per project, five minutes each, and a
restart expires them. Every wizard exit cancels its session. A first token-led setup binds
the bot to the project when its link is created; if it is cancelled, expires, fails or is
cut short by a restart before a chat is bound, the bot is released (its state and
`binding.json` removed). A setup on a bot that already serves a chat never releases it.

Activation is idempotent. It creates (or reuses) the receiver, waits for its test
delivery's real result, then binds it. A receiver it made is deleted with its vault entry
when that test fails; a retry after a later failure reuses it. A setup for a chat the bot
already serves reuses that receiver and its binding; a new token for the same bot and
chat replaces the stored token and is retested. Re-running setup on a chat whose people
are already approved keeps their task control even when the re-run enables only notifications.

## Telegram tab

- **Chats** lists every `telegram.v1` receiver, bound to a bot or not: name, private chat
  or group, notification state and last test, with **Send test**, **Pause**/**Resume**
  (or **Activate** after a passing test), **Options** and **Remove** (confirmed), all
  through the `/webhooks` receiver routes without re-entering the token.
- **Options** edits message content (Minimal/Standard), "Include an excerpt of the agent's
  last message" (Standard only) and the notification delay through `PATCH /webhooks/:id`.
  These edits keep the receiver active with its delivery revision, so task control stays
  bound; a chat, token or format change needs a fresh test. Minimal content suspends task
  control for that chat. Pausing a chat suspends its replies too and reads as paused, not
  as a fault.
- A second receiver for the same chat is marked **Duplicate** and offers Remove. The one
  kept is the one with task control, else the one bound to a bot, else the oldest; a
  duplicate never gets task control of its own.
- **People and permissions** shows task control per chat. A chat without an approved
  person reads "Notifications only" with **Enable task control**. A paired group offers
  **Approve another member**; a private chat whose pairing went stale offers **Replace
  pairing**. Each person's row offers the three permissions and **Revoke access**; groups
  never offer Start tasks. A bound chat does not ask for bot dedication again.
- A suspended binding names its cause: a bot removed from a group (add it back, then
  **Enable replies**), a private chat whose person blocked the bot (they unblock it, then
  **Enable replies**), or a migrated group (remove the chat, connect the group again with
  **Add a chat**).
- **Reset access** removes every approved person and keeps notifications. **Disconnect
  bot** removes its people, its state and binding, and every receiver that sends through
  it (tokens included); receivers go first, so a failure leaves a connected, resettable
  bot. A bot with no chats in the project offers **Release bot**. Both confirm with a
  danger button. Reset and orphan release stay reachable with zero receivers.

## Telegram-originated tasks

1. A paired person sends an accepted command or replies to a Cezar message. Commands use
   the existing parser and group addressing rules.
2. `/task <text>` (private chat, **Start tasks**) answers with a preview naming the
   project, workflow and provider. Only **Confirm** — once, within two minutes, by the
   same person in the same chat — starts the task; the bot then says
   "Started task `<id>`.".
3. The run carries a source record (`telegramSource`): project, receiver, grant and enable
   generations, Telegram bot/chat/user/message ids, request id and run id. It holds ids
   only, never a token or prompt text, and is enough to recover an uncertain send
   without repeating the task effect.
4. Progress is one compact follow-up per meaningful state change; messages are never
   edited. No "Task in progress" notice follows "Started task" or "Continuing task"
   directly; one is sent only after another notice of that turn, or for a task recovered
   after a crash.
5. A question uses the existing question/options format with a Reply instruction. A
   single single-select question with fixed choices gets one button per option.
6. Final notices: completed, ready for review, failed, cancelled, expired. The final
   message of a Telegram-started task (`done` or `review`) carries the agent's last
   message after `Agent:`, redacted, path-scrubbed and bounded to one Telegram message; a
   shortened reply ends with "The full reply is in the cockpit.". It goes only to the
   requester's private chat and needs no `includeAgentExcerpt` opt-in. A `waiting` notice
   without structured questions carries the same reply there; group chats keep the
   opt-in excerpt. The `Repository:` line (`Unchanged`, `Pull request opened`,
   `Changes accepted`) reports the Git outcome; `completed` and `unknown` have no line.
7. Continue, cancel and confirmation re-check the current grant, receiver generation,
   account, provider and run state immediately before the effect; a stale or revoked
   source gets a refusal and cannot mutate the run. A source's own notices need only the
   binding enabled and the requester still holding that grant: a permission edit or
   Disable/Enable keeps them with the bot. Disable/Enable and a blocked private chat drop
   that chat's question correlations but keep its delivery receipts
   (`deliveryReceipt` in `telegram/state.ts`), so no notice is sent twice, across
   restarts too. An explicit Reply routes only through a correlation of the current
   enable generation.
8. A Telegram delivery failure after the task effect was claimed never reruns the task;
   its source in the inbound state is marked `delivery_failed`.
9. A Telegram-started task's chat is served by the bot runtime only while it will
   deliver (`ownsSourceDelivery`); otherwise ordinary webhook admission notifies it, and
   a final can then arrive twice.

`/status` never carries agent text; without an ID it shows the sender's own latest
Telegram task. Tasks not started with `/task` keep their reply in the cockpit and the
chat gets the ordinary notification.

### Private-chat task context

- Ordinary text goes to the task of the person's latest interaction: the newest of a
  confirmed `/task`, an explicit address (`/reply X`, `/status X`, `/continue X` or a
  Reply to a notice, kept per person in the inbound state's optional `contexts`), a
  notice this chat received about a task the person started, and a question notice of
  any task.
- Waiting, the text answers the current question; running or queued, it is delivered as
  a follow-up and acknowledged; terminal, it opens the Continue preview with the task
  title and the text. A Reply to a final or progress notice is a follow-up; only a Reply
  to a question notice is pinned to that question. The `continue` permission and
  confirmation remain mandatory.
- Recognized commands always win over context. Groups never use implicit context; they
  need an addressed command or an explicit Reply.

### Groups

- The bot answers only commands addressed to it (`/tasks@bot`) and Replies to its own
  notices; any other Reply is ignored without an answer.
- A person without a grant who addresses the bot in a bound group is told to ask the
  cezar operator; nobody in a group is told to start pairing. Strangers in an unbound
  group hear nothing.
- Before acting on a group message or button the bot re-checks membership with
  `getChatMember` (cached for a minute). Someone who left or was removed is refused; when
  Telegram cannot answer, nothing is done. Revoking the grant is the way to end access.
- Group help names only addressed commands and `/status@bot <task>` with an ID.

## Service boundaries

- **Wizard state** is client-side and transient; credentials and pairing state live in the
  vault, receiver registry, ownership lease, inbound state store and grants.
- **Rendering** reuses the Telegram renderer, redaction, HTML escaping and the shared send
  budget; no `sendMessage` bypasses the dispatcher. Telegram text is scrubbed by
  `scrubTelegramText` (private roots only; a root also ends at a quote or trailing
  punctuation; one-character roots such as `/` are ignored). Webhook payloads keep
  `scrubWebhookText`.
- **Send budget:** with `CEZ_CHAT_INBOUND=1` every loaded, available bot shares one budget
  between replies and notifications (one message per second per chat, ten per bot, one
  request outstanding). Ready chats rotate and only a retry keeps its chat's head; a ticket
  whose consumer cannot send now (an unrelated send in flight, a scheduler wait) is parked
  and never wins. A Telegram 429 pauses both streams.
- **Authorization** reuses `authorize`, `grantFresh`, `beforeEffect` and the account/provider
  gates; the source correlation is an extra freshness check.
- **Recovery:** claimed source effects recover to uncertain under the existing journal
  rules; deliveries may retry, task effects never replay because a send failed.

## API

Shapes live in `packages/contract` (`telegram.ts`, `telegram-tasks.ts`); routes are chained
under `/api/v1` with project aliases and middleware validation. The guided setup adds
`…/telegram/setup`, its status, activation and cancel, beside receiver/grant edits, Reset,
Disconnect and orphan release. Telegram-started tasks use an internal service seam, not an
HTTP route. `BACKWARD_COMPATIBILITY.md` lists every route and stored file.

## Verification

Unit and contract suites cover setup, activation, grants, routing, delivery and restarts.
Two manual browser suites (`packages/web/e2e/telegram-inbound*.config.ts`) walk the wizard
for a private chat and a group against a simulated Telegram API; neither talks to the real
Telegram service.
