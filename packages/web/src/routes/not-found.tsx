import { CompassIcon } from 'lucide-react'

import { ListEmpty } from '@/components/list-view'
import { Page, PageBody } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Link } from '@/lib/project-router'

/** The 404. Neutral, not danger — a mistyped URL is a dead end, not a failure of ours —
 *  and the one action is the way home (spec, "Routing": unknown routes → a 404 with a
 *  "Back to tasks" action). */
export function NotFoundRoute() {
  return (
    <Page data-route="not-found" width="narrow">
      <PageBody className="flex flex-col justify-center py-10">
        <ListEmpty
          role="alert"
          className="border-0"
          icon={<CompassIcon />}
          title={<h1>Page not found</h1>}
          description="Nothing lives at this address. The link may be mistyped, or it points at something that is gone."
          action={
            <Button asChild variant="outline">
              <Link to="/">Back to tasks</Link>
            </Button>
          }
        />
      </PageBody>
    </Page>
  )
}
