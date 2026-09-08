---
name: cez-fix
description: Implements the minimal change identified by root-cause analysis, adds regression coverage, performs focused validation, self-reviews the diff, and leaves delivery to the caller.
---

## Cezar external-conductor mode

When the caller supplies a Cezar wrapper/phase contract, it is authoritative:
Cezar owns sequencing, issue claims and tracker state, the final validation
gate, review reconciliation, staging, and delivery. Skip setup/claim/delivery
steps owned by that conductor. Execute the complete technical judgment and
implementation workflow below within the phase boundary; do not commit, push,
publish, or open/merge a pull request.


# Apply Fix

You are the implementation phase after read-only root-cause analysis. Implement the proposed minimal change, prove it with regression coverage and focused validation, and stop. The external conductor owns final validation, review reconciliation, staging, and delivery.

## Input and tools

The caller supplies the root-cause artifact and phase result contract. You may
read, search, edit, create tests, and run focused local commands in the current
worktree. Do not mutate trackers or run delivery operations.

## Workflow

0. **Project setup** — follow `references/agentic-setup.md`; use the repository and phase context supplied by the caller. Missing optional config degrades to discovery and never triggers another setup workflow.

1. **Read the analyzer's brief.** The analyzer's full output is included in your prompt, in a block marked:

   ```
   — PREVIOUS STEP (cez-root-cause) said —
   <analyzer brief here>
   ```

   Identify from that block: the file(s) to change, the approach, and the regression test to add. **Do not invent your own root cause.** If the brief is missing, empty, or contradicts the repo (e.g. names files that don't exist), end your own output with `Status: blocked` and a one-line reason — the chain stops cleanly, better than shipping a wrong fix. If the analyzer ended with `LOW_CONFIDENCE`, be extra careful — re-read the affected code yourself before editing.

2. **Make the minimal change.** Edit only the files the analyzer named (plus the test file). Do not refactor unrelated code. Do not broaden scope. Project-convention rules (apply to every fix):

   - Follow the project's data-access conventions in production code — when the surrounding code routes through a helper or wrapper, use it; do not bypass it.
   - Preserve public contracts unless the issue explicitly requires a contract change: exported APIs, HTTP routes and response shapes, event names, CLI flags, DB schema, config formats. If the project documents its own compatibility rules, honor them.
   - Respect the project's data-scoping and permission-check rules.

3. **Add regression tests (mandatory, autonomous).** Every fix MUST include test coverage. This is non-negotiable — never skip tests, never ask whether to add them.

   - Add or update a unit test that fails without your fix and passes with it
   - Add integration tests when the change touches risky flows (permission checks, data scoping, behavior that crosses component boundaries)
   - Tests must be self-contained and target the smallest meaningful scope

4. **Validation loop.** Iterate until clean. Per iteration:

   1. Run targeted unit tests for every changed package/area
   2. Run the typecheck/lint commands from `validation.commands`, scoped to what changed when the toolchain supports scoping
   3. If the project generates derived artifacts from the files you changed, run the relevant generator step
   4. Re-read the diff and remove any accidental scope creep

   Run the targeted validation needed to prove the change. When an external conductor owns the immutable full validation gate, do not duplicate that expensive gate; report the focused commands and leave the final gate to the conductor.

5. **Self-review.** Run the change through the `cez-code-review` skill checks plus the breaking-change review per `references/review-report.md`: no public contract broken silently (checked against `BACKWARD_COMPATIBILITY.md` when present), no API response fields removed, no data-scoping or permission-check rules weakened, fix minimal. If self-review finds new issues, fix them and re-run the validation loop (step 4).

6. **Report back (output contract).** End with a final plain-text message in this shape — the next step parses it:

   ```
   Status: ready
   Files changed:
   - <path/to/file-a.ts>
   - <path/to/file-b.ts>
   - <path/to/file-a.test.ts>

   Summary: <one paragraph — what changed and why it fixes the issue>

   Tests: <which tests/checks were added and that the full validation gate passed (or which commands were skipped and why)>

   Breaking changes: <"none" OR a short statement of the contract change and the migration/deprecation path>
   ```

   If you cannot complete the fix safely (blocker discovered, change unexpectedly broad, tests can't be made to pass), end with `Status: blocked` instead and explain what's wrong. Explain the blocker precisely for the conductor.

## Rules

- Tests are mandatory and added autonomously — never hand off without them.
- No commit, no push, no PR — leave that to `the delivery step`.
- Stay inside the worktree the engine prepared; do not create nested worktrees.
- Keep scope minimal; refactors belong in their own PR.
- Before declaring done, re-check every changed production file against the project's data-access and security conventions.
