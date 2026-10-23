# The Copilot CLI ACP surface — verified reference

Spec Step 3.1 (`.ai/specs/2026-09-19-runner-seam-native-backends.md`), settled on **2026-09-27**
against **`@github/copilot` 1.0.88** (`buildMetadata.gitCommit` `52f75603`). Everything in the
source spec's "Copilot CLI (Phase 3)" research block was marked *unverified*; this file replaces
it. Every fact below names the command or the code site that produced it, and the golden fixtures
in `packages/cezar/src/core/__fixtures__/copilot/` cite this file.

## How the evidence was obtained

The published `@github/copilot` npm package is a loader; the real program is a platform package
(`@github/copilot-linux-x64`) containing a Node single-executable binary. Its payload is an ELF
note named `NODE_SEA_BLOB` holding `sea-loader.js` plus an embedded `copilot.tgz`, whose
`package/app.js` is the CLI bundle. Two kinds of evidence are used:

1. **Live probe** — running `copilot --acp` and writing JSON-RPC frames to its stdin. This
   produced the real `initialize` answer and the real unauthenticated `session/new` error.
2. **Bundle read** — reading `package/app.js` out of the embedded tarball. This is the same
   offline method the source spec used for codex ("strings in the codex 0.154.0 binary") and it
   is what settles the streaming frames, which the live probe cannot reach without entitlement.

Reproduce with:

```bash
mkdir /tmp/copilot-probe && cd /tmp/copilot-probe && npm init -y && npm i @github/copilot@1.0.88
./node_modules/.bin/copilot --version            # GitHub Copilot CLI 1.0.88.
./node_modules/.bin/copilot --help
./node_modules/.bin/copilot help environment
# The bundle: parse the NODE_SEA_BLOB ELF note of
# node_modules/@github/copilot-linux-x64/copilot, take the embedded copilot.tgz and extract
# package/app.js from it.
```

**Not verified:** no *authenticated* transcript exists. The host `gh` token carries no Copilot
entitlement, so `session/new` answers "Authentication required" and no live streaming frames could
be recorded. The frame shapes below come from the bundle's own emitters, which is stronger than
guessing but weaker than a capture — `copilot-acp-runner.smoke.test.ts` is the live gate.

## Invocation

**`copilot --acp`.** There is no `--stdio` flag; the source spec's `copilot --acp --stdio` is
wrong. (`copilot --help`: `--acp  Start as Agent Client Protocol server`. The `--stdio` the spec
cites appears in the package README as part of a `typescript-language-server` LSP example.)

Flags this runner uses, all from `copilot --help`:

| Flag | Why |
|---|---|
| `--acp` | start the ACP server on stdio |
| `-C <dir>` | the session working directory |
| `--allow-all-tools` | spec Q15's `auto` permission mode |
| `--add-dir <dir>` | `AgentRunSpec.additionalDirectories` (repeatable) |
| `--model <model>` | `AgentRunSpec.model` |
| `--no-auto-update` | an agent run must never download a new CLI mid-task |
| `--log-dir <dir>` | keep Copilot's logs out of `~/.copilot/logs` for a cezar run |

**`--allow-all-tools` is used, never `COPILOT_ALLOW_ALL=true`.** Per `copilot help environment`,
the env var set to exactly `"true"` *additionally* trusts the working directory, which loads that
directory's skills, plugins, MCP servers and hooks — including hooks that run shell commands. The
flag only auto-approves tools.

Other flags that exist and are deliberately unused: `--allow-tool`, `--deny-tool`,
`--available-tools`, `--excluded-tools`, `--allow-all-paths`, `--allow-all-urls`, `--allow-all`,
`--yolo`, `--no-ask-user`, `--secret-env-vars`, `--usage-output-file`, `--session-id`,
`--disable-builtin-mcps`, `--mode`, `--autopilot`, `--plan`.

## Authentication

Token precedence, from `copilot help environment`:
**`COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN`.** Login command: `copilot login`.
Config and state live in `COPILOT_HOME` (default `$HOME/.copilot`).

Unauthenticated `session/new`, captured live:

```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Authentication required"}}
```

`app.js` confirms the source: `newSession` throws `ps.authRequired()` when
`hasSessionCredential(authInfo)` is false. This is the frame the runner turns into
`provider-auth-required`.

## `initialize` — captured live

```json
{"jsonrpc":"2.0","id":0,"result":{
  "protocolVersion":1,
  "agentCapabilities":{
    "loadSession":true,
    "mcpCapabilities":{"http":true,"sse":true},
    "promptCapabilities":{"image":true,"audio":false,"embeddedContext":true},
    "sessionCapabilities":{"close":{},"list":{}}},
  "agentInfo":{"name":"Copilot","title":"Copilot","version":"1.0.88"},
  "authMethods":[{"id":"copilot-login","name":"Log in with Copilot CLI",
    "description":"Run `copilot login` in the terminal","_meta":{"terminal-auth":{…}}}]}}
```

