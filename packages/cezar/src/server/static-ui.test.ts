import { describe, expect, it } from 'vitest';
import {
  ASSET_CACHE_CONTROL,
  BUILD_HINT_HTML,
  assetContentType,
  isSafeAssetFilename,
  resolveGetRequest,
  resolveIndexHtml,
  type GetTarget,
  type IndexTarget,
} from './static-ui.ts';

describe('resolveIndexHtml', () => {
  const cases: Array<{ name: string; distExists: boolean; target: IndexTarget }> = [
    { name: 'built app present → the React cockpit', distExists: true, target: 'dist' },
    // R7 deleted the legacy page: a build-less checkout gets the built-in hint
    // page (spec degradation matrix), never a 404 and never the old UI.
    { name: 'never built → the built-in build-hint page', distExists: false, target: 'build-hint' },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(resolveIndexHtml({ distExists: c.distExists })).toBe(c.target);
    });
  }
});

describe('resolveGetRequest', () => {
  const cases: Array<{
    name: string;
    path: string;
    distExists?: boolean;
    target: GetTarget;
  }> = [
    // Deep links cold-load: every route in the spec's map is the SPA's, not a 404.
    { name: '/ → the shell', path: '/', target: 'dist' },
    { name: '/tasks/x → the shell (deep link)', path: '/tasks/x', target: 'dist' },
    { name: '/tasks/x/changes → the shell (tab in the path)', path: '/tasks/x/changes', target: 'dist' },
    { name: '/settings/skills → the shell', path: '/settings/skills', target: 'dist' },
    // react-router owns the 404 — it is the only side that knows the route map.
    { name: '/nope → the shell, which renders the 404 route', path: '/nope', target: 'dist' },
    // The React composer carries the full bookmarklet auto-start contract
    // (?skill=&ref=&auto=1&key=, BACKWARD_COMPATIBILITY.md) since R4 Step 1.3,
    // and R7 removed the ?legacy=1 escape hatch with the page it pointed at.
    { name: '/new → the shell (React composer owns the bookmarklet contract)', path: '/new', target: 'dist' },
    { name: '/new?legacy=1 has no special meaning — the query is not the path', path: '/new', target: 'dist' },

    // Never shadow the API: an unknown /api path must 404 as JSON, not as HTML.
    { name: '/api/v1/runs → passthrough', path: '/api/v1/runs', target: 'passthrough' },
    { name: '/api/v1/runs/x/events (SSE) → passthrough', path: '/api/v1/runs/x/events', target: 'passthrough' },
    { name: '/api/v1/nope → passthrough, so it keeps its own 404', path: '/api/v1/nope', target: 'passthrough' },
    { name: '/api → passthrough', path: '/api', target: 'passthrough' },
    // …but /api-ish paths that are not the API are just routes.
    { name: '/apidocs → the shell (not an /api path)', path: '/apidocs', target: 'dist' },

    // The static routes registered before the catch-all keep their files.
    { name: '/assets/index-abc123.js → passthrough', path: '/assets/index-abc123.js', target: 'passthrough' },
    { name: '/open-mercato.svg (favicon) → passthrough', path: '/open-mercato.svg', target: 'passthrough' },
    // Passthrough is about ownership, not about the build being there.
    { name: '/assets/x.js with no build → still passthrough', path: '/assets/x.js', distExists: false, target: 'passthrough' },
    // R7: the legacy asset routes are gone — these are SPA paths like any other.
    { name: '/app.js → the shell (legacy route retired in R7)', path: '/app.js', target: 'dist' },
    { name: '/style.css → the shell (legacy route retired in R7)', path: '/style.css', target: 'dist' },

    // No build → the hint page, never a 404: the URL still answers with help.
    { name: '/tasks/x with no build → the build-hint page', path: '/tasks/x', distExists: false, target: 'build-hint' },
    { name: '/ with no build → the build-hint page', path: '/', distExists: false, target: 'build-hint' },
    { name: '/new with no build → the build-hint page', path: '/new', distExists: false, target: 'build-hint' },
    // An /api or asset caller is not a person who could run `npm run build:web`.
    { name: '/api/v1/runs with no build → passthrough, not the hint', path: '/api/v1/runs', distExists: false, target: 'passthrough' },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(resolveGetRequest({ path: c.path, distExists: c.distExists ?? true })).toBe(c.target);
    });
  }
});

describe('BUILD_HINT_HTML', () => {
  it('is a self-contained page naming both build commands', () => {
    // The spec's degradation matrix: "run `npm run dev:web` or `npm run build:web`".
    expect(BUILD_HINT_HTML).toContain('npm run build:web');
    expect(BUILD_HINT_HTML).toContain('npm run dev:web');
    expect(BUILD_HINT_HTML).toContain('<!doctype html>');
    // Built into the server: no external asset may be needed to render it.
    expect(BUILD_HINT_HTML).not.toContain('src=');
    expect(BUILD_HINT_HTML).not.toContain('href=');
  });
});

describe('isSafeAssetFilename', () => {
  const cases: Array<[string, boolean]> = [
    ['index-D1sxO2Tm.js', true],
    ['inter-latin-wght-normal-Dx4kXJAl.woff2', true],
    // basename('..') is '..' — it must never reach readFileSync (EISDIR → 500).
    ['..', false],
    ['.', false],
    ['', false],
    ['../index.html', false],
    ['..\\index.html', false],
    ['sub/dir.js', false],
    ['file\0.js', false],
    // A dotfile is a plain filename; whether it exists is the route's 404 check.
    ['.hidden', true],
  ];

  for (const [file, safe] of cases) {
    it(`${JSON.stringify(file)} → ${safe}`, () => {
      expect(isSafeAssetFilename(file)).toBe(safe);
    });
  }
});

describe('assetContentType', () => {
  const cases: Array<[string, string]> = [
    ['index-D1sxO2Tm.js', 'text/javascript; charset=utf-8'],
    ['index-VovY6R-i.css', 'text/css; charset=utf-8'],
    ['open-mercato-toBr6SOa.svg', 'image/svg+xml'],
    ['inter-latin-wght-normal-Dx4kXJAl.woff2', 'font/woff2'],
    ['logo-abc123.PNG', 'image/png'],
    ['something-abc123.bin', 'application/octet-stream'],
    ['noextension', 'application/octet-stream'],
  ];

  for (const [file, type] of cases) {
    it(`${file} → ${type}`, () => {
      expect(assetContentType(file)).toBe(type);
    });
  }
});

describe('ASSET_CACHE_CONTROL', () => {
  it('marks hashed assets immutable for a year', () => {
    expect(ASSET_CACHE_CONTROL).toBe('public, max-age=31536000, immutable');
  });
});
