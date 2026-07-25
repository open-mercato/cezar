# Agent Event Protocols — How Coding-Agent Backends Stream Status & Metadata to GUIs

Research date: 2026-07-14. Sources: docs.claude.com / code.claude.com (Agent SDK + headless stream-json), agentclientprotocol.com (ACP by Zed), developers.openai.com + github.com/openai/codex (app-server), opencode.ai docs + sst/opencode SDK generated types. Cross-referenced against cezar's current normalization in `src/core/agent-runner.ts`, `claude-cli-runner.ts`, `codex-app-server-runner.ts`, `opencode-server-runner.ts`.

---

## 1. Claude Code — `--output-format stream-json` (NDJSON over stdout)

Transport: one JSON object per line on stdout; input side is `--input-format stream-json` (user messages + control responses written to stdin). This is the same wire format the Agent SDK (`@anthropic-ai/claude-agent-sdk`) exposes as `SDKMessage`. Every message carries `session_id` and a `uuid`; messages emitted from inside a subagent additionally carry `parent_tool_use_id`.

### 1.1 Message envelope types

**`system` / `subtype: "init"`** — first line of every session:

```json
{
  "type": "system", "subtype": "init",
  "cwd": "/repo", "session_id": "3f9c…", "uuid": "…",
  "tools": ["Task","Bash","Read","Edit","Write","TodoWrite","Glob","Grep","WebFetch","WebSearch", "…"],
  "mcp_servers": [{"name": "playwright", "status": "connected"}],
  "model": "claude-fable-5", "permissionMode": "acceptEdits",
  "slash_commands": ["compact", "…"], "apiKeySource": "none",
  "output_style": "default", "agents": ["general-purpose", "…"]
}
```

**`assistant`** — wraps a full Anthropic-API `Message` object. Content blocks are the Anthropic block types: `text`, `thinking` (extended-thinking blocks, with `thinking` + `signature` fields), and `tool_use` (`{id, name, input}`). `message.usage` carries per-API-call token usage (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`).

```json
{"type":"assistant","message":{"role":"assistant","content":[
   {"type":"thinking","thinking":"Let me look at…","signature":"…"},
   {"type":"text","text":"I'll fix the bug."},
   {"type":"tool_use","id":"toolu_01AB","name":"Edit","input":{"file_path":"/repo/a.ts","old_string":"…","new_string":"…"}}
 ],"usage":{"input_tokens":4,"output_tokens":120,"cache_read_input_tokens":18000}},
 "parent_tool_use_id":null,"session_id":"3f9c…","uuid":"…"}
```

**`user`** — tool results echoed back as a user message with `tool_result` blocks: `{type:"tool_result", tool_use_id, content, is_error}`. `content` is a string or an array of `text` / `image` (base64 source) blocks. The CLI also attaches a non-API convenience field `toolUseResult` (structured result, e.g. file diff info for Edit) on some messages.

**`result`** — final message of the run/turn:

```json
{"type":"result","subtype":"success","is_error":false,
 "duration_ms":45000,"duration_api_ms":42000,"num_turns":12,
 "result":"Final assistant text…","session_id":"3f9c…",
 "total_cost_usd":0.0834,
 "usage":{"input_tokens":1200,"output_tokens":4800,"cache_creation_input_tokens":9000,"cache_read_input_tokens":210000},
 "modelUsage":{"claude-fable-5":{"inputTokens":…,"outputTokens":…,"costUSD":…}},
 "permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_…","tool_input":{…}}]}
```

Subtypes: `success`, `error_max_turns`, `error_during_execution`. In persistent stream-json sessions (cezar's mode) a `result` message ends **each turn**, not the process — cezar already uses this as its `turn-end` signal.

**`stream_event`** (only with `--include-partial-messages`) — wraps raw Anthropic streaming events (`message_start`, `content_block_start`, `content_block_delta` with `text_delta`/`thinking_delta`/`input_json_delta`, `content_block_stop`, `message_stop`). This is how you get token-by-token text and *live tool input as it's being typed*. cezar does not enable this today — it gets whole text blocks per API round-trip, which is why claude text appears "chunky" in the GUI.

**`control_request` / `control_response`** — bidirectional control protocol (the SDK's plumbing, available on the CLI wire in stream-json input mode):

```json
{"type":"control_request","request_id":"req_1","request":{
  "subtype":"can_use_tool","tool_name":"Bash","input":{"command":"rm -rf …"},
  "permission_suggestions":[…],"blocked_path":null}}
