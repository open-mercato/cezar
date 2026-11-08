# Project slash commands in `/` autocomplete and the Skills list

Source doc: .ai/specs/2026-11-05-project-slash-commands.md

## Goal
Discover repo-local agent commands (`.claude/commands`, `.codex/prompts`, `.cursor/commands`, `.opencode/command(s)`, `.github/prompts/*.prompt.md`) as project skills (`kind: 'command'`), expand `$ARGUMENTS` on every launch path, pick a per-backend variant, and keep commands out of worktree provisioning.

## Scope / Non-goals
Project dirs only (no global `~/.claude/commands`); no new `source`, route or env var.

## Implementation Plan
1. Contract: optional `kind`, `variants` on `skillSchema`.
2. `skills.ts` discovery of command dirs + variants.
3. `run.ts`: `$ARGUMENTS` helper, runner-aware pick, `skillSystemPrompt` hint, provisioning skip.
4. Web hint copy + drift guard test; docs page.
5. Full validation gate.

## Risks
Claude-native commands are now expanded by cezar (spec Q4).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Discovery
- [ ] 1.1 Contract fields `kind` and `variants`
- [ ] 1.2 Discover command dirs with variants

### Phase 2: Delivery
- [ ] 2.1 `$ARGUMENTS` expansion, runner-aware variant pick, no worktree hint
- [ ] 2.2 Skip command provisioning

### Phase 3: UI and docs
- [ ] 3.1 Hint copy, drift guard, docs page
