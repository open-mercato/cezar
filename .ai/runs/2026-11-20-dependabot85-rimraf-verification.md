# Mobile minimatch parent-patch verification

Source: open-mercato/cezar:dependabot:85; GHSA-g3hv-75wg-m249; packages/mobile/package-lock.json. Producta87c315114cb143f7d00f24909ff5be3ae43a4c8; baselineef99cc8088f02e8a1f68c7a0e1bfbef8e2b72b14.

## Resolution and compatibility proof
Old installed path: CapacitorCLI8.6.0→rimraf6.1.3→glob13.0.6→minimatch10.2.6. New installed/locked path: unchangedCLI8.6.0→compatible rimraf6.1.4→glob14.0.6→minimatch11.0.9. Existing incoming ranges accept every edge. All installed/locked minimatch copies are outside the alert interval; an independent npm-semver check confirms old10.2.6is vulnerable and new11.0.9is patched. Parent and reviewer independently verify the graph; audit tolerance is not the proof.

Exactly six required transitive lock entries change (rimraf,glob,minimatch,path-scurry,brace-expansion,new@isaacs/nonrecursive-glob-match). Direct manifest/Capacitor versions and root lock remain unchanged; no overrides, added direct pins, dependency-age settings or app/UI edits. Actual Capacitor-resolved rimraf cleanup-glob controls delete matched files/directories, preserve unmatched files and tolerate unmatched globs. These are compatibility controls, not a timed exploit reproduction.

## Validation
Executed independently by parent and reviewer in packages/mobile:

| Command | Result |
| --- | --- |
| `npm run check` | PASS |
| `npm test` | PASS149, including2new cleanup controls |
| `node node_modules/@capacitor/cli/bin/capacitor --version` | PASS8.6.0 |
| `node node_modules/@capacitor/cli/bin/capacitor --help` | PASS |
| `npm ls --all` | PASS |
| `npm audit --json` | PASS0vulnerabilities |

Fresh configured root gate independentlyPASS, IN ORDER: `npm run typecheck`; `npm test`(17,818passed/8existing skips,881seconds,2configured workers,3000second bound); `npm run test:unit`(54); `npm run build`(includingcheck:pack); `npm run test:package`(35). Exact2701root source/config blobs match main/bothPRs (SHA256cc6c115992227ac3d4998100f74efe126f99febc482a95ff009b723e3570a895), so the root gate is reused with this explicit binding; mobile coverage is separate. Initial parent900second timeout/unchanged automation-race failure remains preserved; no source/assertion/gate/config/workflow was weakened.

## Review and current CI follow-up
Initial [authoritative review5998253506](https://github.com/open-mercato/cezar/pull/2365#pullrequestreview-5998253506) found no mobile product defect but requested changes for exact-head CI Mermaid streaming assertion at packages/web/src/routes/task-thread/markdown-mermaid.test.tsx94. That source is unchanged on main/bothPRs. Focused exact test command `npm test -- packages/web/src/routes/task-thread/markdown-mermaid.test.tsx` passes5/5 without exclusions, source or assertions changes. Parent reran failed jobs only in run44795368496, attempt2 **succeeded** at unchanged head8cd02ae04. [Independent approve follow-up](https://github.com/open-mercato/cezar/pull/2365#pullrequestreview-5998419564) resolves the prior blocker. At2026-11-20T19:45:06Z all33current-head checks,18aggregate PR rows and12workflows were quiet,0failed/0pending. The rerun used the same npmtest shard command and assertions;5,644passed/5existing skips. Final bookkeeping pushes may start new pending checks; required current-head CI remains a merge gate. No further CI monitoring is promised.

GitHub rejects native author approval/request-changes; independent verdicts areCOMMENTED and do not grant eligible native approval. Current-head checks/native review still gate merge. Node24/Linux only; no separateNode20/Windows/macOS/iOS/Android/browserQA claim. Release/v0.20.x lacks this mobile lock path, so no backport. No alert dismissal or main-fixed claim, merge, issues, settings/workflow/descriptor/env/default change. Operator continuation's exact run-local canonical atomic protocol was accepted by independent review; claim release uses the exact SHA lease.
