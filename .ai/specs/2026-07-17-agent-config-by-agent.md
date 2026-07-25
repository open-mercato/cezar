# Agent config, grouped by agent — descriptor-driven Settings pane

Status: approved (owner direction on PR #418) · Date: 2026-07-17 · Amends: `.ai/specs/2026-07-16-agent-config-files.md` (#404)

## Why this amendment

PR #418 shipped the #404 spec as **two purpose-grouped Settings sections**: "Agent config"
(settings + memory, grouped by runner inside) and "MCP" (the `holdsMcp` files, grouped by
runner inside). The owner's review of the result: settings must be grouped **by the agent**,
not discarded by purpose across agents — an agent selector first, then everything that
belongs to that agent (MCP *and* other settings) in one per-agent pane. More agents are
coming (`pi` — #387), and future agents may carry settings shapes today's three don't have,
so the UI must be driven by a per-agent **descriptor**, not by hardcoded section layouts.

Nothing in #404's decisions is reversed: raw editor, never re-serialize, verbatim per-file
precedence, hosted-mode read-only, per-repo scope all stand. This amendment only changes the
*grouping axis* of the UI and introduces the abstraction that keeps it stable as agents are
added. The #404 research finding "MCP is not a file" (only Claude has a dedicated
`.mcp.json`; Codex/OpenCode keep servers inside their main config) actually *argues* for
this shape: MCP is a per-agent concern, so it belongs inside the agent's pane. Folding the
MCP section into the per-agent pane keeps MCP first-class — it becomes a named subsection of
every agent rather than a cross-agent list.

## Decision

1. **One Settings section** (`agent-config`, title "Agent config"). The separate `mcp`
   section is removed from the registry. Its route `/settings/mcp` never shipped in a
   release (it exists only on the unmerged #418 branch), so removal is not a compat break.
2. **Agent selector first.** The pane opens with a selector (segmented tabs) listing every
   agent from the descriptor table — Claude, Codex, OpenCode today — each with the existing
   "not installed" badge from `availableRunners(health.checks)`.
3. **Per-agent pane, descriptor-driven.** The selected agent's pane renders its subsections
   in order: **Settings**, **MCP**, **Memory & instructions** — each a file list feeding the
   existing `FileEditor` master/detail. Claude's MCP subsection also carries the read-only
   `userMcp` block (`~/.claude.json` server names). Per-agent notes (the Codex/OpenCode
   "editor-plus-commit" caveat, the per-agent "where MCP servers live" sentence) move into
   the descriptor.

## The `AgentDescriptor`

`web/app/src/routes/settings/agent-descriptors.ts` — one entry per agent, keyed by the same
`Runner` id used across the codebase (`RunnerId` in `src/core/agent-runner.ts`, the
`BACKEND_MODEL_MAP` precedent from #405: one table entry per agent, extension by design).

```ts
export interface AgentGroup {
  id: 'settings' | 'mcp' | 'memory'   // extensible: future per-agent subsections
  label: string
  note?: string                        // e.g. where this agent keeps MCP servers
  files: (f: AgentConfigFile) => boolean
}

export interface AgentDescriptor {
  id: Runner
  label: string
  note?: string                        // pane-level caveat (editor-plus-commit)
  groups: AgentGroup[]
}
```

Groups derive membership from the **flat, unchanged API listing**: a file belongs to agent
`a` when `f.runners.includes(a)` — fixing a real #418 bug where both sections grouped by
`f.runners[0]` only, so the shared `AGENTS.md` entry (runners `['codex','opencode']`)
rendered under Codex alone and OpenCode's pane lied by omission. Kind membership comes from
`f.kind` with `holdsMcp` promoting a file into the MCP group as well (Codex/OpenCode's main
config appears under both Settings and MCP — that is the honest answer, and each occurrence
opens the same editor).

Adding a future agent = one descriptor entry + its catalog file entries. No section layout
work, no new routes.

## What does NOT change

- **API shape**: none. After #521 these same handlers live in the project-route table, so the
  scoped client reaches `/api/p/:projectId/agent-config*` while legacy `/api/agent-config*`
  remains the boot-project alias. The flat `files[]` + `userMcp` payload and hosted-mode 409s
  are unchanged. The regrouping itself is pure client work.
- **`FileEditor`** and the editor behaviors (draft/dirty/409-conflict/400-format/save) —
  untouched.
- **Server catalog** (`src/agent-config/catalog.ts`) — untouched; `runners[]` stays the
  source of agent membership, `holdsMcp` stays the MCP marker.
- All #404 catalog invariants and their tests.

## Test plan

- `agent-descriptors.test.ts` — every runner has a descriptor; shared files appear under
  every runner in `runners[]`; `holdsMcp` files land in the MCP group; group order stable.
- `agent-config-section.test.tsx` — rewritten: selector renders every agent (+ not-installed
  badge); switching agents swaps the pane; MCP subsection shows the per-agent note and, for
  Claude, the read-only user-scope block (assertions absorbed from the deleted
  `mcp-section.test.tsx`); precedence + save/read-only behaviors re-anchored to the new DOM.
- `settings.test.tsx` — visible-section list drops `mcp` (7 → 6 entries).
- `routes.test.tsx` — `/settings/mcp` no longer routed.
