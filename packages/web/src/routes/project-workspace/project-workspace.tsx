import { TerminalIcon } from 'lucide-react'
import { lazy, Suspense, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'

import { useHealth } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { LoadingState } from '@/components/loading-state'
import { useActiveProjectId } from '@/lib/project-router'

import { BrowserView, normalizeAddress, type BrowserState } from '../task-preview/browser-view'
import { projectTerminalScope } from '../task-workspace/terminal-scope'

const TerminalDrawer = lazy(() =>
  import('../task-workspace/terminal-drawer').then((m) => ({ default: m.TerminalDrawer })),
)

const noop = () => {}

/**
 * The project workspace (#1608): the Preview beside the project-checkout terminal, with no run.
 * `?preview=<url>` is untrusted input — it is re-validated here (http/https only) whatever the
 * launcher already checked. Nothing is persisted and nothing is started: the shells are the
 * project terminal's, opened in the project root by the user, and the app is never launched.
 */
export function ProjectWorkspaceRoute() {
  const projectId = useActiveProjectId() ?? 'default'
  const health = useHealth()
  const [params] = useSearchParams()
  const initial = useMemo(() => {
    const raw = params.get('preview')
    return raw ? normalizeAddress(raw) : null
  }, [params])
  const rejected = params.has('preview') && initial === null
  const [browser, setBrowser] = useState<BrowserState>(() => ({ tabs: initial ? [initial] : [], active: 0 }))
  const scope = useMemo(() => projectTerminalScope(projectId), [projectId])
  const terminalAllowed = health.data ? health.data.capabilities.terminal === true : true

  return (
    <div data-route="project-workspace" className="flex h-full min-h-0 flex-col gap-2 pt-1">
      {rejected ? (
        <p role="alert" data-slot="preview-rejected" className="px-3 text-sm text-destructive">
          The preview address was not opened: only http:// and https:// addresses can be previewed.
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col gap-2 lg:flex-row">
        <section data-slot="workspace-preview" aria-label="Preview" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <BrowserView state={browser} onChange={setBrowser} />
        </section>
        <section data-slot="workspace-terminal" aria-label="Terminal" className="flex min-h-0 min-w-0 flex-1 flex-col">
          {terminalAllowed ? (
            <Suspense fallback={<LoadingState label="Loading terminal…" />}>
              <TerminalDrawer key={scope.key} scope={scope} height={0} onHeightChange={noop} fill />
            </Suspense>
          ) : (
            <CenteredState
              icon={<TerminalIcon />}
              tone="neutral"
              heading="h2"
              title="Terminal disabled"
              subtitle="The terminal is off on this cockpit: CEZ_TERMINAL=0, or hosted mode without CEZ_TERMINAL=1."
            />
          )}
        </section>
      </div>
    </div>
  )
}
