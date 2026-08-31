# Installable cockpit: web app manifest and icons

**Date:** 2026-08-31
**Status:** proposed

## TLDR

The cockpit can already be installed as a desktop app today: Chrome's "Install page as app" and
Safari 18's "Add to Dock" both work against `http://localhost:4321`, because localhost is a secure
context. What they produce is a window named after `<title>` wearing the Open Mercato org mark,
because `packages/cezar/web/dist` ships no `manifest.webmanifest`. This spec adds the manifest, the
cezar icon set behind it, and the three server routes that let either be fetched at all — so the
installed window is a cezar app rather than a browser's best guess, and so the same install works
from an iOS home screen against a `server-install` domain.

No service worker, no offline mode, no push.

## Problem Statement

The cockpit is a browser tab. For a tool the README describes as something you leave running and
check on, a tab is the wrong container: it gets lost among the others, it has no Dock or taskbar
presence, and it is not reachable with a window switcher. Every browser that matters already offers
to fix that — Chrome and Edge on macOS, Windows and Linux, Safari 18 on macOS Sonoma and later —
and the fix costs the user two clicks and no code from us.

What the free path produces is the problem. Chrome falls back to the favicon, so the installed app
in `~/Applications/Chrome Apps` wears `open-mercato.svg`, the organization's mark rather than the
product's. There is no `theme_color`, so the window chrome is the browser's default rather than the
cockpit's. There is no `short_name`, so the Dock label is whatever the browser derives from
`<title>` — and the Dock label is manifest-owned, which no amount of runtime `document.title` work
can influence. The install works and looks unfinished, which for a cockpit meant to sit in the Dock
all day is worse than it sounds.

The same manifest is the precondition for the phone half of the same pitch. iOS only treats a site
as an app — and only permits Web Push — once it has been added to the home screen, and that path
reads the icon and name metadata this spec adds. That half additionally needs a reachable HTTPS
origin, which `server-install` already provisions and which no manifest can substitute for; it is
out of scope here.

Closed issue #354 (mobile layout) listed "No PWA/offline support, no native wrappers" as out of
scope. This spec reverses the first half of that line deliberately and narrowly: installability and
icon metadata only, with offline support and native wrappers still excluded, and with the service
worker rejected below on its own merits rather than by inheritance from #354.

## Proposed Solution

**The manifest and icons as `public/` assets.** `packages/web/public/` already holds
`open-mercato.svg` and Vite copies the directory verbatim into `packages/cezar/web/dist`, which the
published `files` list already covers as `web/dist`. Nothing about packaging changes, and
`check:pack` is unaffected: `findPackGaps` asserts `web/dist/index.html` and at least one
`web/dist/assets/*` exist, so it is a presence check, not a whitelist.

`start_url` and `scope` stay relative (`"/"`) so an install pins whichever origin it was performed
from. That is what makes one static file work for `localhost:4321`, for the port cezar falls back to
when 4321 is busy, and for a `server-install` domain, with no build-time knowledge of any of them.

**Three server routes**, because nothing serves these paths today.
`packages/cezar/src/server/static-ui.ts` passes through only `/api/*`, `/assets/*` and
`/open-mercato.svg`. Two of the three new routes are literals registered before the catch-all, so
Hono's first-match-wins already keeps them out of the shell; the `isStaticAsset` entries matter for
the sub-path case — `/icons/a/b.png` matches no route and would otherwise be answered with
`index.html` instead of a 404. Both halves are kept, matching the existing convention.

**The markup.** `packages/web/index.html` gains the manifest link and, in later phases, the Apple
tags and a theme-color meta.

### Alternatives considered

A **service worker with an offline fallback page** was scoped in and then cut. Three reasons, in
descending order of severity. A worker at scope `/` on `http://localhost:4321` outlives the cezar
process and keeps controlling that origin, and 4321 is also Astro's default dev port, so the next
dev server started there would be intercepted by a cockpit that is no longer running. A cached shell
survives an `npx` upgrade and would boot old markup against a new API inside a window with no
address bar to hard-reload from. And the fallback page would claim "cezar isn't running" precisely
when cezar has hopped to 4322 and is running, replacing an ugly true error with a pretty false one.
AGENTS.md's "prefer a proxy-free, daemon-free mechanism" points the same way.

