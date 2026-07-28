import { useCallback, useMemo } from 'react'
import {
  Link as RouterLink,
  matchPath,
  Navigate as RouterNavigate,
  NavLink as RouterNavLink,
  useLocation,
  useNavigate as useRouterNavigate,
  type LinkProps,
  type NavigateFunction,
  type NavigateOptions,
  type NavigateProps,
  type NavLinkProps,
  type To,
} from 'react-router'

import { useProjectScope } from '@/api/project-scope-context'

/**
 * Scope-aware navigation (multi-project spec, step 3.2): every cockpit route lives under
 * `/p/:projectId/`, but link call sites keep writing the flat paths they always wrote
 * (`to="/new"`, `navigate('/tasks/'+id)`). The wrappers below prefix those targets with the
 * ACTIVE project on the way out, so links stay inside the project the user is looking at.
 *
 * Swapping an import from 'react-router' to this module is the whole migration for a call
 * site — props and semantics are unchanged. Kept mechanical on purpose.
 *
 * The active project comes from `ProjectScopeContext` first (authoritative inside the routed
 * tree) and falls back to the URL's own `/p/:projectId` prefix — the app shell renders OUTSIDE
 * the routes (app.tsx wraps `AppRoutes` in the shell), so its nav has no provider above it but
 * still must generate scoped links. Unscoped (legacy flat URL mid-redirect, or a component
 * test rendering without a prefix) everything is the identity, byte-for-byte.
 */

/** `/p/<id>` at the start of a pathname. One segment, nothing else — `/proxy` must not match. */
const PROJECT_PREFIX_RE = /^\/p\/([^/]+)(?=\/|$)/

/** The project id a pathname is scoped to, or null for legacy flat paths. */
export function pathnameProjectId(pathname: string): string | null {
  const id = PROJECT_PREFIX_RE.exec(pathname)?.[1]
  return id === undefined ? null : decodeURIComponent(id)
}

/**
 * The flat, project-relative pathname — `/p/cezar/git/commits` → `/git/commits`. What the
 * nav's area matching (`activeNavPath`) and route-shaped `matchPath` patterns compare against;
 * they reason about the route map, which is project-agnostic.
 */
export function stripProjectPrefix(pathname: string): string {
  const match = PROJECT_PREFIX_RE.exec(pathname)
  if (!match) return pathname
  const rest = pathname.slice(match[0].length)
  return rest === '' ? '/' : rest
}

function scopePathname(projectId: string, pathname: string): string {
  // Relative targets resolve against the current (already scoped) location; `/p/…` targets are
  // explicit cross-project links. Both pass through untouched.
  if (!pathname.startsWith('/')) return pathname
  if (pathname === '/p' || pathname.startsWith('/p/')) return pathname
  return `/p/${encodeURIComponent(projectId)}${pathname}`
}

/** Prefix a navigation target with a project scope. `null` scope is the identity. */
export function scopeTo(projectId: string | null, to: To): To {
  if (projectId === null) return to
  if (typeof to === 'string') {
    // A string target may carry search/hash (`/skills?skill=x`) — prefixing preserves them.
    return scopePathname(projectId, to)
  }
  if (to.pathname === undefined) return to
  return { ...to, pathname: scopePathname(projectId, to.pathname) }
}

/**
 * The scope every wrapper prefixes with: context when provided, else the URL's own prefix.
 *
 * Exported because links are not the only thing that needs the active project: the bookmarklet
 * generator (step 3.6) bakes it into an absolute URL a browser will open from github.com, and
 * that URL must name the project even for the BOOT project — which mounts UNSCOPED (context
 * `projectId` null) yet still lives under `/p/<boot>/`, so the URL fallback is what answers.
 */
export function useActiveProjectId(): string | null {
  const { projectId } = useProjectScope()
  const { pathname } = useLocation()
  return projectId ?? pathnameProjectId(pathname)
}

/** The step-3.2 helper: turn a flat route target into one scoped to the active project. */
export function useProjectPath(): (to: To) => To {
  const projectId = useActiveProjectId()
  return useCallback((to: To) => scopeTo(projectId, to), [projectId])
}

/** `matchPath` against the flat route map, ignoring any `/p/:projectId` prefix. */
export function useProjectMatch(pattern: string): ReturnType<typeof matchPath> {
  const { pathname } = useLocation()
  return useMemo(() => matchPath(pattern, stripProjectPrefix(pathname)), [pattern, pathname])
}

/** Drop-in `react-router` `Link` that keeps the target inside the active project. */
export function Link({ to, ...props }: LinkProps & { ref?: React.Ref<HTMLAnchorElement> }) {
  const toScoped = useProjectPath()
  return <RouterLink {...props} to={toScoped(to)} />
}

/** Drop-in `NavLink` — the scoped `to` also keeps its own active matching correct. */
export function NavLink({ to, ...props }: NavLinkProps & { ref?: React.Ref<HTMLAnchorElement> }) {
  const toScoped = useProjectPath()
  return <RouterNavLink {...props} to={toScoped(to)} />
}

/** Drop-in `Navigate` for in-tree redirects (`/settings/skills` → `/skills` and friends). */
export function Navigate({ to, ...props }: NavigateProps) {
  const toScoped = useProjectPath()
  return <RouterNavigate {...props} to={toScoped(to)} />
}

/** Drop-in `useNavigate`. Deltas (`navigate(-1)`) pass through; targets get scoped. */
export function useNavigate(): NavigateFunction {
  const navigate = useRouterNavigate()
  const toScoped = useProjectPath()
  return useMemo<NavigateFunction>(() => {
    return ((to: To | number, options?: NavigateOptions) =>
      typeof to === 'number' ? navigate(to) : navigate(toScoped(to), options)) as NavigateFunction
  }, [navigate, toScoped])
}
