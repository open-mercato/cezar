# GitHub Copilot CLI over ACP — golden fixtures

Spec `.ai/specs/2026-09-19-runner-seam-native-backends.md`, Phase 3 (#582).
Verification record: `.ai/runs/2026-09-27-copilot-cli-runner/copilot-acp-notes.md`.

## Provenance — read this before trusting a frame

`AGENT_PROTOCOL.md` §7 requires fixtures to be verified against **upstream wire shapes, never
your own assumptions**, and to cite the source they were derived from. Here is the honest
accounting, because these fixtures are **not** a live capture the way `__fixtures__/gemini/` is:

| Scenario | How the frames were obtained |
|---|---|
| `auth-required` | **Captured live** on 2026-09-27 by piping `initialize` + `session/new` into `copilot --acp`. Both frames are verbatim. |
| everything else | **Assembled from Copilot's own ACP bridge**, read out of the CLI's bundle. Each frame matches an emitter in that code; none is invented. |

The reason for the split is stated plainly: **no Copilot-entitled credential was available on the
verification host**, so `session/new` answers `-32000 "Authentication required"` and no streaming
frames could be recorded. Rather than hand-author from intuition — the failure mode PR #443 is the
worked example of — the frames were taken from the emitters themselves. That is the same offline
method the source spec used for codex ("strings in the codex 0.154.0 binary").

**The live gate is `copilot-acp-runner.smoke.test.ts`**, which is skipped without entitlement.
Anyone with a Copilot subscription should run it and replace these transcripts with a capture.

### Reading the CLI's own bridge

```bash
mkdir /tmp/copilot-probe && cd /tmp/copilot-probe && npm init -y && npm i @github/copilot@1.0.88
# node_modules/@github/copilot-linux-x64/copilot is a Node single-executable. Its ELF note
# NODE_SEA_BLOB holds sea-loader.js plus an embedded copilot.tgz; package/app.js inside that
# tarball is the CLI bundle, and its ACP bridge is what every frame below was read from.
```

## File layout

Line 1 is a `{"fixture": {…}}` header (source, CLI version, ACP docs, scenario, the verification
record it cites). Every other line is `{"dir":"out"|"in","frame":<JSON-RPC message>}` in wire
order — `out` is what cezar wrote to the agent's stdin, `in` is what the agent wrote to stdout.
`copilot-ui-mapper.test.ts` replays exactly those frames through `mapCopilotFrame`, the same way
the runner drives it, and asserts `toStrictEqual` against the `.expected.json`. The same expected
files feed `ui-parity.test.ts`.

## What each fixture covers

| Fixture | Parity rows it carries |
|---|---|
| `tool-lifecycle` | `plan.updated` with entries, tool `running` / `completed` / `failed`, reasoning items, structured diffs, `usage.updated` with raw counts, `turn.completed` with directional usage and a `stopReason` |
| `subagent` | sub-agent `task` items **and** nesting via `parentItemId` |
| `cancel` | `stopReason: cancelled`, and a tool the cancelled turn left running settled as failed rather than spinning |
| `auth-required` | the fatal `session.error` an unauthenticated host gets |
| `malformed` | the robustness contract: unknown kinds, null content, a non-array plan, a nameless tool call, a bad `_meta`, a non-object frame — no events, no throw |

## Where Copilot differs from the plain ACP reading

Three deviations are load-bearing, and all three are why `copilot-ui-mapper.ts` exists:

1. **A started tool is announced as `pending`.** Copilot emits `status: "pending"` from its own
   `tool.execution_start` and **never sends `in_progress`** (its `tool.execution_progress` event
   maps to `null` on the ACP bridge). The ACP meaning of `pending` is "not started", which is the
   opposite, so the dialect's `toolStatusOf` reads it as `running`. Without that, every Copilot
   tool card would sit queued until it finished and the parity row for `running` could not pass.
2. **Sub-agent work is attributed on the wire.** A delegated agent's tool calls carry
   `_meta["github.com/copilot"] = {agentId}`, and that `agentId` **is the delegating `task` call's
   `toolCallId`** — the CLI's own agent registry keys on exactly that. So `parentItemId` is real
   here, not a substitute, and Copilot takes the `claude`/`opencode` side of the nesting rule
   rather than the codex exemption.
3. **There is no tool name on the wire.** ACP carries a `title` (prose the CLI renders, e.g.
   "Editing calc.py") and a `kind`, and Copilot's `_meta` holds only `agentId`. `copilotToolName`
   therefore recovers only `skill` and `task` — each keyed on an argument the CLI's own code proves
   is that tool's — and reports the ACP kind for everything else instead of guessing from argument
   shapes that several tools share.

## Two things deliberately NOT mapped

- **`usage_update`.** Copilot's is `{sessionUpdate:"usage_update", used, size}` — a
  **context-window gauge**, not token counts. Per-turn usage rides on the `session/prompt` result
  instead, as a top-level `usage` in exactly the ACP shape the shared mapper already reads. Feeding
  `{used, size}` into `usage.updated` would report the window size as tokens spent. `TokenUsage`
  has a `contextWindow` field this could legitimately fill; wiring it needs a third hook on the
  shared mapper and is left as a follow-up rather than bundled into this PR.
- **`session_info_update`, `current_mode_update`, `config_option_update`,
  `available_commands_update`, `user_message_chunk`.** Nothing in the cockpit renders them yet;
  they are exercised in `malformed.ndjson` to pin that they produce no events rather than errors.
