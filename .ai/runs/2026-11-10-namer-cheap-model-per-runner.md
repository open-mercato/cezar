# Execution plan — cheap namer model per runner (#2012)

Issue: #2012

## Goal

Task naming and landing commit subjects never run on a runner's default (premium) model:
each runner gets a cheap model, and a runner without one makes no call at all.

## Scope

- `packages/cezar/src/runs/namer-model.ts` (new): `resolveNamerModel(runner, config)` —
  explicit `namerModels[runner]` → Claude `namerModel` → cheapest tier from the server's host
  model discovery (lowest listed effort) → static default (Codex mini at medium effort, Gemini
  flash-lite) → `null` (skip, heuristic title stays).
- `generateRunName` (`runs/auto-name.ts`), the scheduled-launch path in `workflows/run.ts`, and
  `generateCommitMessage` (`workflows/commit-message.ts`) all resolve through it.
- Additive config key `namerModels` (per runner) + config-bundle allowlist.
- Docs: `docs/reference.md`, live-titles feature page.

## Non-goals

- Issue suggestion 3 (tool-less / instruction-less Copilot namer flags) and 4 (bookkeeping
  usage attribution) — follow-ups. Copilot is skipped by default, which removes its cost.
- No new `CEZ_*` env var.

## Risks

- A static Codex default the account lacks: the call fails, the heuristic title stays (no cost).
- Runners now skipped by default lose LLM titles until `namerModels` names one.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Resolve a cheap namer model per runner

- [ ] 1.1 Add namer-model resolver, wire namer + commit message + scheduled path, regression tests
- [ ] 1.2 Document `namerModels`

### Phase 2: Validation

- [ ] 2.1 Full validation gate green
