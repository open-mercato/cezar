# Issue 1902 verification

Base: `aad51073b0899baf6611f2d50d0e87d3be59cabb` (`main`, verified via GitHub). Isolated existing worktree reused; new fix branch only. No subtasks.

## Red–green

- Red: restored `packages/web/src/routes/github/github.tsx` from HEAD while retaining the new tests. `npm test -- --run packages/web/src/routes/github/github.test.tsx -t 'loads private .* body and comment images'` exited 1: issue and PR tests each expected four raster images and received zero. Source restored via an EXIT trap.
- Green: restored production fix; targeted attachment, route, inventory and GitHub UI suites: 4 files, 196 tests passed. Covers Markdown and HTML images in both bodies and comments, unchanged unrelated public URLs and local-file link policy, unavailable assets, source/redirect allowlists, credential stripping, raster MIME/signatures, declared/streamed size caps, dry-run, concurrency, CSRF, unknown projects and typed contract parity.

## Configured gate (implementation pass)

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test` | FAIL: 14,250 passed, 8 skipped, 2 failed initially. New route inventory omission fixed and rechecked green. Remaining `projects-api.test.ts` health-key test rejects baseline `instanceId`; reproduced with original `server.ts` restored from HEAD (same failure). |
| `npm run test:unit` | PASS: 50 tests |
| `npm run build` | PASS, including check:pack |
| `npm run test:package` | PASS: 34 tests |

## Final validation and review

The apparent health mismatch was inherited environment contamination: `server.ts:1947` adds `instanceId` only when the cockpit launcher exports `CEZ_INSTANCE_ID`. The isolated health regression passes with that launcher identity removed. No health/test source was changed. All five configured commands were then rerun in order with only `CEZ_INSTANCE_ID` removed from their environment:

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test` | PASS: 14,252 tests passed, 8 skipped; 890 files passed, 3 skipped |
| `npm run test:unit` | PASS: 50 tests |
| `npm run build` | PASS, including check:pack |
| `npm run test:package` | PASS: 34 tests |

The `om-auto-review-pr --autofix` / `om-code-review` pass found no remaining actionable attachment-code findings. Initial request-changes accounting was corrected after isolating the launcher environment. GitHub disallows this bot formally reviewing its own PR; the review report is posted as a conversation comment, never represented as independent approval. CI and CodeQL completed successfully for code commit `f653371c219812d8f48e6e506eb678fb3f8c1c5d`.

`om-auto-qa-pr` booted through `om-prepare-test-env` and drove local Chrome using the configured agent-browser provider. Authored API fixtures and the existing 320×200 PNG proved issue/PR Markdown and HTML body/comment rendering, raster data sources, local-link preservation, loading, unavailable, empty, long content and 390px mobile states. Screenshots and reports are attached to PR #1979 on a separate evidence branch, never this fix branch. Overall QA: PARTIAL — live private-repository and independently hosted authentication were not exercised. No human QA approval is claimed. The shared Markdown consumers passed automated tests but were not separately browser-driven.

PR: https://github.com/open-mercato/cezar/pull/1979 remains draft. Automerge is withheld: QA is partial, and required tracker-protocol artifacts were updated. Product startup, environment defaults and configuration remain unchanged.

## Chain and safety

Applied locally installed `om-auto-fix-issue`, `om-verify-in-repo`, `om-root-cause`, `om-fix`, then `om-open-pr --handoff om-auto-review-pr`. The analysis brief in `root-cause.md` is the exact previous-step input to implementation. Required atomic ownership operations and paginated claim reads were merged into the existing GitHub tracker descriptor; no product startup/config changes.

Fresh issue/lock/comment/PR searches found no competing work, including same-bot claims. Owned issue ref SHA `63c4f60177e108d2ad709235d9be4fb5eaa7b644`, claim comment `6683552143`, run `a2f8147e-a994-493b-bba3-6509442addbc`. Bot self-assignment rejected; the assignment-specific assignability endpoint returned 404, so existing assignees were preserved and verified `in-progress` retained as the second ownership signal.

No live private-repository credentials/assets were available for end-to-end proof. Controlled credentialed redirect tests use dummy credentials only. Enterprise, SVG/video, and images above 5 MiB are intentionally unsupported by the new loader. Browser QA and code review evidence will be linked on the PR; no claim of merge readiness is made here.
