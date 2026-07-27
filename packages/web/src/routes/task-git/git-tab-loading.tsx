import { LoaderCircleIcon, SearchXIcon, TriangleAlertIcon } from 'lucide-react'
import { Link } from '@/lib/project-router'

import { ApiError } from '@/api/client'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'

import type { RunTab } from '../task-thread/run-header'

/**
 * The Changes/Files tabs' loading + error surfaces, in their own module for the same reason
 * as thread-loading.tsx: they double as the routes' `Suspense` fallbacks (routes.tsx), and a
 * fallback must not import anything from the chunk it is standing in for.
 */
export function GitTabLoading({ tab }: { tab: Exclude<RunTab, 'session'> }) {
  return (
    <div data-route={`task-${tab}`} className="flex min-h-full flex-col">
      <CenteredState
        icon={<LoaderCircleIcon className="motion-safe:animate-spin" />}
        tone="neutral"
        title={tab === 'changes' ? 'Loading changes…' : 'Loading files…'}
        subtitle="Fetching the run record."
      />
    </div>
  )
}

/** The run fetch failed — same grammar as the thread route's error state (task-thread.tsx),
 *  because a dead `/tasks/:id/changes` link deserves the same honesty as a dead `/tasks/:id`. */
export function GitTabLoadError({ tab, error }: { tab: Exclude<RunTab, 'session'>; error: Error }) {
  const notFound = error instanceof ApiError && error.status === 404
  return (
    <div data-route={`task-${tab}`} className="flex min-h-full flex-col">
      <CenteredState
        icon={notFound ? <SearchXIcon /> : <TriangleAlertIcon />}
        tone={notFound ? 'neutral' : 'danger'}
        title={notFound ? 'Task not found' : 'Could not load this task'}
        subtitle={
          notFound
            ? 'No run has this id. It may have been deleted, or the link is from another machine.'
            : error.message
        }
        actions={
          <Button asChild variant="outline">
            <Link to="/">Back to tasks</Link>
          </Button>
        }
      />
    </div>
  )
}
