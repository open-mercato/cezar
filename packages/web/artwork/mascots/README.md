# Cezar manager characters

Nine raster characters derived from the owner's three Cezar reference boards. Original PNG cutout atlases live here; deployable WebP parts and portraits live in `src/assets/mascots/`. `prompts.json` records the ImageGen production directions. The final Guardian atlas includes a second pass to remove background contamination.

## Rebuild and preview

From the repository root:

```sh
npm run build:mascots -w @open-mercato/cezar-web
npm run dev:web -- --host 127.0.0.1 --port 5188
```

Open `http://127.0.0.1:5188/mascots.html`. The studio shows each character, nine activities, light/dark canvases, icon sizes, and pause. It is a development review entry point, not an extra production route.

`npm run build` bundles the WebP files through Vite's fingerprinted `/assets/` URLs. Do not change these to root-relative public URLs: the production server serves only its existing static asset route and otherwise returns the SPA shell.

## Animation

`src/routes/manager/mascot-motion.ts` defines poses in a 400×400 rig space. `mascot-renderer.ts` draws independent raster layers: body, two arms/props, two legs, face overlays, and laptop/typing hands. Smooth pose transitions last 220 ms; activity timing is driven by animation frames, not model calls. `ManagerMascot` stops when off-screen, in a hidden document, or under reduced motion. Sidebar icons are static.

Activities: idle, thinking, working, waiting, present, success, alert, walk, and error. Happy, focused, concerned, and excited expressions are available; Analyst retains its glasses while working. Walk is an in-place cycle; the companion stays in the chat header. Success/alert are brief reactions that settle back to the current activity. Historical messages and loading older pages do not replay reactions.

Rive CLI 1.9.1 was evaluated and the raster pilot validated. Its production `.riv` export requires account authentication, so the shipped player is local Canvas2D. There is no Rive runtime, account dependency, remote asset host, full 3D mesh, or cloth simulation. The editable source is the PNG atlas plus the TypeScript rig/pose curves.

## Product integration

`mascot` is an optional closed enum in `packages/contract`. New managers default to `base`; an absent field preserves a legacy avatar. Creation and Persona settings persist the selection. Appearance does not change instructions, permissions, or model choice. Status mapping uses existing manager summaries and message events, with pending approvals/questions and errors taking priority.

## Verification

- Manager engine test was confirmed failing before persistence was added, then passing after the fix.
- `tests/mascot-manager.e2e.ts` covers creation, persistence after reload, and a visible animated canvas from the production build.
- `packages/web/artwork/mascots/studio.e2e.ts` with `e2e.mascots.config.ts` checks every character actually changes pixels, every activity, pause, reduced motion, and mobile overflow. It records review screenshots and a video.
- Runtime-only WebP payload is approximately 3.4 MB for the entire family; only the selected rig is decoded, and small icons use separate portraits.
