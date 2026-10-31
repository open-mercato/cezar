# Discord receivers for outbound webhooks

Provider contract extending [outbound webhooks](2026-10-12-outbound-webhooks.md).

## Goal

A user pastes a Discord channel **Webhook URL** (Server Settings → Integrations → Webhooks) into
Settings → Webhooks and gets readable task notifications in that channel — no relay, no bot, no
OAuth. Admission, grace, freshness, retries, suspension, history, privacy profiles and ownership
use the shared webhook pipeline.

## Out of scope

Discord bot / application / OAuth, channel picker, buttons or answering a question from Discord,
posting into a thread or forum (`thread_id`, `thread_name`), custom username/avatar per message,
mentions/role pings, editing a message as the task progresses, the `/slack` and `/github`
compatibility endpoints.

## Shared delivery pipeline

Custom JSON, Slack and Discord share the receiver format contract, immutable admission
snapshot, queue, privacy profiles, revision fences and delivery controls. Provider renderers,
URL validation and response diagnostics are selected by the stored format.

## Design

### 1. Contract

- `packages/contract/src/webhooks.ts`: `format` includes `'discord.v1'`
  (`'cezar.json.v1' | 'slack.v1' | 'discord.v1'`, default `cezar.json.v1`).
- Refinement for `discord.v1`: `https://` on `discord.com`, `discordapp.com`, `ptb.discord.com`
  or `canary.discord.com`; path exactly `/api/webhooks/<snowflake 17–20 digits>/<token [A-Za-z0-9_-]{60,80}>`
  (an optional `/api/v10/webhooks/…` version segment accepted); no port, no query, no fragment;
  `allowLocalNetwork === false`. Normalize to `https://discord.com/api/webhooks/<id>/<token>` on save.
- A Discord URL with `format: 'cezar.json.v1'` is rejected with "Choose Discord as the destination
  type" — it could only ever answer `400`.
- `BACKWARD_COMPATIBILITY.md` inventories the receiver formats.

### 2. Rendering (`webhooks/discord.ts`)

`renderDiscordMessage(eventJson: string, ctx): string` maps the **already rendered, redacted,
profile-filtered** cezar event body to a Discord execute-webhook body. Discord never sees a field
the cezar payload for that profile does not carry.

```json
{ "content": "Needs your input · <title or task id8>",
  "allowed_mentions": { "parse": [] },
  "embeds": [{ "title": "…", "description": "…", "color": 15105570, "timestamp": "<occurredAt>",
               "url": "<PR, issue or hosted cockpit link, if any>",
               "fields": [{ "name": "Project", "value": "…", "inline": true },
                          { "name": "Status", "value": "running → waiting", "inline": true },
                          { "name": "Task", "value": "`a1b2c3d4`", "inline": true }],
               "footer": { "text": "cezar" } }] }
```

- `allowed_mentions: { parse: [] }` always — a task title or error containing `@everyone`/`<@id>`
  must never ping anyone. Also neutralize mention syntax in text (zero-width space after `@`).
- Escape Discord markdown (`\ * _ ~ \` | >` and leading `#`/`-`) in every interpolated string.
- Colour per event: attention amber, review blue, finished green, failed red, cancelled grey.
- Standard profile: questions + options as a numbered list in `description`; `task.failed`
  message in a field. Minimal: neither.
- Limits enforced by the renderer: `content` ≤ 2000, title ≤ 256, description ≤ 4096, ≤ 25 fields,
  field value ≤ 1024, all embed text ≤ 6000; drop trailing questions first, then clip, then fall
  back to `content` only.
- Labels reuse the UI wording; `webhook.test` → "cezar is connected to this channel" + receiver name.

### 3. Send path

- `format` snapshot on the delivery record (captured at admission); render with `renderDiscordMessage`
  at send time; retained delivery storage keeps canonical cezar JSON; history exposes metadata only.
- Headers: `content-type: application/json`, no `webhook-*` signature headers (the URL is the
  secret). DNS pinning, no redirects, 10 s timeouts, URL redaction follow the shared transport policy. Append `?wait=true` internally at send time so Discord confirms that the message was saved
  before cezar records success (normally `200 OK`). The stored URL still has no query.
  Discard the successful response body; never retain the returned message content.
