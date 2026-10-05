# Agentic e2e as a cezar verification step

**Brief:** integrate TesterArmy's `e2e` into cezar's workflow engine, so an agentic
end-to-end run (and an independent QA exploration) can be the gate a task has to pass.
**Engine:** om-auto-create-pr (steps: 10, --loop: no)
**Branch:** `cez/83ff0795` — not the skill's default `feat/<slug>`. 38 of the 39 open PRs
in this repo use `cez/<id>` heads, and this run's work was already committed on the cezar
task branch of that name; re-pointing the PR at a second branch would diverge the task the
cockpit tracks from the branch the PR reviews. The slot is keyed on this plan's path.
**Plan is retroactive:** phases 1–3 landed in `00293687` before this plan was written, so
their Progress rows are checked against that SHA rather than committed ahead of the code.

## Goal

Make an agentic e2e run usable as a cezar check step — not by adding a test framework to
cezar, but by closing the one engine gap that made it unsafe, and documenting the chains
that already work.

## Scope

The research answered the design question first: **all three integration levels already
compose from existing cezar primitives.** `e2e explore` is itself an independent agent that
exits 1 on a functional defect, `e2e init` installs its skill into `.agents/skills/`, which
cezar's `SKILL_DIRS` already scans, and the failure-feedback loop is the existing `onFail`
retry with the check's output appended to the retried agent's prompt. So the code change is
small and specific:

- `onFail.retryOn` — exit codes that mean *the work is wrong*. Without it cezar's retry loop
  is binary: `e2e` exits 1 on a verdict but 2 on a config/credential error, 3 on an engine or
  model-provider failure and 4 internally, and each of those spent a full agent session, and
  its tokens, per `onFail.max` on a cause that is not in the worktree.
- The planner offers the repo's own end-to-end suite as a verification command.
- `docs/e2e-verification.md` carries levels 1–3 as working chains plus the worktree facts
  that actually bite.

**Non-goals:**

- No GUI editor for `retryOn` — the builder round-trips it, nothing more. A field that only
  a YAML author sets does not earn a form control until someone asks for it.
- No check-step `timeout` in cezar. It is a real gap (a hung app holds the task's parallel
  slot), but a separable one: e2e's own startup/test/exploration timeouts bound this case,
  and a general timeout belongs with its own tests and docs.
- No `cez init` scaffolding of an e2e workflow, and no built-in workflow — a built-in would
  appear in every project's catalog, including the ones with no e2e installed.
- cezar's own cockpit is not migrated to `e2e`; this is a product capability, not a change
  of cezar's test stack.
- No behavior fix for the unrelated merge-base test failure in
  `packages/web/src/routes/github/hand-to-agent-draft.test.ts` — only the one-line fixture
  unblock the validation gate needed to pass at all (see Risks).

## Approach

`onFail.retryOn` defaults to the old behavior in two ways, deliberately: absent **and**
empty both mean "any non-zero code retries", so neither an existing YAML file nor a GUI that
serializes "nothing selected" as `[]` can silently acquire a gate. `0` is rejected at load
time instead of ignored — a check that exits 0 passed and never reaches the loop, so listing
it is a misreading the loader should say out loud.

The field is mirrored in `packages/contract` (the parity test asserts both directions) and
written back by the cockpit's YAML serializer, because the builder has no editor for it: a
workflow loaded from a file and saved from the GUI would otherwise lose the gate silently —
the same class of bug as a `RUNNER_IDS` widening that bare array literals drop.

## Risks

- **A retryOn that is too narrow stalls a run** that the old behavior would have retried into
  green. Mitigated by the default (omitted = retry on anything) and by naming the exit code in
  the step error, the run error and a rail note, so the stall is self-explaining.
- **The docs name another project's CLI surface**, which can drift: `e2e` is pre-1.0 and says
  so. Every flag, exit code and path in `docs/e2e-verification.md` was taken from the shipped
  `node_modules/e2e/docs` of 0.17.0, and the page says which version it was written against
  only implicitly — a reader on a later minor should re-check the CLI reference.
- **A real e2e run was never executed here.** No browser can launch on this machine, so the
  chains are verified structurally (every YAML example parsed against the real
  `workflowFileSchema`, every shell snippet through `bash -n`) and not end-to-end.
- **One pre-existing red test** on the merge base: `hand-to-agent-draft.test.ts` expects
  `cursor` to be an unknown runner while `RUNNER_IDS` contains it (introduced by c6f1a061).
  Proved pre-existing by stashing this whole diff and re-running on the untouched tip. The
  validation gate cannot go green around it, and leaving it would also leave this PR's CI
  red for a cause no reviewer of this diff can act on, so it got the smallest possible
  unblock in its own commit: the fixture now names a runner id no build has, restoring the
  degradation the test is named for. No assertion and no production line changed. A reviewer
  who would rather see it on its own PR can drop that one commit without touching the rest.

## Progress

PR: #1265

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Establish the facts on both sides

- [x] 1.1 Identify what `e2e` actually is and read its shipped docs — CLI surface, exit codes, reports, explore/bug-bash — 00293687
- [x] 1.2 Map cezar's check-step mechanics against levels 1–3 and name the real gaps — 00293687

### Phase 2: The engine gate

- [x] 2.1 Add `onFail.retryOn` to the step schema and mirror it in the contract — 00293687
- [x] 2.2 Honor it in the run loop; `runCheckStep` reports the exit code — 00293687
- [x] 2.3 Round-trip it through the cockpit's YAML serializer and the step card — 00293687
- [x] 2.4 Tests: `retryableExit` + schema units, and a behavioral test proved red without the fix — 00293687

### Phase 3: Discovery and documentation

- [x] 3.1 Planner detects the repo's e2e suite as a verification command — 00293687
- [x] 3.2 `docs/e2e-verification.md` (levels 1–3, worktree facts) + README and reference links — 00293687

### Phase 4: Ship

- [x] 4.1 Full validation gate (`typecheck`, `test`, `test:unit`, `build`, `test:package`) — green; needed a one-line fixture unblock of a merge-base failure — 992a0e02
- [x] 4.2 PR body, label set, authoritative review pass, summary comment — review approved, one minor fixed as b2c5f550 — b2c5f550
