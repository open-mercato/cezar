# Brand icon: black tile, white mark

## Goal

Recolour the cockpit brand mark (`packages/web/public/icon.svg`) from a purple tile with a black
geometric "C" to a **black tile with a white "C"**, keeping the artwork itself pixel-identical.

## Scope

- `packages/web/public/icon.svg` — the one brand asset, shared by the favicon (`index.html`) and
  the sidebar `BrandTile` (`app-shell.tsx`). Both reference it by URL, so recolouring the file is
  the whole change; no component touches a colour literal for it.
- `packages/web/src/brand-asset.test.ts` — its guard comments and assertions still describe the
  retired purple tile and must move with the asset.

The mark is a raster PNG embedded as a `data:` URI inside the `<svg>` wrapper (it was supplied that
way to preserve the artwork). The recolour therefore happens on the PNG pixels, not on fill
attributes.

### Why a pixel remap is exact here

The source PNG is 704×704 RGBA with only 33 distinct colours: pure tile purple `#9655FD`, pure mark
`#1B1B1B`, the rounded-corner antialiasing (pure purple at partial alpha), and the mark's edge
antialiasing (blends that lie **exactly** on the purple→black line). Every pixel is therefore
`lerp(tile, mark, t)` for some `t`, so remapping each pixel to `lerp(black, white, t)` reproduces
the artwork and its antialiasing without approximation. The conversion asserts this: it measures
each pixel's distance from that line and reports any outlier.

## Non-goals

- Not redrawing the mark as true vector paths — the geometry stays exactly as supplied.
- Not changing the accent/theme tokens in `styles/index.css`; the violet UI accent is unrelated to
  the brand tile and stays as it is.
- Not touching `docs/screenshots/cloud-banner.svg` or any other asset.
- No new asset-pipeline dependency (`sharp`/ImageMagick); the one-off conversion runs on Node's
  built-in `zlib`.

## Implementation Plan

### Phase 1: Recolour the asset

1.1 Remap the embedded PNG to a black tile with a white mark and re-embed it in `icon.svg`,
refreshing the comment that still describes a purple tile.

1.2 Update `brand-asset.test.ts` so its regression guards describe the black/white mark and pin the
new colours rather than the retired purple.

### Phase 2: Validate

2.1 Run the full validation gate (`npm run typecheck`, `npm test`, `npm run test:unit`,
`npm run build`, `npm run test:package`).

## Risks

- **Low.** A single static asset plus its test. The worst case is a visually wrong icon, which the
  rendered before/after check catches immediately.
- On the dark theme the sidebar is `#171717`, so a pure-black tile reads as a near-invisible
  silhouette and the white mark appears to float. That is the literal request; noted on the PR so
  the call is visible rather than silently softened to an off-black.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Recolour the asset

- [x] 1.1 Remap the embedded PNG to black tile + white mark — ed4e5ada
- [x] 1.2 Update the brand-asset regression guards — d356859b

### Phase 2: Validate

- [x] 2.1 Run the full validation gate

## Validation

Gate run in full on `feat/brand-icon-black-tile-white-mark`:

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm test` | 8278 pass, **2 pre-existing failures** (see below) |
| `npm run test:unit` | 36 pass |
| `npm run build` | pass (`check:pack ok — 651 files`) |
| `npm run test:package` | 16 pass |

The two `npm test` failures are `workflows/agent-profile-wiring.test.ts` ("adds NOTHING for the
default account") and `workflows/system-prompt.test.ts` ("without CEZ_FOLLOWUPS the agent is never
told about the inbox"). Both concern agent system-prompt composition and neither reads the brand
asset. Confirmed pre-existing: with the working tree reset to `origin/main`'s content, the same two
tests fail identically (`2 failed | 43 passed`).

The remap's exactness was also checked numerically: the recoloured PNG's opaque tone split is
393,388 black / 91,659 white — the same pixel counts the original had as purple / black.

Note on the environment: this worktree's `node_modules` was empty, so workspace resolution fell
through to the repo-root `node_modules/@open-mercato/*`, whose symlinks point into a deleted
`/tmp/cezar-review-1098-final-*` checkout. That made `npm run typecheck` fail on files outside the
repo entirely. `npm ci` inside the worktree fixes it; the stale root symlinks are untouched by this
run and remain a trap for the next one.

## Visual evidence

`2026-09-27-brand-icon-black-tile-white-mark-artifacts/brand-mark-before-after.png` — the mark
composited over both sidebar backgrounds. Left column before, right column after; top row the dark
sidebar (`#171717`), bottom row the light one (`#fafafa`). Composited rather than screenshotted:
the browser provider was unavailable in this run, and an exact 4×4 box downscale of the 704px
source needs no resampling, so the composite is the real pixels over the real token colours.

It confirms the dark-theme note above: the black tile's edge is only just distinguishable from
`#171717` while the white mark stays crisp, and on light the tile is strong.

## Review

`om-auto-review-pr --autofix` found one blocker, fixed in 51b26ade: the new PNG decoder tripped the
web package's `noUncheckedIndexedAccess`, and CI's typecheck step failed in 29s.

The guards had been written and `npm run typecheck` had passed with them. The suite was then re-run
against `origin/main`'s content to prove the two unrelated failures pre-existing, and restoring
afterwards with `git checkout HEAD -- .` reset the file to the last commit — silently discarding the
uncommitted fixes. The gate was not re-run after the restore, so what was pushed had never been
typechecked in the state it was pushed in.

Worth carrying forward: `git checkout HEAD -- .` is not an undo for "put back what I had"; it is an
undo for "put back what was committed". Comparing against a base branch belongs in a throwaway
worktree, not in the tree holding uncommitted work — and the gate belongs *after* the restore, not
only before it.
