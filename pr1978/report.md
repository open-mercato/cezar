## Browser QA evidence — PARTIAL

QA head: 0757c63995669e82acb25cd1f12de8e11e453a49

Built exact PR head with repository test-env-up.sh, locked npm install, CEZ_DRY_RUN=1 and isolated CEZ_HOME. Real Chromium via configured agent-browser; sandbox/container retry and TMPDIR=/tmp resolved launch restrictions. No paid agent execution.

| Scenario | Observed | Result |
|---|---|---|
| Cold-load project cockpit/composer | Same-origin scoped navigation rendered | PASS |
| Upload four text fixtures and submit dry-run task | notes. .txt→notes.txt; install.sh→install.sh.txt; CON.txt→CON-.txt; zażółć.txt unchanged; all bytes identical in library | PASS |
| Fetch scoped pasted attachment | HTTP200 and original text content | PASS |
|390×844 task | Attachment links/reply controls visible | PASS |
| Real reverse proxy with trailing-slash base origin | Not provisioned; automated URL cases passed | NOT EXERCISED |
| Browser blank/dot-only/truncation stems | Automated regression and differential coverage only | NOT EXERCISED |

Additional parent check: `timeout 300 npm test -- packages/cezar/src/server/attachments-api.test.ts packages/cezar/src/workflows/pasted-attachments.test.ts packages/api-client/src/utils/project-scope.test.ts packages/api-client/src/utils/normalization-security.test.ts` —124 passed. Full five ordered gates independently passed in review; all11 reported head checks successful, including CodeQL and E2E/package.

Browser closed and this run's test server stopped. Source unchanged. Risk-high requires human QA under om-auto-qa-pr; evidence does not grant qa-approved. Keep draft pending remaining QA and formal review from a different eligible account. No issues/merges/automerge/alert dismissal/settings changes.
