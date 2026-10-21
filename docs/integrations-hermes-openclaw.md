# Hermes Agent and OpenClaw integration

Two directions, both opt-in:

- **Control** — `cezar mcp` is a stdio MCP server. Hermes Agent, OpenClaw (or any MCP client) calls it to start tasks, read status, answer a task's question, cancel, accept a review or open a PR on a **running cockpit**.
- **Alerts** — the cockpit POSTs a short message to your Hermes webhook route and/or OpenClaw Gateway hook when a task needs input, reaches review or fails.

`cezar integrations print <hermes|openclaw>` prints the exact config for each side. From an installed build it fills in the absolute path of this node and cezar entry file; run from a source checkout it falls back to a bare `cezar`, which must then be on the agent's PATH. cezar never edits another tool's config.

## Control: `cezar mcp`

Start the cockpit (`cezar`), then register the MCP server in the agent. No address is needed: a running cockpit writes `~/.cezar/cockpits/<pid>.json` (removed on exit, ignored once its pid is dead) and `cezar mcp` reads it. Order: `--url`, `CEZ_API_URL`, a discovered cockpit, `http://127.0.0.1:4321`. With several cockpits running it picks the one serving the current directory, else the most recent, and prints which on stderr. Inside a cezar task (`CEZ_TASK_ID`) nothing is discovered or guessed: set `CEZ_API_URL` or `--url`. `CEZ_PROJECT_ID` picks a default project. Task ids: pass the full id (one request) or at least 6 characters of it; an ambiguous prefix lists the matches.

| Tool | What it does |
| --- | --- |
| `cezar_list_projects` | Projects the cockpit serves. |
| `cezar_list_workflows` | Workflows a task can run (default `quick-task`). |
| `cezar_list_tasks` | Tasks, newest first; filter by `status`. |
| `cezar_get_task` | Status, branch, PR url, error; the pending `question` (only while the task waits) and the agent's `lastAgentMessage`. Ids may be shortened. |
| `cezar_create_task` | Start a task (`task`, `project`, `workflow`, `runner`, `model`, `autonomous`). |
| `cezar_send_message` | Answer a waiting task, steer a running one, send review feedback. |
| `cezar_cancel_task` | Cancel. |
| `cezar_accept_review` | Accept the changes without a PR (review → done). Asynchronous: poll `cezar_get_task`. |
| `cezar_open_pr` | Push the branch and open a (draft) PR through `gh`. Poll `cezar_get_task` for the url. |

Tasks still end at cezar's review gate; nothing is merged. The cockpit has no auth of its own and binds to loopback, so the MCP server must run on the same machine as the cockpit. For an agent on another machine, run it over SSH instead of exposing the cockpit: `command: ssh`, `args: [<host>, cezar, mcp]` (discovery then runs on that host).

### Hermes Agent

Add to `~/.hermes/config.yaml` ([Hermes MCP docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)), then restart or `/reload-mcp`:

```yaml
mcp_servers:
  cezar:
    command: "cezar"        # `cezar integrations print hermes` prints the absolute node + entry path when it can
    args: ["mcp"]
```

Optional skill: `mkdir -p ~/.hermes/skills/cezar && cezar integrations print hermes --skill > ~/.hermes/skills/cezar/SKILL.md`. In PowerShell create the folder yourself and pipe with `| Out-File -Encoding utf8 <path>\SKILL.md` (a plain `>` writes UTF-16 on Windows PowerShell 5).

### OpenClaw

```bash
openclaw mcp set cezar '{"command":"cezar","args":["mcp"]}'        # bash
openclaw mcp add cezar --command cezar --arg mcp           # shell-neutral (PowerShell, cmd)
openclaw mcp doctor --probe
mkdir -p ~/.openclaw/skills/cezar && cezar integrations print openclaw --skill > ~/.openclaw/skills/cezar/SKILL.md
```

The printed snippets show both forms. PowerShell: same `Out-File -Encoding utf8` note as above.

## Alerts

Set the variables on the **cockpit process** (see `.env.example`; a repository `.env` is never auto-loaded). Verify with `cezar alerts test`.

