## 📸 UI QA evidence — PASS

All nine scoped Add-project browser scenarios passed. Evidence-only: no human QA approval granted.

Final source head `499072df851edb509340d113699c80232c44890d`, branch `feat/issue-1688-browse-root`, disposable loopback environment, `agent-browser0.41.0` with Chrome156. Scenarios1–7 used identical production code before plan-only commits; scenarios8–9 ran at final head.

| # | Action | Expected | Observed | Evidence |
| --- | --- | --- | --- | --- |
| 1 / P1 | Cold-open Add project → Open local folder at configured root | Canonical root path, explanation and Settings link; no Up | Root path and hint visible; no Up; useful shell/loading appeared before data | [PASS](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-01-root.png) |
| 2 / P1 | Enter Projects, then activate Up | Up below root, hint absent below root and restored at root | Nested listing shows Up; returning to absolute root restores hint | [PASS](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-02-nested.png) |
| 3 / P1 | Activate Settings link with keyboard and a direct mouse click | Settings → Projects opens and picker dismisses | URL /settings/global/projects, Default browse folder textbox visible, picker absent | [PASS](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-03-settings.png) |
| 4 / P1 | Repeat root picker at 390 × 844 viewport with long canonical path | Hint/link wrap; no horizontal overflow or missing controls | Readable wrapped hint, truncated path, visible Cancel/Add controls | [PASS](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-04-mobile-root.png) |
| 5 / P1 | Enter empty child folder | Existing empty-folder guidance and Up; no root hint | No subfolders guidance and Up visible; root hint absent | [PASS](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-05-empty-nested.png) |
| 6 / P1 | Delete task-owned empty Unavailable fixture after root listing, then enter it | Browse error and Back; no false root hint | Server no such directory error; Back visible; no root hint/link | [PASS](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-06-error.png) |
| 7 / P1 | Change disposable Default browse folder via Settings to Empty; reopen picker; restore setting | Empty root retains explanation and empty-folder guidance | Both messages visible, no Up; original fixture root restored | [PASS](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-07-empty-root.png) |
| 8 / P1 | Delay browse response5s through a task-only loopback QA proxy | Loading with no false root hint; hint appears on successful response | Loading screenshot has no hint; after response the root hint appears | [PASS](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-08-loading.png) |
| 9 / P1 | Return a controlled403 browse response through the QA proxy | Permission error, Privacy Settings and retry controls; no root hint | Controlled permission message, existing privacy/retry guidance, root hint absent | [PASS](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-09-forbidden.png) |

Limits: loading/403 used controlled responses from a task-only loopback proxy (5s delay and403), not actual OS permission denial. Add agent account was source-inspected rather than separately browser-driven; dark theme exercised. Native ref midpoint initially landed between wrapped text; direct mouse text click and keyboard activation both reached Settings and dismissed the picker. No production source, API or shared config was changed for QA.

![Cold-open Add project → Open local folder at configured root](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-01-root.png)

![Enter Projects, then activate Up](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-02-nested.png)

![Activate Settings link with keyboard and a direct mouse click](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-03-settings.png)

![Repeat root picker at 390 × 844 viewport with long canonical path](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-04-mobile-root.png)

![Enter empty child folder](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-05-empty-nested.png)

![Delete task-owned empty Unavailable fixture after root listing, then enter it](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-06-error.png)

![Change disposable Default browse folder via Settings to Empty; reopen picker; restore setting](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-07-empty-root.png)

![Delay browse response5s through a task-only loopback QA proxy](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-08-loading.png)

![Return a controlled403 browse response through the QA proxy](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-09-forbidden.png)

