## UI QA evidence - PASS

Verified feat/issue-1623-recent-automation-runs at 8034cd235b46cc83536bbe5ab14aa4057008a702; production build, private local dry-run repo/home, agent-browser0.41.0 / Chrome156. Evidence only; independent QA approval remains required.

| Step | Action | Observed | Result |
| --- | --- | --- | --- |
| 1 | Cold open saved paused automation with no launches | No runs launched yet; Run now and View log visible | PASS |
| 2 | Run now from editor; launch five more through cockpit CLI | Six real dry-run launches; five semantic list rows, live queued/running/needs-you status and ages | PASS |
| 3 | Focus newest task link and press Enter | Navigated to /p/demo-repo/tasks/4b15e509-7161-478c-b608-ba1aac27c66a | PASS |
| 4 | Return and use View log | Navigated to saved automation /log with all six Open task rows | PASS |
| 5 | Apply long task title through demo API; switch system theme to light | Full title in accessible link/title; dark and light layouts readable | PASS |
| 6 | Set 390x844 viewport and scroll card into view | Measured viewport390/page390, five rows; full title retained | PASS |
| 7 | Delay only log fetch eight seconds in browser fixture then open fresh saved automation | Loading recent runs visible beside Run now and View log | PASS |
| 8 | Respond403 to controlled browser log request | Could not load recent runs with Retry, Run now, View log and Save changes | PASS |
| 9 | Restore real fetch and click Retry | No runs launched yet returned and error cleared | PASS |
| 10 | Abort log refresh after another real launch on a populated card | Could not refresh recent runs, five existing rows and actions remained; retry recovered | PASS |

Loading/403 were controlled browser fetch fixtures; other scenarios exercised the real log/run API. Both fixture schedules stayed paused. Full-suite platform/CI status is reported separately; UI PASS does not claim a green validation gate.

No browser-level test ships in this diff. Follow-up scenario: create a paused schedule through the API, launch six dry-run tasks, assert five newest project-scoped links and live status, View log six rows, empty/loading/403/retry/cached refresh failure, long title and390px layout; stop and remove fixtures after the run.

![Cold open saved paused automation with no launches](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-issue-1623-pr-1834/issue-1623-pr-1834/step-01-empty-dark.png)
![Run now from editor; launch five more through cockpit CLI](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-issue-1623-pr-1834/issue-1623-pr-1834/step-02-five-runs-dark.png)
![Focus newest task link and press Enter](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-issue-1623-pr-1834/issue-1623-pr-1834/step-03-keyboard-task-link.png)
![Return and use View log](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-issue-1623-pr-1834/issue-1623-pr-1834/step-04-full-log.png)
![Apply long task title through demo API; switch system theme to light](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-issue-1623-pr-1834/issue-1623-pr-1834/step-05-five-runs-light.png)
![Set 390x844 viewport and scroll card into view](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-issue-1623-pr-1834/issue-1623-pr-1834/step-07-mobile-card.png)
![Delay only log fetch eight seconds in browser fixture then open fresh saved automation](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-issue-1623-pr-1834/issue-1623-pr-1834/step-11-card-loading.png)
![Respond403 to controlled browser log request](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-issue-1623-pr-1834/issue-1623-pr-1834/step-12-forbidden.png)
![Restore real fetch and click Retry](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-issue-1623-pr-1834/issue-1623-pr-1834/step-13-forbidden-recovered.png)
![Abort log refresh after another real launch on a populated card](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-issue-1623-pr-1834/issue-1623-pr-1834/step-14-cached-refresh-error.png)

Final-head recheck: 5cb1a586540d5e84be10070040444431db29714d cold-loaded successfully from the production build with the five-row list. Runtime sources are identical to full-matrix head 8034cd23; only the tracking document changed. Browser and demo server stopped again.

![Final head recheck](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-issue-1623-pr-1834/issue-1623-pr-1834/step-15-final-head.png)
