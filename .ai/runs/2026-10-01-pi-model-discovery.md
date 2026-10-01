# Discover configured Pi models

Goal: replace Pi's stale picker presets with bounded discovery from the configured Pi CLI, while preserving a usable auto fallback when discovery is unavailable.

Scope: Pi model catalog adapter, workspace model discovery contract/route registration, web picker and query hook, focused tests and parity checks.

Non-goals: Pi runner/RPC mapping, task creation/bookmark workers, event history, and unrelated UI changes.

Implementation plan:

1. Add and test a Pi `--list-models` parser/probe with output and process bounds.
2. Register Pi in the shared catalog, contract, server route, and web discovery hook/picker.
3. Run the full validation gate, review the diff, and record QA evidence.

Risks: Pi CLI output is human-readable and may change; strict parsing and unavailable fallback prevent stale or invented IDs from reaching the picker.

## Progress

PR: #1211

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands.

### Phase 1: Pi discovery

- [x] 1.1 Add bounded Pi discovery adapter and parser — 40eca897
- [x] 1.2 Register Pi across contract, server and web picker — 40eca897

### Phase 2: Verification

- [x] 2.1 Run validation, review and QA evidence — 7e40fc8d

## Final verification

Independent reviewer approved code head `68e394d345f85a157d4f3896000a46cc793b7cfc`: https://github.com/open-mercato/cezar/pull/1211#issuecomment-5922976543.

Reviewer-found Pi fallback naming bug fixed in68e394d3, regression verified independently. Final review suite69/69 and typecheck passed. Browser fixture evidence: https://github.com/open-mercato/cezar/pull/1211#issuecomment-5922968109. Initial local aggregate test run was interrupted after failures; current-head CI remains the merge gate.

This final documentation update supersedes earlier pending review/browser statements without changing implementation. No fix branch was merged; applicable QA/CI still gate merge.
