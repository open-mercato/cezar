# Fail macOS redeploy on failed launchctl restart

Goal: make macOS + ngrok redeploy fail when either launchd agent cannot be restarted, and detect a successful kickstart that leaves the cockpit process unchanged.

Scope: `packages/cezar/src/server-install/platforms/macosx-ngrok.ts` and its focused tests. Do not alter Linux/shared redeploy behavior or add a new configuration requirement.

## Implementation Plan

### Phase 1: Regression and fix

- [x] 1.1 Add deterministic macOS redeploy tests for non-zero kickstart and unchanged cockpit process. — ff72fe99
- [x] 1.2 Throw `StepAborted` on failed kickstart and verify launchd process replacement when identity data is available. — ff72fe99

### Phase 2: Validation and handoff

- [x] 2.1 Run targeted tests, configured validation gate, and review the final diff. — 263e4ea8d4603dbc42304e732d71d62e1e0bb831
- [x] 2.2 Open and finalize the issue PR with evidence and review status. — 68bd97ba

## Risks

`launchctl print` output is platform-specific and may be unavailable in degraded environments; identity comparison will be best-effort, while the kickstart exit status remains a hard failure gate.

## Final verification

Independent review task `690e9ba5` approved `68bd97bab39ce6ff1300afc63826d7527b1490c2` with no actionable findings.

Focused macOS tests 15/15; typecheck, unit 36/36, build/check-pack and package 17/17 passed. CI passed. Two local full-suite environment failures reproduced on the base; native macOS manual exercise remains pending.

GitHub author self-approval is unavailable. QA sign-off remains a merge gate; ready status does not waive it.

## Progress

PR: #1149

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Regression and fix

- [x] 1.1 Add deterministic macOS redeploy tests for non-zero kickstart and unchanged cockpit process. — ff72fe99
- [x] 1.2 Throw `StepAborted` on failed kickstart and verify launchd process replacement when identity data is available. — ff72fe99

### Phase 2: Validation and handoff

- [x] 2.1 Run targeted tests, configured validation gate, and review the final diff. — 263e4ea8d4603dbc42304e732d71d62e1e0bb831
- [x] 2.2 Open and finalize the issue PR with evidence and review status. — 68bd97ba
