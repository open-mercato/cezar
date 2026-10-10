import { CircleCheckIcon, CircleXIcon } from 'lucide-react'

import { E2E_SETUP_WORKFLOW_NAME, type ApiRun } from '@open-mercato/cezar-api-client'
import { useE2eStatus } from '@/api/queries'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

/**
 * The last word of an e2e setup task (spec 2026-10-10-e2e-one-click-setup): does e2e work now,
 * and what is left. The transcript ends on collapsed check cards and a dim "run finished", which
 * says nothing to someone who only wanted e2e set up. A setup run can only settle `done`/`review`
 * after both of its check steps passed, so that status IS the verdict.
 */
export function E2eSetupVerdict({ run }: { run: ApiRun }) {
  const settled = run.status === 'done' || run.status === 'review' || run.status === 'failed' || run.status === 'cancelled'
  if (run.workflow !== E2E_SETUP_WORKFLOW_NAME || !settled) return null
  return <Verdict run={run} />
}

function Verdict({ run }: { run: ApiRun }) {
  // Whether the setup's config is in the checkout yet — the difference between "merge it" and
  // "use it". Unknown while loading: the copy then names the merge step, which is never wrong.
  const status = useE2eStatus()
  const landed = Boolean(status.data?.configFile)
  const works = run.status === 'done' || run.status === 'review'
  const failedStep = run.steps.find((step) => step.status === 'failed')
  const settings = <Link className="font-medium underline underline-offset-2" to="/settings/e2e">Settings → End-to-end tests</Link>

  return (
    <div
      data-slot="e2e-setup-verdict"
      data-verdict={works ? 'works' : 'not-working'}
      role="status"
      className={cn(
        'mt-4 flex gap-3 rounded-lg border p-4 text-sm',
        works ? 'border-success/40 bg-success/5' : 'border-danger/40 bg-danger/5',
      )}
    >
      {works
        ? <CircleCheckIcon className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
        : <CircleXIcon className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />}
      <div className="min-w-0">
        <p className="font-semibold">{works ? 'e2e works' : run.status === 'cancelled' ? 'e2e is not set up — the setup was cancelled' : 'e2e is not working yet'}</p>
        {works ? (
          <>
            <p className="mt-1 text-muted-foreground">The config loads and the smoke test passed in a real browser.</p>
            <p className="mt-1">
              {landed
                ? <>It is live in this project: pick the <code>implement-and-e2e</code> workflow for your next task.</>
                : <>One step left: merge branch <code>{run.branch ?? 'of this task'}</code>. Then pick the <code>implement-and-e2e</code> workflow for your next task.</>}
            </p>
          </>
        ) : run.status === 'cancelled' ? (
          <p className="mt-1 text-muted-foreground">Start it again from {settings}.</p>
        ) : (
          <>
            <p className="mt-1 text-muted-foreground">
              {failedStep ? <>“{failedStep.name}” did not pass — its output is above.</> : 'The setup stopped before it could prove e2e works — the reason is above.'}
            </p>
            <p className="mt-1">Continue this task to fix it, or set it up again from {settings}.</p>
          </>
        )}
      </div>
    </div>
  )
}
