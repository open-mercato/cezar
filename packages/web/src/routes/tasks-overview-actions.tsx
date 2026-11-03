import * as React from 'react'
import { ArchiveIcon, ArchiveRestoreIcon, EyeIcon, EyeOffIcon } from 'lucide-react'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { canBeUnread, isDoneItem, isUnread } from '@/lib/read-state'
import { runTitle } from '@/lib/task-groups'

export type TasksOverviewAction = 'archive' | 'restore' | 'read' | 'unread'
export type TasksOverviewActionHandler = (run: RunRecord, action: TasksOverviewAction) => Promise<void>

const labels = { archive: 'Archive', restore: 'Restore', read: 'Mark read', unread: 'Mark unread' }

/** Same eligibility as All Tasks and the shared read-state decider (#1599). */
export function taskActionEligible(run: RunRecord, action: TasksOverviewAction): boolean {
  if (action === 'restore') return Boolean(run.archived)
  if (action === 'archive') return !run.archived && isDoneItem(run.status)
  return canBeUnread(run) && isUnread(run) === (action === 'read')
}

export function useTasksOverviewSelection(
  displayed: readonly RunRecord[],
  onAction?: TasksOverviewActionHandler,
) {
  const [ids, setIds] = React.useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState('')
  const locked = React.useRef(false)
  const selected = displayed.filter((run) => ids.has(run.id))
  React.useEffect(() => {
    const visible = new Set(displayed.map((run) => run.id))
    setIds((current) => {
      const next = new Set([...current].filter((id) => visible.has(id)))
      return next.size === current.size ? current : next
    })
  }, [displayed])

  const toggle = React.useCallback((id: string) => {
    if (locked.current) return
    setIds((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])
  const clear = () => { if (!locked.current) setIds(new Set()) }
  const toggleAll = () => {
    if (!locked.current) setIds(selected.length === displayed.length ? new Set() : new Set(displayed.map((r) => r.id)))
  }
  const apply = React.useCallback(async (action: TasksOverviewAction, targets: readonly RunRecord[]) => {
    if (locked.current || !onAction) return
    locked.current = true
    setBusy(true)
    setMessage(`${labels[action]} in progress…`)
    const eligible = targets.filter((run) => taskActionEligible(run, action))
    const succeeded = new Set<string>()
    const failures: string[] = []
    // Sequential requests bound load and keep partial success visible; never retry successful rows.
    for (const run of eligible) {
      try {
        await onAction(run, action)
        succeeded.add(run.id)
      } catch (error) {
        failures.push(`${runTitle(run)}: ${error instanceof Error ? error.message : 'Request failed'}`)
      }
    }
    setIds((current) => new Set([...current].filter((id) => !succeeded.has(id))))
    setMessage(`${labels[action]}: ${succeeded.size} succeeded, ${targets.length - eligible.length} skipped, ${failures.length} failed.${failures.length ? ` ${failures.join('; ')}` : ''}`)
    locked.current = false
    setBusy(false)
  }, [onAction])
  return { ids, selected, busy, message, toggle, clear, toggleAll, apply }
}

export function TaskSelectionCheckbox({ checked, mixed = false, label, disabled, onChange }: {
  checked: boolean
  mixed?: boolean
  label: string
  disabled: boolean
  onChange: () => void
}) {
  const ref = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => { if (ref.current) ref.current.indeterminate = mixed }, [mixed])
  return <input ref={ref} type="checkbox" aria-label={label} checked={checked} disabled={disabled}
    onChange={onChange} className="size-4 shrink-0 cursor-pointer accent-primary focus-visible:outline-2 focus-visible:outline-ring" />
}

export function TasksSelectionToolbar({ displayed, selection, archived }: {
  displayed: readonly RunRecord[]
  selection: ReturnType<typeof useTasksOverviewSelection>
  archived: boolean
}) {
  const { selected, busy } = selection
  const actions: TasksOverviewAction[] = [archived ? 'restore' : 'archive', 'read', 'unread']
  return <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
    <TaskSelectionCheckbox label="Select displayed tasks" checked={displayed.length > 0 && selected.length === displayed.length}
      mixed={selected.length > 0 && selected.length < displayed.length} disabled={busy || displayed.length === 0} onChange={selection.toggleAll} />
    <span>{selected.length > 0 ? `${selected.length} selected` : 'Select tasks'}</span>
    {selected.length > 0 ? <>
      {actions.map((action) => {
        const count = selected.filter((run) => taskActionEligible(run, action)).length
        return <Button key={action} type="button" size="sm" variant="outline" disabled={busy || count === 0}
          onClick={() => void selection.apply(action, selected)}>{labels[action]} ({count})</Button>
      })}
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={selection.clear}>Clear selection</Button>
      <span className="text-xs text-muted-foreground">Only eligible selected tasks are changed; others are skipped.</span>
    </> : null}
    <p role="status" aria-label="Task action status" aria-live="polite" className="w-full empty:hidden text-xs text-muted-foreground">{selection.message}</p>
  </div>
}

export function TaskQuickActions({ run, busy, onAction }: {
  run: RunRecord
  busy: boolean
  onAction: (action: TasksOverviewAction, targets: readonly RunRecord[]) => Promise<void>
}) {
  const actions: TasksOverviewAction[] = [run.archived ? 'restore' : 'archive', isUnread(run) ? 'read' : 'unread']
  const icons = { archive: ArchiveIcon, restore: ArchiveRestoreIcon, read: EyeIcon, unread: EyeOffIcon }
  return <span className="inline-flex shrink-0 items-center gap-1">
    {actions.filter((action) => taskActionEligible(run, action)).map((action) => {
      const Icon = icons[action]
      const label = `${labels[action]}: ${runTitle(run)}`
      return <Button key={action} type="button" variant="ghost" size="icon-sm" title={label} aria-label={label}
        disabled={busy} onClick={() => void onAction(action, [run])}><Icon className="size-3.5" aria-hidden="true" /></Button>
    })}
  </span>
}
