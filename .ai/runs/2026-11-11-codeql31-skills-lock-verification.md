# CodeQL31 verification

Security-Source: open-mercato/cezar:code-scanning:31
Security-Fingerprint: js/file-system-race:packages/cezar/src/skills-update.ts:readLockMetadata

Implementation: d5de3db3. Base: 9cbdd8882b6be38936cb37e205d6fd26db2211fc.

## Before and after

The old reader obtains `stat(path).mtimeMs`, then opens the pathname again through `readFile(path)`. Tests replace the actual directory entry between those operations. A live original owner plus a malformed replacement makes the original service incorrectly run an update check (`current`, rather than `unavailable`). The reverse replacement changes the metadata helper's fallback into a different file's live PID/timestamp. These are behavioral failures, not only implementation-shape assertions.

The fixed reader opens once, obtains metadata and contents through that handle, and closes in `finally`. Both replacement tests pass. Dedicated coverage also checks live contention, malformed/read-error fallback, metadata-error degradation, descriptor cleanup, `EPERM` and the inclusive 120000ms stale bound. Existing dead-owner recovery, update/coordinator and API coverage pass.

Before the source fix, the initial six-case suite failed all six cases, including both actual replacement failures above. Four remaining failures checked the newly required descriptor lifecycle. Three additional boundary/EPERM cases were then added. No assertion or existing production behavior was weakened to make the gate pass.

## Commands and results

All commands used Node24 and repository npm workspace tooling. Installation: `timeout 300 env TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm ci --no-audit --no-fund` — passed,536 packages; manifests and lockfile unchanged.

Each test/gate command below was invoked with exactly this prefix:

```text
timeout <seconds> env -u CEZ_INSTANCE_ID TMPDIR=/tmp TMP=/tmp TEMP=/tmp
```

The instance ID is removed only for test subprocesses because it adds an optional health field. `/tmp` keeps filesystem fixtures away from the running agent's real-home temporary directory. No application setting or test assertion changes.

| Seconds | Command | Result |
| ---: | --- | --- |
|120|`npm test -- packages/cezar/src/skills-update-lock-metadata.test.ts` against original source|Fail:6/6, including both directory-entry replacement defects|
|120|`npm test -- packages/cezar/src/skills-update-lock-metadata.test.ts packages/cezar/src/skills-update.test.ts packages/cezar/src/server/skills-update-api.test.ts`|Pass:39 tests, including9 dedicated filesystem cases|
|600|`npm run typecheck`|Pass, all workspaces and release scripts|
|600|`npm test`|Pass:15331 passed,8 existing skips;951 files passed,3 skipped|
|600|`npm run test:unit`|Pass:51|
|600|`npm run build`|Pass, including check:pack|
|600|`npm run test:package`|Pass:34|

The five configured commands ran in the order shown. `git diff --check` passes. No new environment variable, runtime dependency, API/schema, default, setting, workflow or persisted format changed. No audit exception or force upgrade was introduced.

## Scope and residual limits

This proves that metadata and contents describe one opened file. It does not make stale-lock deletion or release atomic against competing replacements, prevent same-inode mutation, or provide a general symlink/parent-directory sandbox. CodeQL30 is not claimed fixed. No local CodeQL analyzer was run; source alert31 remains open on main until merge/rescan. No merge or alert dismissal occurs in this run.

Newest released line `origin/release/v0.19.x` contains the same pathname-stat/pathname-read sequence. Request `backport release/v0.19.x` without pushing that line.

## Review

The authoritative independent implementation review through `om-auto-review-pr2096 --autofix` and `om-code-review` approved exact head `c71cd97425fff319a7501bd70d1ebcefb3751cfa` with zero findings. The reviewer independently repeated all five gates above with the same results,39 targeted tests, and the final nine-case red/green proof:9 fail with original production source;9 pass after exact restoration. No assertion, dependency or source edit by the reviewer; no child commit to merge.

[Published independent code review](https://github.com/open-mercato/cezar/pull/2096#pullrequestreview-5858942626). GitHub refused native self-approval for the shared author bot (`Review Can not approve your own pull request`); the published review is COMMENTED with a clearly stated independent code APPROVE verdict. It is not native approval. [Required QA instructions](https://github.com/open-mercato/cezar/pull/2096#issuecomment-6796277602) remain outstanding. No QA approval or automerge label is granted.

All reported CI checks at the reviewed head were success/skipped, including CodeQL. These results do not predict checks on later documentation commits. No local CodeQL analyzer or native Windows/macOS metadata regression execution is claimed. Final changes after the reviewed head only record evidence/Progress; production source and test bytes remain identical. Final reporting does not wait on CI; native approval, required QA and current-head checks remain merge gates for the maintainer.

## Scan accounting

Authenticated closeout pagination rechecked50 Dependabot and11 CodeQL source identities on unchanged main9cbdd888. This run handles one remediation group/one alert identity (CodeQL31) on PR2096;43 identities already have existing PR coverage;17 are deferred or blocked. Existing coverage is PR1253 (38 Dependabot identities),PR2093 (CodeQL22),PR2091 (24),PR2007 (26/27),PR2008 (29). All61 remain open on main until merge/rescan; no alert is dismissed or described as fixed on main.

The12 uncovered dependency identities remain38,41,52,56,68,69/70/71/72,73/74/75, spanning seven package/manifest groups. Rust tooling/parent-major compatibility and exact npm parent pins/ranges need separate verified resolution. Other deferred CodeQL identities are30,34,42,62,86. No upstream no-patch claim is made. Retrying unchanged blocked candidates needs relevant upstream/code/tooling/authorization changes and fresh ownership checks. Per-run installed atomic claim operations were used only after operator-directed continuation; repository descriptors/settings/workflows stayed unchanged.
