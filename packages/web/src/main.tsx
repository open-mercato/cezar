import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setApiBaseUrl } from '@open-mercato/cezar-api-client'
import { App } from './app'
import './styles/index.css'

/**
 * Where the API lives, resolved before anything can fetch.
 *
 * Empty — same origin — is the bundled cockpit's case and the default: the service serves this
 * page and owns `/api/v1/*` under the same authority. The two overrides exist for the case this
 * whole split was for, a cockpit talking to a service somewhere else:
 *
 * - `VITE_CEZ_API_BASE` bakes it in at build time, for a bundle shipped separately.
 * - `<meta name="cez-api-base" content="…">` sets it at RUN time, so an operator can point a
 *   deployed bundle at a different service without rebuilding it. It wins, because the HTML is
 *   served per deployment while the bundle is baked once.
 */
function resolveApiBase(): string {
  const meta = document.querySelector('meta[name="cez-api-base"]')?.getAttribute('content')
  return meta?.trim() || import.meta.env.VITE_CEZ_API_BASE || ''
}

declare global {
  interface Window {
    /** index.html's boot guard: the page's way out when the app cannot run (src/boot-guard.test.ts). */
    __cezBootFallback?: () => void
    __cezBootDone?: () => void
  }
}

// Every file the entry imports has loaded by now: chunk failures from here on are lazyRoute's.
window.__cezBootDone?.()

setApiBaseUrl(resolveApiBase())

const container = document.getElementById('root')
if (!container) throw new Error('cezar: #root container is missing from index.html')

createRoot(container, {
  // React unmounts the whole tree on an uncaught error: say so, with Reload, instead of a black page.
  onUncaughtError(error) {
    reportError(error)
    window.__cezBootFallback?.()
  },
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
