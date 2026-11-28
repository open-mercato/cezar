# Next.js patch verification

Source group: open-mercato/cezar:dependabot:87,89,91,92,93,94,95. Product commit635d186df7605e108904e35ed4b60d0d292b3cd9. Main baselineef99cc8088f02e8a1f68c7a0e1bfbef8e2b72b14.

## Before/after and compatibility
Next16.4.2 fails5of10new security/control cases, with5controls passing. The same cases pass after16.4.5; all7existing compression cases also pass. Both parent and independent reviewer reproduce this red/green result. The cases exercise actual Next image-optimizer SVG rejection, Edge adapter cookie filtering and real-loopback fetched-gzip forwarding. Ordinary raster images, explicit SVG opt-in, bounded AVIF/HEIC signatures and middleware cookie propagation remain covered. Three flaw classes are reproduced; four cache findings are removed by version resolution without separate exploit reproduction.

Installed and all locked Next copies are16.4.5, outside every source interval. Manifest/lock pins agree; only Next/env/matchingSWC patch entries change; root lock, static export and unoptimized-image settings are unchanged. Docs audit is clean. No override or dependency-age setting changed.

## Exact validation commands/results
The independent reviewer freshly ran the configured root gate IN ORDER against this exact product and verified2701identical root workspace/config blobs across main and both remediation branches:

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test` | PASS:17,818passed,8existing skips;881seconds,2configured workers,3000second process bound |
| `npm run test:unit` | PASS:54tests |
| `npm run build` | PASS, including check:pack |
| `npm run test:package` | PASS:35tests |
| `npm --prefix docs/site run test:security` | PASS:17tests |
| `npm --prefix docs/site run check` | PASS |
| `npm --prefix docs/site run typecheck` | PASS |
| `npm --prefix docs/site run build` | PASS:static export |
| `npm --prefix docs/site ls --all` | PASS |
| `npm --prefix docs/site audit --json` | PASS:0vulnerabilities |

Root gate environment clears CEZ_INSTANCE_ID and sets TMPDIR/TMP/TEMP=/tmp. Actual static-preview HTTP checks return200for3docs pages and3scriptassets; process stopped. Source interval checks independently use npm-semver and actual installed resolution, not a baseline-tolerant audit. Node24/Linux only; no separateNode20/Windows/macOS/native/browserQA claim.

The initial parent root attempt hit a900second timeout after a failure in unchanged automation lock code matching existingPR2193; coreunit/build/package passed. No assertion, timeout inside a test, config, workflow or audit exception was changed. The fresh full independent gate above passed. Initial logs remain in task Assets/resumed; successful reviewer commands/results/hashes in resumed/final-review.

## Independent review and limits
[Authoritative review5998249708](https://github.com/open-mercato/cezar/pull/2364#pullrequestreview-5998249708): **approve**, zero actionable blockers on daa5e3c0d808728174ad6b057337248beb09656f. GitHub rejects native author self-approval; the independent verdict is COMMENTED, not eligible native approval. Native review and required current-head CI still gate merge. AllCIpassed at reviewed head; bookkeeping pushes may start pending checks. No merge, alert dismissal or main-fixed claim.

The reviewer accepted the explicit operator continuation's run-local use of exact installed canonical atomic helpers. All four function bodies match the installed implementation, with create-only refs and expected-SHA-lease release. Repository descriptors/settings/workflows are unchanged. Release/v0.20.x has the vulnerableNext16.4.2pin; backport label applied. No UI or public API/state/default/env change; skip-qa is the repository's dependency-only policy, not a QA approval.
