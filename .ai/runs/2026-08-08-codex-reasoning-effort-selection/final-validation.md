# Final validation — Codex reasoning-effort selection

**Date:** 2026-08-09
**Branch:** `feat/codex-reasoning-effort-selection`

## Focused coverage and package gate

- `npm run typecheck` — passed.
- `npm test -- --reporter=dot` — passed: 307 files, 5,507 tests.
- `npm run test:unit` — passed: 35 tests, 1 skipped.
- `npm run build` — passed.
- `node --import tsx --test packages/cezar/test/e2e/package-cli.test.ts` — passed. The packed CLI starts the shared Codex App Server fixture and verifies that only the task `turn/start` receives `effort: "high"`; task naming does not.
- `npm run test:package` — passed: 12 tests.
- Focused UI/client suite — passed: 6 files, 249 tests. It covers capability filtering, auto omission, New Task, Inbox, GitHub handoff, lock behavior, and Continue.

## Browser evidence

The live dry-run cockpit was opened through `agent-browser` at `http://127.0.0.1:4321`. With Codex and a concrete Codex model selected, the visible `Effort` control displayed `Codex default`; the screenshot is `.ai/qa/artifacts_e2e/codex-effort-picker.png` (ignored QA artifact). The control is labelled for accessibility and is omitted outside its supported model/runner state.

## 🧪 om-integration-tests — full cockpit E2E suite

**Result:** ❌ 31 of 208 tests failed, with two additional suite-cleanup failures; 172 passed and 5 were skipped. The command was `npm run test:e2e`, which reused the healthy shared dry-run environment at `http://127.0.0.1:4321` and its installed `agent-browser` provider.

