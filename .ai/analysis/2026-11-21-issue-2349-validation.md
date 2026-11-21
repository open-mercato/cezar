# #2349 terminal proc hardening — final verification

Issue: https://github.com/open-mercato/cezar/issues/2349
Implementation: https://github.com/open-mercato/cezar/pull/2371
Design-only spec: https://github.com/open-mercato/cezar/pull/2370
Verified production source: `d868b7b523fefa6736caefb0a69dd0db944018a7`. The final evidence commit changes Markdown only.

## Result
Linux terminal foreground and shutdown readers follow cezar descendants through every thread's children links. They do not enumerate the global proc directory or invoke ps. The asynchronous foreground cache, validated shutdown root/group checks, 1.5-second killable Node helper, SIGKILL/8 MiB bound, and failure warning/fallback remain. No application startup, configuration, dependency, HTTP/CLI or persisted-format changes. Other process scanners remain explicitly outside scope.

The root independently inspected the complete diff and found a native hidepid=2 defect during continuation: a live elevated child hidden by proc permissions reports ENOENT, so the initial code falsely treated it as exited/idle. The correction rechecks its visible parent's children link. A missing child is skipped only when the link is gone; a still-linked hidden child makes the snapshot unknown. The same shared traversal handles async polling, sync testing and the compiled shutdown helper.

## Red-before-green proof
- Both original routing regressions fail on actual legacy ps calls when only foreground/process-tree routing is removed; they pass with scoped routing.
- The root's new `live hidepid=2 child` regression fails on the previous helper, then passes with the link recheck. The true-exit guard removes the parent link, retaining ordinary exit tolerance.
- The full terminal scope passes **14 files / 161 tests**, including real PTY group teardown, background/nohup jobs, a foreground job ignoring HUP, the killable helper, non-leader threads, stale/recycled IDs, denied relationships, missing support and output validation.

## Native privilege and access evidence
A network-disabled Linux container uses a real setuid-root C bridge (real UID 1001 / effective UID 0) and an ordinary-user grandchild, plus an unrelated root process:
- hidepid=0: async/sync/compiled readers retain the elevated bridge and ordinary-user grandchild and exclude the unrelated root process.
- hidepid=1: the independent control read is denied with EPERM; all readers return unknown.
- hidepid=2: the independent control read is denied with ENOENT; all readers return unknown. The old helper reproduced false idle before the correction.

Container proc mounts and temporary credentials/UID transitions are isolated; no host security setting changed. Fixture code, commands and logs are in the root cockpit Assets under `terminal-native/`.

The corrected compiled-reader strace asserts that numeric proc paths name only root, ordinary child and bounded helper; there is no ps execution or global proc-root open/enumeration. Native permission denial is not claimed to make hidden relationships readable: existing unknown-state warning and shutdown fallback deliberately apply.

## Root full configured gate
Every command ran in configured order on the frozen corrected source:

| Command | Result | Duration |
|---|---|---|
| `npm run typecheck` | PASS (0) | 20.75 s |
| `npm test` | PASS (0) | 869.56 s |
| `npm run test:unit` | PASS (0) | 12.1 s |
| `npm run build` | PASS (0) | 11.0 s |
| `npm run test:package` | PASS (0) | 19.45 s |

Vitest: **17,832 passed / 8 skipped**, 1093 files passed / 3 skipped. Node unit: **54/54**. Packaged CLI: **35/35**; build includes check:pack. Only inherited CEZ_INSTANCE_ID and CEZ_ARTIFACTS_DIR were removed for test subprocesses, with TMPDIR=/tmp. No product source/configuration or assertions were weakened. Earlier 600-second attempts and inherited-environment health-key mismatch are historical limits resolved by the full normalized run; no health fix belongs in this PR.

## Real-browser QA
`om-auto-qa-pr` used the configured agent-browser provider and repository test-env entrypoint on a disposable local dry-run cockpit. **Ten** live start/busy/Stop/idle cycles pass. The busy-close dialog appears, Cancel retains the tab, idle close removes it, policy-disabled rendering is respected, and a 390×844 viewport stays usable. Screenshots, scenario JSON and logs are in the root Assets under `terminal-native/`; the PR evidence comment is authoritative for the published head and requested self-QA signoff.

No UI source changed. Auth/session/token, business-record edits, shared-record stale writes, money and locale-entry checks are inapplicable to this internal reader change. Non-Linux runtime is unchanged and not claimed as locally re-exercised. Existing cross-platform CI and all final-head checks continue to gate merge. A follow-up browser automation scenario is recorded with the evidence; no extra tracking issue was opened.

## Review and publication
The root applied om-auto-review-pr/om-code-review against AGENTS, CODE_REVIEW, BACKWARD_COMPATIBILITY, consumers and the full checklist. The inherited native-QA blocker and newly observed hidepid=2 false-idle defect are resolved. No remaining actionable code or QA finding was identified in this scope. Root verification is separate from the worker's initial self-review; GitHub still treats the authenticated bot as PR author, so its COMMENT verdict does not supply formal approval.

Automerge is eligible under the user's instruction because no application startup/configuration/architecture change ships. Requested QA self-signoff is backed by actual runtime evidence; formal GitHub approval/protection and exact-head CI remain enforced. The newest release/v0.20.x contains the original scans, so its backport request remains. No PR or base branch is merged by this task.

Atomic PR ownership uses root run bab16231-b24e-4b5b-a184-ac255f19a607; tracker comments record controlled label/claim cleanup and leased ref release. All initial worker issue/PR claims were released before root acquisition. No extra workers were dispatched.