**`vite-plugin-pwa`**, the standard tool for this, is rejected for the same reason: most of what it
buys is Workbox and a generated service worker. Without those it would add a build-time dependency
to `packages/web` in exchange for emitting static files this spec can commit directly.

**Keeping the server alive** (a launchd agent, a `--daemon` mode, a launcher `.app`) addresses the
real complaint behind the offline page — the icon does not start `cez`. It is a better answer than a
nicer error, and it is a different capability; it belongs in its own spec.

**Runtime window-title work** was considered and found already shipped:
`packages/web/src/lib/use-document-title.ts` is wired through `AppShellContainer`, which wraps the
whole app in `app.tsx`, and already yields `"{project} — {page or task} · cezar"`. The Dock and
app-switcher label is a separate, manifest-owned string, so nothing runtime could have changed it.

**Web Push** is blocked on a reachable HTTPS origin rather than on anything here, and on iOS
additionally on the home-screen install this spec enables. Deferred.

**Doing nothing** stays viable and is the honest baseline: the install already works. This spec
makes the result presentable, not possible.

## Research: what comparable projects do

Three choices this spec would otherwise have missed.

**Home Assistant** updates a single `<meta name="theme-color">` at runtime from the active theme
rather than relying on media queries. That is the only way an explicit in-app theme override — a
user forcing light on a dark OS — reaches the window chrome, and it is the pattern adopted below.

**Immich and Nextcloud** ship `purpose: "any"` and `purpose: "maskable"` icons as separate entries.
A single icon declared maskable gets its corners cropped by Android's circular mask; a single icon
declared `any` gets letterboxed inside the mask instead. They are different artwork, not different
sizes of one file.

**The `id` field.** Without it, Chrome derives app identity from `start_url`, so a later change to
`start_url` silently registers a second app rather than updating the first. `id: "/"` pins identity
independently. It does not — and cannot — unify installs across ports, since `id` resolves against
the origin.

Skipped as having no use here yet: `shortcuts`, `share_target`, `file_handlers`, and manifest
`screenshots`.

## Architecture

### Files added under `packages/web/public/`

| File | Purpose |
| --- | --- |
| `manifest.webmanifest` | The manifest itself |
| `cezar-logo.svg` | Scalable `any` icon; the favicon and sidebar tile from Phase 3 on |
| `icons/icon-192.png` | `purpose: "any"`, the size Chrome requires for install |
| `icons/icon-512.png` | `purpose: "any"`, install dialog and high-DPI |
| `icons/icon-maskable-512.png` | `purpose: "maskable"`, full-bleed, art inside the safe zone |
| `icons/apple-touch-icon-180.png` | Safari "Add to Dock" and the iOS home screen (Phase 2) |

The source artwork is a 176×176 SVG: a `#9655fd` rounded-square plate carrying a `#1b1b1b` mark.
Its corners are drawn into the art, which is correct for `purpose: "any"` (desktop platforms apply
no mask of their own) and wrong for the other two. Android's maskable safe zone is the central 80%
of the canvas, and Apple applies its own squircle to a full-bleed square, so both derived assets are
the mark re-composited on an edge-to-edge `#9655fd` field — the maskable one additionally scaled so
the mark clears the safe zone.

**The PNGs are committed, not generated.** The repo has no image toolchain, and adding `sharp` or
`resvg` to `packages/web` to rasterize four files that change when the brand changes trades a build
dependency for nothing. The cost is real: an SVG edit does not propagate, and whoever changes the
mark must re-export. That is the bargain `open-mercato.svg` already lives under.

### Manifest contents

```json
{
  "id": "/",
  "name": "cezar",
  "short_name": "cezar",
  "description": "Local cockpit for running and tracking AI agent tasks in your repo.",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "theme_color": "#0d0d0d",
  "background_color": "#0d0d0d",
  "icons": [
    { "src": "/cezar-logo.svg", "type": "image/svg+xml", "sizes": "any", "purpose": "any" },
    { "src": "/icons/icon-192.png", "type": "image/png", "sizes": "192x192", "purpose": "any" },
    { "src": "/icons/icon-512.png", "type": "image/png", "sizes": "512x512", "purpose": "any" },
    { "src": "/icons/icon-maskable-512.png", "type": "image/png", "sizes": "512x512", "purpose": "maskable" }
  ]
}
```