| Failing test | Evidence used | Reasoning (why it failed) | Suggested owner | Next action |
|--------------|---------------|---------------------------|-----------------|-------------|
| `agents-dock::docks both sub-agents with odometer, type badge, activity and tool count` | `agent-browser` wait timed out after 25 s for two `agent-item` elements. | The replay fixture never produced the two expected agent rows, so the UI assertion could not begin. | Shared | Inspect the replay fixture/server event timing and make the test wait for a stable run state. |
| `agents-dock::a row opens the drill-down sheet with that agent’s output and nobody else’s` | The same two-agent wait timed out after 25 s. | The prerequisite dock rows were absent, so this dependent interaction failed. | Shared | Fix the fixture prerequisite before judging the sheet interaction. |
| `agents-dock::the long agent panel scrolls, detaches from follow-tail, and exposes the jump pill` | The same two-agent wait timed out after 25 s. | The panel cannot be exercised before the absent replayed rows render. | Shared | Repair the replayed fan-out setup. |
| `agents-dock::collapses to a one-line odometer` | The same two-agent wait timed out after 25 s. | The initial dock state was never established. | Shared | Repair the replayed fan-out setup. |
| `github::opens an issue’s detail: meta, labels, markdown body, hand-to-agent dropdowns` | `gh-workflow-option` count never reached one in 25 s. | The dry-run fixture did not expose the expected handoff workflow option. | Shared | Verify workflow fixture discovery independently of the effort picker. |
| `github::renders the activity thread: comments, a commit row with a CI glyph, and events` | The runner reported `fetch failed` with `ECONNRESET`. | The request lost its local server connection after the prior scenario, so this is not a meaningful assertion of the activity thread. | Shared | Stabilize lifecycle/cleanup between GitHub scenarios. |
| `new-task::the pill row resolves: project skill preselected, runner pill iff >1 backend, base: main, ×1` | The expected `lint-fix` source pill never appeared in 25 s. | Skill discovery returned a different global skill, so the intended fixture prerequisite was absent before Effort is involved. | Shared | Isolate test skill directories from global skill discovery. |
| `new-task::the source dropdown groups project skills first and picking one updates the pill` | Expected `['lint-fix', 'spec-writer']`; received `['lint-fix', 'om-apply-upgrade-notes']`. | The fixture expectation is drifted by an externally discovered global skill. | Agent/QA | Pin the test's skill discovery inputs or update the fixture contract deliberately. |
| `new-task::type + submit → the thread; the run record carries the exact skill chain` | The runner reported `fetch failed` with `ECONNRESET`. | The dry-run server connection reset during the scenario, preventing a valid assertion about task launch. | Shared | Stabilize the fixture server before evaluating the task-launch flow. |
| `new-task::back on /new the picked source stuck and the spent draft is gone` | The expected `spec-writer` source pill never appeared in 25 s. | This is downstream of the same skill-fixture drift, not a direct Effort-control failure. | Shared | Pin skill discovery for the suite. |
| `plan-mode::Plan first selects visibly (#383) and submit produces the review overlay, not a run` | The expected `lint-fix` source pill never appeared in 25 s. | Plan mode inherits the same mismatched skill fixture as New Task. | Shared | Pin skill discovery for the suite. |
| `plan-mode::save as chain lands in /api/v1/workflows; saving again asks before overwriting` | `plan-save` could not be clicked after the first scenario failed. | The scenario did not reach its prepared plan state, making this a cascade rather than a save-route verdict. | Shared | Re-run after the source-pill prerequisite is stable. |
| `plan-mode::on an iPhone the overlay is a full-screen sheet and the ↑/↓ buttons still reorder` | The browser wait timed out after 25 s. | The plan overlay prerequisite did not render under the drifted fixture state. | Shared | Restore deterministic plan-mode setup. |
| `plan-mode::remove + reorder shape the chain; ▶ Start posts those EXACT inline steps and opens the thread` | The browser wait timed out after 25 s. | The initial plan interaction did not reach a stable state, so the later ordering check is not isolated. | Shared | Restore deterministic plan-mode setup. |
| `plan-mode::back on /new: plan mode stuck (draft store) and the spent draft text is gone` | It failed immediately after earlier plan-mode errors. | This assertion consumes state from the failed plan setup. | Shared | Re-run after the earlier plan-mode prerequisites pass. |
| `project-groups::scopes every group nav to its own project, and lights only the active one` | The expected project-group GitHub link never appeared in 25 s. | The multi-project fixture did not render its expected scoped navigation. | Shared | Inspect workspace-registry fixture initialization. |
| `project-groups::persists a collapse in THIS browser, so a reload keeps it and the workspace file does not` | The runner reported `fetch failed` with `ECONNRESET`. | The local server disconnected during the dependent scenario. | Shared | Stabilize multi-project server lifecycle and rerun. |
| `queued-stack::removes the stacked message` | `agent-browser` could not find `[aria-label="Remove message"]`. | The expected remove control was absent from the rendered queued-message fixture. | Shared | Inspect the queue fixture and semantic label before changing product behavior. |
| `queued-stack::keeps the amendment when the run finally starts, and goes read-only` | The record retained an earlier message in addition to the expected final text. | The previous removal failure left shared state behind, so this is a direct cascade. | Shared | Make each queued-stack scenario independent or repair its teardown. |
| `quick-list::groups the runs under Needs you / Recent, in that order` | The rendered text contains `#396` where the assertion expected no number prefix. | This is a fixture/UI expectation mismatch in task title formatting. | Agent/QA | Decide whether the current title format is intended, then update the assertion or product deliberately. |
| `quick-list::expands the variant group into per-variant rows, and collapses it again` | The expected token text `96.2k` was absent from the rendered row. | The fixture/rendered metadata no longer matches the exact textual expectation. | Agent/QA | Update fixture data or the semantic assertion. |
| `quick-list::is the home: the table renders every active fixture run with its status` | The expected `128.4k` token text was absent from the rendered review row. | The test expects legacy aggregate token display absent in the current row content. | Agent/QA | Reconcile the quick-list fixture with the current display contract. |
| `settings-agents::per-runner model preset: select writes the runner key, others untouched` | Codex already had `gpt-5.6-terra` when the test expected `undefined`. | A supposedly clean settings fixture carried an existing Codex model value. | Shared | Reset persisted workspace config before this scenario. |
| `settings-agents::system prompt: explicit save persists the trimmed text` | `GET /api/v1/config` never reached the expected state. | The test could not observe its own settings write in the shared config. | Shared | Diagnose config isolation/read-after-write in the dry-run environment. |
| `settings-agents::a cold load renders the persisted knobs — the form is a view of config.json` | The expected saved system prompt was empty. | This is downstream of the failed persistence assertion. | Shared | Re-run after the persistence setup is stable. |
| `settings-appearance::the shell renders the registry sections — hidden ones absent, active one marked` | The test expected five sections and found six. | The registry UI now exposes one additional section, making the strict count stale. | Agent/QA | Replace the count with intended-section assertions or update the expected contract. |
| `settings-monitoring::persists capacity and interval mode through a cold reload` | Workspace resources never reached the expected state after polling. | The settings write/read round trip did not settle in the dry-run environment. | Shared | Diagnose workspace-config persistence under the E2E environment. |
| `task-thread::the step rail maps the record steps to checklist rows over the progress bar` | Browser evaluation found no progress-bar child and threw on `.style`. | The test assumes a DOM shape not present in the rendered fixture. | Agent/QA | Use an observed semantic progress element or restore the intended DOM contract. |
| `task-thread::the header meta line reads workflow · branch chip · ± · tokens · cost off the record` | The rendered meta line omitted expected `3.6k tokens`. | The fixture/UI no longer renders that token text in this header shape. | Agent/QA | Reconcile the header assertion with the current metadata display. |
| `workflows::Save writes a real portable workflow file the server round-trips` | `wb-save` was covered by the sticky header at its click point. | The browser rejected a physical click because the test has not scrolled the control into an unobscured position. | Agent/QA | Adjust the interaction to a visible, observed control position. |
| `workflows::Import parses pasted YAML through the server and renders richer flows as full steps` | `wb-import` was covered by the sticky header at its click point. | This is the same browser-interaction issue as Save. | Agent/QA | Scroll/reposition before clicking and keep the test semantic. |

Two additional failed suites are cleanup defects: `plan-mode.e2e.ts` and the empty quick-list suite both called `rmSync(..., { recursive: true, force: true })` while their temporary directories were still non-empty. They should be owned by Shared test infrastructure and made to await server/browser shutdown before removal.

The dominant classes are fixture/config isolation, cascading state after timeouts, and stale E2E expectations. None of the runner output names `ReasoningEffortPill`, its accessibility label, or its request payload. The feature-specific UI/client tests and package CLI test pass, but the global E2E gate remains red and must be resolved before promoting this draft PR.
