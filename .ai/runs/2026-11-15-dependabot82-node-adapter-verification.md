# Node adapter alerts82/83 — verification

Source identities: `open-mercato/cezar:dependabot:82` / `GHSA-jpvv-r467-5p4w` and `open-mercato/cezar:dependabot:83` / `GHSA-qv5m-9pm6-hqp3`, package `@hono/node-server`, manifest `package-lock.json`.

## Scope and before/after proof

Main `b424111d22dd8936df737d66160b739620c11c5e` installs2.1.3. `npm ci --no-audit --no-fund` installed the exact baseline; `npm ls @hono/node-server --all` confirmed it. Before the dependency change, `timeout90 env -u CEZ_INSTANCE_ID TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm test -- packages/cezar/src/server/node-adapter-request.test.ts` fails4/7tests, with3controls passing: two raw-backslash paths reach fetch and return200, a pending socket reset throws ECONNRESET, and a destroyed pending socket reaches handshake handling. The unchanged new regressions pass after2.1.6. This demonstrates upstream adapter flaws, not arbitrary internet reachability in cezar; cezar's custom WS hub is distinct from the adapter's opt-in built-in WS integration.

The service minimum becomes^2.1.6 and npm regenerates only the matching workspace range and adapter entry (version/resolved/integrity/peer metadata). Node>=20 and Hono4 remain supported. No overrides, unrelated package upgrades, API/default/env/config/settings/workflow changes. The exact patch was installed via a second npm ci; `npm ls --all --json` has0graph problems, every lock and installed adapter copy is2.1.6, and npm audit has no adapter entry (14unrelated residual package entries remain). Existing PR1253 carries adapter1.19.19, an incompatible downgrade from main2.x; do not count that as compatible coverage for82/83.

Focused command, with the same timeout/env prefix: `npm test -- packages/cezar/src/server/node-adapter-request.test.ts packages/cezar/src/server/node-adapter-security.test.ts packages/cezar/src/server/static-ui.test.ts packages/cezar/src/server/origin-guard.test.ts` passes103tests. New unit coverage creates no listening socket. Existing real WS-hub suite passes28tests. `node --import tsx --test packages/cezar/test/e2e/node-adapter.test.ts` passes2real-loopback tests: JSON/cookies/SSE and exact raw HTTP paths (raw backslashes400, percent-encoded/query backslashes200). Real socket tests remain in test:package. Unit mock-emitted errors reproduce EventEmitter's unhandled-error primitive without killing the runner; this is not a native TCP-RST timing/stress or heap-leak measurement.

## Ordered gate

Runner: Node24.22.2/npm11.19.1, native Linux. Commands are always run through repository npm scripts. Full commands prefix: `timeout600 env -u CEZ_INSTANCE_ID TMPDIR=/tmp TMP=/tmp TEMP=/tmp`, except npm test uses timeout900. No separate Node20/Windows/macOS or HTTP2 execution claimed. Initial typecheck caught optional mock-call access in the new test; corrected before the final gate.

| Command, in configured order | Result |
|---|---|
| npm run typecheck | PASS |
| npm test | PASS —15,867passed,8existing skips |
| npm run test:unit | PASS —51passed |
| npm run build | PASS —including check:pack |
| npm run test:package | PASS —36passed |

No lint script exists; `git diff --check` and complete npm graph checks apply. Upgrade npm metadata confirms2.1.6's same Node>=20 and Hono4 peer support. No configured package age delay found; none added/bypassed.

## Review and gates

Independent authoritative `om-auto-review-pr2204 --autofix` / `om-code-review` verdict: **APPROVE**, zero findings, at exact source head `d7ee9df97d2381a0878195d069daeda23d3d5c90`. [Review5910772684](https://github.com/open-mercato/cezar/pull/2204#pullrequestreview-5910772684) is COMMENTED because GitHub rejects native self-approval by the author bot; eligible external native approval remains required. Reviewer independently repeated every ordered gate (15,867Vitest/51core/36package), SHA512-verified baseline4red/3controls against the unchanged seven-test file, patched7green, clean installed graph/target audit removal, and exact canonical helper/claim checks. No reviewer source edits/commits/pushes. Manual QA instructions are [posted](https://github.com/open-mercato/cezar/pull/2204#issuecomment-6894477851). No UI components changed; no screenshot assertion is claimed. Needs-qa preserves the repository manual QA gate for HTTP path behavior. Release/v0.20.x has the same adapter2.1.3 range/lock and needs a supported backport label. This task does not merge or dismiss alerts; they remain open on main until a future run verifies the merged patch.

## Deduplication and residual candidates

Fully paginated authenticated source APIs return53Dependabot+11CodeQL; open/closed PRs164/1313; all four local remediation automations and active claims checked.50source alerts duplicate existing8PRs;2CodeQL network flows match intended behavior;2launcher findings lack precise native/source reproduction. The other8Dependabot alerts are Rust zip/glib/rustls: Cargo absent and crates.io metadata requests return403, so compatible dependency resolution/build/removal proof is blocked. GitHub updater source mentions zip9 but is insufficient proof of a published compatible resolved graph. No forced lock edits or new issues. Retry only when relevant source/upstream/permissions changes.

The user resumed autonomous completion after initial descriptor-blocked evidence. Exact already-installed canonical atomic helper functions run from an untracked task artifact, using the repository's existing label guards; descriptor/settings/workflows remain untouched. Recorded run id75c85ed7-d0cd-41e3-86de-20ad34c5b794, exact claim refrefs/om-locks/pr-2204 and SHA855b1f33bdfa86458f4b6ac7e522fd688df61794; owning comment6894270017. Bot assignment check404 confirms unassignable; no assignment changed. The first helper extraction selected a setup example, which stopped at absent brew; corrected to the exact function block before atomic acquisition. No package manager settings or global tool install ran. Independent reviewer must assess the recorded continuation decision and helper fidelity.

Final source/deduplication recheck: all53Dependabot and11CodeQL identities remain open; no competing82/83PR found. Main advanced to `15f5d7994eb7b0df5074f7cad3964644c47ebe2f` through unrelated manager/reference-chip changes; adapter manifest/lock and remediation source scope are unchanged, and PR2204 remains mergeable. No base merge or production source change was made after review. At finalization, all visible checks on reviewed source head d7ee9df97 were success/skipped, including npm snapshot and CodeQL. Final documentation/progress pushes may start fresh checks; required CI, manual QA and eligible native approval continue to gate merge. No CI wait or merge is promised.