`theme_color` and `background_color` are the dark tokens (`--background: #0d0d0d`), because dark is
what an unconfigured cockpit paints. The manifest carries one value and cannot follow a preference;
the meta tag is what makes a running window track the user's actual theme.

### Serving

Three route registrations in `packages/cezar/src/server/server.ts`, beside the existing
`app.get('/open-mercato.svg', staticFile(…))`:

| Route | Handler |
| --- | --- |
| `GET /manifest.webmanifest` | `staticFile('manifest.webmanifest', 'application/manifest+json')` |
| `GET /cezar-logo.svg` | `staticFile('cezar-logo.svg', 'image/svg+xml')` |
| `GET /icons/:file` | as `/assets/:file`, reusing `isSafeAssetFilename` and `assetContentType`, reading `web/dist/icons/`, **without** `ASSET_CACHE_CONTROL` |

One param route rather than four literals keeps the guard surface to the one already written and
unit-tested. `ASSET_TYPES` needs no new entry: `png` and `svg` are present, and the two literal
routes name their own content type.

**`ASSET_CACHE_CONTROL` must not reach these routes.** The year-long immutable cache is correct only
for Vite's fingerprinted `/assets/` filenames; these are stable names whose bytes change when the
brand does. They follow the `/open-mercato.svg` precedent and set content-type only.

`open-mercato.svg` and its route stay: `BACKWARD_COMPATIBILITY.md` §2 lists them as a protected
static surface, and this spec only adds beside them. All three new paths join that list — including
`/cezar-logo.svg`, which from Phase 3 is the URL every shipped `index.html` names as its favicon,
exactly the "an OS has written this down" case §2 exists for.

### Theme-color synchronization (Phase 4)

A single `<meta name="theme-color" content="#0d0d0d">` in `packages/web/index.html`, stamped by the
pre-paint script that already computes the light/dark decision from `cez-theme`, and rewritten when
the preference changes at runtime.

The runtime write goes in `theme-provider.tsx`, beside its `applyResolvedTheme` call — **not**
inside `applyResolvedTheme` itself. That function's contract is "stamp the element I hand you"
(`applyResolvedTheme(root: HTMLElement, resolved: ResolvedTheme)`), its header promises no side
effects beyond the two DOM helpers, and every existing test in `theme.test.ts` passes a *detached*
element. Reaching into `document.head` from there would give those tests an untested global side
effect.

Media-qualified meta pairs were the obvious alternative and are insufficient alone: they follow
`prefers-color-scheme`, so a user who explicitly picks light on a dark OS gets a dark title bar.

## Data Model and API contracts

None and none. No new state, no schema, no migration; no `/api` surface changes, so no
`packages/contract` schema and no validator. The new routes are static-file GETs outside the
versioned surface, where `/assets/:file` and `/open-mercato.svg` already live —
`versioned-surface.test.ts` and `bc-route-inventory.test.ts` both filter on the `/api/` prefix and
neither sees them.

## Edge Cases & Failure Scenarios

**No build (`web/dist` missing).** `staticFile` already answers 404 rather than crashing, and
`/icons/:file` does the same via its `existsSync` check. A 404 manifest means the browser silently
declines to offer an install; the shell route continues to serve its build-hint page. This is also
the state of a fresh CI checkout, which constrains how these routes can be tested — see Phase 1
step 5.

**Port fallback.** cezar takes 4321 and walks up to 4370 when it is busy. An install pins the origin
it was performed from, so an app installed at 4321 opens a dead page on a day cezar landed on 4322.
Out of scope by decision, and not fixable in the manifest — `start_url` cannot name a port it does
not know. If it becomes a real annoyance the fix is in `pickPort`, as its own change.

**Hosted mode behind nginx + htpasswd.** The manifest, the icons and `start_url` are all fetched by
the browser under the same basic-auth realm as the page. This needs verifying rather than assuming:
some browsers fetch `start_url` during install in a context that does not carry credentials, which
would show a failed install rather than a broken app. An acceptance check on a hosted instance, not
a blocker for the local path.

**Two marks disagreeing.** Phase 1 puts the cezar mark in the installed app icon while the tab
favicon and the sidebar tile stay Open Mercato. That is a deliberate, visible inconsistency for as
long as Phase 3 has not shipped, and it is why Phase 3 changes both call sites together rather than
just the favicon.

