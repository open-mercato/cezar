# CodeQL30 verification

Security-Source: open-mercato/cezar:code-scanning:30
PR: https://github.com/open-mercato/cezar/pull/2099
Implementation: 87fd5ac5

## Regression proof

Focused command: `env -u CEZ_INSTANCE_ID TMPDIR=/tmp TMP=/tmp TEMP=/tmp timeout 120 npm test -- packages/cezar/src/skills-update-lock-ownership.test.ts packages/cezar/src/skills-update.test.ts` — 30/30pass (9dedicated+21existing). Coverage includes stale metadata reclaimers, expired owner release, inclusive two-minute metadata boundary/dead legacy owner, failed guard, dead choosing/ticket/staged/released claims, unrelated cache files, old LIVE claims, EPERM, normal separate-process exclusion, and the M1 abandoned-guard interleaving.

First five cases, unchanged assertions against original main source via source-only stash: exit1,3failed/2passed, reproducing peak2commands and successor ENOENT. Guard-failure contract is the third red case; legacy and ordinary exclusion cases pass both ways.

Independent review found M1 in first implementation31297f61: proper-lockfile's stale rmdir can erase a fresh guard. The new executable M1 case fails that implementation with bothCommandsRunning=true before either worker finishes; revised protocol passes, preserves successor metadata and excludes a third process. Only the initial abandoned fixture is aged; subsequent active replacements are production code. Children are real Node processes with 8s kill bounds, injected commands and cleanup. No real npx/network call. No assertions weakened.

## Ordered gate

Each command uses `env -u CEZ_INSTANCE_ID TMPDIR=/tmp TMP=/tmp TEMP=/tmp timeout 600`. Only inherited runner instance identity is cleared. Initial read-only scan lacked vitest; npm ci subsequently succeeded. First M1 typecheck found test-helper typing errors, fixed without assertion changes. First broad rerun hit untouched Codex143 teardown timing assertion; its source/test match main, and combined isolated65cases (30skills+35Codex) pass. The final complete ordered rerun is recorded below; no unrelated product/test workaround.

| Command | Final result |
|---|---|
| npm run typecheck | PASS0 |
| npm test | PASS0,15331passed/8existing skips |
| npm run test:unit | PASS0,51passed |
| npm run build | PASS0,including check:pack |
| npm run test:package | PASS0,34passed |

No separate lint/resolution script is configured; manifests/lock unchanged. `git diff --check` passes. No UI changed; no screenshot applicable. Independent M1 re-review APPROVE at efe148bd: M1 resolved, not waived; no remaining blocker/major within documented boundary. GitHub rejected bot self-approval, so the review is COMMENTED; native/QA approval remain absent.

## Guard protocol and limits

Unique PID/UUID claims follow choosing/ticket order, documented and linked to the primary algorithm reference in the plan. Each slot has one writer; ready/released values publish by atomic rename of that attempt's own staging file. Only dead or released unique names are pruned. There is no shared guard pathname deletion. Released markers allow recovery after an unlink failure even while PID lives. Busy/choosing waits are bounded; timing never establishes exclusion.

Directory persists empty and is reconstructible. A LIVE mutator is not expired by age; its short file-only section must finish or PID die. npx is outside the guard. Original two-minute METADATA owner expiry and legacy PID/timestamp lines remain; UUID guards release. Same-PID-namespace local filesystem visibility/atomic entry operations are assumed. PID reuse can conservatively delay an orphan; mixed versions, noncooperating writers and hostile parent directories/incoherent network filesystems are outside guarantee. CodeQL31 metadata read is unchanged (existingPR2096).

Newest release0.19 contains the same main bug; backport requested. No dependency/settings/workflow/env/default/API/telemetry change. No main-fixed or analyzer-closure claim. All61 source alerts remain open pending merged fixes/rescan; one group handled by this PR, other candidates deferred. No issue, merge, auto-merge, alert dismissal or release.

## Independent approval and parent acceptance

[Authoritative re-review](https://github.com/open-mercato/cezar/pull/2099#pullrequestreview-5863795199) independently reproduced original two defects and M1 red on prior source, restored final source, passed all five ordered gates and focused65cases. It killed actual choosing/ready processes, verified refusal while live and recovery after death, then ran six processes/120attempts with19entries/101refusals/zerooverlaps, every worker progressing and no retained claims.

Parent verified reviewed source hash/exact head/inherited claim, inspected report/probes and empty child source diff, reran focused30PASS and the executable crash/contention probe: again19entries/101refusals/zerooverlaps with all claims/children cleaned. No source/test change followed review. Only tracking documents record this acceptance.

[QA instructions](https://github.com/open-mercato/cezar/pull/2099#issuecomment-6804371150) are posted. No browser UI changed. QA/platform/manual checks, eligible native GitHub approval and current-head CI still gate merge. All reported checks at reviewed code head succeeded/skipped; bookkeeping may start new checks. This run does not wait for or promise further CI follow-up.

Final authenticated inventory still has50Dependabot+11CodeQL and unchanged main9cbdd888. No duplicate exact-source30PR exists. This run handles one group via PR2099;44identities have prior existingPR coverage and16are deferred (12dependency identities across seven groups; CodeQL34/42/62/86). Earlier missing atomic operations were resolved for this run via installed protocol; they are not claimed as a continuing blocker. Other candidates need their own confirmed compatible fix/reproduction in later bounded runs; none is marked no-patch or fixed. No advisory selection, issue, merge, auto-merge, alert dismissal, settings or workflow change.
