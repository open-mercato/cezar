# Fix skill frontmatter and atomic workspace writes

Goal: preserve compatible skill frontmatter values while accepting valid YAML scalars, and make workspace JSON writes flush and clean up their staging files safely.

Scope: `packages/cezar/src/skills.ts`, `packages/cezar/src/skills.test.ts`, `packages/cezar/src/workspace/config.ts`, and `packages/cezar/src/workspace/config.test.ts`.

Non-goals: changing frontmatter keys or discovery order; adding dependencies; changing slugification, structured JSON parsing, or binary detection; promising directory-level power-loss durability.

Risks: YAML coercion can alter legacy scalar spelling, so unsupported values and numeric/boolean/null `name`/`description` values must retain the legacy parser result. Atomic cleanup must preserve the original write/rename error.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Reproduce and plan

- [x] 1.1 Confirm issue #1218 and overlap PRs #1184/#1185
- [x] 1.2 Record parser and atomic-write regressions

### Phase 2: Implement compatibility-preserving fixes

- [x] 2.1 Add parser and atomic-write regression tests — 39fa44d5 + a1bffb0d follow-up
- [x] 2.2 Implement YAML per-key fallback and durable temp-file lifecycle — 5935762b + follow-up

### Phase 3: Validate and publish

- [x] 3.1 Run targeted tests and prove regressions fail without the fix — targeted 58/58; reverted-source proof 2 failures
- [x] 3.2 Run the configured full validation gate — clean env: typecheck, 8589 Vitest, 36 unit, build, 17 package E2E
- [x] 3.3 Inline review completed; PR finalized and ready — independent final review remains for parent

## Evidence

- Final head: `adb2ce31` (code/test changes through `066bfcd3`).
- PR: https://github.com/open-mercato/cezar/pull/1231
- Clean gate: typecheck, 8,589 Vitest tests, 36 unit tests, build, and 17 package E2E tests passed. Final targeted parser/config tests: 58/58.
