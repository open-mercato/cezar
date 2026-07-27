/**
 * The active project scope — the cockpit half of the multi-project seam (multi-project spec,
 * step 3.1; the server half is `/api/p/:projectId/*`, step 2.2).
 *
 * Module-level rather than context-threaded on purpose: the API client (client.ts) is a module
 * of plain functions and its private `send()` is the single choke point every request funnels
 * through — threading a React context down into it would mean turning every exported call into
 * a hook. Instead the ProjectScopeProvider (project-scope-context.tsx) writes the scope here as
 * it mounts/changes, and the client reads it per request. One provider per app (it wraps the
 * routed tree), so there is exactly one writer.
 *
 * THE invariant this file exists to keep (spec "URL scheme"): **unscoped means byte-identical
 * request paths to the pre-multi-project cockpit.** With no scope set, `scopeApiPath` is the
 * identity function — every URL is exactly what it was, so the boot project keeps the protected
 * legacy `/api/*` surface (BACKWARD_COMPATIBILITY.md).
 */

let activeProjectId: string | null = null

/** Written by ProjectScopeProvider on mount/param change (and cleared on unmount). Everything
 *  else only reads. */
export function setApiScope(projectId: string | null): void {
  activeProjectId = projectId === '' ? null : projectId
}

export function getApiScope(): string | null {
  return activeProjectId
}

/** The scoped API base — what the context carries and what deep links embed. */
export function apiBase(): string {
  return activeProjectId === null ? '/api' : `/api/p/${encodeURIComponent(activeProjectId)}`
}

/**
 * The leading TanStack Query key segment (queries.ts prepends this to every key so caches never
 * bleed across projects). `'default'` when unscoped — a stable sentinel, and also the server's
 * reserved alias for the boot project, so the segment always *names* the project the data
 * belongs to. A registered project id can never collide with it: `'default'` is a reserved slug
 * server-side.
 */
export function queryScope(): string {
  return activeProjectId ?? 'default'
}

/**
 * Workspace-level routes — single-mount on the server (`app.get`, never mirrored under
 * `/api/p/`), so prefixing them would 404. `/api/workspace/*` (config, ui-state, events),
 * `/api/projects` (the registry, GET + the step 4.2 POST + the step 4.3 `/checkout`),
 * `/api/fs/*` (the folder picker — one filesystem, not one per project), `/api/providers/*`
 * (host credential state shared across projects), and `/api/health` (CORS-open, boot-bound by
 * design).
 */
const WORKSPACE_LEVEL = /^\/api\/(?:health$|models(?:$|[/?])|providers(?:$|[/?])|projects(?:$|[/?])|workspace\/|fs\/)/

/**
 * Prefix a root-relative `/api/...` path with the active project scope.
 *
 * - Unscoped: the identity — byte-identical to today (the critical assertion).
 * - Scoped: `/api/runs/x` → `/api/p/<id>/runs/x`, except workspace-level routes (above) and
 *   paths already scoped (`/api/p/...` — server-minted URLs may one day arrive scoped, and
 *   double-prefixing would corrupt them), which pass through untouched.
 *
 * Applied at request/render time (send(), the EventSources, the image `src`es), never stored —
 * cached data keeps the server's own unscoped URLs and is re-scoped wherever it is used.
 */
export function scopeApiPath(path: string): string {
  if (activeProjectId === null) return path
  if (!path.startsWith('/api/')) return path
  if (path.startsWith('/api/p/')) return path
  if (WORKSPACE_LEVEL.test(path)) return path
  return `/api/p/${encodeURIComponent(activeProjectId)}${path.slice('/api'.length)}`
}