## Risks & Impact Review

**Blast radius: small and additive.** Six new files, three new routes, a handful of lines of markup,
one statement in the pre-paint script and one in `theme-provider.tsx`. No existing route, response
shape, state file or CLI flag changes. A browser that ignores all of it sees today's cockpit;
deleting the files and registrations returns it there exactly, and users who already installed keep
a working app that falls back to the favicon.

**The validation gate cannot see this feature, and it cannot even see the routes.** CI runs
`npm run typecheck`, `npm run test:unit` and `npm test` *before* `npm run build`, and
`resolveWebDir()` is a private function hardcoded to `<pkg>/../../web` with no injection point. So in
the unit suites `web/dist` does not exist and every one of these routes answers 404. A test asserting
"200 and the right content-type" would fail; a test asserting "no `cache-control` header" would pass
vacuously against that 404, which is worse. This is why no existing test asserts a 200 on
`/open-mercato.svg`. The split the plan uses: pure functions and the missing-build 404 path in the
unit suites, everything requiring bytes on disk in `npm run test:e2e`, which boots a built app.

**The durable commitment.** `BACKWARD_COMPATIBILITY.md` §2 gains three paths, and §2 is a protected
surface: once listed, moving or removing them is breaking. That is the intended bargain — an
installed app's `start_url` and icon URLs are exactly what a user's OS writes down.

## Phasing

Phase 1 stands alone. Phase 2 depends on Phase 1 for the `/icons/:file` route. Phases 3 and 4 are
independent of each other and of Phase 2, and either may ship in any order after Phase 1.

- **Phase 1 — installable identity.** Manifest, `any` and `maskable` icons, the three routes, the BC
  inventory entries. Chrome and Edge install a cezar app on every platform.
- **Phase 2 — Apple.** `apple-touch-icon` and `apple-mobile-web-app-title`. Safari's Add to Dock and
  the iOS home screen match the Chrome result. *Requires Phase 1's `/icons/:file` route; shipped
  alone, the `<link>` would fall through to the catch-all and receive `index.html` as `text/html`.*
- **Phase 3 — brand mark.** Swap the favicon and the sidebar tile from the org mark to the cezar
  mark, resolving the inconsistency Phase 1 introduces. Independent of Phases 2 and 4.
- **Phase 4 — theme-color synchronization.** Independent of everything above: it changes browser
  chrome for users who never install anything (Chrome on Android tints the address bar from it).

### Phase 1 — installable identity

1. **Add the artwork.** Commit `packages/web/public/cezar-logo.svg` (source:
   `/Users/maciejgren/Documents/cezar-logo.svg`, 176×176) and `icon-192.png`, `icon-512.png`,
   `icon-maskable-512.png` under `packages/web/public/icons/`. Add
   `packages/web/public/icons/README.md` recording that they are exported by hand from the SVG and
   must be re-exported when the mark changes.
   *Verify:* a unit test reading each PNG's IHDR chunk (bytes 16–25, no dependency) and asserting
   exact width, height, and colour type 6 (RGBA) — so a wrong-sized or accidentally-greyscale export
   fails the build. Corner opacity is not machine-checked here; it is a manual check in step 8.
2. **Write `packages/web/public/manifest.webmanifest`** with the contents above.
   *Verify:* a unit test `JSON.parse`s the file and asserts `id`, `name`, `short_name`, `start_url`,
   `scope`, `display`, and that the icon list contains a 192 and a 512 with `purpose: "any"` plus one
   with `purpose: "maskable"`, and that every `src` resolves to a file that exists in `public/`.
3. **Teach `static-ui.ts` the new paths.** Extend `isStaticAsset` with
   `path === '/manifest.webmanifest'`, `path === '/cezar-logo.svg'` and `path.startsWith('/icons/')`.
   *Verify:* cases in `static-ui.test.ts` asserting `resolveGetRequest` returns `'passthrough'` for
   `/icons/a/b.png` — the sub-path that no route matches and that this entry exists for — and still
   returns the shell for the lookalike `/iconsomething`.
4. **Register the three routes in `server.ts`** per the table above.
   *Verify:* a unit test asserting the routes reached Hono's table (`app.routes` contains each path)
   and that `/icons/..` and `/icons/nope.png` answer 404 — both true without a build.
