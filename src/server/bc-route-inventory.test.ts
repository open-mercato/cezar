import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The `BACKWARD_COMPATIBILITY.md` §2 route inventory drift guard (#525 Phase 3).
 *
 * §2 declares the cockpit's HTTP API a protected surface consumed by saved bookmarklets and by
 * anyone scripting `localhost:4321`. But the inventory is prose, and the repo has no linter, no
 * markdown check and no link checker — so nothing verified the list matched reality. It didn't:
 * `GET /api/github/comments/:kind/:number` (#499), `GET /api/worktrees` and
 * `POST /api/worktrees/reclaim` had all drifted out of it.
 *
 * This test is the cause fix rather than the instance fix. It would have caught each of those
 * omissions on the commit that introduced them.
 *
 * Two things make it non-trivial, and both are why a substring match would not do:
 *
 * 1. The inventory **brace-compresses** groups — `/api/repo/{diff,changes}` stands for two paths
 *    and `/api/runs/:id/{cancel,…,git/push}` for eleven. They need expanding before comparison.
 * 2. Path params are spelled inconsistently across the two files, so both sides are normalized to
 *    a positional placeholder before being compared.
 *
 * SCOPE LIMIT worth knowing before trusting the inventory: this only sees paths registered as
 * `app.get('…')`/`api.post('…')`/… An **upgrade-only** endpoint has no such registration — the
 * `/api/ws` subscription bus (spec `2026-07-23-websocket-subscriptions.md`) is attached to the
 * raw http server's `upgrade` event, not to Hono — so it is inventoried by hand in §2 and this
 * guard can never catch it drifting. Any future upgrade route needs the same manual entry.
 */

const REPO_ROOT = join(import.meta.dirname, '../..');

/** `/api/repo/{diff,changes}` → [`/api/repo/diff`, `/api/repo/changes`]. Handles one brace group
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

/** Every legacy `/api/*` path registered in server.ts. Project routes are declared on the `api`
 *  sub-app and mounted at `/api` (plus the scoped mirror), while workspace routes are declared
 *  directly on `app`. `use` is deliberately excluded — middleware is not a callable route. */
export function registeredApiRoutes(source: string): Set<string> {
  const out = new Set<string>();
  const re = /\b(app|api)\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const receiver = m[1]!;
    const declaredPath = m[3]!;
    const path = receiver === 'api' ? `/api${declaredPath}` : declaredPath;
    if (path.startsWith('/api/')) out.add(normalizePath(path));
  }
  return out;
}

/** Every `/api/*` path named in the §2 section, brace-expanded and normalized. */
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
      if (clean.startsWith('/api/')) out.add(normalizePath(clean));
    }
  }
  return out;
}

describe('BACKWARD_COMPATIBILITY.md §2 route inventory', () => {
  const source = readFileSync(join(REPO_ROOT, 'src/server/server.ts'), 'utf8');
  const doc = readFileSync(join(REPO_ROOT, 'BACKWARD_COMPATIBILITY.md'), 'utf8');

  it('lists every /api/* route registered in server.ts', () => {
    const registered = registeredApiRoutes(source);
    const inventoried = inventoriedApiRoutes(doc);
    const missing = [...registered].filter((r) => !inventoried.has(r)).sort();

    expect(
      missing,
      `These /api/* routes are registered in server.ts but missing from the §2 inventory in ` +
        `BACKWARD_COMPATIBILITY.md. §2 calls this surface protected, so an unlisted route is a ` +
        `contract nobody agreed to keep. Add them to the "Routes:" list.`,
    ).toEqual([]);
  });

  it('finds a non-trivial number of routes on both sides — guards against a vacuous pass', () => {
    // Without this, a regex that silently stopped matching would make the guard above pass by
    // comparing two empty sets, which is exactly the failure mode a drift guard must not have.
    expect(registeredApiRoutes(source).size).toBeGreaterThan(40);
    expect(inventoriedApiRoutes(doc).size).toBeGreaterThan(30);
  });

  describe('the helpers it relies on', () => {
    it('expands a brace group into one path per member', () => {
      expect(expandBraces('/api/repo/{diff,changes}')).toEqual(['/api/repo/diff', '/api/repo/changes']);
    });

    it('expands members that themselves contain a slash', () => {
      expect(expandBraces('/api/runs/:id/{cancel,git/push}')).toEqual([
        '/api/runs/:id/cancel',
        '/api/runs/:id/git/push',
      ]);
    });

    it('leaves a brace-free path alone', () => {
      expect(expandBraces('/api/github')).toEqual(['/api/github']);
    });

    it('normalizes differing param names to the same placeholder', () => {
      expect(normalizePath('/api/runs/:id/events')).toBe(normalizePath('/api/runs/:runId/events'));
      expect(normalizePath('/api/github/comments/:kind/:number')).toBe('/api/github/comments/:p/:p');
    });

    it('ignores app.use middleware — it is not a callable route', () => {
      const fake = `app.use('/api/health', mw); app.get('/api/real', h);`;
      expect(registeredApiRoutes(fake)).toEqual(new Set(['/api/real']));
    });

    it('includes project routes mounted from the api sub-app under the legacy prefix', () => {
      const fake = `api.get('/runs/:runId', h); app.route('/api', api);`;
      expect(registeredApiRoutes(fake)).toEqual(new Set(['/api/runs/:p']));
    });

    it('ignores non-/api routes', () => {
      expect(registeredApiRoutes(`app.get('/assets/:file', h); app.get('/api/x', h);`)).toEqual(
        new Set(['/api/x']),
      );
    });
  });
});
