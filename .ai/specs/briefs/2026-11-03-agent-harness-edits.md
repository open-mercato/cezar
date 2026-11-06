# Let cezar's Claude tasks edit the project's agent harness (skills, commands, agents) behind a per-user project toggle

- Date: 2026-11-03
- Category: feature
- Priority signal: medium — using cezar to improve a project's own harness is blocked today; the only workaround is an interactive `claude --resume` takeover.
- Risk signal: high — changes the Claude runner's permission mode and lets agents write files that shape later agent behavior.
- Routing: Next: om-auto-write-spec "Per-user project toggle letting cezar's Claude tasks edit .claude/skills, commands, agents and CLAUDE.md — brief: .ai/specs/briefs/2026-11-03-agent-harness-edits.md"

## Problem

A Claude task in cezar cannot write `.claude/skills/**`, `.claude/commands/**`, `.claude/agents/**` or `.claude/CLAUDE.md`. cezar runs `claude --print … --permission-mode dontAsk --allowedTools …` (`packages/cezar/src/core/claude-cli-runner.ts`, `buildClaudeArgs`). Claude Code treats `.claude/` and `.mcp.json` as protected paths that always prompt, and under `dontAsk` the prompt becomes a denial. Evidence: #1248 (SDRC project, four denied Edits on `.claude/skills/pnl-update/SKILL.md`; maintainer reproduced on `main`), closed by #1256 which only explains the denial; it recurred in a 2026-11-02 run. The goal is to use cezar to improve a project's own harness (skills, agents, commands, CLAUDE.md) through ordinary reviewed tasks.

## Agreed direction

One toggle per project, per user, off by default, flipped by hand in the cockpit's project settings page. With it on, Claude runs for that project switch from `--permission-mode dontAsk` to `--permission-mode default` plus `--permission-prompt-tool` pointing at a small approver that cezar ships (stdio MCP server added to the `--mcp-config` file cezar already writes for private MCP servers). The approver allows `Edit`/`Write`/`MultiEdit` only when the resolved target (symlinks and `..` followed) lies under the run worktree's `.claude/skills/`, `.claude/commands/`, `.claude/agents/`, or is `.claude/CLAUDE.md`. It denies everything else. The path decision is a pure function so it can later move onto #1027's `--permission-prompt-tool stdio` channel unchanged.

`.claude/settings*.json` and `.mcp.json` stay locked: they hold permission rules, hooks (shell run by the harness without the model), `env`, `apiKeyHelper` and MCP server launch commands, and a change there takes effect on the task's next turn, before the review gate. The agent proposes such changes in its summary and a human applies them.

The spec states openly that skill/command frontmatter can declare `allowed-tools` and `hooks`, skill bodies can run shell via `` !`cmd` ``, and agent frontmatter can declare `tools`, `permissionMode`, `hooks`, `mcpServers` (Claude Code docs, fetched 2026-11-03). So the toggle is a trust decision, presented as such in the UI, and the review gate flags diffs that add or change those frontmatter keys. The run record notes that the toggle was on. It is a power-user switch, not a default-path fix.

Threat-model note for the spec, without a bypass recipe: cezar's zero-config allowlist includes unrestricted `Bash`, and Claude Code's protected-path check only covers paths visible in the command text (documented: "a Bash command you approve can still write anywhere your user account can"; OS-level enforcement needs the Bash sandbox). So the toggle does not widen what a hostile or prompt-injected agent can already do; it lets an honest agent make the change openly through Edit, visible in the tool timeline and the diff.

Rejected:
- `--permission-mode bypassPermissions`: works, but also writes `.claude/settings.json` (verified), i.e. hooks and permissions.
- `--allowedTools Edit(.claude/skills/**)` (several spellings), `--add-dir`, a `PreToolUse` hook returning `allow`: all still denied under `dontAsk` (verified on Claude Code 2.1.317; the hook ran).
- Agents write to unprotected `.ai/skills/**` and cezar copies into `.claude/` at review: no MCP approver needed, but it does not cover agents, commands or `.claude/CLAUDE.md`.
- Build nothing / wait for #1027: its zero-config default stays `dontAsk`; `Guarded` means a click per write; `Auto` unlocks settings and hooks too.

## Resolved unknowns

| Question | Answer (from the conversation) |
|----------|--------------------------------|
| Where is the toggle stored? | Per user, never in the repo: the project's entry in the `~/.cezar` registry (not `.ai/cezar/config.json`, which is committable — a cloned repo must never arrive with it on). |
| Where is it set? | Manually in the cockpit's project settings page; applies from the next agent turn (each turn/Continue respawns `claude`). |
| Which paths become writable? | `.claude/skills/**`, `.claude/commands/**`, `.claude/agents/**`, `.claude/CLAUDE.md`. Root `CLAUDE.md`/`AGENTS.md` are already writable (verified). |
| `.claude/settings*.json` and `.mcp.json`? | Stay locked; the agent proposes the change in its summary, a human applies it. |
| Behaviour for every other tool call once the mode is `default`? | Fail closed: identical to today's `dontAsk` (deny anything not pre-allowed); approver crash, timeout or malformed reply = deny. |
| `CEZ_APPROVAL_GATE=1`? | Unchanged; the toggle is not applied on that path. |
| Private MCP servers (`claudeMcpAllowRules`)? | Keep their existing allow rules; the approver config is merged into the same `--mcp-config` file. |
| Other backends? | Claude only; Codex/OpenCode/Cursor do not have the protected-path denial. |
| Interaction with #1027 permission presets? | Under its restrictive presets the toggle adds an auto-allow for the same paths; under `Auto` it is moot. The pure path function is shared. |
| Mechanism durability? | A canary test pins that Claude Code consults the prompt tool for protected-path writes; if a future version stops, the toggle degrades to today's denial, never to an open write. |

## Non-goals

- Making `.claude/settings*.json`, `.mcp.json` or hooks writable.
- Backends other than Claude Code.
- A cockpit Allow/Deny prompt UI (that is #475 / #1027).
- Cross-project harness work: a task in project X editing project Y, or reading Y's past sessions. Follow-up, linked to #1303 (`cez task create --project`).
- Follow-up idea, not in scope: an opt-in Claude Code Bash sandbox for cezar runs, denying OS-level writes to `.claude/settings*.json` and `.mcp.json`.

## Affected areas (if known)

- `packages/cezar/src/core/claude-cli-runner.ts` (`buildClaudeArgs`, MCP config writing)
- A new approver script shipped in the `@open-mercato/cezar` package
- The `~/.cezar` project registry (`packages/cezar/src/workspace/projects.ts`, `config.ts`) and its contract schema in `packages/contract`
- Project settings page in `packages/web/src/routes/settings/`
- The run record (`packages/cezar/src/runs/store.ts`) for the "toggle was on" note
- Review gate diff surface (frontmatter key flag)
- Docs: feature page, `BACKWARD_COMPATIBILITY.md` for the new registry field
