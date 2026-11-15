# Antigravity CLI — golden fixtures

## Provenance

Every `.ndjson` here is a **live capture** of the Google Antigravity CLI's stdout — `agy` 1.4.0
(WinGet `Google.AntigravityCLI`), captured 2026-10-17 on a signed-in Google AI Pro account. None
of the frames is synthetic. Redaction only: the capture directory became `/repo`, the user's home
became `/home/user`, and the `init` frame's ~60-name `tools` list was trimmed to the tools these
transcripts use. Conversation ids, step indexes, timings and token counts are verbatim.

| Fixture | Command (`--output-format stream-json --dangerously-skip-permissions` on all) | What it pins |
| --- | --- | --- |
| `text-turn` | `agy -p "Reply with exactly: PONG"` | `init` without `model`, streamed `text_delta`, per-step `usage` |
| `tools-turn` | `agy -p "Read a.txt, then create b.txt …, then run git status …" --model gemini-3.8-flash-low` | `view_file` / `write_to_file` / `run_command` lifecycles, TitleCase `parameters`, `output` |
| `tool-error` | `agy -p "Read the file missing-file-xyz.txt …" --model gemini-3.8-flash-low` | `state: "ERROR"` with `tool_info.error.{type,message}` inside a SUCCESS turn |
| `subagent-turn` | `agy -p "… manage_task … replace_file_content … invoke_subagent …" --model gemini-3.8-flash-high` | `step_type: "subagent"` with `subagent_info.subagents[]`, `system_message` steps, `cache_read_tokens` |
| `resumed-turn` | `agy -p "…" --conversation <tools-turn id>` | step indexes continue the old conversation; `result.usage` / `num_turns` are conversation-cumulative |
| `two-turn-session` | `agy --input-format stream-json … -p=` fed two `{"event":"user","message":{"content":…}}` lines | one process, two turns, one `result` per turn, cumulative `result.usage` |
| `bad-model` | `agy -p "x" --model bogus-model` | ERROR `result` with an empty `conversation_id` and no `init`; the process exits 1 |

## What the wire does not carry

These are the parity-matrix exceptions in `ui-parity.test.ts`, each observed rather than assumed:

- **Plan** — no plan frame exists; `manage_task` (subagent-turn, step 4) manages *background*
  tasks (`"No background tasks are currently running."`), not a todo list.
- **Reasoning text** — `agent_response` steps report `usage.thinking_tokens` (3139 in
  subagent-turn) but never the thinking itself.
- **Structured diffs** — `write_to_file` and `replace_file_content` carry only `TargetFile`;
  there is no old/new text to build a diff from. The Changes tab still shows the worktree diff.
- **Sub-agent nesting** — a subagent runs in its own conversation (`conversation_id`,
  `log_uri`); none of its steps appear on the parent's stdout. Its cell is the task item.

One launch-side exception, outside the wire: **private MCP** (`.ai/cezar/mcp.local.json`) does
not reach agy. agy 1.4.3 has no launch-time MCP flag or config override — only `agy mcp add`,
which rewrites the user's persistent config — so `antigravity` stays out of
`PRIVATE_MCP_RUNNERS` and its runs get the standard note naming the servers not attached.

## Layout and replay

Each `.expected.json` is the exact `UiEvent[]` `antigravity-ui-mapper.ts` produces for its
`.ndjson`, replayed line by line exactly as `AntigravityRunner` feeds it (no seeding — agy's own
`user_input` step opens each turn). `antigravity-ui-mapper.test.ts` asserts it with
`toStrictEqual` after a JSON round-trip and checks the mapper never mutates its input state;
`ui-parity.test.ts` reads the same files.

To refresh after a CLI change: re-run the commands above in a scratch git repo, redact as
described, regenerate the expectations, and review the diff of every `.expected.json` by hand.
