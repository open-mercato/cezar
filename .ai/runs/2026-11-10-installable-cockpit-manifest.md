# Installable cockpit: web app manifest (#1762)

Issue: #1762 (scope + triage comment). Prior design reference: closed spec PR #944.

## Goal

Let the cockpit be added to a phone's home screen (and installed on desktop) and open like an app,
landing on the last project, without a service worker.

## Scope

- `packages/web/public/manifest.webmanifest` — name, `display: standalone`, `start_url: "/"`
  (the bare root already restores `cez-last-location`), dark theme/background colors, icons.
- PNG icons rasterized once from `public/icon.svg` and committed: 192 + 512 (`any`), 512
  `maskable`, 180 `apple-touch-icon`.
- `index.html`: `<link rel="manifest" crossorigin="use-credentials">` (remote mode behind an
  authenticated proxy), `apple-touch-icon`, `apple-mobile-web-app-title`, `theme-color` meta
  stamped by the pre-paint script and kept in sync by `ThemeProvider`.
- Server: `/manifest.webmanifest` (`application/manifest+json`) and `/icons/:file` routes,
  `isStaticAsset` entries, BC §2 inventory.
- Package gate: `findPackGaps` and the packaged-CLI test require the manifest and icons.

## Non-goals

Service worker (none, so nothing caches `/api/*`), offline mode, push, brand-mark changes,
port-fallback handling, changes to remote-mode auth.

## Risks

- Manifest `theme_color` is one value; the meta tag carries the live theme.
- iOS home-screen apps get their own storage, so the first launch lands on the boot project.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Manifest, icons and serving

- [ ] 1.1 Add manifest and PNG icons with asset tests
- [ ] 1.2 Serve the manifest and icons from the server
- [ ] 1.3 Link manifest, Apple tags and theme-color in index.html and ThemeProvider
- [ ] 1.4 Require manifest and icons in the package gate and BC inventory

### Phase 2: Validation

- [ ] 2.1 Full validation gate
