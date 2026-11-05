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
2. **Project grouping.** Tag them `source: 'agents'` (reuse; no contract change). `isProjectSkill` then already emphasizes and groups them as project skills in the picker, palette and Skills page — which is the "visible as project-specific skills" requirement.
3. **Expansion.** A command body uses `$ARGUMENTS`. `expandRegistrySlashSkillText` substitutes the text after the command name for `$ARGUMENTS` (appending a `User request:` block only when the body has no placeholder), then the usual path applies for every backend.
4. **Scope.** Project dirs only; global `~/.claude/commands` is out of scope (see Q2).
5. **Docs/UI copy.** Update `SKILL_PROJECT_DIRS` hint text and the pinned `test/unit/skill-dirs.test.ts` drift guard; mention in the skills docs page.

## Resolved assumptions (autonomous defaults)

| # | Question | Default | Why |
|---|----------|---------|-----|
| Q1 | Which dirs count? | The six above, project-relative | Covers spec-kit's per-agent outputs; any dir not listed is a one-line addition |
| Q2 | Include global `~/.claude/commands`? | No | The ask is repo-local; global commands would flood the list. Easy follow-up |
| Q3 | New `source` value? | No — reuse `agents` | Avoids a contract/BC change; revisit if a "Commands" badge is wanted |
| Q4 | Expand natively-handled commands for Claude too? | Yes, all backends | One behavior everywhere; loses command frontmatter such as `allowed-tools` (acceptable, noted) |
| Q5 | Name collision with a skill | Skill wins (existing first-seen order) | Precedence already local-first |

No `⚠ NEEDS HUMAN CONFIRMATION` items.

## Risks & Impact

- **Catalog growth.** Repos with many commands lengthen the list; mitigated by existing filtering and most-used ordering.
- **Backward compat.** Additive to discovery output; no route, schema or env change. A command that previously reached Claude natively as `/name` is now expanded by cezar (Q4) — visible only as the same instructions delivered inline.
- **Recursion.** Commands dirs are scanned flat (depth 0 for `.github/prompts`) to avoid pulling unrelated Markdown.

## Implementation Plan

1. `skills.ts`: add `COMMAND_DIRS` (flat scan, `.prompt.md` suffix strip) to `discoverSkills` and `discoverLocalSkills`; unit tests with a temp repo containing `.claude/commands/speckit.specify.md`.
2. `run.ts`: `$ARGUMENTS` substitution in `expandRegistrySlashSkillText`; tests for placeholder, no-placeholder, empty-args, unknown pass-through.
3. Web: hint copy + `skill-dirs.test.ts` guard; component test that `/spec` lists `speckit.specify` as a project skill.
4. Docs page update; validation gate from `AGENTS.md`.

## Changelog

- 2026-11-05 — initial draft (autonomous).
