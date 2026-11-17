import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiRun, ThreadStatus } from '@open-mercato/cezar-api-client'
import { continueRun, getThreadStatus } from '@/api/client'
import { queryKeys } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Markdown } from './markdown'

export function ThreadHygienePanel({ run }: { run: ApiRun }) {
  const [saved, setSaved] = useState<ThreadStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const query = useQueryClient()
  const pending = run.threadHygiene?.pending
  const act = async (action: 'continue' | 'handoff') => {
    setBusy(true); setError('')
    try {
      await continueRun(run.id, { threadDecision: { action, expectedCount: run.threadHygiene!.continuations } })
      await query.invalidateQueries({ queryKey: queryKeys.runs.all })
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <section data-slot="thread-hygiene" className="rounded-md border border-border p-3 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={async () => {
        setBusy(true); setError('')
        try { setSaved(await getThreadStatus(run.id)) }
        catch (error) { setError(error instanceof Error ? error.message : String(error)) }
        finally { setBusy(false) }
      }}>Status — no agent call</Button>
      <span className="text-muted-foreground">Work continuations: {run.threadHygiene?.continuations ?? 'no data'}{run.threadHygiene && !run.threadHygiene.historyKnown ? ' since tracking began; earlier history unknown' : ''}</span>
    </div>
    {pending ? <div className="mt-2" role="status">
      <p>Another work continuation needs your decision. Reports from subtasks are retained; active subtasks keep running. Budgets and approvals still apply.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={() => act('continue')}>Continue work</Button>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => act('handoff')}>Prepare handoff</Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Use the composer to continue with your own instruction. Preparing a handoff runs the agent; successor creation is a separate action.</p>
    </div> : null}
    {error ? <p role="alert" className="mt-2 text-danger">{error}</p> : null}
    {saved ? <div className="mt-3">
      <p>Saved state: {saved.status}. Notes updated: {saved.contentUpdatedAt ? new Date(saved.contentUpdatedAt).toLocaleString() : 'no data'}.</p>
      {saved.handoff.trim() ? <Markdown>{saved.handoff}</Markdown> : <p>No saved result, blockers or next step available.</p>}
    </div> : null}
  </section>
}
