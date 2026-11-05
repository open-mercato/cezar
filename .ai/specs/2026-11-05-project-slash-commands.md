# Project slash commands in the `/` autocomplete and the Skills list

> Slug: `project-slash-commands` · Status: proposed (design only, 2026-11-05)
> Extends: `src/skills.ts` discovery (#1082 unified skills), #380 (`/` autocomplete), #676/#811 (slash expansion).

## 📝 TLDR

Repo-local agent **commands** — what GitHub spec-kit (`speckit.specify`, `speckit.plan`, …) installs — never reach the composer's `/` autocomplete or the Skills list, because discovery only scans *skill* directories. This spec adds the per-agent command/prompt directories as project skill sources, so they list, autocomplete, and expand like any project skill. Implementation follows on its own PR.

## 📝 Problem Statement

- **Symptom.** After installing spec-kit in a repo, typing `/` in the composer does not offer `speckit.*`, and the Skills page does not list them.
- **Cause (from code; the spec-kit layout below is from its documented install, not re-verified in this environment).** `SKILL_DIRS` in `packages/cezar/src/skills.ts` covers `.claude/skills`, `.codex/skills`, `.cursor/skills`, `.opencode/skills`, `.agents/skills`, `.ai/skills`, `.ai/cezar/skills`. spec-kit writes *commands*, not skills: `.claude/commands/speckit.*.md`, `.codex/prompts/`, `.cursor/commands/`, `.opencode/command/`, `.github/prompts/*.prompt.md`. None are scanned, and `.specify/` holds templates/scripts, not entrypoints.
- **One chokepoint.** The `/` list (`composer.tsx` → `useSkills`), the Skills page, the ⌘K palette and the runner's slash expansion all read `discoverSkills`, so one discovery change fixes every surface.

## Proposed Solution

1. **Discovery.** Add project-relative command dirs to the scan, after the existing skill dirs (so a real skill of the same name wins): `.claude/commands`, `.codex/prompts`, `.cursor/commands`, `.opencode/command`, `.opencode/commands`, `.github/prompts`. Files are flat `*.md` (also `*.prompt.md`); the name is the filename minus `.md`/`.prompt.md` (frontmatter `name` still wins), so `speckit.specify.md` → `/speckit.specify`. `leadingSlashSkillName` already accepts dots.
2. **Provenance and project grouping.** Add `kind?: 'command'` to the `Skill` schema (optional, additive) and keep `source: 'agents'`. `isProjectSkill` keys on `source`, so commands still group and emphasize as project skills in the picker, palette and Skills page — the "visible as project-specific skills" requirement. `kind` is what lets the runner treat them differently (below).
3. **Expansion on every launch path.** A command body uses `$ARGUMENTS`. Substitution lives in one helper used by (a) a typed leading `/name` (`expandRegistrySlashSkillText`) and (b) skill-step launches that bypass the slash path — ⌘K / skill picker / bookmarklet / workflow `step.skill` with `prompt: '{{task}}'` (`run.ts` ~7729, `new-task-form.ts`), where `{{task}}` is substituted for `$ARGUMENTS`. With no placeholder in the body, the request is appended as `User request:`.
3a. **Worktree-correct references.** `skillSystemPrompt` skips the "skill files are installed at <dir>" hint for `kind: 'command'` — that hint points at the main checkout, while the task runs in its own worktree and commands reference repo-root files (`.specify/…`). Commands instead get a line that repo-relative paths resolve against the task's working directory.
3b. **Same-name commands across agents.** Within commands, collisions resolve by the run's selected backend first (`.claude/commands` for Claude, `.codex/prompts` for Codex, `.cursor/commands` for Cursor, `.opencode/command(s)` for OpenCode, `.github/prompts` for none), then scan order. The picker lists both when they differ, labelled by backend dir; `expandRegistrySlashSkillText` gains an optional runner argument.
4. **Scope.** Project dirs only; global `~/.claude/commands` is out of scope (see Q2).
5. **Docs/UI copy.** Update `SKILL_PROJECT_DIRS` hint text and the pinned `test/unit/skill-dirs.test.ts` drift guard; mention in the skills docs page.

## Resolved assumptions (autonomous defaults)

| # | Question | Default | Why |
|---|----------|---------|-----|
| Q1 | Which dirs count? | The six above, project-relative | Covers spec-kit's per-agent outputs; any dir not listed is a one-line addition |
| Q2 | Include global `~/.claude/commands`? | No | The ask is repo-local; global commands would flood the list. Easy follow-up |
| Q3 | New `source` value? | No new `source`; add optional `kind: 'command'` | Keeps project grouping, adds provenance for the worktree-path and `$ARGUMENTS` handling; optional field is additive |
| Q4 | Expand natively-handled commands for Claude too? | Yes, all backends | One behavior everywhere; loses command frontmatter such as `allowed-tools` (acceptable, noted) |
| Q5 | Name collisions | Skill beats command; command-vs-command resolves by selected backend, then scan order | Existing precedence is local-first; mixed-agent repos need backend-specific bodies reachable |

No `⚠ NEEDS HUMAN CONFIRMATION` items.

## Risks & Impact

- **Catalog growth.** Repos with many commands lengthen the list; mitigated by existing filtering and most-used ordering.
- **Backward compat.** Additive to discovery output; no route, schema or env change. A command that previously reached Claude natively as `/name` is now expanded by cezar (Q4) — visible only as the same instructions delivered inline.
- **Recursion.** Commands dirs are scanned flat (depth 0 for `.github/prompts`) to avoid pulling unrelated Markdown.

## Implementation Plan

0. Contract: optional `kind` on the `Skill` schema (`packages/contract`), parity tests.
1. `skills.ts`: add `COMMAND_DIRS` (flat scan, `.prompt.md` suffix strip) to `discoverSkills` and `discoverLocalSkills`; unit tests with a temp repo containing `.claude/commands/speckit.specify.md`.
2. `run.ts`: shared `$ARGUMENTS` helper used by `expandRegistrySlashSkillText` and the `step.skill` path; `skillSystemPrompt` omits the companion-dir hint for commands; runner-aware collision pick. Tests: placeholder, no-placeholder, empty-args, unknown pass-through, ⌘K/`step.skill` delivery, worktree hint absent, `review.md` in both `.claude/commands` and `.codex/prompts`.
3. Web: hint copy + `skill-dirs.test.ts` guard; component test that `/spec` lists `speckit.specify` as a project skill.
4. Docs page update; validation gate from `AGENTS.md`.

## Changelog

- 2026-11-05 — initial draft (autonomous).
- 2026-11-05 — addressed Codex review: all launch paths expand `$ARGUMENTS`, `kind: 'command'` provenance (worktree-correct hints), backend-aware same-name resolution.
