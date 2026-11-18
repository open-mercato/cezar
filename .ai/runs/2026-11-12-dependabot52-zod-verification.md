# Dependabot52 verification

Security-Source: open-mercato/cezar:dependabot:52
Security-Fingerprint: GHSA-mrhx-c7xc-m3w5:zod:package-lock.json
PR: https://github.com/open-mercato/cezar/pull/2114

## Change and removal proof

Baseline main682ba953 resolves shared Zod4.6.1. e2e0.19.0 pins that exact vulnerable version; runtime service/contract share it. Parent upgrade to e2e0.22.0 pins Zod4.6.7 and runtime/root minimums are now ^4.6.7. No overrides. Parent-related lock changes are MCP/oxc/expect dependencies and platform bindings; unrelated root dependency versions stay locked. Both e2e versions require ^22.22.3 or >=24.8.0, so the development engine requirement does not change. Published cezar still declares Node>=20.

`timeout 300 npm ci --no-audit --no-fund` succeeds before and after. `timeout 30 npm ls zod e2e --all` succeeds with one Zod4.6.7 copy, shared by runtime service/contract, AI SDK and e2e0.22.0. A lockfile enumeration independently finds only node_modules/zod4.6.7. `timeout 45 npm audit --json` is nonzero for15 unrelated findings (3low/5moderate/6high/1critical); parsed vulnerability map has **no zod**. No audit exceptions, forced upgrades or baseline tolerance are used as target-removal evidence.

## Regression and integration proof

Before manifest/lock upgrade, run:

`timeout 90 env -u CEZ_INSTANCE_ID TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm test -- packages/cezar/src/server/zod-collection-security.test.ts`

Result:2FAIL/2PASS against original installedZod4.6.1. Oversized inline workflow triggers1000 element getter visits and creates a65950-character HTTP JSON error. Valid eight-step workflow and malformed within-limit element guards pass. After upgrade, identical4tests PASS: zero element visits on oversized input; one size issue; middleware returns400/bounded JSON error and never invokes handler. Existing in-limit validation is preserved. This proves the security regression is red against original dependency, not merely a version-string test.

Patched command:

`timeout 120 env -u CEZ_INSTANCE_ID TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm test -- packages/cezar/src/server/zod-collection-security.test.ts packages/cezar/src/server/request-validation.test.ts packages/cezar/src/server/typed-bodies.test.ts`

Result:28/28PASS. Covers the shared contract's consuming Hono middleware plus existing route-validation/type checks.

## Ordered configured gate

All commands run in `.ai/agentic.config.json` order with `timeout 600 env -u CEZ_INSTANCE_ID TMPDIR=/tmp TMP=/tmp TEMP=/tmp` on dependency/source head32e3ccef:

| Command | Result |
| --- | --- |
| npm run typecheck | PASS18s |
| npm test | PASS15348tests;8existing skips;954passed/3skipped files |
| npm run test:unit | PASS51tests |
| npm run build | PASS including check:pack |
| npm run test:package | PASS34tests |

Only the one-line browser smoke locator correction below followed that gate. Independent review reruns the ordered gate on the final review head. No product source/schema/default/API-format changes follow the gate.

## Test-runner compatibility

`timeout 30 npm exec --offline -- e2e --version` ->0.22.0. `timeout 45 env E2E_TELEMETRY_DISABLED=1 npm exec --offline -- e2e list --reporter json` loads the existing root config and discovers tests.

`timeout 240 env -u CEZ_INSTANCE_ID TMPDIR=/tmp TMP=/tmp TEMP=/tmp E2E_TELEMETRY_DISABLED=1 npm exec --offline -- e2e run tests/smoke.e2e.ts --workers 1 --retries 0`

Initial result: existing locator getByRole(navigation) matches both Mode and Main, LOCATOR_AMBIGUOUS. Restoring all four original main manifests/lock and npm-ci'ing the original graph reproduces the identical failure with e2e0.19.0. Patched manifests/lock and installation restored in a finally block. Narrowing the existing locator to navigation name Main, exact:true corrects the test without changing application UI. Final same command (timeout180) PASS1/1 in real headless Chromium; app startup and browser complete in3.77s; no model steps or model calls. Browser/app processes exited. Existing e2e config/model/defaults unchanged. New dependency-graph behavior is verified through the actual CLI, engine, config, app and browser.

## Residual limits and routing

No local CodeQL analyzer or unrestricted stress/OOM test ran. The deterministic bounded input proves excess element work/error accumulation without risking process exhaustion; unbounded schemas remain their authors' responsibility. The alert's individual patch boundary is4.6.6;4.6.7 meets it. Main/alert remains vulnerable/open until merge/rescan.15 other audit findings are not cleared by this PR. Rust critical zip fixes require unavailable Cargo and parent major compatibility work; other uncovered groups remain deferred. Existing PR1253 covers38 different source rows and retains vulnerableZod; no duplicate source remediation was found before opening2114.

No repo settings/workflows/descriptor/env/docs changes. The continuing operator instruction authorized proceeding; atomic claim operations come verbatim from installed pipeline template into run-local helpers, using refs/om-locks/pr-2114 and exact-SHA lease release. No protocol fallback. release/v0.19.x lock resolves4.6.1, so backport requested. No issue, merge, auto-merge, release or alert dismissal. Independent review and current-head checks still gate completion/merge; no native approval waiver.

## Final independent review

[Authoritative review](https://github.com/open-mercato/cezar/pull/2114#pullrequestreview-5874366218): independent **APPROVE**, no findings/autofix, on e84cd69f. Reviewer independently repeated original graph red2/guard2, patched focused28, physical resolution/audit proof, all five ordered gates and browser smoke1 with zero model calls. Final reviewer gate:15348Vitest/8existing skips,51core,34package, typecheck/build/checkpack all PASS. Parent read logs, verified exact child checkout HEAD/clean tree equals review SHA, and reran focused28PASS.

The reviewer's first full suite had one timing failure in unchanged markdown-mermaid.test.tsx:93. Focused5PASS and a full ordered-gate rerun PASS without edits. Both attempts retained; no baseline-causation assertion or exception. Fifteen unrelated audit findings remain unwaived.

GitHub rejected same-bot native self-approval. Review is **COMMENTED**, preserving the independent APPROVE verdict; eligible native approval and repository merge gates remain required. Exact reviewed-head CI was11successful checkruns plus successful CLA, no pending/failed checks. Final documentation/Progress commits may trigger fresh checks; those still gate merge. No further CI monitoring is promised. Final source/manifests/lock/tests are identical to reviewed head; final commits only record proof/Progress.

Occurrence accounting:61source alerts;1handled (Dependabot52, patched PR only),45existing-PR skips,15deferred. Of the latter,8Rust alerts (zip73–75,rustls69–72,glib41) remain blocked by unavailable Cargo/toolchain and parent compatibility verification;7others (dependency38/56/68 and CodeQL34/42/62/86) remain outside the selected coupled group and require compatibility or finding validation. No residual alert is dismissed, waived or claimed fixed on main. This run selected one coupled remediation group (at most two authorized); no second source change/PR was started. Current-source identity sets were rechecked before finalization, and no duplicate source52 PR was found.
