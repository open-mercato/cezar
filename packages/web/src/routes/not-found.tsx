import { CompassIcon } from 'lucide-react'
import { CenteredState } from '@/components/centered-state'
import { Link } from '@/lib/project-router'
import { Button } from '@/components/ui/button'

/** The 404. Neutral, not danger — a mistyped URL is a dead end, not a failure of ours —
 *  and the one action is the way home (spec, "Routing": unknown routes → CenteredState 404
 *  with a "Back to tasks" action). */
export function NotFoundRoute() {
  return (
    <div data-route="not-found" className="flex min-h-full flex-col">
      <CenteredState
        icon={<CompassIcon />}
        tone="neutral"
        title="Page not found"
        subtitle="Nothing lives at this address. The link may be mistyped, or it points at something that is gone."
        actions={
          <Button asChild variant="outline">
            <Link to="/">Back to tasks</Link>
          </Button>
        }
      />
    </div>
  )
}