`loadSession: true` is what makes resume-by-`session/load` legitimate; `promptCapabilities.image`
is what makes sending pasted screenshots legitimate.

## Methods the agent implements

From the method-name literals in `app.js`:

`initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`, `session/cancel`,
`session/close`, `session/list`, `session/fork`, `session/resume`, `session/ready`,
`session/set_mode`, `session/set_model`, `session/set_config_option`, and — as requests *to* the
client — `session/request_permission`, `session/update`, `fs/read_text_file`,
`fs/write_text_file`, `terminal/*`.

cezar's client advertises `fs: {readTextFile:false, writeTextFile:false}` and `terminal:false`
(`ACP_CLIENT_CAPABILITIES`), so the agent uses its own tools inside `cwd` and never calls those.

`session/new` answers `{"sessionId":"<uuid>"}` — nothing else.

## `session/update` — the full kind vocabulary

Every `sessionUpdate` literal in `app.js`:

`agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk`, `tool_call`,
`tool_call_update`, `plan`, `usage_update`, `available_commands_update`, `current_mode_update`,
`config_option_update`, `session_info_update`.

Shapes, from the emitters:

- **`agent_message_chunk`** — `{sessionUpdate:"agent_message_chunk", content:{type:"text", text}}`.
  Assistant text arrives as deltas; the non-delta `assistant.message` event maps to `null`.
- **`agent_thought_chunk`** — the same shape; this is the reasoning channel.
- **`tool_call`** — `{sessionUpdate:"tool_call", toolCallId, title, kind, status:"pending",
  rawInput, locations, content, _meta}`.
- **`tool_call_update`** — `{sessionUpdate:"tool_call_update", toolCallId,
  status:"completed"|"failed", content, rawOutput, _meta}`. A partial result emits the same kind
  carrying only `content`.
- **`plan`** — `{sessionUpdate:"plan", entries:[{content, priority:"medium", status}]}` with
  `status` one of `pending` / `in_progress` / `completed`. **Copilot has a native plan channel**;
  unlike Gemini it does not require reading a `write_todos` tool call. The `update_todo` tool's
  result is also folded into the same `plan` update.
- **`usage_update`** — `{sessionUpdate:"usage_update", used:<currentTokens>, size:<tokenLimit>}`.
  This is a **context-window gauge, not per-turn token counts**, and it is emitted only when
  `tokenLimit > 0`.

## Token usage — on the `session/prompt` result

The source spec left this an open question ("`usage_update`, the prompt result's `_meta`, or
none"). It is **none of those three**: `prompt()` answers
`{stopReason, usage: <tokens>}` with `usage` a **top-level** field, built from the session's
counters as

```js
{ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
  thoughtTokens?: reasoningTokens, cachedReadTokens?, cachedWriteTokens? }
```

and omitted entirely when either `inputTokens` or `outputTokens` is undefined. So `usage.updated`
needs **no** documented substitute — the dialect's `usageFromPromptResult` reads `result.usage`.

## `stopReason`

`end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled` — the standard ACP set. A
prompt that is aborted answers `{stopReason:"cancelled", usage:…}` rather than erroring.

## Sub-agent attribution

Tool-call frames carry `_meta` keyed by the literal **`"github.com/copilot"`**, and its only
member is `{agentId}` — present exactly when the tool call belongs to a delegated agent. That is
a real wire parent attribution, so the parity matrix's nesting row needs no substitute: the
dialect derives `parentItemId` from the `task` tool item that opened the same `agentId`.

## Copilot's own tool names

From the tool-kind mapper in `app.js`, with the ACP `kind` it assigns:

| Copilot tool | ACP `kind` |
|---|---|
| `bash`, `local_shell`, `stop_bash` | `execute` |
| `view`, `glob`, `grep`, `read_agent`, `list_agents`, `read_bash` | `read` |
| `edit`, `create`, `str_replace_editor`, `str_replace`, `write_bash` | `edit` |
| `delete` | `delete` |
| `move` | `move` |
| `web_search`, `github-mcp-server-web_search`, `search_code_subagent` | `search` |
| `web_fetch`, `fetch_copilot_cli_documentation` | `fetch` |
| `update_todo`, `report_progress` | `think` |
| `task`, `skill` | `other` |

Unknown names fall back to substring matching (`bash`/`shell` → `execute`) and to the
`github-mcp-server-` prefix. ACP carries a `title` and a `kind` but **no tool name**, so the
dialect's `toolNameOf` recovers it from `_meta`/`rawInput`/`title` — see
`packages/cezar/src/core/copilot-ui-mapper.ts`.

## Session modes

`interactive`, `plan` and `autopilot`, exposed as the agentclientprotocol.com session-mode URIs
`…/session-modes#agent`, `#plan` and an autopilot variant. cezar ships `auto` only (spec Q15) and
does not call `session/set_mode`.
