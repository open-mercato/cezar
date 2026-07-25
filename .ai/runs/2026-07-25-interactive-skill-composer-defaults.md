# Interactive skill composer defaults implementation

Source doc: .ai/specs/2026-07-25-interactive-skill-composer-defaults.md

## Goal

Honor additive `interactive: true` skill metadata in New Task so untouched Autonomous and Worktree choices default off while explicit choices and hard run-shape constraints remain authoritative.

## Scope

- Extend skill discovery and the skills API type with the optional metadata.
- Centralize composer run-mode resolution and wire interactive skill recommendations into New Task.
- Add parser, resolver, and route regression coverage plus accessible explanatory copy.

## Non-goals

- Workspace/environment-configurable defaults, quick-task cold selection, and generalized workflow Worktree controls belong to the companion spec.
- Runner, workflow YAML, and run persistence contracts remain unchanged.

## Risks

- Running in the current checkout widens edit exposure, so the UI must explain the recommendation and retain an explicit Worktree override.
- Resolver precedence must preserve plan-first, parallel-variant, and no-git constraints.

## Implementation Plan

### Phase 1: Metadata and contracts

1. Extend skill discovery with strict scalar `interactive: true` recognition and parser coverage.
2. Mirror the optional metadata through the web skills API contract.

### Phase 2: Composer behavior

3. Extract and test the pure run-mode resolver with hard constraints, explicit values, and interactive recommendations.
4. Wire selected skill metadata into New Task while preserving touched choices across source changes.
5. Add accessible explanatory copy and route regression coverage.

### Phase 3: Verification

6. Run the configured validation gate and browser smoke verification.

## Progress

PR: #665

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Metadata and contracts

- [x] 1.1 Extend skill discovery with strict scalar recognition and parser coverage — 048e5b9e
- [x] 1.2 Mirror metadata through the web skills API contract — 048e5b9e

### Phase 2: Composer behavior

- [x] 2.1 Extract and test the pure run-mode resolver — 048e5b9e
- [x] 2.2 Wire selected skill metadata into New Task — 048e5b9e
- [x] 2.3 Add accessible explanatory copy and route regression coverage — 048e5b9e

### Phase 3: Verification

- [x] 3.1 Run validation and browser smoke verification — validation passed; browser evidence follows on the PR
