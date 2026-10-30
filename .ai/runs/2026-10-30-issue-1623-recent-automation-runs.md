# Issue 1623: inline recent automation runs

Source doc: .ai/specs/2026-10-30-issue-1623-recent-automation-runs.md (design PR #1833)
Engine: om-auto-create-pr (steps: 3, --loop: no)

## Goal
Show five recent launched tasks on a saved automation detail page, keeping Run now and View log reachable.

## Scope
editor.tsx and uniquely named recent-runs components/tests. No list/table, shared contracts, configuration, schedule fields or API edits. Cost follows existing visibility policy; launch checks without tasks remain in the log.

## Implementation Plan
### Phase 1: Detail recent runs
1.1 Add bounded, event-refreshed card and integrate saved editors.
1.2 Cover recent launches, filtering, metadata fallbacks, loading/errors/actions/events and editor integration; prove the editor regression red on old sources.
### Phase 2: Verification
2.1 Run configured gate, full review/autofix and real-browser QA; publish evidence and release claims with ready/review/unassigned PRs.

## Risks
Root baseline has Windows/load failures in unrelated tests. Record actual full-gate outcome without changing unrelated files. API log window is bounded at 100 records; no older history is fetched. Private QA environment avoids active production cockpit/state.

## Progress

PR: #1834

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Detail recent runs
- [x] 1.1 Add bounded, event-refreshed card and integrate saved editors. - 7cc967fe
- [x] 1.2 Cover recent launches, filtering, metadata fallbacks, loading/errors/actions/events and editor integration; prove the editor regression red on old sources. - 7cc967fe (28 targeted tests pass; regression failed on original editor)

### Phase 2: Verification
- [x] 2.1 Run configured gate, full review/autofix and real-browser QA; publish evidence and release claims with ready/review/unassigned PRs. - implementation 7cc967fe; evidence below, final metadata release on PR.


## Verification evidence
- Local gate (all five commands, in order): typecheck PASS; npm test with4workers/30s per-test timeout hit the1200s process bound, with106 failed files before timeout on this Windows host; test:unit FAIL due POSIX mkdir and /bin/sh ENOENT; build PASS including check:pack; test:package PASS. Full local gate is not green.
- Parent independently reproduced the broad Windows/load suite failures and the same two POSIX-dependent node:test failures on unchanged source. No unrelated tests or source were modified.
- Supported-platform CI at8034cd235b46cc83536bbe5ab14aa4057008a702: all three full Vitest shards plus Typecheck/build/unit/package verification PASS, cross-platform webhook legs PASS. CI run41102444486. Any subsequent documentation-only head still needs its own CI result recorded on the PR.
- Targeted editor/card suite:28/28 PASS. New multi-run editor regression fails with original editor.tsx (missing Recent runs heading), passes with the feature.
- Real-browser QA PASS: default/empty,6launches->5rows, shared live status, keyboard task navigation, View log, long title, light/dark,390px without overflow, delayed response,403/retry, cached refresh error. Evidence: https://github.com/open-mercato/cezar/pull/1834#issuecomment-6530204879 . No author qa-approved.
- Self-review found no actionable source/contract/security/coverage findings. Local platform gate limitations remain explicit; independent review and needs-qa remain.
