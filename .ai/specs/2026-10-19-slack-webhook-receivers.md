# Slack receivers for outbound webhooks

Provider contract extending [outbound webhooks](2026-10-12-outbound-webhooks.md).

## Goal

A user pastes a Slack **Incoming Webhook URL** into Settings → Webhooks and gets readable task
notifications in a Slack channel — no relay, no cezar-managed Slack app or OAuth (the user installs an Incoming Webhook app in Slack). Admission, grace, freshness, retries, suspension, history, privacy profiles and ownership
use the shared webhook pipeline.

## Out of scope

Cezar-managed Slack app / OAuth / bot token, channel picker, interactive buttons or answering a question from
Slack, threading per task, mentions, per-event channels, Teams, GovSlack
(`hooks.slack-gov.com`).

## Design

### 1. Receiver format (contract)

- `packages/contract/src/webhooks.ts`: receiver `format` is
  `z.enum(['cezar.json.v1', 'slack.v1', 'discord.v1']).default('cezar.json.v1')`
  in private settings and public responses. An omitted format means `cezar.json.v1`.
  Slack renders the event defined by `webhookEventSchema` / `webhooks.schema.json`.
- Refinement: `format === 'slack.v1'` ⇒ URL is `https://hooks.slack.com/services/<T…>/<B…>/<token>`
  (exact host, no port/query) and `allowLocalNetwork === false`. A `hooks.slack.com` URL with
  `format: 'cezar.json.v1'` is rejected with "Choose Slack as the destination type" — it could only
  ever answer `400 invalid_payload`.
- `endpoints.ts`: `format` belongs to the delivery-relevant `fields` list, so changing it resets the
  receiver to `inactive` like any other delivery change.
- `BACKWARD_COMPATIBILITY.md` inventories the receiver formats.

### 2. Rendering (`webhooks/slack.ts`)

`renderSlackMessage(eventJson: string, ctx): string` takes the **already rendered, redacted,
profile-filtered** cezar event body and maps it to Slack JSON. Privacy stays single-source: Slack
can never see a field the cezar payload for that profile would not carry.

- `text` (fallback / notification line): `<label> · <title or task id8> · <projectId>`.
- `blocks`: one `section` (mrkdwn: label, title, status `previous → current`), one `context`
  (project, task id, time), optional `section` with questions + options (standard profile only),
  optional error message (`task.failed`, standard only), optional actions-free link line for
  PR / issue / cockpit (cockpit only when the event carries it, i.e. hosted).
- Labels reuse the UI wording (`Needs your input`, `Ready for review`, `Task finished`,
  `Task failed`, `Task cancelled`, `Test message`).
- Escape `&`, `<`, `>` in every interpolated string; clip each text block to 2900 chars and the
  question list to what fits; whole body ≤ 40 KB (Slack limit) — fallback to `text` only.
- `webhook.test` → "cezar is connected to this channel" with the receiver name.

### 3. Send path

- Snapshot `format` on the delivery record (optional field, default cezar) at admission, so a
  retry renders what was admitted even if the receiver is later edited.
- `service.ts`: if `format === 'slack.v1'`,
  wrap the cezar body with `renderSlackMessage`. Retained delivery storage keeps the canonical cezar JSON; history exposes metadata only.
- `transport.ts`: for Slack, send `content-type: application/json` without `webhook-id` /
  `webhook-timestamp` / `webhook-signature` (the URL itself is the secret; Slack ignores them and
  signing a body nobody verifies only adds confusion). DNS pinning, no redirects, 10 s timeouts,
  URL redaction use the shared transport policy.
- Response diagnostics: a custom path-bearing URL never has its body read. For
  `hooks.slack.com` only, read ≤ 64 bytes and retain only exact codes from the closed vocabulary in `chatDiagnostics` (including `invalid_token`, `no_service`, `channel_not_found`, `channel_is_archived`,
  `invalid_payload`, `action_prohibited`). Anything else is discarded.
- Outcome mapping: response table — 2xx success, 410 (`channel_is_archived`) gone →
  `disabled`, 429 + `Retry-After` rate-limited, 5xx transient, 400/403/404 permanent. Tests cover these provider statuses.

### 4. Cockpit (`webhook-form.tsx`, `webhook-card.tsx`)

- First field **Destination**: "Custom receiver (signed cezar JSON)" / "Slack channel
  (Incoming Webhook)" / "Discord channel (Webhook URL)".
- Slack: placeholder `https://hooks.slack.com/services/…`, one sentence + link to Slack's
  "Sending messages using incoming webhooks" page, local-network checkbox hidden, JSON preview
  replaced by a Slack-style preview of the example message.
- After create: no signing-key reveal for Slack ("Slack receivers do not use a signing key");
  rotate-key action hidden for Slack receivers.
- Card shows a `Slack` badge next to the masked destination.
- Typing a `hooks.slack.com` URL while "Custom receiver" is selected shows an inline hint and
  offers to switch.

### 5. Setup guide

`packages/cezar/docs/webhooks.md`: the "Send to Slack" section (create an Incoming Webhook in
Slack → paste URL → Test → Activate; what Minimal vs Standard shows in Slack; the URL is a secret).
Feature flag: `CEZ_WEBHOOKS=1`, as documented in `.env.example`.

## Validation

Automated checks cover contract validation, renderer privacy/size/escaping, transport policy,
provider diagnostics, revision changes and UI setup. The isolated browser command is
`npx e2e run --config packages/web/e2e/chat-webhooks.config.ts`.
`CEZ_DRY_RUN=1` substitutes synthetic HTTP success and sends no receiver traffic, including Test;
it validates local flows, not provider delivery.

Live provider acceptance requires explicit authorization: use a dedicated,
user-provided Slack test-channel webhook and an isolated project containing no sensitive
data. Start the test server with `CEZ_WEBHOOKS=1` and dry-run disabled (`CEZ_DRY_RUN` unset or
`0`). This mode makes real network requests; use only harmless, explicitly authorized tasks.
Save → Test → Activate, then create fresh tasks that ask a benign question, finish a trivial
local task, and produce a controlled benign failure. Respect the configured attention grace
and failure delay. Verify attention / finished / failed messages in the channel and compare
delivery history; a synthetic green check is not evidence of provider delivery.
With separate explicit authorization for the destructive test, confirm that archiving the dedicated test channel yields `channel_is_archived` and disables the receiver.
Pause the receiver afterwards. Record the checks performed and their observed results.

## Risks

- The Slack URL is the credential: it is treated as a secret (`secrets()` includes
  `item.url`, masked in UI, redacted from diagnostics) — keep a test that it never appears in
  history or logs.
- Slack's 1 msg/s per webhook: bursts rely on the existing 429/`Retry-After` path.
- Standard profile puts task titles/questions/errors into a third-party workspace — the form
  warns before activation.

## API and failure handling

Admissions and manual tests snapshot the receiver format. Create/edit requests enforce the
selected destination's URL rules. Chat creation returns an empty `secret`, and key rotation is
rejected. Switching from chat to custom creates a fresh key; the edit
confirmation instructs the user to rotate and copy it before connecting the custom receiver.

Provider diagnostics use a closed vocabulary. Slack webhook URLs are credentials and are
redacted from diagnostics. Invalid stored chat payloads terminate as
`payload_invalid` before a send claim is published. Retained-URL format mismatches return 409.

Automated dry-run checks do not establish that a provider displayed a message.
