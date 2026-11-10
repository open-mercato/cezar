# Automations from a prompt — implementation

Source doc: .ai/specs/2026-09-13-automations-from-prompt.md
Builds on: .ai/specs/2026-07-25-github-automations.md, .ai/specs/2026-09-10-dispatch.md

## Goal

Let a user create a GitHub automation from the New task window by describing it — either by picking
the built-in `create-cezar-automation` skill or by simply asking, with the agent recognising the
intent from its system prompt — without adding routes, state or flags.

## What was built

- `packages/cezar/src/automations/prompts.ts` — `AUTOMATIONS_PROMPT` (always-on part),
  `AUTOMATION_SCHEMA_REFERENCE` (the definition shape `cez automation schema` prints),
  `CREATE_AUTOMATION_SKILL_BODY` (the playbook).
- `packages/cezar/src/automations/automation-cli.ts` — `cez automation
  schema|create|update|check|list|show|enable|pause|delete`, a thin client over the existing
  automations routes; routed in `src/index.ts` ahead of the cockpit parser like `cez task`.
- `packages/cezar/src/automations/builtin-skill.ts` — `automationsReachable()` (flag AND
  `CEZ_API_URL`), the built-in `Skill` (`source: 'builtin'`, `interactive: true`) and
  `builtinSkills()`; `src/skills.ts` appends it last in `discoverSkills`. `Skill.source` gains
  `'builtin'` in `src/skills.ts` and `packages/contract/src/skills.ts` (additive).
- `packages/cezar/src/workflows/run.ts` — `ActiveRun.automationsPrompt`,
  `prepareAutomationsSession` at both session construction sites, composed after the dispatch part
  at both `startSession` calls.
- `packages/web/src/lib/prompt-templates.ts` — built-in `create-automation` template assigned to
  the skill; `AUTOMATIONS_TEMPLATE_IDS` gate in `availablePromptTemplates` (now reads
  `capabilities.automations` too; the three composers already pass the whole capabilities object).
- Docs: README (env row + CLI), `.env.example`, `BACKWARD_COMPATIBILITY.md` (CLI section), this spec.

## Tests

- `automations/automation-cli.test.ts` — request shape per command, `--enable` lifting, stdin,
  malformed input, refusal relay, update merge + revision echo, check polling, no-cockpit exit.
- `automations/prompts.test.ts` — the reference names every event and key of the storage schema
  and parses as a valid definition once comments are stripped; prompt and skill pin the CLI and
  the paused/preview rules.
- `skills.test.ts` — built-in absent with the flag off or no transport, present and `builtin`
  when reachable, shadowed by a repo skill of the same name.
- `workflows/system-prompt.test.ts` — the part rides only when on AND reachable.
- `web/src/lib/prompt-templates.test.ts` — the automations gate, independent of the dispatch gate.

## Validation

`npm run typecheck`, `npm test` (server + web), `npm run test:unit`, `npm run build` — see the PR.

## Not done

The redesigned Automations screens from the Claude Design export (the export was not available in
the session); the composer keeps its existing skill picker and template menu as the entry points.
