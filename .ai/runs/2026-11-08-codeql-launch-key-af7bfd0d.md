# Launch-key descriptor safety

Goal: remediate CodeQL: open-mercato/cezar#28 without changing the bookmarklet key format or boot degradation.
Source doc: .ai/specs/011-bookmarklets.md
Status: in-progress

Fingerprint: packages/cezar/src/server/launch-key.ts:ensureLaunchKey:existsSync/readFileSync/writeFileSync/chmodSync
Base: origin/main a0e39453bce53fd800ece924e7898d269be69bbe (authenticated API verified).
Run: af7bfd0d-87fd-499c-a538-0b39cec1315c

## Scope
Only launch-key.ts, its dedicated test, and this plan. No configuration, dependency, API, workflow or release changes. No issue creation, dismissal, merge, automerge or advisory publication. Parent owns independent final review; PR remains draft.

## Findings and risks
An attacker able to replace state-directory entries can redirect pathname reads to a chosen key, writes to an unrelated file (truncation), or chmod to an unrelated target. The existing existence check does not bind any later operation. A normal private state directory limits exploitability; remote-only access does not establish this precondition.

Use exclusive creation and pinned descriptors; no pathname chmod or truncating open. Preserve persisted regular-file key reuse, empty-file regeneration, 0600 on generated keys, and ephemeral keys on storage failure. Refuse symlink leaf entries. Parent-directory replacement and malicious same-user writers are outside this leaf-entry fix; no claim of filesystem sandboxing.

## Implementation plan
1. Establish baseline and publish this plan in a draft PR after duplicate checks.
2. Add deterministic adversarial tests, prove red on original source, implement descriptor safety, prove green and removal red.
3. Run all five ordered npm gates with CEZ_INSTANCE_ID unset, review scope, recheck duplicates, publish exact evidence and hand off draft to parent review.

## Validation and ownership
Initial ordered baseline attempt without dependencies failed (missing tsc/vitest/tsx); npm ci --no-audit --no-fund installed the lockfile successfully. Baseline gates rerun with dependencies. Evidence logs: /tmp/cez-launch-key-af7bfd0d/.

All open PR bodies, paginated file lists and comments inspected; none edits launch-key. No matching remediation claim; refs/om-locks list empty. Open in-progress items concern unrelated work. No source item is created for this code-scanning alert; claim the new draft PR atomically immediately after creation through the authoritative primary tracker descriptor.

Backport required: identical vulnerable helper is present in origin/release/v0.18.x. Labels requested: bug, security, review, needs-qa, priority-high, risk-high, backport release/v0.18.x (secret handling/state-file hardening).

## Progress

PR: #2004

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Plan
- [x] 1.1 Establish baseline and publish plan draft. — 2177181c

### Phase 2: Remediation
- [x] 2.1 Prove regression red, implement fix, and prove green/removal red. — 3931921d

### Phase 3: Validation and handoff
- [x] 3.1 Run ordered gates and hand off draft with exact evidence. — validated source 3931921d

## Evidence and handoff

Implementation commit: 3931921dfb753aa9ce57758dbddd9d68c7714fab.
Source blob: 1c4ea714c966a4443c1c88c14d128a39bf3b4fdf.
Test blob: 1bd8b58484a6ef9b930084286cf798da2e2fa0b4.
No source/test edits followed the final gate start.

### Security proof

Tests perform actual filesystem operations in unique temporary directories; hooks deterministically replace the entry at creation/write boundaries. Original source yielded four failed/four passing tests in the first suite (`red.log`): chosen-key symlink reuse, dangling-target creation, target truncation, and chmod of a replacement victim. Expanded final suite also detects clobbering a concurrent creator. Guards cover normal/legacy/read-only reuse, exact empty-file regeneration, short writes and non-fatal unusable storage.

Final regression command:
`env -u CEZ_INSTANCE_ID timeout 120 npm test -- packages/cezar/src/server/launch-key.test.ts`
Fixed: exit 0, 11 passed (`green-final.log`).

Independent source-removal replay (final tests unchanged):
```bash
cp packages/cezar/src/server/launch-key.ts /tmp/cez-launch-key-af7bfd0d/fixed-source.ts
git show origin/main:packages/cezar/src/server/launch-key.ts > packages/cezar/src/server/launch-key.ts
env -u CEZ_INSTANCE_ID timeout 120 npm test -- packages/cezar/src/server/launch-key.test.ts > /tmp/cez-launch-key-af7bfd0d/removal-red-final.log 2>&1
# exit 1: five failed, six passed
cp /tmp/cez-launch-key-af7bfd0d/fixed-source.ts packages/cezar/src/server/launch-key.ts
```
The test fixture's short-write flag was added before this final replay and final gates. The old helper still passed six guards; regressions are not green-either-way.

### Ordered final gates

Logs live at `/tmp/cez-launch-key-af7bfd0d/`, `final-1.log` through `final-5.log` in this order. Commands run from repository root, using npm and the default healthy temporary directory. Each exit was 0:

1. `env -u CEZ_INSTANCE_ID timeout 600 npm run typecheck` — passed.
2. `env -u CEZ_INSTANCE_ID timeout 600 npm test` — 14,369 passed, eight skipped; 895 files passed, three skipped.
3. `env -u CEZ_INSTANCE_ID timeout 600 npm run test:unit` — 50 passed.
4. `env -u CEZ_INSTANCE_ID timeout 600 npm run build` — passed, including check:pack (1,286 files; 186 web assets; four skills).
5. `env -u CEZ_INSTANCE_ID timeout 600 npm run test:package` — 34 passed.

`git diff --check` passed. Baseline installed gates also all passed (14,358 Vitest tests; 50 core tests; 34 package tests). An intermediate implementation passed all five too; final rerun followed the short-write refinement. No tests weakened and no environment/configuration changed. Four Unix symlink/permission regression cases are platform-skipped on Windows; all 11 executed here on Linux.

### Publication/claim audit

Final authenticated recheck: main still a0e39453bce53fd800ece924e7898d269be69bbe; alert28 open, no linked PRs in the alert API. There are 143 open PRs (including this one), with no changed competing head since all 142 other file lists/comments were read. Only #2004 carries the exact source marker; the only atomic lock is this run's. No matching remediation was found among open issues or recent repository security claim comments either.

Primary checkout `.ai/trackers/github.md` supplied unchanged get-lock/acquire-lock/release-lock and guarded labels. Acquired `refs/om-locks/pr-2004`, SHA `160e73b5d127c64ae9c9c3a9966497eaf80093e0`, run `af7bfd0d-87fd-499c-a538-0b39cec1315c`, actor `open-mercato-maintenance[bot]`, original comment `6714254477`. Assignment probe explicitly returned 404 for this bot's assignability; no human assignee changed. Exact ref/comment ownership and absence of claim-reset events were reverified before publication. Release after final publication uses expected-SHA Git lease deletion; the original claim comment records the terminal result.

User explicitly assigns independent final review to the parent and prohibits further child tasks. Therefore no child/self-review chain or ready flip was run. Implementation handoff is complete; workflow Status remains in-progress and draft pending the parent's independent review and manual QA. No CI follow-up is promised by this child; parent owns implementation-head CI/CodeQL verification. Alert28 is not declared fixed on main.
