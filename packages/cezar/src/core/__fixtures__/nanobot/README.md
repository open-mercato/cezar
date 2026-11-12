# Nanobot native bridge fixture

Schema-derived, not a live inference capture. Source: installed `nanobot-ai 0.4.1`
Python package (2026-11-12), `AgentLoop.process_direct`, native `on_progress`
`tool_events` start/end/error records, `AgentHook.after_run` usage, and
`agent/hooks/file_edit_activity.py` and `utils/file_edit_events.py` (real unified diffs),
`agent/tools/filesystem.py` (`edit_file` path/old_text/new_text) and
`agent/tools/subagent.py` (`subagent`, action=create). The checked-in adapter is
`packages/cezar/scripts/nanobot-cezar.py`; this fixture is its output protocol,
not Claude JSONL or a fabricated Nanobot CLI mode.

Native progress provides complete text/reasoning and tool lifecycle snapshots;
we do not invent token streaming, costs, approvals, or provider-response model
identity. Session model metadata is the admitted runtime configuration.

The native direct-run tool/progress API has no todo-list or plan-update schema.
Its separate `create_goal`/`update_goal` tools describe an objective/status rather
than a list of steps; converting those to `plan.updated` would invent a plan.
The parity test records that wire gap. Subagent tool creation is a task item;
child events are not streamed by this direct callback with parent attribution,
so there is no nested child transcript.
