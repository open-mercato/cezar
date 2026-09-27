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

- [ ] 1.1 Remap the embedded PNG to black tile + white mark
- [ ] 1.2 Update the brand-asset regression guards

### Phase 2: Validate

- [ ] 2.1 Run the full validation gate
