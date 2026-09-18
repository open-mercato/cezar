# Execution plan — pin the Continue tool-policy invariant end to end (#877)

- Date: 2026-09-16
- Slug: `bashallowlist-continue-regression`
- Branch: `fix/bashallowlist-continue-regression`
- Issue: #877 — "bashAllowlist is dropped on Continue turns — the allowlist expires after the opening turn (claude backend)"
- Engine: om-auto-create-pr (steps: 6, --loop: no)

## Goal

Close #877 by pinning, end to end, the invariant it asked for: a Continue turn's
`startSession` spec carries the SAME `allowedTools` and `bashAllowlist` as the opening
turn's spec on the same run.

## Background — the production fix already landed

The issue's text describes `runContinuation` hardcoding `allowedTools: DEFAULT_ALLOWED_TOOLS`
and omitting `bashAllowlist`. That is no longer true:

- `ae9b38b2` — `fix(runs): a resumed session keeps its step's tools instead of the default set (#928)`, merged 2026-08-30.
- `packages/cezar/src/workflows/run.ts:3620-3621` now reads
  `allowedTools: toolsStep?.allowedTools ?? DEFAULT_ALLOWED_TOOLS,` / `bashAllowlist: toolsStep?.bashAllowlist,`.
- The agent-step call site (`run.ts:4395-4396`) is unchanged.

The release gap the issue's comment flagged (2026-09-02: "in `main` but not in any published
release") is closed too. Verified against the published tarball, not the git tree:

```
npm pack @open-mercato/cezar@0.11.0        # npm `latest`
grep -c bashAllowlist package/dist/workflows/run.js   -> 4   (was 1 on 0.10.0)
dist/workflows/run.js:3236  allowedTools: toolsStep?.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
dist/workflows/run.js:3237  bashAllowlist: toolsStep?.bashAllowlist,
```

So there is no production behavior left to change, and this run must not invent one.

### The issue's open question, answered

> If Continue genuinely cannot see the originating step (it resumes from a run record), then
> the step's `allowedTools`/`bashAllowlist` should be persisted on the run record …

Continue does **not** hold the originating step object. `runContinuation` resolves it from the
run record's persisted `workflowDef` (`record.workflowDef.steps`), matching the owning step by
the `sessionId` recorded on it and falling back to the definition's last agent step. So the
policy IS persisted on the run record — as the whole `workflowDef`, rather than as separate
`allowedTools`/`bashAllowlist` fields alongside `systemPrompt`.

## Scope

`packages/cezar/src/workflows/continuation-tools.test.ts` — one added test case.

### What the existing coverage does and does not pin

`continuation-tools.test.ts` (6 cases, from #928) asserts that a continuation spec carries the
step's `allowedTools`/`bashAllowlist`. But every case **synthesizes** a terminal run record via
`store.createRun` / `store.updateRun` and then asserts the single captured continuation spec
against a module-level constant. No case drives a real run through `startRun`, and no case
compares two specs. The invariant the issue actually named —

> asserts the SECOND `startSession` spec carries the same allowlist as the first

— is therefore not pinned: a future change that altered how the FIRST spawn resolves the policy
(the `runAgentStep` call site), or that desynchronized the two call sites in the other
direction, would leave every existing case green.

## Non-goals

- Any change to production code. The fix is in `main` and in the published release.
- Anything outside `packages/cezar/src/workflows/`. In particular: automations, server-install,
  forge, web.
- Cross-backend parity (#288) and the docs posture (#430) — different issues, still open on
  their own terms.
- Widening `continuation-tools.test.ts`'s existing six cases; they stay exactly as they are.

## Risks

- **Low.** Test-only. The one real risk is a test that passes with or without the fix, which
  step 2.2 rules out explicitly by reverting the two production lines and requiring red.
- Sibling PRs #995 and a concurrent #955 task also touch `run.ts`; this diff touches no
  production file at all, so it cannot collide with them.

## Implementation Plan

### Phase 1: Verify the premise

- 1.1 Re-confirm on the freshly fetched `origin/main` that the continuation call site resolves
  the step's tool policy, and that published `0.11.0` carries it; record both in this plan.
- 1.2 Re-read `continuation-tools.test.ts` and state precisely which invariant is unpinned.

### Phase 2: Regression coverage

- 2.1 Add the end-to-end case: `startRun` a def whose agent step sets `bashAllowlist: ['git']`,
  let the opening spawn land, `continueRun`, and assert spec[1] equals spec[0] on both
  `bashAllowlist` and `allowedTools` — spec-to-spec, not against a constant.
- 2.2 Prove it fails without the fix: temporarily revert `run.ts:3620-3621` to the pre-#928
  shape, run the new case, require red, restore. (Per AGENTS.md; done by edit-and-restore
  rather than `git stash`, because the stash stack is shared across this repo's worktrees.)

### Phase 3: Validation and PR

- 3.1 Run the full `validation.commands` gate.
- 3.2 Finalize the PR: body says `Fixes #877`, states the resolution path, labels applied.

### Phase 4: Self-review follow-ups (om-auto-review-pr --autofix)

- 4.1 Apply the three non-blocking review findings (ambient backend, `AgentRunResult`, optional `onEvent`).
- 4.2 Re-prove red and re-run the full gate on the final code.

## Progress

PR: #1006

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Verify the premise

- [x] 1.1 Re-confirm the continuation call site and the published release — 9761ba63
- [x] 1.2 State the unpinned invariant in `continuation-tools.test.ts` — 9761ba63

### Phase 2: Regression coverage

- [x] 2.1 Add the end-to-end two-spec invariant case — fdf5f8c6
- [x] 2.2 Prove the new case fails without the fix — fdf5f8c6

### Phase 3: Validation and PR

- [x] 3.1 Run the full validation gate — 1e5474ca
- [x] 3.2 Finalize the PR body and labels — 1e5474ca

### Phase 4: Self-review follow-ups (om-auto-review-pr --autofix)

- [x] 4.1 Pin the backend, reuse `AgentRunResult`, match the optional `onEvent` — 3d75042c
- [x] 4.2 Re-prove red and re-run the full gate on the final code — 3d75042c