| Variable | Meaning |
| --- | --- |
| `CEZ_ALERT_EVENTS` | `needs-input`, `review`, `done`, `failed`, `cancelled`, `all`. Default `needs-input,review,failed`. |
| `CEZ_ALERT_COCKPIT_URL` | Base URL for the link in the message. Default `http://127.0.0.1:<port>`. |
| `CEZ_OPENCLAW_URL`, `CEZ_OPENCLAW_HOOK_TOKEN` | OpenClaw Gateway (default port 18789) and its `hooks.token`. |
| `CEZ_OPENCLAW_AGENT_ID` | Optional target agent. |
| `CEZ_OPENCLAW_CHANNEL` + `CEZ_OPENCLAW_TO` | Both or neither. Set: `/hooks/agent` runs an agent turn that messages you on that channel and can reply through the MCP tools. Unset: `/hooks/wake` system event. |
| `CEZ_OPENCLAW_SESSION_KEY_PREFIX` | With channel+to: `/hooks/agent` gets `sessionKey: <prefix>cezar:<project>:<task>` and `sessionMode: "persistent"`, so every alert and your replies about one task share one OpenClaw session that can call the cezar tools. Requires `hooks.allowRequestSessionKey: true` and `hooks.allowedSessionKeyPrefixes: ["<prefix>"]` in OpenClaw. |
| `CEZ_HERMES_WEBHOOK_URL`, `CEZ_HERMES_WEBHOOK_SECRET` | Full Hermes route URL (port 8644) and the route's `secret`. |
| `CEZ_DRY_RUN=1` | Log the request instead of sending. |
| `CEZ_ALERTS_LIVE_IN_DRY_RUN=1` | Test only: deliver anyway under `CEZ_DRY_RUN=1` (mock agents, real gateway). |

An alert fires on a status **transition** (not on every update, and not for statuses already on record when cezar starts). `waiting` is "needs input"; a session that ended on an unanswered question counts as needs-input too.

### OpenClaw setup

1. Enable hooks in the OpenClaw config (off by default), with a token dedicated to hooks, then `openclaw config validate && openclaw gateway restart`:
   ```json5
   hooks: { enabled: true, token: "<long random>", path: "/hooks", allowedAgentIds: ["main"] }
   ```
2. `CEZ_OPENCLAW_URL=http://127.0.0.1:18789`, `CEZ_OPENCLAW_HOOK_TOKEN=<token>`; add `CEZ_OPENCLAW_CHANNEL`/`CEZ_OPENCLAW_TO` for a message on telegram/slack/discord/whatsapp. If you changed `hooks.path`, put it in the URL.
3. `cezar alerts test`.

Requests: `Authorization: Bearer <token>`; `/hooks/wake` body `{text, mode:"now"}`; `/hooks/agent` body `{message, name, wakeMode, deliver:true, channel, to, agentId?, idempotencyKey}`.

### Hermes setup

1. In `~/.hermes/.env`: `WEBHOOK_ENABLED=true`, `WEBHOOK_PORT=8644`. In `config.yaml`:
   ```yaml
   platforms:
     webhook:
       extra:
         routes:
           cezar:
             secret: "<long random>"
             events: ["cezar.task.needs-input", "cezar.task.review", "cezar.task.failed"]
             prompt: "{message}"
             deliver: telegram
             deliver_extra: { chat_id: "<id>" }
             deliver_only: true     # no LLM turn; drop it to let Hermes act on the alert
   ```
2. `CEZ_HERMES_WEBHOOK_URL=http://127.0.0.1:8644/webhooks/cezar`, `CEZ_HERMES_WEBHOOK_SECRET=<same secret>`.
3. `cezar alerts test`.

The body is `{"event_type":"cezar.task.<event>","message":"…","task":{id,title,status,project,branch?,prUrl?,url?,question?,detail?}}`, signed as Hermes' generic HMAC V2: `X-Webhook-Timestamp` (unix seconds) and `X-Webhook-Signature-V2` = hex HMAC-SHA256 of `<timestamp>.<body>`; `X-Request-ID` makes retries idempotent.

## What leaves the machine

Only when a target is configured: task title (≤200 chars), status, project id, branch, PR url, the cockpit link and, for needs-input, the agent's question and option labels (≤600 chars) — or, when it asked no structured question, its last message (≤280 chars) — and, for failed, the run's error (≤280 chars). Never the task prompt, transcript, diffs or secrets. The MCP server sends nothing anywhere except to the cockpit you point it at.

## Limits

- Delivery: 5 s timeout, one retry on a network error / 5xx / 429. If it still fails, the alert (title, status, project, … — no token, no signature) is parked in `.ai/cezar/alerts-outbox.ndjson`, retried at boot and every 5 minutes with the same idempotency id (`X-Request-ID` / `idempotencyKey`) and a fresh signature, dropped after 24 h, at most 200 kept. A gateway that did receive the first try drops the duplicate.
- Alerts carry no cockpit authentication; use HTTPS and a dedicated token/secret when the gateway is not on loopback.
- The alert link is only as good as the address the cockpit knows about; behind a proxy set `CEZ_ALERT_COCKPIT_URL`.
- No HTTP MCP transport; use ssh-stdio for remote agents.