5. **Assert the served bytes in the e2e suite.** In `packages/web/e2e/`, which boots a built app via
   `.ai/scripts/e2e.sh`, assert 200 plus `application/manifest+json` for the manifest, 200 plus
   `image/png` for `/icons/icon-192.png`, and that neither response carries `cache-control`.
   *Verify:* the assertions run against a real 200, so the header-absence check is meaningful rather
   than vacuous.
6. **Link the manifest** in `packages/web/index.html`:
   `<link rel="manifest" href="/manifest.webmanifest">`.
   *Verify:* an assertion over `index.html` that the link is present and its `href` is a served path.
7. **Append the three paths to `BACKWARD_COMPATIBILITY.md` §2** in the static/GUI line.
   *Verify:* extend `bc-route-inventory.test.ts`, which already reads the document from `REPO_ROOT`,
   with one `expect(doc).toContain(path)` per new route — three lines that pin the commitment instead
   of leaving §2 unchecked for static paths.
8. **Manual acceptance.** After `npm run build`, with the cockpit running: Chrome → Install page as
   app; confirm the app lands in `~/Applications/Chrome Apps` with the cezar mark, the Dock label
   reads "cezar", the window opens without browser chrome, and the maskable icon shows no
   transparent corners under a circular mask (Chrome DevTools → Application → Manifest previews it).

### Phase 2 — Apple

9. **Add `packages/web/public/icons/apple-touch-icon-180.png`**, full-bleed on `#9655fd` so Safari's
   squircle exposes no transparent corners.
   *Verify:* extend step 1's IHDR test with the 180×180 entry.
10. **Add the tags** to `packages/web/index.html`:
    `<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png">` and
    `<meta name="apple-mobile-web-app-title" content="cezar">`.
    *Verify:* extend step 6's index.html assertion.
11. **Manual acceptance.** Safari → Share → Add to Dock; confirm the Dock icon is the cezar mark and
    the label reads "cezar". On a `server-install` domain, add to the iOS home screen and confirm the
    same, and that the manifest and `start_url` fetch cleanly through basic auth (the risk above).

### Phase 3 — brand mark

12. **Point the favicon at the cezar mark** in `packages/web/index.html`
    (`<link rel="icon" href="/cezar-logo.svg">`), and replace the stale comment above it — it claims
    the logo is bundled out of `web/` rather than copied from `public/`, which stopped being true
    when `public/` appeared.
    *Verify:* extend step 6's assertion to pin the new `href`.
13. **Point the sidebar tile at the same file.** `brandLogoUrl` in
    `packages/web/src/components/app-shell.tsx`, and update the comment block above it, which names
    `/open-mercato.svg` as "the favicon index.html points at" and goes stale in this commit.
    *Verify:* a render assertion that `BrandTile` uses `/cezar-logo.svg`.
14. **Manual acceptance.** Tab favicon, sidebar tile and installed app icon all show the same mark.
    `/open-mercato.svg` still answers 200 — it stays served for BC §2.

### Phase 4 — theme-color synchronization

15. **Add the meta tag and stamp it before first paint.** `<meta name="theme-color" content="#0d0d0d">`
    in the head, and one more statement in the existing pre-paint IIFE setting its `content` from the
    `light` boolean it already computes. Extract that IIFE's decision into a testable function rather
    than leaving it inline — nothing in the repo currently executes that script, so an inline-only
    change is unverifiable.
    *Verify:* a unit test over the extracted decision for `cez-theme` values `light`, `dark`,
    `system` (both OS preferences) and an unrecognized value.
16. **Keep it in sync at runtime** in `packages/web/src/components/theme-provider.tsx`, beside the
    existing `applyResolvedTheme(root, resolved)` call — not inside that function, for the
    contract reason given in Architecture. Update index.html's "keep the two in sync" comment to name
    the meta as the third stamped thing.
    *Verify:* a render test that switching the provider's resolved theme rewrites
    `meta[name=theme-color]`.
17. **Cold-load check in the e2e suite.** Seed `cez-theme=light`, load the app, read
    `meta[name=theme-color].content` before any React render.
    *Verify:* this is the only check that separates "the tag is present" from "the tag is right".
18. **Manual acceptance.** In the installed window, switch the cockpit between light and dark and
    confirm the title bar follows, including the case where the in-app choice contradicts the OS.