```

Client replies `{"type":"control_response","response":{"subtype":"success","request_id":"req_1","response":{"behavior":"allow","updatedInput":{…}}}}` or `{"behavior":"deny","message":"…"}`. Other control subtypes: `interrupt`, `initialize`, `set_permission_mode`, `hook_callback`, `mcp_message`. SDK equivalents: `canUseTool` callback returning `PermissionResult` (`{type:"approve"|"deny"}`). This is the hook cezar would use to surface **interactive permission prompts** instead of hard-wiring `--permission-mode acceptEdits`.

### 1.2 Plan/todo and subagents (conventions on top of tool_use)

- **TodoWrite tool** — the plan is just a `tool_use` with `name:"TodoWrite"` and input:
  ```json
  {"todos":[{"content":"Run tests","status":"pending","activeForm":"Running tests"}]}
  ```
  `status ∈ pending | in_progress | completed`. Each call carries the **full replacement list** (same semantics as ACP plans). `activeForm` is the present-continuous label shown while in_progress.
- **Subagents (Task tool)** — `tool_use` with `name:"Task"`, input `{description, prompt, subagent_type}`. All messages generated inside the subagent then stream with `parent_tool_use_id` = that tool_use id, so a GUI can nest them under the Task row. The `tool_result` for the Task id is the subagent's final report.
- **Thinking** — `thinking` content blocks inside `assistant` messages (cezar currently drops them).

---

## 2. Agent Client Protocol (ACP) — agentclientprotocol.com (Zed)

JSON-RPC 2.0 over stdio (client spawns the agent). The editor is the "Client", the agent the "Agent". Baseline flow: `initialize` → `session/new` (or `session/load`) → `session/prompt` → stream of `session/update` notifications → response with `stopReason`.

### 2.1 `session/update` notification — the single streaming channel

`params: { sessionId, update }` where `update.sessionUpdate` discriminates:

| `sessionUpdate` | Meaning |
|---|---|
| `user_message_chunk` | echo of user content |
| `agent_message_chunk` | streamed assistant text (ContentBlock) |
| `agent_thought_chunk` | streamed reasoning/thinking |
| `tool_call` | a new tool call was created |
| `tool_call_update` | status/content update for an existing tool call |
| `plan` | full-replacement execution plan |
| `available_commands_update` | slash commands changed |
| `current_mode_update` | session mode changed |

### 2.2 Tool calls

```json
{"sessionUpdate":"tool_call","toolCallId":"call_001","title":"Reading configuration file",
 "kind":"read","status":"pending","locations":[{"path":"/repo/src/main.py","line":42}],
 "rawInput":{…}}
```

Then `tool_call_update` with any changed fields:

```json
{"sessionUpdate":"tool_call_update","toolCallId":"call_001","status":"in_progress",
 "content":[{"type":"content","content":{"type":"text","text":"Found 3 files…"}}]}
```

- **`status`** (ToolCallStatus): `pending` → `in_progress` → `completed` | `failed` (plus implicit cancellation via turn cancel).
- **`kind`** (ToolKind): `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `other` — lets a GUI pick icons/verbs without knowing tool names.
- **`content`** items are one of three types: `content` (wraps a ContentBlock: text/image/audio/resource_link/embedded resource), **`diff`** `{path, oldText: string|null, newText}`, or **`terminal`** `{terminalId}` (live command output streamed via the terminal extension).
- `locations` (`{path, line?}`) enable "follow-along" in the editor; `rawInput`/`rawOutput` are the untyped tool payloads.

### 2.3 Plans

```json
{"sessionUpdate":"plan","entries":[
  {"content":"Analyze the existing codebase structure","priority":"high","status":"pending"}]}
```

`priority ∈ high|medium|low`, `status ∈ pending|in_progress|completed`. Spec: "The Agent MUST send a complete list of all plan entries in each update… The Client MUST replace the current plan completely." — identical replacement semantics to Claude's TodoWrite.

### 2.4 Permissions and turn end

`session/request_permission` (Agent→Client **request**, blocks the tool): `params: {sessionId, toolCall, options: PermissionOption[]}` where options are e.g. allow-once / allow-always / reject-once / reject-always, each with `optionId`, `name`, `kind`. Response: `{outcome: {outcome:"selected", optionId}}` or `{outcome:"cancelled"}`.

