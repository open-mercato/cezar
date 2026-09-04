import { createContext, useContext, useLayoutEffect, useMemo, type ReactNode } from 'react'

import { API_PREFIX, getApiScope, setApiScope } from '@open-mercato/cezar-api-client'

/**
 * The React face of the project scope (multi-project spec, step 3.1): components read
 * `{projectId, apiBase}` from context; the module-level client seam (project-scope.ts) is kept
 * in sync by the provider. Step 3.2 mounts the provider from the `/p/:projectId` URL param —
 * until then nothing mounts it, the default below applies, and the app is byte-identical to the
 * single-project cockpit.
 */
export interface ProjectScope {
  /** The registered project id from the URL, or null when unscoped (the boot project). */
  projectId: string | null
  /** `/api/p/<id>` when scoped, `/api` when not — for the rare caller that builds URLs itself. */
  apiBase: string
}

const UNSCOPED: ProjectScope = { projectId: null, apiBase: API_PREFIX }

export const ProjectScopeContext = createContext<ProjectScope>(UNSCOPED)

/** The active scope. Outside a provider this is the unscoped default, not an error — that IS
 *  the boot project's normal state until 3.2 mounts the provider. */
export function useProjectScope(): ProjectScope {
  return useContext(ProjectScopeContext)
}

/**
 * Binds the module-level API scope to this subtree's lifetime.
 *
 * The module write happens **during render**, not in an effect: the children's very first render
 * computes query keys (queries.ts reads `queryScope()`), and an effect would run after that —
 * the first paint would fetch under the wrong scope and cache it there. The write is idempotent
 * and derived solely from props, so re-renders (StrictMode's double-invoke included) converge on
 * the same value. The effects below only re-assert it (covering StrictMode's mount–unmount–mount
 * cycle, whose cleanup ran the reset) and reset to unscoped on real unmount.
 *
 * The reset lives in its OWN mount-only effect rather than as the `[projectId]` effect's
 * cleanup, and that split is load-bearing (multi-project spec, step 3.4 — swapping projects
 * from the composer's project pill). React runs every destroy in a commit before any create,
 * and the provider is an ancestor of the subtree the swap remounts: a cleanup here would null
 * the scope *between* the render that set it and the children's mount effects, so the arriving
 * project's very first requests would go out unprefixed and cache under the wrong key. A
 * project change must therefore never run a cleanup — only a real unmount does.
 *
 * Both are LAYOUT effects, and that is the second half of the same rule (#task-detail-404). Every
 * request in this app goes out from a passive effect — TanStack's mount fetch, the EventSource
 * hooks — and React runs every layout effect in a commit (destroys in the mutation phase, creates
 * in the layout phase) before any passive one. Passive effects here would leave two windows where
 * a child fetches with the scope this provider's own cleanup nulled, because a child's create runs
 * BEFORE its ancestor's:
 *
 *   - StrictMode's simulated remount, where the whole subtree's destroys (this reset among them)
 *     run and then its creates — so a thread mounted in the SAME commit as this provider re-fires
 *     its query unprefixed. That is a soft navigation into another project's task: 404, cached
 *     under the correctly-scoped key, and only a reload (where the provider commits with the lazy
 *     route's Suspense fallback, a commit earlier than the route's own) clears it.
 *   - a real unmount+mount of two providers in ONE commit (leaving a project area for another),
 *     where the departing provider's cleanup would land between the arriving one's render and its
 *     children's fetches.
 *
 * As layout effects, the whole dance finishes before the first request of the commit is made.
 */
export function ProjectScopeProvider({
  projectId,
  children,
}: {
  projectId: string | null
  children: ReactNode
}) {
  if (getApiScope() !== projectId) setApiScope(projectId)

  useLayoutEffect(() => {
    setApiScope(projectId)
  }, [projectId])

  // Unmount only — see the note above on why this cannot be the cleanup of the effect above, and
  // why both are layout effects: destroys run before creates, so the re-created `[projectId]`
  // effect re-asserts the scope after this one nulled it, and the whole exchange happens in the
  // layout phase — before the passive effects where every request of the commit is made.
  useLayoutEffect(() => () => setApiScope(null), [])

  const value = useMemo<ProjectScope>(
    // Built from the same prefix the request path uses — the version is one fact, not two.
    () => (projectId === null ? UNSCOPED : { projectId, apiBase: `${API_PREFIX}/p/${encodeURIComponent(projectId)}` }),
    [projectId],
  )
  return <ProjectScopeContext.Provider value={value}>{children}</ProjectScopeContext.Provider>
}
