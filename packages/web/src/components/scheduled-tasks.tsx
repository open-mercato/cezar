import { useEffect, useState } from 'react'
import { useLocation } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import type { AutomationListEntry } from '@open-mercato/cezar-api-client'
import { ApiError, deleteAutomation, runAutomationNow, updateAutomation } from '@/api/client'
import { automationsQueryKey, useAutomationsGate, useAutomationsQuery } from '@/routes/automations/use-automations'
import { Link, useNavigate } from '@/lib/project-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { writeClipboard } from '@/lib/clipboard'

/** Task-facing view of composer starts. The implementation's automation terminology stays hidden. */
export function ScheduledTasks({ compact = false, enabled = true }: { compact?: boolean; enabled?: boolean }) {
  const [startedRuns, setStartedRuns] = useState<string[]>([])
  const gate = useAutomationsGate()
  const query = useAutomationsQuery(enabled && gate.known && !gate.off)
  const items = query.data?.automations.filter(a => a.deferredStart) ?? []
  if (!items.length && !startedRuns.length) return null
  return <section aria-label="Scheduled tasks" className={compact ? 'px-2 py-3' : 'border-b p-4 md:px-5'}>
    <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Scheduled · {items.length}</h2>
    {startedRuns.length > 0 && <p role="status">This scheduled task already started. {startedRuns.map((id, index) => <Link key={id} to={`/tasks/${id}`} className="mr-3 underline">View run {index + 1}</Link>)}</p>}
    {compact ? items.map(item => <Link key={item.id} to={`/#scheduled-${item.id}`} className="block truncate rounded px-2 py-1.5 text-sm">◷ {item.name}</Link>) :
      <div className="grid gap-3">{items.map(item => <ScheduledTask key={item.id} item={item} onAlreadyStarted={setStartedRuns} />)}</div>}
  </section>
}
function ScheduledTask({ item, onAlreadyStarted }: { item: AutomationListEntry; onAlreadyStarted: (ids: string[]) => void }) {
  const location = useLocation()
  const state = item.deferredStart!
  const navigate = useNavigate()
  const client = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Keep the revision and submitted definition together for the lifetime of an edit.
  const [editSnapshot, setEditSnapshot] = useState<AutomationListEntry | null>(null)
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const toggleEditing = () => {
    if (editSnapshot) { setEditSnapshot(null); return }
    setDate(item.schedule?.date ?? '')
    setTime(`${String(item.schedule?.hour ?? 0).padStart(2, '0')}:${String(item.schedule?.minute ?? 0).padStart(2, '0')}`)
    setEditSnapshot(item)
    setError('')
  }
  const act = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action() } catch (e) {
      if (e instanceof ApiError && e.runIds?.length) onAlreadyStarted(e.runIds)
      else setError(e instanceof Error ? e.message : String(e))
    }
    finally { await client.invalidateQueries({ queryKey: automationsQueryKey() }); setBusy(false) }
  }
  const claimed = state.runIds.length > 0
  const ambiguous = claimed && state.status === 'failed' && state.failureKind === 'ambiguous'
  const bindingInvalid = state.failureKind === 'binding-invalid'
  const anchor = `scheduled-${item.id}`
  const [open, setOpen] = useState(false)
  // The sidebar links here by hash; a closed <details> would otherwise hide the target.
  useEffect(() => {
    if (location.hash === `#${anchor}`) {
      setOpen(true)
      document.getElementById(anchor)?.scrollIntoView?.({ block: 'nearest' })
    }
  }, [anchor, location.hash, location.key])
  const inlineSkills = item.task.steps?.flatMap(step => step.skill ? [step.skill] : []) ?? []
  const workflowLabel = item.task.workflow ?? (inlineSkills.length ? `Skills: ${inlineSkills.join(', ')}` : 'Inline steps')
  const modelLabel = state.binding.models?.map(m => `${m.step ? `${m.step}: ` : ''}${m.runner} / ${m.model ?? 'Provider default'}`).join('; ') ?? item.task.model ?? 'Resolved step models unavailable'
  const label = state.status === 'failed' ? "Couldn't start" : state.status === 'missed' ? 'Missed' : state.status === 'launching' ? 'Starting…' : state.holdUntil ? 'Waiting for reset' : 'Scheduled'
  return <details id={anchor} open={open} onToggle={e => setOpen(e.currentTarget.open)} className="rounded-lg border p-3">
    <summary className="cursor-pointer text-sm"><span className="font-medium">{item.name}</span><span className="ml-2 text-muted-foreground">{label} · {new Date(state.notBefore).toLocaleString('en-GB', { timeZone: state.timeZone })} · {state.timeZone}</span></summary>
    <div className="mt-3 space-y-3 text-sm">
      <p className="whitespace-pre-wrap break-words">{item.task.prompt}</p>
      <p className="text-muted-foreground">{workflowLabel} · {modelLabel} · {state.binding.accounts.map(a => `${a.runner} / ${a.id}`).join(', ')}</p>
      <p className="text-muted-foreground">The server must be running. This is the earliest start; account holds and queue limits still apply.</p>
      {state.holdUntil && <p>Waiting until {new Date(state.holdUntil).toLocaleString('en-GB', { timeZone: state.timeZone })} for a newer observed reset.</p>}
      {state.error && <p role="status">{state.error}</p>}
      {ambiguous && <p>Check the runs below. Start missing runs creates only the ones that do not exist yet — a run you deleted starts again. Dismiss removes this entry and starts nothing.</p>}
      {state.runIds.map((id, index) => <Link key={id} to={`/tasks/${id}`} className="mr-3 underline">Check run {index + 1}</Link>)}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => writeClipboard(item.task.prompt))}>Copy prompt</Button>
        <Button size="sm" variant="outline" disabled={busy || (claimed && !ambiguous)} onClick={() => void act(async () => { const result = await runAutomationNow(item.id, item.revision); navigate(`/tasks/${result.runId}`) })}>{ambiguous ? 'Start missing runs' : state.status === 'failed' ? 'Retry' : 'Run now'}</Button>
        <Button size="sm" variant="ghost" disabled={busy || claimed || bindingInvalid} onClick={toggleEditing}>Change time</Button>
        <Button size="sm" variant="ghost" disabled={busy || (claimed && !ambiguous)} onClick={() => void act(() => deleteAutomation(item.id, item.revision))}>{ambiguous ? 'Dismiss' : 'Cancel'}</Button>
      </div>
      {editSnapshot && !bindingInvalid && <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); void act(async () => {
        const [hour, minute] = time.split(':').map(Number)
        await updateAutomation(item.id, { expectedRevision: editSnapshot.revision, name: editSnapshot.name, kind: 'schedule', task: editSnapshot.task, schedule: { type: 'once', date, hour: hour ?? 0, minute: minute ?? 0 }, enabled: true })
        setEditSnapshot(null)
      }) }}><label>Date<Input type="date" required value={date} onChange={e => setDate(e.target.value)} /></label><label>Time (server time zone)<Input type="time" required value={time} onChange={e => setTime(e.target.value)} /></label><Button type="submit" disabled={busy}>Save time</Button></form>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  </details>
}
