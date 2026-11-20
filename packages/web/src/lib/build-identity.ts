// The cockpit's build vs the server's: a server left running across an in-place update serves the
// NEW files from disk while its own schemas are old, and a tab left open across a restart is the
// reverse. Both fail as opaque 400s ("Unrecognized key"), so name them once instead.

import { getApiBaseUrl } from '@open-mercato/cezar-api-client'

declare const __CEZ_WEB_BUILD__: string | undefined

/** Must match `BUILD_HEADER` in packages/cezar/src/server/build-identity.ts; the meta regex in `diskBuild` mirrors its `BUILD_META`. */
export const BUILD_HEADER = 'x-cezar-build'

/** `server`: the files on disk are this page's, the process is older — restart it.
 *  `page`: the server moved on and this page is the old one — reload it. */
export type BuildSkew = 'server' | 'page'

// Only a production build defines it (vite.config.ts `buildIdentity`): dev and tests stay silent.
let pageBuild: string | null = typeof __CEZ_WEB_BUILD__ === 'string' ? __CEZ_WEB_BUILD__ : null
let skew: BuildSkew | null = null
/** The server build last judged — one probe per distinct server build, never per response. */
let judged: string | null = null
const listeners = new Set<() => void>()

function publish(next: BuildSkew | null): void {
  if (next === skew) return
  skew = next
  for (const fn of listeners) fn()
}

export function subscribeBuildSkew(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function buildSkew(): BuildSkew | null {
  return skew
}

/** Where the server's own shell lives: under the API base, or null when the bundle is served from
 *  another origin than the service (`cez-api-base`) — then the two builds are independent. */
function serverShellUrl(): string | null {
  const base = getApiBaseUrl()
  if (!base) return '/'
  try {
    if (new URL(base, window.location.href).origin !== window.location.origin) return null
  } catch {
    return null
  }
  return `${base}/`
}

/** The build the shell on disk names right now — read from index.html, never from a cache. */
async function diskBuild(url: string, signal?: AbortSignal): Promise<string | null> {
  const res = await fetch(url, { cache: 'no-store', credentials: 'include', ...(signal ? { signal } : {}) })
  if (!res.ok) throw new Error('Cannot reach the cockpit')
  return /<meta\s+name="cezar-build"\s+content="([^"]+)"/.exec(await res.text())?.[1] ?? null
}

const RELOAD_ATTEMPT = 'cez:build-reload-from'

/** A manual reload came back to the same bundle, as older CezarBot proxies can do. */
export function buildReloadWarning(): string | null {
  try {
    if (pageBuild && window.sessionStorage.getItem(RELOAD_ATTEMPT) === pageBuild) {
      return 'The previous reload returned this old page. In CezarBot, close and reopen this server, then try again. You may need to update CezarBot.'
    }
  } catch { /* Storage is optional; reload never depends on it. */ }
  return null
}

/** Keep the working page on screen until the paired computer can serve a newer shell. */
export async function reloadUpdatedPage(reload = () => window.location.reload()): Promise<void> {
  const shell = serverShellUrl()
  if (!shell) throw new Error('Cannot find the updated cockpit. Reopen this server and try again.')
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 15_000)
  try {
    const disk = await diskBuild(shell, controller.signal)
    if (!disk || disk === pageBuild) throw new Error('The updated cockpit is not ready. Try again after cezar finishes restarting.')
    try {
      if (pageBuild) window.sessionStorage.setItem(RELOAD_ATTEMPT, pageBuild)
    } catch { /* Do not clear cookies, pairing or the server's data store to refresh HTML. */ }
    reload()
  } finally {
    window.clearTimeout(timeout)
  }
}

/** Fed the build header of every API response (api/client.ts). A no-op unless the two builds
 *  differ, and then at most one `GET /` per server build. */
export function noteServerBuild(serverBuild: string | null): void {
  if (!pageBuild || !serverBuild || serverBuild === judged) return
  const shell = serverShellUrl()
  if (!shell) return
  judged = serverBuild
  if (serverBuild === pageBuild) return publish(null)
  const page = pageBuild
  void diskBuild(shell)
    .catch(() => null)
    .then((disk) => {
      if (judged !== serverBuild) return
      // The disk holds this page's build: only the process is behind. Anything else — the disk
      // matches the server, or neither — is fixed (or clarified) by loading the page again.
      publish(disk === page ? 'server' : 'page')
    })
}

/** Tests only: pretend this bundle was built as `id`, and forget every judgement. */
export function resetBuildIdentityForTest(id: string | null): void {
  pageBuild = id
  judged = null
  publish(null)
}
