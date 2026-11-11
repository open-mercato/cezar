# CodeQL30 verification

Security-Source: open-mercato/cezar:code-scanning:30
PR: https://github.com/open-mercato/cezar/pull/2099
Implementation: 9994c9fc

## Regression proof

`env -u CEZ_INSTANCE_ID TMPDIR=/tmp TMP=/tmp TEMP=/tmp timeout 120 npm test -- packages/cezar/src/skills-update-lock-ownership.test.ts packages/cezar/src/skills-update.test.ts` passes26/26. Five dedicated cases cover stale reclaimers, expired owner release, legacy live boundary/dead owner, guard failure and real separate-Node-process exclusion. No real npx command/network is run.

With source-only `git stash push -- packages/cezar/src/skills-update.ts`, the unchanged final dedicated suite exits1:3failed/2passed. Stale contenders actually run two commands concurrently (peak2 versus1), and the expired owner deletes the successor file (ENOENT). The third failing case is the new guard-failure contract. Legacy liveness and ordinary cross-process exclusion pass both ways. `git stash pop` restores source; focused suite then passes. No assertion weakening.

## Ordered gate

Each command uses `env -u CEZ_INSTANCE_ID TMPDIR=/tmp TMP=/tmp TEMP=/tmp timeout 600`. Only the runner-injected instance identity is cleared; own /tmp is used for fixtures. The initial read-only triage had no installed node_modules and its npm test failed127; npm ci subsequently succeeded before implementation. No failing gate is hidden.

| Command | Result |
|---|---|
| npm run typecheck | PASS0 |
| npm test | PASS0,15327passed/8existing skips |
| npm run test:unit | PASS0,51passed |
| npm run build | PASS0,including check:pack |
| npm run test:package | PASS0,34passed |

`git diff --check` passes. No separate lint/resolution command is configured; manifests/lock/dependencies are unchanged. Built CLI package coverage is included. No UI changed, so no browser screenshot is applicable. Independent code review pending; required QA/native review and GitHub checks are not granted by this evidence.

## Scope and limits

Guard serializes acquisition/reclamation/release among cooperating upgraded processes; release token prevents an expired owner deleting its successor. Existing two-minute live-owner expiry and dead recovery remain. PID/timestamp remain the first two lines; UUID is an extra line ignored by older readers. Old implementations ignore guard/token and can still race with new ones. Arbitrary same-user tampering, parent-directory/hardlink attacks and eliminating overlap after deliberately preserved expiry are not guarantees. Guard contention on release retries briefly, then cleanup is best-effort with existing stale recovery. ReadLockMetadata/CodeQL31 remains unchanged and already has PR2096.

Newest release line0.19 contains the same vulnerable method; backport requested. No settings/workflow/env/default/API/telemetry change. CodeQL scan/main-fixed status is not asserted. All61 source alerts remain open pending merged fixes/rescan; this run handles one group, while other candidates are deferred. No issue creation, merge, auto-merge, alert dismissal or release.
