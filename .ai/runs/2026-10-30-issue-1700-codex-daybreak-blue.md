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

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Contracts and capability discovery

- [x] 1.1 Add optional neutral contract/persistence/workflow fields. - 48261a4f
- [x] 1.2 Preserve validated capabilities and isolate account catalog/query context. - 48261a4f, 7152309a

### Phase 2: Execution lifecycle

- [x] 2.1 Carry selection through creation, recovery, workflows and Continue. - 48261a4f, 728433d6
- [x] 2.2 Validate explicit selection and translate it at every Codex turn/start. - 48261a4f

### Phase 3: Consistent picker and release evidence

- [x] 3.1 Share compatibility and access picker rules across New Task, Inbox/GitHub and Continue. - 728433d6, 7152309a
- [x] 3.2 Prove regression red/green; run gates, review/autofix and actual-browser QA. - 86cfa33a, 440cce50, 36582bf2

Implementation PR #1856; design-only spec PR #1855. Main merged at 75a2dc01. All source findings from om-auto-review-pr --autofix were corrected. In particular, missing catalog models now fail closed without crashing other backends, and account/mode mismatches leave the shared controls usable. Both catalog regressions were proved red without their source fixes and green after restoration.

Validation: focused boundary/picker 197/197; capability/wire/lifecycle 33 pass with 21 unrelated cases filtered; lifecycle restart/Continue 7/7; draft/typed-route 53/53; affected CI screens/guidance/tracker 126/126 and Changes tab 44/44. Full typecheck passes after autofix. Ordered local gate: typecheck PASS; Vitest TIMEOUT at 300s with existing Windows failures and no completed total; core-unit 45 pass / 2 fail / 1 skip (mkdir and /bin/sh ENOENT); build/check:pack PASS; package 33/33 PASS. These Windows limits are not concealed or described as green.

Supported-platform source-head CI is green at 36582bf2: https://github.com/open-mercato/cezar/actions/runs/41131759853, including all three Vitest shards and Ubuntu/macOS/Windows jobs. The final tracking-only commit's head is checked separately in the PR/task report.

Real-browser evidence (12 screenshots): https://github.com/open-mercato/cezar/pull/1856#issuecomment-6534426151. New Task, two Blue models, explicit Standard, Continue Native clearing, account mismatch/recovery, unknown/cached/empty/loading catalogs, narrow long content and Inbox launch were exercised. Evidence is PARTIAL because a paid/live Blue turn and full real-forge GitHub handoff were not exercised; fixture wire and boundary tests cover the plumbing. No entitlement/credential mutation or paid/live Blue turn occurred. The installed Codex 0.164.0 protocol and read-only catalog metadata were verified; metadata is not proof of entitlement. Own demo/browser processes stopped. Independent review and human QA remain required; no author approval or qa-approved label.


Parent fresh-review correction: scheduled/deferred starts previously saved explicit accessMode but omitted it from ordinary manager input. Four new regressions fail on5588 (native guard passes); all44 scheduled/template/binding tests pass after forwarding the shared-enum-validated field, freezing explicit treatment in deferred revisions and rejecting mode under model lock. Native revision digests retain their legacy shape; workflow-step modes remain included in existing workflow fingerprints. Full typecheck passes39s. Parent requests fresh re-review and exact corrected-head CI; results are recorded on PR1856. No paid/live turn or credential/entitlement change.