`session/prompt` response ends the turn with **`stopReason`**: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`. Cancellation: client sends `session/cancel`, agent must wind down and return `cancelled`.

### 2.5 Adoption (as of mid-2026)

- **Gemini CLI**: native ACP support (was Zed's launch partner / reference implementation; `gemini --experimental-acp`).
- **Claude Code**: no native ACP; Zed ships an **adapter** (`claude-code-acp`, npm `@zed-industries/claude-code-acp`) that wraps the Claude Agent SDK and translates to ACP — proof that stream-json maps cleanly onto ACP's model.
- JetBrains announced ACP adoption across its IDEs; the ACP registry lists ~50 agents (Claude Code, Gemini CLI, Codex, Copilot, Goose…), several via adapters.
- **Takeaway for cezar:** ACP is the closest thing to an industry-neutral GUI event vocabulary; aligning cezar's normalized events with ACP names (tool status enum, ToolKind, PlanEntry, diff shape, stopReason) buys future compatibility (a cezar ACP-client backend would make *any* ACP agent a fourth backend nearly for free).

---

## 3. OpenAI Codex — `codex app-server` (JSON-RPC 2.0 JSONL over stdio)

The protocol behind the VS Code extension, desktop app, and partner integrations. Bidirectional JSON-RPC; also `ws://` and `unix://` transports. Requires `initialize` with `capabilities.experimentalApi: true` for the v2 thread/turn/item API (which cezar already sends).

### 3.1 Model: Thread → Turn → Item

- **Thread** — durable conversation; `thread/start`, `thread/resume`, `thread/fork`, `thread/read`, `thread/list`. Notifications: `thread/started`, `thread/status/changed` (idle/active), `thread/closed`, `thread/archived`.
- **Turn** — one exchange; client calls `turn/start` (input items), `turn/steer` (append input to in-flight turn, with `expectedTurnId`), `turn/interrupt`. Notifications: `turn/started` `{turn:{id,status:"inProgress",items:[]}}`, `turn/completed` `{turn:{id,status:"completed"}}`, `turn/failed`.
- **Item** — the atomic unit with an explicit lifecycle: **`item/started` → streaming deltas → `item/completed`** (some item types also get `item/updated`). Items are persisted; clients can re-read history via `thread/items/list`.

### 3.2 Item types (the `item.type` field) and statuses

```json
{"type":"userMessage","id":"…","content":[{"type":"text","text":"…"}]}
{"type":"agentMessage","id":"…","text":"…","phase":"commentary | final_answer"}
{"type":"reasoning","id":"…","summary":["…"],"content":["…"]}
{"type":"commandExecution","id":"…","command":[…],"cwd":"…",
 "status":"inProgress | completed | failed | declined","exitCode":0}
{"type":"fileChange","id":"…","changes":[{"path":"…","kind":"…","diff":"…"}],
 "status":"inProgress | completed | failed | declined"}
{"type":"mcpToolCall","id":"…","server":"…","tool":"…",
 "status":"inProgress | completed | failed","arguments":{…},"result":"…"}
{"type":"webSearch","id":"…","query":"…","action":{"type":"search | openPage | findInPage"}}
{"type":"plan","id":"…","text":"…"}
```

Plus `enteredReviewMode` / `exitedReviewMode`, `contextCompaction`, and a **`plan`** item (`{type:'plan', id, text}` — plan-MODE prose, streamed via `item/plan/delta`).

