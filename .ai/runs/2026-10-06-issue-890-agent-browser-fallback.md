# Fix issue #890: rootless agent-browser dependency fallback

## Goal

Make the committed `agent-browser` provider descriptor recognize a working Chrome
launch in an unprivileged Linux environment when the provider's staged dependency
libraries are already present, while keeping sandbox disabling narrowly scoped to
the detected rootless/container case. The provider must report the working
invocation to the generated QA environment.

## Scope

- `.ai/browsers/agent-browser.md` — the `ensure-installed` POSIX operation and its
  provider-facing output.
- `.ai/scripts/test-env-up.sh` and `.ai/scripts/e2e.sh` — the generated provider
  bootstrap and its environment propagation into real browser processes.
- New provider-specific validation fixtures/docs to exercise the failure path,
  staged-library fallback, and environment propagation.
- This run plan.

Non-goals: changing application code, adding mandatory configuration, downloading
packages as a new provisioning mechanism, or modifying unrelated descriptors/plans.

## Implementation Plan

### Phase 1: preflight and plan

- [x] 1.1 Recheck issue/PR claims, current main, and the descriptor's failure path. — e615153d
- [x] 1.2 Commit this execution plan and open the draft PR. — e615153d (PR #1294)

### Phase 2: descriptor fix and focused validation

- [x] 2.1 Implement the minimal staged-library fallback and justified rootless
  sandbox/environment propagation in the descriptor. — a78cb6ba
- [x] 2.2 Add isolated provider fixtures/docs proving failure, fallback success, and
  exported environment values; prove the old descriptor fails where practical. — a78cb6ba, 780dafbe
- [x] 2.3 Run the descriptor harness and relevant documentation checks, then inspect
  the complete diff for scope creep. — a8a657b3
- [x] 2.4 Wire the generated QA bootstrap to persist and export the effective browser
  environment, including user-namespace detection and a real launch probe when
  `doctor` cannot honor browser args. — e1c11878, d5f0caee, b43243da

### Phase 3: completion

- [x] 3.1 Run the configured validation gate and any available real-browser smoke.
  — gate attempted; blocked by unrelated baseline failures; staged-library launch attempted but Chrome failed on task TMP SingletonSocket path
- [x] 3.2 Run the authoritative PR review/autofix workflow, update the PR evidence,
  and finalize the PR without merging main. — independent review complete; browser/CI remain explicit blockers

## Risks

- Browser provisioning runs in shell snippets embedded in Markdown, so quoting and
  environment propagation need fixture coverage rather than TypeScript tests.
- The current container may not have a real browser or writable staged libraries;
  those checks will be reported as unavailable instead of presented as success.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: preflight and plan

- [x] 1.1 Recheck issue/PR claims, current main, and the descriptor's failure path. — e615153d
- [x] 1.2 Commit this execution plan and open the draft PR. — e615153d (PR #1294)

### Phase 2: descriptor fix and focused validation

- [x] 2.1 Implement the minimal staged-library fallback and justified rootless sandbox/environment propagation in the descriptor. — a78cb6ba
- [x] 2.2 Add isolated provider fixtures/docs proving failure, fallback success, and exported environment values; prove the old descriptor fails where practical. — a78cb6ba, 780dafbe
- [x] 2.3 Run the descriptor harness and relevant documentation checks, then inspect the complete diff for scope creep. — a8a657b3
- [x] 2.4 Wire the generated QA bootstrap to persist and export the effective browser environment, including user-namespace detection and a real launch probe when `doctor` cannot honor browser args. — e1c11878, d5f0caee, b43243da

### Phase 3: completion

- [x] 3.1 Run the configured validation gate and any available real-browser smoke. — gate attempted; blocked by unrelated baseline failures; real binary unavailable
- [ ] 3.2 Run the authoritative PR review/autofix workflow, update the PR evidence, and finalize the PR without merging main.
