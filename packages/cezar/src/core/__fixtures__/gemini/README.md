# Gemini CLI over ACP — golden fixtures and the Step 2.1 verification record

Spec `.ai/specs/2026-09-19-runner-seam-native-backends.md`, Phase 2 Step 1 (#581).

Every `*.ndjson` here is a **real** `gemini --acp` transcript, captured on 2026-09-19 against
`@google/gemini-cli` **0.60.0** (docs: `docs/cli/acp-mode.md` bundled with the package; wire schema: the
ACP SDK bundled in the same package, `PROTOCOL_VERSION = 1`) by `capture-acp.mjs` in this directory, in a
throwaway git repo, with `GEMINI_CLI_TRUST_WORKSPACE=true` and a free-tier Gemini API key. Nothing was
hand-authored. The only edits are redactions: key values become `<REDACTED>`, and the capturing user's home
dir becomes `/home/user`.

File layout: line 1 is a `{"fixture": {…}}` header (source, CLI version, docs, command line, scenario, child
exit). Every other line is `{"dir":"out"|"in","frame":<JSON-RPC message>}`, in wire order: `out` is what
cezar (the ACP client) wrote to the agent's stdin, `in` is what the agent wrote to stdout. The mapper test
replays exactly those frames through `mapAcpFrame`, the same way the runner drives it.

To re-verify on a newer CLI:
`node capture-acp.mjs <out.ndjson> main|cancel|load|controls|newonly <git-dir> --model <flash id> --approval-mode yolo`
(`PROMPT1`, `PROMPT2`, `LOAD_SID`, `CANCEL_AFTER_MS` in the env). Then convert the transcript to this layout.

## What Step 2.1 verified (and where the spec's assumptions did not hold)

| Question | Finding on 0.60.0 | Fixture |
|---|---|---|
| `--acp` usable? | **Yes.** `initialize` → `protocolVersion 1`, `agentCapabilities.loadSession: true`, `promptCapabilities {image, audio, embeddedContext}: true`. The `-p` fallback (U6) is not needed. | all |
| `session/new` result | `sessionId`, `modes {availableModes: default/autoEdit/yolo/plan, currentModeId}`, `models {availableModels, currentModelId}`. | all |
| `setSessionMode` values | `default`, `autoEdit`, `yolo`, `plan` over `session/set_mode` (answers `{}`, and echoes an `agent_message_chunk` `[MODE_UPDATE] <id>`). | `session-controls` |
| Model change mid-thread | `session/set_model {modelId}` answers `{}`. `session/unstable_setSessionModel` is **Method not found** on the wire. | `session-controls` |
| Usage `_meta` shape | On the `session/prompt` result: `_meta.quota.token_count {input_tokens, output_tokens}` plus `model_usage[] {model, token_count}`. No standard `usage` field, and no `usage_update`. | `tool-lifecycle` |
| Tool frames | `tool_call {toolCallId, status:"in_progress", title, content, locations, kind}` then `tool_call_update {status:"completed"|"failed", …}`. **There is no `rawInput`.** The tool name is only the `toolCallId` prefix (`read_file__call_…`, `replace__…`, `run_shell_command__…`, `write_todos__…`, `invoke_agent__…`). | `tool-lifecycle` |
| Diffs | `tool_call_update.content[] {type:"diff", path, oldText, newText, _meta:{kind:"add"|"modify"|"delete"}}`. | `tool-lifecycle` |
| Failed tools | `status:"failed"` only when the tool throws (for example, reading a missing file), with the message as `content` text and **no title**. A shell command that exits non-zero is `completed`. | `write-todos-quota` |
| **Plan** | **No plan on the wire.** Gemini 0.60 never sends a `plan` update. `write_todos` is registered only for non-preview Gemini **2** models, and even there its frames carry only the title `Set N todo(s)` with empty `content`. The entries exist only in Gemini's own session recording (`~/.gemini/tmp/<project>/chats/session-*.jsonl`). Gemini 3 models (the default `auto` routing) have no plan tool at all, unless the experimental `tracker` tools are switched on. **Decision (#581): accepted as a documented wire gap** (`WIRE_GAPS` in `ui-parity.test.ts`); no side-reading of Gemini's files. | `write-todos-quota` |
| Subagents | `invoke_agent` tool, `kind:"think"`, title `Delegating to agent '<name>'`. The child's work is not attributed on the wire (the nesting-cell substitute: one `task` item). | `subagent` |
| Cancel | The `session/cancel` notification makes the pending prompt resolve `{stopReason:"cancelled"}`. The session answers the next prompt. | `cancel` |
| `session/load` | Works in a new process. The history is **replayed** as `session/update` frames (`user_message_chunk`, thoughts, `tool_call` with `status:"completed"`, messages), some before and some after the load result. The replay ends with `available_commands_update`, sent from a `setTimeout(0)` after the replay started. An unknown id answers `-32603` with details. | `load-replay`, `session-controls` |
| Permission requests | In the `default` mode, the agent sends `session/request_permission {options:[proceed_always/allow_always, proceed_once/allow_once, cancel/reject_once], toolCall{status:"pending"}}`. After the answer, only a `tool_call_update` follows: no `tool_call` frame for that id. | `permission` |
| Model errors | A JSON-RPC error on `session/prompt`: `{code:429, "You have exhausted your daily quota on this model."}`, `{code:400, …API_KEY_INVALID…}`. | `write-todos-quota`, `invalid-api-key` |
| Google sign-in only | `initialize` succeeds. `session/new` fails `{code:-32000, message:"This client is no longer supported for Gemini Code Assist for individuals. … Antigravity …"}`, and stderr carries `IneligibleTierError … UNSUPPORTED_CLIENT`. | `unsupported-client` |
| Vertex selector | `GOOGLE_GENAI_USE_VERTEXAI=true` (`getAuthTypeFromEnv`; `GOOGLE_GENAI_USE_GCA=true` selects Google login). | bundle source |
| Account isolation (Q14) | `GEMINI_CLI_HOME` did **not** isolate credentials on this host: a fresh `GEMINI_CLI_HOME` (and even a fresh `HOME`) still authenticated with the stored key. `PROFILE_ENV_VAR.gemini` stays `null`. | — |
| **Resume in the creation minute** (found by the real-CLI smoke, reproduced 2026-09-19) | A `session/load` in the same UTC minute the session was created **destroys it permanently**. The loading process starts a new recording for the id before it reads the history, and inside the creation minute that recording has the original's file name (`session-<ISO minute>-<id8>.jsonl`), so it resets `messages` in the original file. The load answers `-32603 … No previous sessions found for this project.`, and so does every later load. A load one minute later works. `gemini-sessions.ts` waits for the minute to roll over before resuming. | `load-same-minute` |
| Where `/auth` keeps an API key | In the OS keychain (`HybridTokenStorage`, service `gemini-cli-api-key`), invisible to cezar. So `security.auth.selectedType` in `settings.json` also counts as configured credentials (`gemini-credentials.ts`); an env-only rule would make the run gate refuse those users. | bundle source |