- Diagnostics: for the Discord hosts only, read ≤ 512 bytes of a JSON body and keep only
  `code` (integer) and `message` if it is one of Discord's fixed strings (`Unknown Webhook`,
  `Invalid Webhook Token`, `Invalid Form Body`, `You are being rate limited.`). Everything else
  discarded.
- Outcome mapping — differs from the generic table in one place:
  - `404` with `code 10015` (Unknown Webhook) or `401` with `50027` (Invalid Webhook Token) → `gone`
    → receiver `disabled`: the webhook was deleted in Discord and will never come back.
  - `429` → `rate_limited` using the `Retry-After` header (Discord sends seconds); `retry_after`
    from the body is not needed. Global/channel limits (≈ 5 req / 2 s per webhook) are covered by
    the existing backoff.
  - `400` (`50035`, invalid form body) → permanent; `5xx` → transient; `2xx` → success.

### 4. Cockpit

- "Destination" includes **Discord channel (Webhook URL)**.
- Discord: placeholder `https://discord.com/api/webhooks/…`, one sentence + link to Discord's
  "Intro to Webhooks" support article, local-network checkbox hidden, Discord-style embed preview.
- No signing-key reveal or rotation for Discord receivers; `Discord` badge on the card.
- Pasting a Discord URL under "Custom receiver" shows an inline hint offering to switch.

### 5. Setup guide

`packages/cezar/docs/webhooks.md`: "Send to Discord" (create webhook in channel → paste URL →
Test → Activate; Minimal vs Standard in Discord; URL is a secret; mentions never ping). The feature is enabled by `CEZ_WEBHOOKS=1`, documented in `.env.example`.

## Validation

Automated checks cover contract validation, renderer privacy/size/escaping, transport policy,
provider diagnostics, revision changes and UI setup. The isolated browser command is
`npx e2e run --config packages/web/e2e/chat-webhooks.config.ts`.
`CEZ_DRY_RUN=1` substitutes synthetic HTTP success and sends no receiver traffic, including Test;
it validates local flows, not provider delivery.

Live provider acceptance requires explicit authorization: use a dedicated,
user-provided Discord test-channel webhook and an isolated project containing no sensitive
data. Start the test server with `CEZ_WEBHOOKS=1` and dry-run disabled (`CEZ_DRY_RUN` unset or
`0`). This mode makes real network requests; use only harmless, explicitly authorized tasks.
Save → Test → Activate, then create fresh tasks that ask a benign question, finish a trivial
local task, and produce a controlled benign failure. Respect the configured attention grace
and failure delay. Verify attention / finished / failed messages in the channel and compare
delivery history; a synthetic green check is not evidence of provider delivery.
With separate explicit authorization for the destructive test, confirm that deleting the dedicated test webhook yields `10015` and disables the receiver.
Pause the receiver afterwards. Record the checks performed and their observed results.

## Risks

- URL = credential (anyone with it can post). Included in `secrets()`, masked and redacted — keep a
  test that the token never reaches history or logs, including the normalized form.
- A third-party server sees titles/questions/errors under Standard — the activation flow discloses this.
- Mention injection from task text — closed by `allowed_mentions` plus text neutralization; pinned
  by a test with `@everyone`, `<@123>`, `<@&123>`.

## API and failure handling

Admissions and manual tests snapshot the receiver format. Create/edit requests enforce the
selected destination's URL rules. Chat creation returns an empty `secret`, and key rotation is
rejected. Switching from chat to custom creates a fresh key; the edit
confirmation instructs the user to rotate and copy it before connecting the custom receiver.

Provider diagnostics use a closed vocabulary. Discord credentials are redacted by token as well
as full URL, covering normalized host/path aliases. Invalid stored chat payloads terminate as
`payload_invalid` before a send claim is published. Retained-URL format mismatches return 409.

Automated dry-run checks do not establish that a provider displayed a message.
