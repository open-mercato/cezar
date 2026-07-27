/** Which browser UI a request for `/` gets.
 *
 *  The React cockpit built to `web/dist` is the only web UI — the legacy
 *  vanilla page (`web/app.js` + friends) was deleted in phase R7 of the spec
 *  `.ai/specs/2026-07-14-cockpit-ui-redesign.md`. A checkout without a build
 *  gets a small built-in hint page (`build-hint`), never a 404.
 */
export type IndexTarget = 'dist' | 'build-hint';

/** Pick the response for `/`, given whether the build exists.
 *
 *  The published tarball always ships `web/dist`, so `build-hint` is a dev-only
 *  state (a fresh checkout that never ran `npm run build:web`) — the spec's
 *  degradation matrix answers it with a plain "run the build" page.
 */
export function resolveIndexHtml(opts: { distExists: boolean }): IndexTarget {
  return opts.distExists ? 'dist' : 'build-hint';
}

/** `passthrough` = not the SPA's to answer: `/api/*` keeps its JSON/SSE behavior
 *  and its own 404s, and the files with dedicated static routes keep being
 *  served by them. */
export type GetTarget = IndexTarget | 'passthrough';

/** Paths owned by routes registered before the catch-all: the built app's
 *  hashed bundles and the favicon. */
function isStaticAsset(path: string): boolean {
  return path.startsWith('/assets/') || path === '/open-mercato.svg';
}

/** Decide what any GET gets, so every route in the spec's map (`/tasks/:id/changes`,
 *  `/settings/skills`, …) cold-loads and survives a refresh — that is what makes a
 *  cockpit URL pasteable.
 *
 *  Unknown paths deliberately resolve to the shell, not a 404: react-router owns
 *  the 404 (it is the only side that knows the route map). Everything the server
 *  itself owns — `/api/*` and the static files above — passes through untouched.
 */
export function resolveGetRequest(opts: { path: string; distExists: boolean }): GetTarget {
  const { path, distExists } = opts;
  if (path === '/api' || path.startsWith('/api/') || isStaticAsset(path)) {
    return 'passthrough';
  }
  return resolveIndexHtml({ distExists });
}

/** The dev fallback page served for every shell route when `web/dist` is
 *  missing (spec degradation matrix: "run `npm run dev:web` or
 *  `npm run build:web`"). Built into the server so it needs no files on disk. */
export const BUILD_HINT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cezar — build the cockpit</title>
<style>
  body { margin: 0; display: grid; place-items: center; min-height: 100dvh;
         font: 15px/1.6 system-ui, sans-serif; background: #101014; color: #e8e8ea; }
  main { max-width: 34rem; padding: 2rem; }
  code { font-family: ui-monospace, monospace; background: #1c1c22; border-radius: 6px; padding: 2px 6px; }
  p { color: #a0a0aa; }
</style>
</head>
<body>
<main>
  <h1>The cockpit isn&rsquo;t built yet</h1>
  <p>This checkout has no <code>web/dist</code>. Run <code>npm run build:web</code>
  and reload — or use <code>npm run dev:web</code> for the live dev server.</p>
</main>
</body>
</html>
`;

const ASSET_TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
  woff: 'font/woff',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
};

/** True only for a plain filename the `/assets/:file` route may serve.
 *
 *  `basename` alone is not a guard here: `basename('..')` is `'..'`, which
 *  joins back to the assets dir itself and turns the route's `readFileSync`
 *  into an EISDIR crash (a 500) instead of a 404. Dot-segments, separators,
 *  and NUL all mean "not a file we ship" — the caller answers 404. */
export function isSafeAssetFilename(file: string): boolean {
  return (
    file.length > 0 &&
    file !== '.' &&
    file !== '..' &&
    !file.includes('/') &&
    !file.includes('\\') &&
    !file.includes('\0')
  );
}

/** Content type for a hashed file under `web/dist/assets/`. */
export function assetContentType(file: string): string {
  return ASSET_TYPES[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

/** Vite fingerprints every filename under `assets/`, so the bytes behind a URL
 *  can never change — cache them for a year. */
export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
