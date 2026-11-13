# Manager connectors (2026-11-12)

Extends `2026-10-31-managers.md` § Safety. Contract: `packages/contract/src/managers.ts` § connectors.

## Problem

A manager runs Claude Code headless with `--permission-mode dontAsk` and an allowlist. Claude Code
loads the user's claude.ai connectors (Gmail, Google Calendar, Drive, …) and any MCP server from the
user's own Claude config into that session, so the tools are listed, and every call is denied
(seen 2026-11-12: `mcp__claude_ai_Google_Calendar__list_calendars`). The servers also disconnect and
reconnect during a session, so tools come and go between turns.

## Model

- A **connector** is any MCP server the manager's Claude session reports, keyed by the `<server>`
  segment of `mcp__<server>__<tool>` (`claude_ai_Google_Calendar`). Not only `claude_ai_*`: a
  user-configured server in `~/.claude.json` is granted the same way.
- `Manager.connectors` maps key → `{ level: off|read|write, tools?: { <tool>: deny|ask|allow } }`.
  Absent key = off; absent field = all off, so every existing manager behaves as today.
- A tool's **kind** is read by its verb prefix (`get_ list_ search_ read_ find_ …`), else write
  (`managerConnectorToolKind`). Its **mode** is `managerConnectorToolMode`: override, else
  off → deny, read → read tools allow, write → read tools allow + write tools ask.
  Both live in the contract so server and cockpit cannot disagree.

## Discovery

Claude's `system/init` stream message carries `mcp_servers: [{name, status}]` and `tools: [...]`.
The Claude runner emits it as a new AgentEvent `{ type: 'mcp-servers', servers: [{ name, status }],
tools: string[] }` (other runners never emit it). The engine stores the latest one per manager in
its state (`connectors: { observedAt, servers: [{ key, name, status, tools[] }] }`) on EVERY turn
— chat, watch, job.

`GET /api/v1/workspace/managers/:id/connectors` returns `managerConnectorsResponseSchema` from that
state plus the current grants. `POST …/connectors/refresh` runs a probe: a Claude session with the
manager's runner/account/env and NO allowed tools, ended (`hardStop`) as soon as the init event
arrives — no model call is needed for init. A non-Claude runner answers `available: false`.

## Launch

Each turn (chat and job only; a watch stays read-only and gets nothing) adds the exact tool names
`mcp__<key>__<tool>` whose mode is `allow`, expanded against the last observed tool list, to
`allowedTools`. Exact names, never wildcards: only tools Claude actually reported are granted, each by
the same classification the settings screen shows. Grants are read fresh per turn, so a revoke applies from the next
turn. Anything else stays denied by `dontAsk`, unless the user's own Claude settings allow it:
their `permissions.allow` rules widen `--allowedTools` for every manager session, as they did
before connectors (follow-up: pass `--disallowedTools` for observed tools whose mode is deny).
Read verbs leave out `query`, `resolve`, `check` and `fetch`: the first three write in real
servers, and `fetch` is an egress channel for connector data. `search` stays read, so a
web-search server under a Read grant can still carry data out in its query.

## Approval cards for writes

`cez-manager propose-action --connector <key> --tool <tool> --args '<json>' [--reason …]` (also
accepts a full `--tool mcp__<key>__<tool>`) posts a `connector-call` action. Proposal refuses a tool
whose mode is `deny` (403) and one that is `allow` (400: "call it directly"). The server stamps
`connectorName`.

On approval the **server** runs exactly that call: a one-shot Claude session (the manager's
runner account/env, cwd = the manager workdir) whose `allowedTools` is that single tool and whose
prompt asks for one call with the given JSON. The call is fenced by a `PreToolUse` hook passed
through `--settings`: it compares the hook's `tool_input` with the approved args (canonical JSON)
and denies on any difference, so the executor model cannot change a recipient or a body. It is
single-use: the first allowed call writes a marker, and a retry is denied. The fence sets
`disableAllHooks: false`; managed settings that disable hooks leave only the engine's
after-the-fact input check. The tool
result (clipped) becomes the action's `result`, which the existing `settle` posts to the chat and
notes into the manager's next turn. Mode is re-checked at approval (a grant revoked while the card
waited fails the card). A connector that is not `connected` fails with
"<name> is temporarily unavailable".

Settings → Manager's `managerConfirm['connector-call']` behaves like the other types.

## Telling the manager

The system prompt lists each granted connector: its level, which tools it may call directly, which
need `propose-action`, and its last observed status. It is told that a missing tool or a
disconnected server means "say <Connector> is temporarily unavailable", never to promise or fake
the action.

## Connection churn

The reconnect churn is Claude Code's own claude.ai connector client; cezar cannot keep it alive.
Mitigations here: status is re-observed every turn and shown in the prompt; the executor reports
"temporarily unavailable" instead of failing silently. Not in scope: a keepalive.

## Not in v1

- Passing grants to tasks a manager dispatches (handover item 4).
- Non-Claude runners (Codex/OpenCode have their own MCP config; the section says so).
