# Independent Codex Daybreak Blue selection

Source doc: .ai/specs/2026-10-30-issue-1700-codex-daybreak-blue.md (design-only spec branch `spec/issue-1700-codex-daybreak`)
Issue: #1700
Engine: om-auto-create-pr (steps: 6, --loop: no)

## Goal and scope

Offer independent access mode and underlying model selection using the selected Codex account's advertised capabilities. Preserve native omission, explicit standard, legacy aliases, old runs/CLIs and non-Codex behavior. Scope is catalog/runner/run/workflow contracts and assigned engine pickers; parent supplies server.ts, api/client.ts and compatibility-note edits.

## Implementation Plan

### Phase 1: Contracts and capability discovery

1.1 Add optional neutral contract/persistence/workflow fields.
1.2 Preserve validated capabilities and isolate account catalog/query context.

### Phase 2: Execution lifecycle

2.1 Carry selection through creation, recovery, workflows and Continue.
2.2 Validate explicit selection and translate it at every Codex turn/start.

### Phase 3: Consistent picker and release evidence

3.1 Share compatibility and access picker rules across New Task, Inbox/GitHub and Continue.
3.2 Prove regression red/green; run gates, review/autofix and actual-browser QA.

## Risks

Protected HTTP/state/workflow/runner surfaces need optional additive fields and omission semantics. Unknown metadata never grants eligibility. No paid/live Blue turn is authorized; protocol/fixtures and real-picker verification will be recorded, with live-turn limits disclosed. Windows baseline full-suite timing/symlink and node:test shell failures must be reported honestly. Full-suite runs coordinate with parent.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` â€” <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Contracts and capability discovery

- [x] 1.1 Add optional neutral contract/persistence/workflow fields. — 48261a4f
- [ ] 1.2 Preserve validated capabilities and isolate account catalog/query context.

### Phase 2: Execution lifecycle

- [x] 2.1 Carry selection through creation, recovery, workflows and Continue. — 48261a4f, 728433d6
- [x] 2.2 Validate explicit selection and translate it at every Codex turn/start. — 48261a4f

### Phase 3: Consistent picker and release evidence

- [ ] 3.1 Share compatibility and access picker rules across New Task, Inbox/GitHub and Continue.
- [ ] 3.2 Prove regression red/green; run gates, review/autofix and actual-browser QA.

Core 33 passed / 21 skipped; lifecycle 7/7. Picker implementation 728433d6 and boundary regression tests a358f2d1 committed. Remaining profile catalog/request serialization needs parent-owned server.ts/client.ts edits. Current boundary tests intentionally expose the missing fields (8 HTTP, 3 component failures); 114 component tests pass. Installed Codex 0.164.0 real model/list advertised per-model standard/Blue capabilities without a model turn. Private real-browser preliminary picker/unknown-metadata checks captured; final-head QA/review/gates pending parent boundary integration and full-suite release.

