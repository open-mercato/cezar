# Agent-gateway integrations (Hermes Agent, OpenClaw)

Status: implemented. Related draft: `2026-10-12-outbound-webhooks.md` (general webhooks, not implemented; this is the narrow, two-target case).

## Goal

Let Hermes Agent (Nous Research) and OpenClaw control a running cezar cockpit easily, and let cezar alert them.

## Design

1. **Control — `cezar mcp`** (`src/agent-gateway/mcp-server.ts`). Hand-rolled MCP over stdio (newline-delimited JSON-RPC 2.0: `initialize`, `ping`, `tools/list`, `tools/call`; notifications ignored). It is an HTTP client of the existing `/api/v1` routes — no new route, no new dependency, no state. Nine tools (`question` in `cezar_get_task` only while the task is `waiting`; batch frames get -32600); inputs are zod schemas turned into JSON Schema with `z.toJSONSchema`; responses are narrowed with contract schemas (`runRecordSchema`, `runHistoryPageSchema`), `status` kept a string so a newer cockpit still lists. Discovery: `--url`, `CEZ_API_URL`, `http://127.0.0.1:4321` — the server writes no port file. `cockpit-address.ts` refuses to default `CEZ_API_URL` for *agents inside a task*; here the person started `cezar mcp` on purpose, so the default is the cockpit's documented address. A client without an `Origin` header passes the #426 guard, as `cez task` does. Remote agents use `ssh host cezar mcp`; no HTTP MCP.
2. **Alerts** (`src/agent-gateway/alerts.ts`). `RunAlerts.watch(store, projectId)` listens to the store's `run` event, remembers each run's last status (seeded from `listRuns()` so a restart replays nothing) and the latest `ask.requested` question from the `event` stream. Attached in `createApp` for the boot context and, via `onContextBuilt`, for lazily built projects — after `recover()`. The store drops its listeners at project teardown. Statuses map: `waiting` and `failed`+`awaitingAnswerSince` → needs-input; `review`, `done`, `failed`, `cancelled`. Default set `needs-input,review,failed` (`CEZ_ALERT_EVENTS`).
   - OpenClaw (`CEZ_OPENCLAW_URL`, `_HOOK_TOKEN`, `_AGENT_ID`, `_CHANNEL`+`_TO`): bearer-authenticated `POST <hooks>/wake` `{text, mode:"now"}` or, with a destination, `POST <hooks>/agent` `{message, name, wakeMode, deliver:true, channel, to, idempotencyKey}`.
   - Hermes (`CEZ_HERMES_WEBHOOK_URL`, `_SECRET`): `{event_type:"cezar.task.<event>", message, task}` signed with generic HMAC V2 — `X-Webhook-Timestamp` (unix s) and `X-Webhook-Signature-V2` = hex HMAC-SHA256 of `<ts>.<body>`; `X-Request-ID` for idempotency. Verified in `gateway/platforms/webhook.py` of NousResearch/hermes-agent (the V1 body-only header is deprecated there).
   - Delivery: detached, 5 s timeout, one retry (network error, 5xx, 429), failures logged once, never thrown. `CEZ_DRY_RUN=1` logs only. Payload is allow-listed (title, status, project id, branch, PR url, link, question, and `detail`: the agent's last message ≤280 chars for needs-input without an ask, the run's error ≤280 chars for failed).
   - `cezar alerts test` sends a test alert.
3. **Packaging** (`src/agent-gateway/integrations.ts`). `cezar integrations print <hermes|openclaw> [--skill]` prints config and a SKILL.md. Kept as TypeScript strings so the published tarball (`dist`) needs no new asset path and the command path is resolved at print time. Nothing is written to other tools' config.

## Zero-config check

With no `CEZ_OPENCLAW_*`/`CEZ_HERMES_*` set, no listener is attached and nothing is sent; the default path is unchanged. `cezar mcp` is a separate process the user starts.

## Not done

Inbound webhooks, HTTP MCP, per-project alert targets, durable retry queue, signing for OpenClaw (it uses a bearer token), alert link when the boot project is unregistered (id `default`).
