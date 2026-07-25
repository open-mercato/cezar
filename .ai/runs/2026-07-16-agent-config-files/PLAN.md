# Execution plan — Agent config files in Settings

Source spec: `.ai/specs/2026-07-16-agent-config-files.md`
Tracker issue: #404
Branch: `feat/agent-config-files`
Base: `main`
Status: in-progress

## Tasks

> Authoritative status table. `Status` is one of `todo` or `done`. On landing a Step, flip `Status` to `done` and fill the `Commit` column with the short SHA. The first row whose `Status` is not `done` is the resume point for `om-auto-continue-pr-loop`. Step ids are immutable once a Step has a commit.

| Phase | Step | Title | Status | Commit |
|-------|------|-------|--------|--------|
| 1 | 1.1 | Config catalog (`src/agent-config/catalog.ts`) | done | aae2f81 |
| 1 | 1.2 | Home-path helpers (`src/paths.ts`) | done | 0a9a9a7 |
| 1 | 1.3 | Validators + JSONC stripper (`src/agent-config/validate.ts`, add `smol-toml`) | done | 1e65078 |
| 1 | 1.4 | Reader/writer (`src/agent-config/files.ts`) | done | 4d908ce |
| 1 | 1.5 | API routes + hosted-mode gate (`src/server/server.ts`) | done | a9fa0a1 |
| 2 | 2.1 | Add `toml` to highlighter `LANG_LOADERS` | done | 2e5334b |
| 2 | 2.2 | Code editor overlay (`web/app/src/components/code-editor.tsx`) | done | a9d748b |
| 3 | 3.1 | Registry: add `agent-config`, unhide `mcp`; fix section/route tests | done | c1933bc |
| 3 | 3.2 | API client types + queries | done | 3417a96 |
| 3 | 3.3 | `agent-config-section.tsx` | done | cd2d194 |
| 3 | 3.4 | `mcp-section.tsx` | done | 847fa22 |
| 4 | 4.1 | Worktree seeding of the personal layer (`src/workflows/run.ts`) | done | 3f61a24 |
| 5 | 5.1 | Docs: AGENTS.md, README, BACKWARD_COMPATIBILITY.md §2, CHANGELOG | done | a4686f3 |
| 5 | 5.2-review-fix | Gate home-dir file READS in hosted mode (disclosure fix) | done | 31c6f09 |
| 5 | 5.3-review-fix | Refuse empty-over-non-empty write; JSONC offset + tmp-name uniqueness | done | 3ed1ffb |
| 6 | 6.1 | Spec: group settings by agent, descriptor-driven (amends #404) | done | 4210235 |
| 6 | 6.2 | `agent-descriptors.ts` — per-agent descriptor table + tests | done | 8a4ff9e |
| 6 | 6.3 | Rework `agent-config-section.tsx`: agent selector + per-agent pane | done | ed62285 |
| 6 | 6.4 | Fold MCP into the per-agent pane; remove the `mcp` section | done | e1fedb2 |
| 6 | 6.5 | Docs: README + AGENTS.md reflect the per-agent grouping | done | 4ef4ddc |
| 6 | 6.6-review-fix | Sync package-lock.json (npm ci failed at head — QA finding) | done | 657f665 |
| 6 | 6.7-review-fix | De-duplicate the tracked-file effect sentence (QA cosmetic finding) | done | a4dd697 |
| 6 | 6.8-review-fix | Lock sync for npm 10 (CI): top-level @emnapi peer entries + oxide-wasm32-wasi bundled deps | done | 52a65ef |
| 6 | 6.9-review-fix | Remove unused `homeDir()` export from src/paths.ts (merge leftover) | done | 92b7985 |

> Phase 6 (2026-07-17): owner direction on PR #418 — settings grouped BY AGENT (selector
> first, then that agent's Settings/MCP/Memory together), driven by an agent-descriptor
> table so future agents (#387 `pi`) are one entry. Spec: `.ai/specs/2026-07-17-agent-config-by-agent.md`.

## Goal

Add a Settings surface that reads and writes the coding agents' own config files (Claude / Codex / OpenCode: `settings.json`, `.mcp.json`, `CLAUDE.md`, `AGENTS.md`, `config.toml`, `opencode.json`) raw, per scope, with syntax highlighting, showing each scope's file and the vendor's documented precedence. MCP is first-class. Global scope vs local shown together.

## Scope

Backend catalog + reader/writer + additive API routes; a highlighted overlay editor; two Settings sections (`agent-config`, `mcp`); worktree seeding of Claude's gitignored personal layer; docs.

## Non-goals

- No source-file → agent routing (not this feature).
- No project registry / multi-repo switching (separate spec).
- No editing of `~/.claude.json` (Claude's state file) — read-only listing only.
- No `.claude/rules/`, `.opencode/agents/`, managed/enterprise scopes (follow-ups).
- No teaching `AgentRunSpec` about MCP (follow-up).

## Risks

- **First write outside `.ai/cezar/`**, some of it code-executing (hooks, MCP `command`). Mitigated by the by-mode hosted gate (writes local-only). This is the #1 review-blocker property — Step 1.5.
- Vendor drift on paths/precedence strings — mitigated by the single-file catalog + `docsUrl` + dated research.
- One new runtime dep (`smol-toml`) — sanctioned by the spec.
- Editing repo-tracked files dirties the user's working tree.

## External References

None (`--skill-url` not passed). The spec's §Research cites primary vendor docs, verified 2026-07-16.

## Implementation Plan

Follows the spec's `## Implementation Plan` verbatim; see the spec for full per-step detail and the authoritative architecture, API contracts, and edge-case table.

**Phase 1 — Backend foundation** (1.1–1.5): pure catalog → paths → validators → reader/writer → API routes with the by-mode hosted gate.

**Phase 2 — Editor** (2.1–2.2): `toml` grammar + the overlay-on-textarea component.

**Phase 3 — Settings UI** (3.1–3.4): registry + tests, API client, the two sections.

**Phase 4 — Worktree seeding** (4.1): Claude personal layer into the run's worktree, `git check-ignore`-guarded, idempotent `info/exclude`.

**Phase 5 — Documentation** (5.1).
