# Execution plan — add the missing root LICENSE file

**Slug:** `add-license-file`
**Branch:** `fix/add-license-file`
**Base:** `main`
**Engine:** om-auto-create-pr (steps: 3, --loop: no)

## 🎯 Goal

Ship a real `LICENSE` file at the repository root so GitHub detects the project as MIT-licensed
and corporate license scanners stop flagging it as "no license". The MIT declaration already
exists in `package.json` (`"license": "MIT"`) and in `README.md` (badge + License section), but
neither is a licence *text* — GitHub's licence detection and most SCA/compliance scanners look
for a root `LICENSE` file containing the full licence body, so today the repo reads as
unlicensed to anyone evaluating it for adoption.

## Scope

- Add `LICENSE` at the repository root: the verbatim MIT licence text, attributed to the
  copyright holder already named in `README.md` ("**MIT** © Patryk Lewczuk"), year `2026`
  (the repository's first and only commit year).
- Make `README.md`'s licence signposting point at that file rather than only at its own
  anchor, so a reader lands on the actual terms.
- Verify the published npm tarball carries the licence too (`npm pack --dry-run`), since the
  same corporate scanners inspect the package, not just the GitHub page.

## Non-goals

- **No re-licensing or licence change.** MIT is already the declared licence in `package.json`
  and `README.md`; this run only writes down what is already true. Anything that would alter
  the licence terms is out of scope.
- **No copyright-header sweep.** Per-file SPDX headers across `src/` are a separate, much
  larger decision and are not part of this run.
- **No `NOTICE`/`THIRD-PARTY` dependency-attribution file.** Useful for compliance, but a
  distinct piece of work with its own tooling question.
- **No packaging changes.** `package.json`'s `files` array is not touched: npm includes a root
  `LICENSE` in every tarball regardless of `files`, so no change is needed and adding one would
  be noise. Step 2.1 verifies this rather than assuming it.
- **No change to `scripts/check-pack.mjs` / `src/pack-check.ts`.** Adding a "LICENSE must be
  packed" gate would ripple through six existing unit-test expectations to guard a failure mode
  npm makes essentially impossible. Recorded here as a deliberate rejection, not an oversight.

## Implementation Plan

### Phase 1: Write the licence

- **1.1 Add the root `LICENSE` file.** Verbatim OSI MIT text, `Copyright (c) 2026 Patryk
  Lewczuk`. No wording drift from the canonical text — scanners match on it.
- **1.2 Point `README.md` at the file.** Change the shields badge target from the in-page
  `#license` anchor to `LICENSE`, and expand the License section so it links the file
  explicitly.

### Phase 2: Verify

- **2.1 Verify tarball + validation gate.** Confirm `npm pack --dry-run` lists `LICENSE`, then
  run the full configured gate (`npm run typecheck`, `npm test`, `npm run test:unit`,
  `npm run build`, `npm run test:package`).

## Risks

- **Low overall.** The change is additive and touches no runtime code path.
- **Wrong copyright holder or year** would be the only meaningful defect. Mitigated by taking
  the holder verbatim from `README.md`'s existing declaration and the year from the repository's
  own commit history (first commit 2026), rather than inventing either.
- **Licence-text drift** (a reworded MIT that scanners fail to classify) is mitigated by
  copying the canonical OSI text unmodified.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Write the licence

- [ ] 1.1 Add the root `LICENSE` file
- [ ] 1.2 Point `README.md` at the file

### Phase 2: Verify

- [ ] 2.1 Verify tarball + validation gate
