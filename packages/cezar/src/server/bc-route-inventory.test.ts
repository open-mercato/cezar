import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';

/**
 * The `BACKWARD_COMPATIBILITY.md` §2 route inventory drift guard (#525 Phase 3).
 *
 * §2 declares the cockpit's HTTP API a protected surface consumed by saved bookmarklets and by
 * anyone scripting `localhost:4321`. But the inventory is prose, and the repo has no linter, no
 * markdown check and no link checker — so nothing verified the list matched reality. It didn't:
 * `GET /api/v1/github/comments/:kind/:number` (#499), `GET /api/v1/worktrees` and
 * `POST /api/v1/worktrees/reclaim` had all drifted out of it.
 *
 * This test is the cause fix rather than the instance fix. It would have caught each of those
 * omissions on the commit that introduced them.
 *
 * Two things make it non-trivial, and both are why a substring match would not do:
 *
 * 1. The inventory **brace-compresses** groups — `/api/v1/repo/{diff,changes}` stands for two paths
 *    and `/api/v1/runs/:id/{cancel,…,git/push}` for eleven. They need expanding before comparison.
 * 2. Path params are spelled inconsistently across the two files, so both sides are normalized to
 *    a positional placeholder before being compared.
 *
 * The registered side is read off a **built app** (`app.routes`), not off server.ts's source.
 * It used to be a regex over `app.get('…')`/`api.post('…')` statements, which was fine while
 * every route was a statement — but families are being converted to chained sub-app builders
 * (`new Hono().get(…).post(…)`, spec 2026-07-23-independent-server-web-packages) so that Hono
 * can infer the API's types, and a chained registration has no `app.`/`api.` receiver for a
 * regex to find. The regex would not have failed; it would have quietly stopped seeing those
 * routes, which is the one thing a drift guard must never do.
 *
 * SCOPE LIMIT worth knowing before trusting the inventory: this only sees paths Hono knows
 * about. An **upgrade-only** endpoint has no route registration — the `/api/v1/ws` subscription bus
 * (spec `2026-07-23-websocket-subscriptions.md`) is attached to the raw http server's `upgrade`
 * event, not to Hono — so it is inventoried by hand in §2 and this guard can never catch it
 * drifting. Any future upgrade route needs the same manual entry.
 */

const REPO_ROOT = join(import.meta.dirname, '../../../..');

/** `/api/v1/repo/{diff,changes}` → [`/api/v1/repo/diff`, `/api/v1/repo/changes`]. Handles one brace group
 *  per path, which is all the inventory uses. */
export function expandBraces(path: string): string[] {
  const match = /^(.*)\{([^}]*)\}(.*)$/.exec(path);
  if (!match) return [path];
  const [, prefix, inner, suffix] = match;
  return inner!.split(',').map((part) => `${prefix}${part.trim()}${suffix}`);
}

/** `:id`, `:groupId`, `:kind` … all become `:p`, so the two files' naming choices can differ
 *  without the guard caring. */
export function normalizePath(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, ':p').replace(/\/+$/, '');
}

/** One row of `app.routes` — the shape this guard needs from Hono. */
export interface RegisteredRoute {
  method: string;
  path: string;
}

/**
 * Every `/api/v1/*` path a built app answers on, in the spelling §2 inventories.
 *
 * Two kinds of registration are folded away, because §2 lists each route once:
 *   - `method: 'ALL'` — middleware (`app.use`), not a callable route.
 *   - `/api/v1/p/:projectId/…` — the project-scoped mirror of the unscoped spelling, held
 *     identical by `route-parity.test.ts`.
 *
 * There is no unversioned surface left to fold onto: `versioned-surface.test.ts` fails if a
 * route appears outside `/api/v1`, so every path this sees is already the real URL.
 */
export function registeredApiRoutes(routes: readonly RegisteredRoute[]): Set<string> {
  const out = new Set<string>();
  for (const route of routes) {
    if (route.method === 'ALL') continue;
    if (route.path.startsWith('/api/v1/p/')) continue;
    if (route.path.startsWith('/api/v1/')) out.add(normalizePath(route.path));
  }
  return out;
}

