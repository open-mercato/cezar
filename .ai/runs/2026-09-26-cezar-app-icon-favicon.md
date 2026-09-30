# Replace cezar app icon and favicon

Tracking plan: `.ai/runs/2026-09-26-cezar-app-icon-favicon.md`
Engine: om-auto-create-pr (steps: 5, --loop: no)

## Goal

Replace the cockpit brand mark (`packages/web/public/open-mercato.svg`) used as both the sidebar/app icon and the browser favicon with the new purple geometric mark the user provided.

## Scope

- Swap `packages/web/public/open-mercato.svg` while keeping the public URL `/open-mercato.svg` (BACKWARD_COMPATIBILITY + pack-check + static route).
- Refresh comments in `app-shell.tsx` that describe the old lime/yellow gradient tile.
- Add a small unit guard that the brand asset remains a valid SVG and that `index.html` still points the favicon at `/open-mercato.svg`.

## Non-goals

- Renaming the public path away from `/open-mercato.svg`.
- Changing BrandTile layout, size, or chrome beyond the asset itself.
- Updating README screenshots or marketing assets outside the cockpit.

## Implementation Plan

### Phase 1: Brand asset

1. Replace `open-mercato.svg` with the new mark (preserve path and MIME).
2. Update brand-tile comments for the new solid-purple tile.
3. Add a unit test pinning favicon + asset contract.

### Phase 2: Validate

4. Run targeted web/server tests for the brand/static surface.
5. Run the full validation gate.

## Risks

- Raster-in-SVG may be slightly softer at favicon size than a pure vector mark; acceptable to ship the exact provided artwork without rewriting path geometry by eye.
- Cached favicons in browsers may lag until hard-refresh.

## Progress

PR: #1090

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Brand asset

- [x] 1.1 Replace open-mercato.svg with the new mark — 32d47873
- [x] 1.2 Update brand-tile comments for the new tile — 32d47873
- [x] 1.3 Add unit test for favicon + asset contract — 32d47873

### Phase 2: Validate

- [x] 2.1 Run targeted brand/static tests — b94eed80
- [x] 2.2 Run full validation gate — b94eed80
