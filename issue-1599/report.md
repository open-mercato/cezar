## 📸 UI QA evidence — PASS

**Verdict:** PASS — individual and selected-row actions, mixed eligibility, pending/error recovery, keyboard, responsive layout and large-list behavior exercised with demo data. Evidence only; manual QA approval still gates merge.
**Verified:** feat/issue-1599-tasks-actions @ c88c207f (source revision); local demo, agent-browser0.41.0 / Chrome156.

| # / Priority | Route and action | Expected | Observed | Evidence |
|---|---|---|---|---|
|1/P1|Cold-load /p/demo-repo/ on desktop|Useful shell; eligible row controls visible|Tasks and existing filters/header render; quick controls visible beside checkboxes|PASS: step-01-default.png|
|2/P1|Select done + needs-review, archive selected|Only finished row archived; review row skipped and selected; no navigation|1 succeeded,1 skipped,0 failed; URL stays on Tasks|PASS: step-03-archive-result.png|
|3/P1|Archived: select2, Restore|Restore only selected; archive view empties|2 succeeded,0 skipped,0 failed; empty Archived view|PASS: step-04-restored-empty.png|
|4/P1|Row Mark unread then Mark read|Read marker and inverse control update without opening thread|Both mutations succeeded and inverse row control appeared|PASS: step-05-mark-unread.png|
|5/P1|390x844 mobile: checkbox and row controls|Selection sync; card stays on Tasks; toolbar wraps|Selected card and wrapped toolbar; URL unchanged|PASS: step-06-mobile-selection.png|
|6/P1|Abort demo archive request with browser network route; retry after unroute|Failure explicit; row remains selected and retryable|0 succeeded,0 skipped,1 failed with title/error; retry succeeds|PASS: step-08-error.png|
|7/P1|Search for no-task-matches-issue-1599|Empty state; no hidden action targets|No matching tasks; selection reset|PASS: step-09-filtered-empty.png|
|8/P1|Light theme and keyboard Space on focused checkbox|Tokens preserved; native keyboard selection without navigation|Light controls legible; checkbox checked and1 selected; Tasks URL unchanged|PASS: step-11-keyboard.png|
|9/P1|306 displayed rows: select all, Archive305 eligible|Virtualized list stays responsive; pending controls disabled|All306 selected despite windowing; Archive in progress; controls disabled|PASS: step-07-loading.png|
|10/P1|Complete large batch|All eligible rows processed once; review skipped|305 succeeded,1 skipped,0 failed|PASS: step-14-large-result.png|
|11/P1|390px Archived cards with long title|Title wraps; controls remain available|Long title wraps within card; no horizontal card overflow|PASS: step-12-mobile-long.png|

No new permission surface: local cockpit has no account/role permission state. Existing server checks are unchanged; explicit cross-project request/cache isolation has route interaction coverage. A browser-runner test is not committed; the table above supplies the repeatable follow-up scenario.

Local validation:105/105 targeted tests; typecheck/build pass; packaged CLI33/33 pass. Full npm test hit600s with broad Windows failures; node:test45pass/2fail/1skip matches baseline missing POSIX commands. Final supported-platform CI is reported separately.

The pending-state screenshot uses306real demo rows and existing endpoints. No source API, contract or shared test-environment file was changed.
