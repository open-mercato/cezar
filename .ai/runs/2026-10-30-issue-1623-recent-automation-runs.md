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

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Detail recent runs
- [ ] 1.1 Add bounded, event-refreshed card and integrate saved editors.
- [ ] 1.2 Cover recent launches, filtering, metadata fallbacks, loading/errors/actions/events and editor integration; prove the editor regression red on old sources.

### Phase 2: Verification
- [ ] 2.1 Run configured gate, full review/autofix and real-browser QA; publish evidence and release claims with ready/review/unassigned PRs.
