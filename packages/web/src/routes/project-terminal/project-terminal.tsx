import { TerminalIcon } from 'lucide-react'
import { lazy, Suspense, useMemo } from 'react'

import { useHealth } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { LoadingState } from '@/components/loading-state'
import { useActiveProjectId } from '@/lib/project-router'

import { projectTerminalScope } from '../task-workspace/terminal-scope'

/** Lazy: xterm is the heaviest thing a page can load, and the nav item alone must not pay for it. */
const TerminalDrawer = lazy(() =>
  import('../task-workspace/terminal-drawer').then((m) => ({ default: m.TerminalDrawer })),
)

const noop = () => {}

/**
 * The project terminal (#1526): the task drawer's tabs, filling the page, with every shell opened
 * in the project root rather than a task's worktree. Leaving the page keeps the shells running —
 * coming back reattaches, the way reopening a task's drawer does.
 */
export function ProjectTerminalRoute() {
  const projectId = useActiveProjectId() ?? 'default'
  const health = useHealth()
  const scope = useMemo(() => projectTerminalScope(projectId), [projectId])

  // Before health answers nothing is claimed either way; the drawer's own state read is the
  // authority once mounted, and it carries the reason when the PTY cannot load.
  if (health.data && health.data.capabilities.terminal !== true) {
    return (
      <div data-route="terminal" className="flex min-h-full flex-col">
        <CenteredState
          icon={<TerminalIcon />}
          tone="neutral"
          heading="h1"
          title="Terminal disabled"
          subtitle="The terminal is off on this cockpit — it is off in hosted mode unless CEZ_TERMINAL=1."
        />
      </div>
    )
  }

  return (
    <div data-route="terminal" className="flex h-full min-h-0 flex-col pt-1">
      <Suspense fallback={<LoadingState label="Loading terminal…" />}>
        <TerminalDrawer key={scope.key} scope={scope} height={0} onHeightChange={noop} fill />
      </Suspense>
    </div>
  )
}
