## 📸 UI QA evidence — PARTIAL

Seven exercised browser scenarios passed. Initial loading and permission-denied states remain browser coverage limits; component tests cover both. Evidence-only: no QA approval granted.

Verified `feat/issue-1688-browse-root` @ `e26d8594f0827d5f660a9de8d8a6f90feb56df55`, disposable loopback environment, `agent-browser 0.41.0` with Chrome 156.

| # | Action | Expected | Observed | Result |
| --- | --- | --- | --- | --- |
| 1 / P1 | Cold-open Add project → Open local folder at configured root | Canonical root path, explanation and Settings link; no Up | Root path and hint visible; no Up; useful shell/loading appeared before data | [PASS](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-01-root.png) |
| 2 / P1 | Enter Projects, then activate Up | Up below root, hint absent below root and restored at root | Nested listing shows Up; returning to absolute root restores hint | [PASS](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-02-nested.png) |
| 3 / P1 | Activate Settings link with keyboard and a direct mouse click | Settings → Projects opens and picker dismisses | URL /settings/global/projects, Default browse folder textbox visible, picker absent | [PASS](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-03-settings.png) |
| 4 / P1 | Repeat root picker at 390 × 844 viewport with long canonical path | Hint/link wrap; no horizontal overflow or missing controls | Readable wrapped hint, truncated path, visible Cancel/Add controls | [PASS](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-04-mobile-root.png) |
| 5 / P1 | Enter empty child folder | Existing empty-folder guidance and Up; no root hint | No subfolders guidance and Up visible; root hint absent | [PASS](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-05-empty-nested.png) |
| 6 / P1 | Delete task-owned empty Unavailable fixture after root listing, then enter it | Browse error and Back; no false root hint | Server no such directory error; Back visible; no root hint/link | [PASS](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-06-error.png) |
| 7 / P1 | Change disposable Default browse folder via Settings to Empty; reopen picker; restore setting | Empty root retains explanation and empty-folder guidance | Both messages visible, no Up; original fixture root restored | [PASS](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-07-empty-root.png) |
| 8 / P1 | Initial pending and permission-denied browse states | No premature root hint, existing permission guidance retained | Covered by component tests, including cached-root refresh failure; not separately forced in browser | not exercised in browser |

Limits: native CLI midpoint click landed between wrapped link text lines; a direct mouse click on visible text and keyboard activation both reached Settings and dismissed the picker. Add-agent-account caller was inspected but not separately browser-tested. Initial shell/loading was observed; deterministic pending/403 screenshots were not captured.

![Cold-open Add project → Open local folder at configured root](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-01-root.png)

![Enter Projects, then activate Up](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-02-nested.png)

![Activate Settings link with keyboard and a direct mouse click](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-03-settings.png)

![Repeat root picker at 390 × 844 viewport with long canonical path](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-04-mobile-root.png)

![Enter empty child folder](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-05-empty-nested.png)

![Delete task-owned empty Unavailable fixture after root listing, then enter it](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-06-error.png)

![Change disposable Default browse folder via Settings to Empty; reopen picker; restore setting](https://raw.githubusercontent.com/open-mercato/cezar/qa-evidence-pr-1832/pr-1832/step-07-empty-root.png)

