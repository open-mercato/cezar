# Execution plan — add the missing LICENSE files

**Slug:** `add-license-file`
**Branch:** `fix/add-license-file`
**Base:** `main`
**Engine:** om-auto-create-pr (steps: 4, --loop: no)

## 🎯 Goal

Ship real MIT licence text so GitHub detects the project as MIT-licensed and corporate licence
scanners stop reporting it as unlicensed. MIT is already declared in every `package.json`
(`"license": "MIT"`) and in `README.md` (badge + License section), but a declaration is not
licence *text* — GitHub's licence detection and most SCA/compliance tooling look for a
`LICENSE` file containing the full body, so today the repo reads as "no license" to anyone
evaluating it for adoption.

## Scope

The repository is a **monorepo** (root `cezar-monorepo`, private, publishes nothing; workspaces
`packages/{contract,api-client,cezar,web}`, of which only `@open-mercato/cezar` is publishable).
That shapes the fix into two places:

- `LICENSE` at the **repository root** — what GitHub's licence detection and repo-level scanners
  read. This is the fix the brief asks for.
- `packages/cezar/LICENSE` — npm only includes a `LICENSE` found in the *package's own*
  directory, never one from a monorepo root, so without this the published
  `@open-mercato/cezar` tarball ships with no licence text at all. Same failure, same scanners,
  one file; included deliberately rather than left as a follow-up.

Both carry the verbatim OSI MIT text attributed to the holder already named in `README.md`
("**MIT** © Patryk Lewczuk"), year `2026` (the repository's first and only commit year).
`README.md`'s badge and License section are repointed at the file so a reader lands on the
actual terms.

## Non-goals

- **No re-licensing.** MIT is already declared everywhere; this run only writes down what is
  already true. Nothing that alters the terms is in scope.
- **No per-package LICENSE for the private workspaces** (`contract`, `api-client`, `web`). They
  are `"private": true` and never published, so they have no tarball to license; the root file
  covers them for repo-level scanning.
- **No copyright-header sweep.** Per-file SPDX headers across `packages/*/src` are a separate,
  much larger decision.
- **No `NOTICE`/`THIRD-PARTY` dependency-attribution file.** Useful for compliance, but distinct
  work with its own tooling question.
- **No packaging changes.** `packages/cezar/package.json`'s `files` array is not touched: npm
  includes a package-root `LICENSE` in every tarball regardless of `files`. Step 2.1 verifies
  this against `npm pack --dry-run` rather than assuming it.
- **No sync-script or `check-pack` change.** The repo copies `README.md` into the package at
  `prebuild` (`packages/cezar/scripts/sync-readme.mjs`) to keep one source of truth for a large
  living document. A licence is frozen legal text whose only variable — holder and year —
  changes at most annually, so a committed second copy is the simpler, zero-moving-parts choice
  and matches ordinary monorepo practice. Deliberately rejected, not overlooked: routing it
  through the sync script would add a build step and a `findPackGaps` gate (rippling six unit
  tests) to guard a file that cannot silently disappear.

## Implementation Plan

### Phase 1: Write the licence

- **1.1 Add the root `LICENSE` file.** Verbatim OSI MIT text, `Copyright (c) 2026 Patryk
  Lewczuk`. No wording drift from the canonical text — scanners classify by matching it.
- **1.2 Point `README.md` at the file.** Change the shields badge target from the in-page
  `#license` anchor to `LICENSE`, and expand the License section to link the file explicitly.
- **1.3 Add `packages/cezar/LICENSE`.** Identical text, so the published npm tarball carries the
  licence.

### Phase 2: Verify

- **2.1 Verify tarball + validation gate.** Confirm `npm pack --dry-run -w @open-mercato/cezar`
  lists `LICENSE`, then run the full configured gate (`npm run typecheck`, `npm test`,
  `npm run test:unit`, `npm run build`, `npm run test:package`).

## Risks

- **Low overall.** The change is additive and touches no runtime code path, no build script and
  no packaging manifest.
- **Wrong copyright holder or year** would be the only meaningful defect. Mitigated by taking
  the holder verbatim from `README.md`'s existing declaration and the year from the repository's
  own commit history (first commit 2026), rather than inventing either.
- **Licence-text drift** (a reworded MIT that scanners fail to classify) is mitigated by copying
  the canonical OSI text unmodified into both locations.
- **Two copies could drift** on a future holder/year change. Accepted: the alternative (generate
  the copy at build time) trades a frozen-text duplication risk for real build machinery. Anyone
  changing the holder must update both files.

## Progress

PR: #796

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Write the licence

- [x] 1.1 Add the root `LICENSE` file — 5c398ff3
- [x] 1.2 Point `README.md` at the file — 6edad5f7
- [x] 1.3 Add `packages/cezar/LICENSE` — b34efafa

### Phase 2: Verify

- [x] 2.1 Verify tarball + validation gate — verified on b34efafa (`npm pack --dry-run -w @open-mercato/cezar`: 456 files, `LICENSE` present; gate green — typecheck ✅, `npm test` 5344 passed / 299 files ✅, `test:unit` 36 passed ✅, `build` + `check:pack` ok ✅, `test:package` 12 passed ✅)
