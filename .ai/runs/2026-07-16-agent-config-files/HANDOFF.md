# Handoff — Agent config files (#404) + per-agent regrouping (PR #418)

**Run folder:** `.ai/runs/2026-07-16-agent-config-files/`
**Branch:** `feat/agent-config-files` (base `main`) — PR #418
**Plan:** `PLAN.md` — the `## Tasks` table is the authoritative status source.

## State

All Steps through 6.5 are done (checkpoint-4 green, full gate green). Phase 6 reworked the
Settings surface per the owner's PR direction: ONE `agent-config` section, agent selector
first, per-agent pane (Settings / MCP / Memory) driven by the descriptor table in
`web/app/src/routes/settings/agent-descriptors.ts` (spec
`.ai/specs/2026-07-17-agent-config-by-agent.md`). The `mcp` section is retired; Claude's
read-only user-scope MCP block lives in Claude's MCP subsection.

## The one thing to know

The API and `FileEditor` are untouched — the regrouping is pure client work over the flat
listing, keyed by `runners[]` inclusion (NOT `runners[0]`; shared `AGENTS.md` shows under
Codex AND OpenCode) with `holdsMcp` promoting files into the MCP group.

## Next concrete action

The branch still needs a merge with `origin/main` (known add/add conflicts in
`src/paths.ts`/`src/paths.test.ts`, content conflicts in `src/server/server.ts` and
`package-lock.json` — pre-existing divergence, orthogonal to Phase 6), then the
`om-auto-verify-pr-ui` browser pass and `om-auto-review-pr`.

## Blockers

None.
