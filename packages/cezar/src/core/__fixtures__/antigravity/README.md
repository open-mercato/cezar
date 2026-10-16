# Antigravity CLI — golden fixtures

## Provenance

`AGENT_PROTOCOL.md` §7 requires verified wire shapes and explicit sources.
These transcripts split the synthetic fixture inherited from commit `78cecc0b`.
**None of the frames in these four files has been captured live.**
Source: [Antigravity headless CLI documentation](https://antigravity.google/docs/cli/headless/),
consulted on **2026-10-14**. A documentation-derived shape is not a live capture.

| Fixture / frames | Source and limitation |
| --- | --- |
| All: `init` and `result` | Documentation's initialization and result envelope/usage fields; conversation ID `fixture`, paths and token counts are synthetic example values. |
| `text-turn`: both `step_update` frames | Documentation's `agent_response`, `ACTIVE`/`DONE` and `text_delta`; text and indexes are illustrative. |
| `tools-turn`: both `step_update` frames | Documentation's tool lifecycle and `tool_info`; `run_command`, TitleCase parameters and output are inherited offline examples, awaiting live verification. |
| `tool-error`: `step_update` | Inherited synthetic `ERROR` state with `tool_info.error.message`, not independently verified by a live capture. The surrounding step/tool envelope is documentation-derived. |
| `subagent`: `step_update` | Documentation's `subagent_info.subagents` shape; `delegate`, reviewer role and child conversation ID are synthetic placeholders. No live subagent trace exists here. |

The old mapper comment claimed observations from agy 1.3.3 captures, but the
approved branch contains no auditable capture supporting that claim. This README
supersedes it rather than presenting the inherited examples as captured evidence.
In particular, `ERROR`, TitleCase parameter spelling and the delegation tool name
still require verification before an upstream contribution can be considered ready.

## Layout and replay

Each `.ndjson` contains raw stdout frames in order; its `.expected.json` contains
hand-maintained UI events separated from the previously reviewed combined expectation.
`antigravity-ui-mapper.test.ts` replays every scenario, checks immutable previous state,
and compares the JSON round-trip of all events with `toStrictEqual`.
`tool-error` exercises a failed tool inside a successful turn, not a fatal CLI result.

## Required live follow-up

On an authenticated machine, capture a text/tool turn and a missing-file tool error
with `agy -p ... --output-format stream-json --dangerously-skip-permissions`.
Review and redact personal paths/data before committing. Replace these examples and
record the CLI version, capture date and exact frame provenance. A subagent capture
is also needed to verify the documentation-derived delegation example.
The local tests use isolated Node scripts; they never invoke an authenticated `agy`.
