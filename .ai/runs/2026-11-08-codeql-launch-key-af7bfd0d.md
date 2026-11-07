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

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Plan
- [ ] 1.1 Establish baseline and publish plan draft.

### Phase 2: Remediation
- [ ] 2.1 Prove regression red, implement fix, and prove green/removal red.

### Phase 3: Validation and handoff
- [ ] 3.1 Run ordered gates and hand off draft with exact evidence.