> **Correction (2026-07-17, verified against `openai/codex@main`).** An earlier revision of this section listed a **`todoList`** item updated via `item/updated`. Neither exists: the app-server v2 `ThreadItem` union has no todo variant, and `ServerNotification` has no `item/updated` method (only `item/started` and `item/completed`). The agent's step checklist (the `update_plan` tool) arrives as the turn-level notification **`turn/plan/updated`** → `{threadId, turnId, explanation: string|null, plan: [{step, status}]}`, where `status` is **camelCase** `pending|inProgress|completed` on the app-server wire (codex's core type is snake_case; the app-server layer re-serializes). It is full-replacement and the steps carry no ids. Plan-mode prose and `update_plan` are mutually exclusive — codex rejects `update_plan` in plan mode. Sources: `app-server-protocol/schema/typescript/v2/{ThreadItem,TurnPlanUpdatedNotification,TurnPlanStep,TurnPlanStepStatus}.ts`, `schema/typescript/ServerNotification.ts`. (codex's *exec* transport — which cezar does not spawn — does have a `todo_list` item on dot-named methods.)

Delta notifications:

- `item/agentMessage/delta` — `{threadId, turnId, itemId, delta}` streamed assistant text
- `item/reasoning/textDelta` (and summary deltas) — streamed reasoning
- `item/commandExecution/outputDelta` — live stdout/stderr chunks of a running command

### 3.3 Approvals (server→client JSON-RPC **requests**, block the item)

```json
{"method":"item/commandExecution/requestApproval",
 "params":{"itemId":"…","threadId":"…","turnId":"…","command":[…]}}
{"method":"item/fileChange/requestApproval",
 "params":{"itemId":"…","threadId":"…","turnId":"…","changes":[…]}}
```

Response decisions: `accept`, `acceptForSession`, `decline`, `cancel` (command approval also `acceptWithExecpolicyAmendment`). A declined item completes with `status:"declined"`. cezar suppresses these entirely via `approvalPolicy:"never"` + `sandbox:"workspace-write"`.

### 3.4 Usage + legacy `codex proto`

`thread/tokenUsage/updated` → `{threadId, tokenUsage:{total:{totalTokens,…}, last:{…}}}` — **cumulative** totals (cezar reads `tokenUsage.total.totalTokens`). No cost-in-USD field (ChatGPT-plan auth); GUIs show tokens/context-window, not dollars.

The older **`codex proto`** NDJSON interface (Submission Queue ops in / Event Queue `EventMsg` out: `task_started`, `agent_message_delta`, `agent_reasoning`, `exec_command_begin/end`, `exec_approval_request`, `apply_patch_approval_request`, `token_count`, `plan_update`, `turn_diff`, `task_complete`…) is effectively superseded by app-server; OpenAI's docs now steer all integrations to app-server. cezar is on the right transport — no reason to touch `proto`.

---

## 4. OpenCode — `opencode serve` (HTTP + SSE)

Headless HTTP server (OpenAPI 3.1 at `/doc`), the same API the TUI uses. `GET /event` is an SSE stream: first event `server.connected`, then bus events, each `{type, properties}`.

### 4.1 Event types (SSE)

| Event | Payload |
|---|---|
| `message.updated` | `{info: Message}` — message-level metadata (role, tokens, cost, model, time) |
| `message.part.updated` | `{part: Part, delta?: string}` — the workhorse; every part mutation |
| `message.part.removed` | part deleted |
| `session.updated` | session info (title, time) |
| `session.idle` | `{sessionID}` — **the turn-end signal** (agent went quiet) |
| `session.error` | `{sessionID?, error?}` |
| `permission.updated` | a `Permission` object — a pending permission ask |
| `permission.replied` | permission resolved |

### 4.2 Message + Part model (from sst/opencode SDK `types.gen.ts`)

`AssistantMessage`: `{id, sessionID, role:"assistant", time:{created,completed?}, error?, parentID, modelID, providerID, mode, path:{cwd,root}, summary?, cost, tokens:{input, output, reasoning, cache:{read, write}}, finish?}` — **cumulative-per-message** cost (USD) and token breakdown.

`Part` union: `text`, `reasoning`, `file`, **`tool`**, **`step-start`**, **`step-finish`** (one per LLM round-trip; carries per-step `cost` + `tokens`), `snapshot`, **`patch`** (file diff/revert point), `agent`, `retry`, `compaction`, `subtask` (`{prompt, description, agent}` — subagent spawn). Text parts carry the **full accumulated text** each update (cezar diffes against a cursor to synthesize deltas; newer server versions also include `delta`).

**Tool part**: `{id, messageID, sessionID, type:"tool", callID, tool: "<name>", state: ToolState}` with a genuine 4-state lifecycle:

```
ToolStatePending   {status:"pending", input, raw}
ToolStateRunning   {status:"running", input, title?, metadata?, time:{start}}
ToolStateCompleted {status:"completed", input, output, title, metadata, time:{start,end}, attachments?}
ToolStateError     {status:"error", input, error, metadata?, time}
```

Built-in tool names include `bash`, `edit`, `write`, `read`, `grep`, `glob`, `webfetch`, `task` (subagent), and **`todowrite`/`todoread`** — todo input is `{todos:[{id, content, status, priority}]}`, same replace-the-list convention.

### 4.3 Permissions

`permission.updated` carries `Permission {id, type, pattern?, sessionID, messageID, callID?, title, metadata, time:{created}}`. Client replies `POST /session/:id/permissions/:permissionID` with `{response: "once"|"always"|"reject"}`. cezar today auto-approves via server config and never surfaces these.

---

## 5. What cezar normalizes today (and the gaps)

Current `AgentEvent` union (`src/core/agent-runner.ts`): `text`, `tool-call {id,tool,input}`, `tool-result {toolCallId,result,isError}`, `image`, `token-usage {tokensUsed}` (single cost-weighted number), `cost {usd}`, `session`, `turn-end`, `note`, `done`, `error`.

Per-backend mapping as implemented:

| cezar event | claude runner | codex runner | opencode runner |
|---|---|---|---|
| `text` | `assistant` text blocks (whole blocks, no deltas) | `item/agentMessage/delta` (+ completed fallback) | text-part cursor diffing |
| `tool-call` | `tool_use` block | `item/started` for non-message items (name = **item type**, input = whole item) | first sight of a tool part |
| `tool-result` | `tool_result` block in `user` msg | `item/completed` (result = `JSON.stringify(item)`, isError = regex on status) | tool state `completed`/`error` |
| `turn-end` | `result` message | `turn/completed` | **synthesized from HTTP prompt-response**, not `session.idle` |
| usage | cost-weighted sum of Anthropic usage | `tokenUsage.total.totalTokens` (raw) | input+output+reasoning (raw) |
| `cost` | `total_cost_usd` | never | message `cost` delta |

**Concrete gaps this research exposes:**

1. **No tool lifecycle** — cezar has call→result (2 states). Every protocol has 3–5 states (ACP `pending/in_progress/completed/failed`; codex `inProgress/completed/failed/declined`; opencode `pending/running/completed/error`). The GUI can't show a spinner on a *running* tool vs a queued one, and a claude tool is "running" implicitly between two events.
2. **Plan/todo invisible** — claude `TodoWrite` arrives as a generic tool-call blob; codex `plan`/`todoList` items are in `NON_TOOL_ITEMS` and **dropped entirely**; opencode `todowrite` is a generic tool. All three have the same full-replacement checklist semantics as ACP `plan` — a trivially unifiable, high-value GUI feature.
3. **Reasoning/thinking dropped** — claude `thinking` blocks are skipped in `handleClaudeMessage`; codex `reasoning` is in `NON_TOOL_ITEMS` (and no `item/reasoning/textDelta` case); opencode `reasoning` parts are ignored in `handlePart`.
4. **Permissions bypassed, not surfaced** — all three backends are forced into auto-approve. All three *do* have a wire-level interactive ask (claude `control_request/can_use_tool`, codex `requestApproval` JSON-RPC requests, opencode `permission.updated` + reply endpoint) that could power a GUI approval flow later; the normalized schema should reserve events for it now.
5. **No structured diffs** — codex `fileChange.changes[].{path,diff}` is stringified; claude `Edit` input (`file_path/old_string/new_string`) maps 1:1 to ACP's diff `{path,oldText,newText}`; opencode `patch` parts are dropped.
6. **Usage is lossy** — one number, cost-weighted for claude but raw for the other two (not comparable across backends). No input/output/cache split, no context-window fill.
7. **No sub-agent attribution** — claude `parent_tool_use_id`, codex review-mode items, opencode `subtask` parts are all flattened.
8. **Codex tool naming** — `tool-call.tool` is the item *type* (`commandExecution`) and `input` is the whole item; the GUI can't render "ran `npm test`" without backend-specific parsing.
9. **turn-end fidelity** — opencode synthesizes turn-end from the HTTP response instead of `session.idle`; no stop-reason anywhere (timeout/refusal/cancelled/max-tokens all look alike).

---

## 6. Comparison table — event/status models

| Concern | Claude Code stream-json | Codex app-server | OpenCode SSE | ACP |
|---|---|---|---|---|
| Transport | NDJSON stdout (+stdin input) | JSON-RPC 2.0 JSONL stdio (also ws/unix) | HTTP + SSE `/event` | JSON-RPC 2.0 stdio |
| Container | session → turns (implicit) → messages | thread → turn → **item** | session → message → **part** | session → prompt turn → updates |
| Streaming text | `assistant` whole blocks; deltas only with `--include-partial-messages` (`stream_event`) | `item/agentMessage/delta` | `message.part.updated` full text (+ `delta`) | `agent_message_chunk` |
| Reasoning | `thinking` content blocks (+ thinking_delta) | `reasoning` item + `item/reasoning/textDelta` | `reasoning` part | `agent_thought_chunk` |
| Tool call unit | `tool_use` block → `tool_result` block | typed items (`commandExecution`, `fileChange`, `mcpToolCall`, `webSearch`) | `tool` part with `state` | `tool_call` + `tool_call_update` |
| Tool status enum | none (2 implicit states) | `inProgress/completed/failed/declined` | `pending/running/completed/error` | `pending/in_progress/completed/failed` |
| Tool semantic kind | tool name (Read/Bash/Edit…) | item type | tool name (bash/edit/read…) | **`kind`: read/edit/delete/move/search/execute/think/fetch/other** |
| Live command output | no (result only) | `item/commandExecution/outputDelta` | tool `metadata` while running | `terminal` content type |
| Plan/todo | `TodoWrite` tool input `{todos:[{content,status,activeForm}]}`, or the incremental `TaskCreate`/`TaskUpdate` calls | `turn/plan/updated` notification `{plan:[{step,status}]}` (NOT an item) | `todowrite` tool `{todos:[{content,status,priority}]}` — `status` is free-form, incl. `cancelled` | `plan` update `{entries:[{content,priority,status}]}` — full replace |
| Diffs | `Edit` tool input (old/new string); `toolUseResult` | `fileChange.changes[{path,kind,diff}]` | `patch` part; edit tool metadata | `diff` content `{path,oldText,newText}` |
| Permissions | `control_request` `can_use_tool` (allow/deny+updatedInput) | `item/*/requestApproval` (accept/acceptForSession/decline/cancel) | `permission.updated` + POST reply (once/always/reject) | `session/request_permission` with option list |
| Turn end | `result` message | `turn/completed` / `turn/failed` | `session.idle` | prompt response `stopReason: end_turn/max_tokens/max_turn_requests/refusal/cancelled` |
| Usage | per-message `usage` + result `total_cost_usd`, `modelUsage` | `thread/tokenUsage/updated` cumulative (no USD) | message `tokens{input,output,reasoning,cache}` + `cost` USD | not in core spec (extension) |
| Sub-agents | `Task` tool + `parent_tool_use_id` on nested msgs | review mode items | `subtask` part / `task` tool | nested tool call content |
| Errors | `result.subtype`, `is_error` | `turn/failed`, item `failed` status, `-32001` backpressure | `session.error` | JSON-RPC errors + `refusal` stop |

**Convergence:** all four have converged on (a) an *item/part with explicit lifecycle* as the atomic UI unit, (b) a small tool-status enum, (c) full-replacement plan checklists, (d) blocking permission asks with a small option vocabulary. ACP is the cleanest editor-agnostic articulation of exactly this shape — and Claude Code (via Zed's adapter) and Gemini CLI already map onto it, with Codex in the ACP registry via adapter.

---

## 7. RECOMMENDED — cezar normalized UI-event schema v2

Design rules: (1) item-lifecycle model like Codex/ACP — one stable `id` per item, `started/delta/completed` phases — because 2 of 3 backends are natively item-shaped and claude maps trivially; (2) ACP vocabulary wherever a choice is arbitrary (tool status, tool kind, plan entries, diff shape, stop reasons) for ecosystem alignment; (3) every v1 `AgentEvent` remains derivable, so the store/GUI can migrate incrementally.

```ts
/** ---- shared enums (ACP-aligned) ---- */
type ToolStatus = 'pending' | 'running' | 'completed' | 'failed' | 'declined';
//  ACP: pending/in_progress/completed/failed. 'running'≡in_progress (opencode word,
//  reads better in code); 'declined' covers codex approvals + claude permission_denials.
type ToolKind =
  | 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute'
  | 'think' | 'fetch' | 'task'   // 'task' = subagent spawn (Task / subtask / review)
  | 'plan' | 'other';            // superset of ACP ToolKind
type StopReason = 'end_turn' | 'max_tokens' | 'refusal' | 'cancelled' | 'timeout' | 'error';
type PlanStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'; // 'cancelled' is opencode-only

interface TokenUsage {          // raw counts, never pre-weighted
  input: number; output: number;
  cacheRead?: number; cacheWrite?: number; reasoning?: number;
  total: number;                // backend's own total when given, else sum
  contextWindow?: number;       // for a fill gauge, when known
}

interface FileDiff { path: string; oldText: string | null; newText?: string; unified?: string; }
// claude Edit → old/newText; codex fileChange → unified; opencode patch → unified.

/** ---- events (discriminated on `type`) ---- */
type UiEvent =
  // session lifecycle
  | { type: 'session.started'; sessionId: string; backend: RunnerId; model?: string;
      cwd?: string; tools?: string[] }                       // claude system/init, codex thread/started, opencode POST /session
  | { type: 'session.ended'; reason: StopReason; message?: string }   // replaces done/error(fatal)
  | { type: 'session.error'; message: string; fatal: boolean }        // note+error unified, severity explicit

  // turn lifecycle
  | { type: 'turn.started'; turnId: string }                 // codex turn/started; claude: on user send; opencode: on prompt POST
  | { type: 'turn.completed'; turnId: string; stopReason: StopReason;
      usage?: TokenUsage; costUsd?: number }                 // claude result, codex turn/completed|failed, opencode session.idle

  // item lifecycle — ONE id-keyed stream for text, reasoning, and tools
  | { type: 'item.started'; item: UiItem }
  | { type: 'item.delta';   itemId: string; field: 'text' | 'reasoning' | 'output'; delta: string }
  | { type: 'item.updated'; item: UiItem }                   // status flips, streamed content snapshots
  | { type: 'item.completed'; item: UiItem }

  // plan (full replacement, ACP semantics — sourced from TodoWrite/todoList/todowrite)
  | { type: 'plan.updated'; entries: Array<{ content: string; status: PlanStatus;
      priority?: 'high' | 'medium' | 'low'; activeForm?: string }> }

  // permissions (reserved now, wired when auto-approve becomes optional)
  | { type: 'permission.requested'; requestId: string; itemId?: string; title: string;
      options: Array<{ id: string; label: string;
        kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }> }
  | { type: 'permission.resolved'; requestId: string; optionId: string }

  // telemetry (cumulative-for-session, raw)
  | { type: 'usage.updated'; usage: TokenUsage; costUsd?: number }
  // media (kept from v1 — persisted then re-emitted as URL by run manager)
  | { type: 'image'; itemId?: string; mediaType: string; data: string };

/** ---- items ---- */
type UiItem =
  | { kind: 'message'; id: string; role: 'assistant' | 'user'; text: string;
      phase?: 'commentary' | 'final'; parentItemId?: string }
  | { kind: 'reasoning'; id: string; text: string; parentItemId?: string }
  | { kind: 'tool'; id: string; name: string;         // backend tool name / item type
      toolKind: ToolKind;                             // ACP-style icon/verb hint
      title: string;                                  // human line: "Bash: npm test", "Edit src/a.ts"
      status: ToolStatus;
      input?: unknown;                                // raw input (may arrive incrementally)
      output?: string; error?: string;
      diffs?: FileDiff[];                             // Edit/fileChange/patch
      locations?: Array<{ path: string; line?: number }>;
      exitCode?: number;                              // commandExecution/bash
      parentItemId?: string };                        // nests subagent work under its Task item
```

### 7.1 Backend → v2 mapping (the load-bearing part)

**Claude (stream-json):**
- `system/init` → `session.started` (model, tools, cwd). Each stdin user message → `turn.started`.
- `assistant` `text` block → message `item.started`+`item.completed` (or true deltas via `--include-partial-messages` → `item.delta`). `thinking` block → reasoning item.
- `tool_use` → tool `item.started` with `status:'running'` (claude has no pending phase); `toolKind` from a static name map (Read/Glob/Grep→read|search, Edit/Write/NotebookEdit→edit, Bash→execute, WebFetch/WebSearch→fetch, Task→task, TodoWrite→plan, else other). `Edit`/`Write` input → `diffs` + `locations`.
- `tool_result` → `item.completed` with `status: is_error?'failed':'completed'`; image blocks → `image` events with `itemId`.
- `tool_use name==="TodoWrite"` → **also** emit `plan.updated` (map `{content,status,activeForm}` directly) and suppress or de-emphasize the tool item.
- `parent_tool_use_id` → `parentItemId` on everything nested (subagent grouping for free).
- `result` → `turn.completed` (stopReason: success→end_turn, error_max_turns→max_tokens-ish/`error`, error_during_execution→error; usage + total_cost_usd). `permission_denials` → tool items with `status:'declined'`.
- Later: `control_request can_use_tool` → `permission.requested` (options: allow once/always, deny), `control_response` ← `permission.resolved`.

**Codex (app-server):**
- `thread/started`/`thread/start` result → `session.started`; `turn/started`/`turn/completed`/`turn/failed` → turn events (failed → stopReason `error`; interrupt → `cancelled`).
- `item/started|completed` → same-named item events (`item/updated` is accepted defensively but codex does not send it). Type map: `agentMessage`→message (`phase` from item.phase), `reasoning`→reasoning, `commandExecution`→tool(kind execute, title from `command`, exitCode), `fileChange`→tool(kind edit, `changes[]`→`diffs[]` unified), `mcpToolCall`→tool(kind other, name `server.tool`), `webSearch`→tool(kind fetch), `plan`(prose)/`todoList`(non-app-server tolerance)→**`plan.updated`**, review mode items → tool(kind task).
- `turn/plan/updated` → **`plan.updated`** — the real `update_plan` checklist channel (see the correction above). `plan[].step`→`content`, `plan[].status` `pending|inProgress|completed`→`pending|in_progress|completed`; `explanation` is dropped (no field on `PlanEntry`).
- Status map: `inProgress→running`, `completed→completed`, `failed→failed`, `declined→declined` (kills the current regex-on-status hack).
- `item/agentMessage/delta` → `item.delta{field:'text'}`; `item/reasoning/textDelta` → `item.delta{field:'reasoning'}`; `item/commandExecution/outputDelta` → `item.delta{field:'output'}` (live terminal!).
- `thread/tokenUsage/updated` → `usage.updated` (raw totals; keep cost absent).
- Later: `item/*/requestApproval` → `permission.requested` (accept→allow_once, acceptForSession→allow_always, decline→reject_once).

**OpenCode (SSE):**
- `POST /session` → `session.started`; each prompt POST → `turn.started`; **switch turn-end to `session.idle`** → `turn.completed` (stopReason end_turn; error if a `session.error` preceded).
- `message.part.updated`: text part → message item (keep cursor/delta logic → `item.delta`); reasoning part → reasoning item; tool part → tool item with direct status map (`pending→pending`, `running→running` — emit `item.updated` on the flip, using `state.title`/`metadata` for live titles — `completed→completed`, `error→failed`), `state.time` for durations; `patch` part → `diffs`; `subtask` part → tool(kind task) and use as `parentItemId` scope; `step-finish` part → `usage.updated` increments.
- tool `todowrite` → `plan.updated` (content/status/priority map 1:1).
- `message.updated` info.tokens/cost → `usage.updated` (raw breakdown + USD).
- Later: `permission.updated` → `permission.requested` (once/always/reject options), POST reply on `permission.resolved`.

### 7.2 Migration & compatibility notes

- v1 events are pure projections of v2 (`text` ⇐ message item deltas; `tool-call`/`tool-result` ⇐ tool item started/completed; `turn-end` ⇐ turn.completed; `token-usage` ⇐ usage.updated with the cost-weighting moved to the *presentation* layer, not the wire). Ship v2 alongside v1, port GUI panels one at a time.
- Persisting v2 events keyed by `itemId` gives replay/reconnect for free (codex explicitly persists items; opencode parts are idempotent snapshots; claude uuids are stable) — the store can upsert instead of append-only.
- The `plan.updated` + tool-status + `item.delta{field:'output'}` trio is the biggest visible GUI win: a live checklist header, spinners on running tools, and streaming command output — matching what the Codex IDE extension and Zed's agent panel already ship.
- Keeping enums/shape ACP-adjacent means an eventual `acp` backend (Gemini CLI etc. via `session/update`) is mostly a transcription, and cezar could even *expose* ACP to editors later.