/** Every `/api/v1/*` path named in the §2 section, brace-expanded and normalized. */
export function inventoriedApiRoutes(doc: string): Set<string> {
  const start = doc.indexOf('## 2. HTTP API');
  const end = doc.indexOf('\n## 3.', start);
  const section = doc.slice(start, end === -1 ? undefined : end);
  const out = new Set<string>();
  // Paths appear inside backticks, optionally preceded by one or more HTTP verbs.
  for (const [, path] of section.matchAll(/`(?:[A-Z/]+ )?(\/api\/[^`]*)`/g)) {
    for (const expanded of expandBraces(path!)) {
      // A brace group's members can themselves carry a slash (`git/push`), which is fine, but
      // trailing punctuation from prose must not leak in.
      const clean = expanded.trim().replace(/[.,;]$/, '');
      if (clean.startsWith('/api/v1/')) out.add(normalizePath(clean));
    }
  }
  return out;
}

describe('BACKWARD_COMPATIBILITY.md §2 route inventory', () => {
  const doc = readFileSync(join(REPO_ROOT, 'BACKWARD_COMPATIBILITY.md'), 'utf8');

  // A real app, because the route table is what is being inventoried. The deps are the minimum
  // `createApp` needs to build one: no run ever starts here, nothing is requested — the app is
  // only asked what routes it has.
  const repoRoot = mkdtempSync(join(tmpdir(), 'cez-bc-inventory-'));
  const app = createApp({
    repoRoot,
    store: RunStore.open(join(repoRoot, '.ai/cezar')),
    manager: {} as RunManager,
    version: '0.0.0-test',
  });

  it('lists every /api/v1/* route registered in server.ts', () => {
    const registered = registeredApiRoutes(app.routes);
    const inventoried = inventoriedApiRoutes(doc);
    const missing = [...registered].filter((r) => !inventoried.has(r)).sort();

    expect(
      missing,
      `These /api/v1/* routes are registered in server.ts but missing from the §2 inventory in ` +
        `BACKWARD_COMPATIBILITY.md. §2 calls this surface protected, so an unlisted route is a ` +
        `contract nobody agreed to keep. Add them to the "Routes:" list.`,
    ).toEqual([]);
  });

  it('finds a non-trivial number of routes on both sides — guards against a vacuous pass', () => {
    // Without this, a reader that silently stopped seeing routes would make the guard above
    // pass by comparing two empty sets, which is exactly the failure mode a drift guard must
    // not have.
    expect(registeredApiRoutes(app.routes).size).toBeGreaterThan(40);
    expect(inventoriedApiRoutes(doc).size).toBeGreaterThan(30);
  });

  it('sees the chained families, not just the statement-registered ones', () => {
    // The specific regression the app-walk replaced a source regex to prevent: a family
    // converted to a chained builder must stay inventoried.
    const registered = registeredApiRoutes(app.routes);
    for (const path of ['/api/v1/health', '/api/v1/agent-config', '/api/v1/agent-config/:p', '/api/v1/workflows']) {
      expect(registered, `${path} disappeared from the registered set`).toContain(path);
    }
  });

  describe('the helpers it relies on', () => {
    it('expands a brace group into one path per member', () => {
      expect(expandBraces('/api/v1/repo/{diff,changes}')).toEqual(['/api/v1/repo/diff', '/api/v1/repo/changes']);
    });

    it('expands members that themselves contain a slash', () => {
      expect(expandBraces('/api/v1/runs/:id/{cancel,git/push}')).toEqual([
        '/api/v1/runs/:id/cancel',
        '/api/v1/runs/:id/git/push',
      ]);
    });

    it('leaves a brace-free path alone', () => {
      expect(expandBraces('/api/v1/github')).toEqual(['/api/v1/github']);
    });

    it('normalizes differing param names to the same placeholder', () => {
      expect(normalizePath('/api/v1/runs/:id/events')).toBe(normalizePath('/api/v1/runs/:runId/events'));
      expect(normalizePath('/api/v1/github/comments/:kind/:number')).toBe('/api/v1/github/comments/:p/:p');
    });

    it('ignores middleware — an `ALL` entry is not a callable route', () => {
      const fake = [
        { method: 'ALL', path: '/api/v1/health' },
        { method: 'GET', path: '/api/v1/real' },
      ];
      expect(registeredApiRoutes(fake)).toEqual(new Set(['/api/v1/real']));
    });

    it('folds the project-scoped mirror onto the unscoped spelling', () => {
      const fake = [
        { method: 'GET', path: '/api/v1/runs/:runId' },
        { method: 'GET', path: '/api/v1/p/:projectId/runs/:runId' },
      ];
      expect(registeredApiRoutes(fake)).toEqual(new Set(['/api/v1/runs/:p']));
    });

    it('ignores a route outside the version prefix — it is not part of this surface', () => {
      // `versioned-surface.test.ts` is what fails on such a route; inventorying it here would
      // only ask BACKWARD_COMPATIBILITY.md to document something that must not exist.
      const fake = [
        { method: 'GET', path: '/api/legacy-leftover' },
        { method: 'GET', path: '/api/v1/real' },
      ];
      expect(registeredApiRoutes(fake)).toEqual(new Set(['/api/v1/real']));
    });

    it('ignores non-/api routes', () => {
      const fake = [
        { method: 'GET', path: '/assets/:file' },
        { method: 'GET', path: '*' },
        { method: 'GET', path: '/api/v1/x' },
      ];
      expect(registeredApiRoutes(fake)).toEqual(new Set(['/api/v1/x']));
    });
  });
});
