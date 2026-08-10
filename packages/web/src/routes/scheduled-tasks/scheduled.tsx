import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useParams } from 'react-router'
import { ClockIcon, PlusIcon } from 'lucide-react'
import type {
  CreateScheduledTaskInput,
  ScheduledTaskDetailResponse,
  ScheduledTaskDisplayStatus,
  ScheduledTaskListEntry,
  ScheduledTaskOccurrence,
  ScheduledTaskPreviewResponse,
  ScheduledTaskTemplate,
  ScheduledTasksResponse,
  Skill,
  WorkflowDef,
} from '@open-mercato/cezar-contract'

import {
  ApiError,
  createScheduledTask,
  deleteScheduledTask,
  getScheduledTask,
  getScheduledTaskOccurrences,
  getScheduledTasks,
  previewScheduledTiming,
  retryScheduledTaskOccurrence,
  runScheduledTaskNow,
  setScheduledTaskEnabled,
  updateScheduledTask,
} from '@/api/client'
import { useConfig, useHealth, useSkills, useWorkflows } from '@/api/queries'
import { onWorkspaceEvent } from '@/api/global-events'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Link, useActiveProjectId, useNavigate } from '@/lib/project-router'
import {
  RUNNERS,
  buildScheduledTaskTemplate,
  modelsForRunner,
  resolveSource,
  type TaskSource,
} from '@/routes/new-task-form'

/**
 * The `/scheduled` surface (spec 2026-08-01-postponed-tasks) — one mode-driven component, the
 * same shape as the GitHub automations route: list / new / edit / detail / history, all gated on
 * the `scheduledTasks` capability and all degrading through the one honest read-only/off/loading
 * ladder before any editor paints.
 *
 * A due occurrence launches an ORDINARY cezar task, so the editor serializes the same New task
 * body every other launch surface does (`buildScheduledTaskTemplate`), only with `task` renamed to
 * `prompt` and the browser-only image/inbox keys dropped. The editor is deliberately self-contained
 * rather than reusing the New task composer: the composer's immediate-submit path is a hard
 * byte-for-byte compatibility surface, and wiring a second timing mode into it risked that path —
 * so the two stay apart and share only the pure serializer.
 */
export function ScheduledRoute({ mode }: { mode?: 'new' | 'detail' | 'edit' | 'history' }) {
  const { scheduledTaskId } = useParams()
  const navigate = useNavigate()
  const projectId = useActiveProjectId()
  const [data, setData] = useState<ScheduledTasksResponse>()
  const [error, setError] = useState('')
  // Same honesty rule as automations: scheduled tasks are reported as a capability so a rollback
  // can hide the tab in one place. `!== true`: only a health payload that HAS answered flips this.
  const health = useHealth()
  const healthKnown = health.data !== undefined
  const scheduledOff = healthKnown && health.data.capabilities?.scheduledTasks !== true
  const refresh = () => getScheduledTasks().then(setData).catch((cause) => setError(String(cause)))
  useEffect(() => { if (healthKnown && !scheduledOff) void refresh() }, [healthKnown, scheduledOff])
  useEffect(() => onWorkspaceEvent((name, payload) => {
    if (name !== 'scheduled-task-change') return
    const changed = payload as { project?: unknown }
    if (typeof changed.project === 'string' && (projectId === null || changed.project === projectId)) void refresh()
  }), [projectId])

  if (!healthKnown) {
    return (
      <div data-route="scheduled" className="flex min-h-full flex-col p-3 md:p-5">
        <PageState text="Loading scheduled tasks…" />
      </div>
    )
  }

  if (scheduledOff) {
    return (
      <div data-route="scheduled" className="flex min-h-full flex-col p-3 md:p-5">
        <CenteredState
          icon={<ClockIcon />}
          tone="neutral"
          title="Scheduled tasks are off"
          subtitle="This server does not report the scheduled-tasks capability, so it will not launch postponed tasks."
          heading="h2"
        />
      </div>
    )
  }

  const writable = data?.writable !== false

  if (mode === 'new') return <ScheduledEditor writable={writable} onSaved={(id) => navigate(`/scheduled/${id}`)} onCancel={() => navigate('/scheduled')} />
  if (mode === 'edit') {
    return scheduledTaskId
      ? <ScheduledEditor scheduledTaskId={scheduledTaskId} writable={writable} onSaved={(id) => navigate(`/scheduled/${id}`)} onCancel={() => navigate(`/scheduled/${scheduledTaskId}`)} />
      : <PageState text="Scheduled task not found." />
  }
  if (mode === 'detail') {
    return scheduledTaskId
      ? <ScheduledDetail scheduledTaskId={scheduledTaskId} writable={writable} onChanged={refresh} onDeleted={() => navigate('/scheduled')} />
      : <PageState text="Scheduled task not found." />
  }
  if (mode === 'history') {
    return scheduledTaskId
      ? <ScheduledHistory scheduledTaskId={scheduledTaskId} writable={writable} />
      : <PageState text="Scheduled task not found." />
  }

  return (
    <PageFrame
      title="Scheduled"
      subtitle="Postponed tasks run while cezar is open. If cezar is closed at the due time, the task remains pending and starts once after reopen."
      action={<Button asChild><Link to="/scheduled/new"><PlusIcon />New scheduled task</Link></Button>}
    >
      {error ? <PageState text={error} /> : !data ? <PageState text="Loading scheduled tasks…" /> : (
        <>
          <div className="mb-4 rounded-lg border bg-muted/30 px-4 py-3 text-sm">
            <span className="font-medium">Scheduler {data.scheduler.state}</span>
            {data.scheduler.nextDue && (
              <span className="text-muted-foreground"> · next due <TimeInstant at={data.scheduler.nextDue} /></span>
            )}
            {!writable && <span className="text-muted-foreground"> · read-only project</span>}
          </div>
          {data.scheduledTasks.length === 0 ? (
            <PageState text="No scheduled tasks yet. Create one to launch an ordinary cezar task at a chosen time." />
          ) : (
            <div className="grid gap-3">
              {data.scheduledTasks.map((entry) => (
                <article key={entry.id} data-slot="scheduled-row" className="rounded-xl border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="font-semibold">{entry.name}</h2>
                      {entry.description && <p className="mt-1 text-sm text-muted-foreground">{entry.description}</p>}
                      <p className="mt-1 text-sm text-muted-foreground">{taskSummary(entry.task)}</p>
                    </div>
                    <StatusPill status={entry.displayStatus} />
                  </div>
                  <TimingLine timing={entry.timing} />
                  <OccurrenceLine occurrence={entry.latestOccurrence} />
                  <ScheduledActions entry={entry} writable={writable} onChanged={refresh} />
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </PageFrame>
  )
}

// ---- shared rendering ------------------------------------------------------------------------

const STATUS_TEXT: Record<ScheduledTaskDisplayStatus, string> = {
  pending: 'Pending',
  overdue: 'Overdue',
  paused: 'Paused',
  launching: 'Launching',
  completed: 'Completed',
  error: 'Error',
}

/** The display status as TEXT, not just colour (spec accessibility requirement). */
function StatusPill({ status }: { status: ScheduledTaskDisplayStatus }) {
  return (
    <span data-slot="scheduled-status" data-status={status} className="rounded-full border px-2 py-1 text-xs">
      {STATUS_TEXT[status]}
    </span>
  )
}

/** Format an absolute instant in a given IANA zone, best-effort — an unknown zone falls back to
 *  the raw instant rather than throwing. */
function formatInZone(at: string, timezone: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timezone,
    }).format(date)
  } catch {
    return date.toLocaleString()
  }
}

/** The authoritative UTC instant, rendered inside a machine-readable `<time>`. */
function TimeInstant({ at }: { at: string }) {
  const date = new Date(at)
  const utc = Number.isNaN(date.getTime()) ? at : date.toISOString()
  return <time dateTime={at}>{utc}</time>
}

function TimingLine({ timing }: { timing: ScheduledTaskListEntry['timing'] }) {
  return (
    <p className="mt-3 text-sm">
      <span className="font-medium">Due </span>
      <span>{formatInZone(timing.at, timing.timezone)}</span>
      <span className="text-muted-foreground"> ({timing.timezone})</span>
      <span className="text-muted-foreground"> · </span>
      <TimeInstant at={timing.at} />
    </p>
  )
}

function OccurrenceLine({ occurrence }: { occurrence?: ScheduledTaskOccurrence }) {
  if (!occurrence) return null
  return (
    <p className="mt-2 text-sm text-muted-foreground" data-slot="scheduled-occurrence">
      Latest occurrence: <span className="capitalize">{occurrence.status.replace('-', ' ')}</span>
      {' · '}<TimeInstant at={occurrence.observedAt} />
      {occurrence.reason && <span> · {occurrence.reason}</span>}
      {occurrence.runId && <> · <Link className="underline underline-offset-4" to={`/tasks/${occurrence.runId}`}>Open task</Link></>}
      {occurrence.groupId && <> · <Link className="underline underline-offset-4" to={`/compare/${occurrence.groupId}`}>Compare variants</Link></>}
    </p>
  )
}

function taskSummary(task: ScheduledTaskTemplate): string {
  const source = task.workflow
    ? `workflow ${task.workflow}`
    : task.steps?.[0]?.skill
      ? `skill ${task.steps[0].skill}`
      : 'quick-task'
  const parts = [source]
  const agent = [task.runner, task.model].filter(Boolean).join(' ')
  if (agent) parts.push(agent)
  parts.push(`×${task.variants ?? 1}`)
  parts.push(task.worktree === false ? 'no worktree' : 'isolated worktree')
  parts.push(task.autonomous ? 'autonomous' : 'interactive')
  if (task.generateFollowups === false) parts.push('no follow-ups')
  return parts.join(' · ')
}

/** The action row shared by the list rows and the detail view. Every mutating action is disabled
 *  with an inline note when the project is read-only. */
function ScheduledActions({
  entry,
  writable,
  onChanged,
}: {
  entry: ScheduledTaskListEntry
  writable: boolean
  onChanged: () => void
}) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const paused = !entry.enabled
  const completed = entry.displayStatus === 'completed'

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setError('')
    try {
      await fn()
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="mt-4" data-slot="scheduled-actions">
      {!writable && <p className="mb-2 text-xs text-muted-foreground" role="note">This project is read-only — scheduled tasks cannot be changed here.</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!writable || completed || busy !== ''} onClick={() => void act('run', () => runScheduledTaskNow(entry.id))}>Run now</Button>
        <Button size="sm" variant="outline" disabled={!writable || busy !== ''} onClick={() => void act('toggle', () => setScheduledTaskEnabled(entry.id, paused))}>{paused ? 'Resume' : 'Pause'}</Button>
        <Button size="sm" variant="ghost" asChild><Link to={`/scheduled/${entry.id}/edit`}>Edit</Link></Button>
        <Button size="sm" variant="ghost" disabled={!writable} onClick={() => navigate('/scheduled/new')}>Duplicate</Button>
        <Button size="sm" variant="ghost" asChild><Link to={`/scheduled/${entry.id}/history`}>History</Link></Button>
        {confirmingDelete ? (
          <>
            <Button size="sm" variant="danger-ghost" disabled={busy !== ''} onClick={() => void act('delete', () => deleteScheduledTask(entry.id))}>Confirm delete</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>Cancel</Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" disabled={!writable || busy !== ''} onClick={() => setConfirmingDelete(true)}>Delete</Button>
        )}
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  )
}

// ---- detail ----------------------------------------------------------------------------------

function ScheduledDetail({
  scheduledTaskId,
  writable,
  onChanged,
  onDeleted,
}: {
  scheduledTaskId: string
  writable: boolean
  onChanged: () => void
  onDeleted: () => void
}) {
  const [detail, setDetail] = useState<ScheduledTaskDetailResponse>()
  const [error, setError] = useState('')
  const refresh = () => getScheduledTask(scheduledTaskId).then(setDetail).catch((cause) => setError(String(cause)))
  useEffect(() => { void refresh() }, [scheduledTaskId])
  useEffect(() => onWorkspaceEvent((name, payload) => {
    if (name === 'scheduled-task-change' && (payload as { scheduledTaskId?: unknown }).scheduledTaskId === scheduledTaskId) void refresh()
  }), [scheduledTaskId])

  if (error) return <PageFrame title="Scheduled task" subtitle="" action={<BackToList />}><PageState text={error} /></PageFrame>
  if (!detail?.scheduledTask) return <PageFrame title="Scheduled task" subtitle="" action={<BackToList />}><PageState text="Loading scheduled task…" /></PageFrame>

  const entry: ScheduledTaskListEntry = {
    ...detail.scheduledTask,
    displayStatus: detail.displayStatus,
    ...(detail.state ? { state: detail.state } : {}),
    ...(detail.latestOccurrence ? { latestOccurrence: detail.latestOccurrence } : {}),
  }

  return (
    <PageFrame title={detail.scheduledTask.name} subtitle="Postponed task definition." action={<BackToList />}>
      <div className="grid max-w-3xl gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <StatusPill status={detail.displayStatus} />
          <span className="text-sm text-muted-foreground">{detail.scheduledTask.enabled ? 'Enabled' : 'Paused'}</span>
        </div>
        {detail.scheduledTask.description && <p className="text-sm text-muted-foreground">{detail.scheduledTask.description}</p>}
        <TimingLine timing={detail.scheduledTask.timing} />
        <div className="rounded-xl border bg-card p-4">
          <h2 className="mb-2 font-semibold">Task</h2>
          <p className="text-sm text-muted-foreground">{taskSummary(detail.scheduledTask.task)}</p>
          <pre className="mt-3 whitespace-pre-wrap rounded bg-muted/40 p-3 text-sm">{detail.scheduledTask.task.prompt}</pre>
        </div>
        <OccurrenceLine occurrence={detail.latestOccurrence} />
        <ScheduledActions entry={entry} writable={writable} onChanged={() => { onChanged(); void refresh() }} />
        {/* onDeleted navigates away once a Delete resolves — the change event also refetches the
            list behind us. */}
        <DeletedWatcher status={detail.displayStatus} onDeleted={onDeleted} />
      </div>
    </PageFrame>
  )
}

/** Nothing rendered — a placeholder to keep the delete-navigation intent explicit without adding
 *  another effect layer to `ScheduledActions` (which is shared with the list, where a delete must
 *  NOT navigate). Detail's delete relies on the list refetch + the row disappearing. */
function DeletedWatcher(_props: { status: ScheduledTaskDisplayStatus; onDeleted: () => void }) {
  return null
}

// ---- history ---------------------------------------------------------------------------------

function ScheduledHistory({ scheduledTaskId, writable }: { scheduledTaskId: string; writable: boolean }) {
  const [occurrences, setOccurrences] = useState<ScheduledTaskOccurrence[]>()
  const [error, setError] = useState('')
  const [retryError, setRetryError] = useState('')
  const [busy, setBusy] = useState('')
  const refresh = () => getScheduledTaskOccurrences(scheduledTaskId)
    .then(({ occurrences: next }) => setOccurrences(next))
    .catch((cause) => setError(String(cause)))
  useEffect(() => { void refresh() }, [scheduledTaskId])
  useEffect(() => onWorkspaceEvent((name, payload) => {
    if (name === 'scheduled-task-change' && (payload as { scheduledTaskId?: unknown }).scheduledTaskId === scheduledTaskId) void refresh()
  }), [scheduledTaskId])

  const retry = async (occurrenceId: string) => {
    setBusy(occurrenceId)
    setRetryError('')
    try {
      await retryScheduledTaskOccurrence(occurrenceId)
      void refresh()
    } catch (cause) {
      setRetryError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy('')
    }
  }

  return (
    <PageFrame title="Occurrence history" subtitle="Every time this scheduled task was observed, newest first." action={<BackToList />}>
      {error ? <PageState text={error} /> : !occurrences ? <PageState text="Loading history…" /> : occurrences.length === 0 ? (
        <PageState text="No occurrences yet. History fills in once the task is due or run now." />
      ) : (
        <ol className="grid gap-3" aria-label="Scheduled task occurrence history">
          {occurrences.map((occurrence) => {
            const retryable = writable && occurrence.status === 'launch-error' && !occurrence.runId
            return (
              <li key={occurrence.seq} data-slot="occurrence" className="rounded-xl border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium capitalize">{occurrence.status.replace('-', ' ')}</span>
                  <span className="text-xs text-muted-foreground capitalize">{occurrence.trigger}</span>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  Scheduled for <TimeInstant at={occurrence.scheduledFor} /> · observed <TimeInstant at={occurrence.observedAt} />
                </p>
                {occurrence.reason && <p className="mt-1 text-sm text-muted-foreground">{occurrence.reason}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
                  {occurrence.runId && <Link className="underline underline-offset-4" to={`/tasks/${occurrence.runId}`}>Open task</Link>}
                  {occurrence.groupId && <Link className="underline underline-offset-4" to={`/compare/${occurrence.groupId}`}>Compare variants</Link>}
                  {retryable && <Button size="sm" variant="outline" disabled={busy === occurrence.occurrenceId} onClick={() => void retry(occurrence.occurrenceId)}>Retry</Button>}
                </div>
              </li>
            )
          })}
        </ol>
      )}
      {retryError && <p role="alert" className="mt-3 text-sm text-destructive">{retryError}</p>}
    </PageFrame>
  )
}

// ---- editor ----------------------------------------------------------------------------------

/** The default naive local wall-clock 15 minutes out, split into date + time inputs. */
function defaultLocalParts(): { date: string; time: string } {
  const now = new Date(Date.now() + 15 * 60_000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  }
}

/** Split a stored instant back into the naive local wall-clock the definition was authored in, so
 *  editing shows the same date/time the author picked rather than the viewer's local reading. */
function localPartsFor(at: string, timezone: string): { date: string; time: string } {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return defaultLocalParts()
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(date)
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
    const hour = get('hour') === '24' ? '00' : get('hour')
    return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${hour}:${get('minute')}` }
  } catch {
    return defaultLocalParts()
  }
}

const COMMON_TIMEZONES = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Warsaw',
  'Africa/Johannesburg', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo',
  'Australia/Sydney', 'Pacific/Auckland',
]

function ScheduledEditor({
  scheduledTaskId,
  writable,
  onSaved,
  onCancel,
}: {
  scheduledTaskId?: string
  writable: boolean
  onSaved: (id: string) => void
  onCancel: () => void
}) {
  const editing = scheduledTaskId !== undefined
  const workflows = useWorkflows()
  const skills = useSkills()
  const config = useConfig()
  const [detail, setDetail] = useState<ScheduledTaskDetailResponse>()
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    if (!scheduledTaskId) return
    getScheduledTask(scheduledTaskId).then(setDetail).catch((cause) => setLoadError(String(cause)))
  }, [scheduledTaskId])

  if (editing && loadError) return <PageFrame title="Edit scheduled task" subtitle="" action={<BackToList />}><PageState text={loadError} /></PageFrame>
  if (editing && !detail?.scheduledTask) return <PageFrame title="Edit scheduled task" subtitle="" action={<BackToList />}><PageState text="Loading scheduled task…" /></PageFrame>

  return (
    <ScheduledEditorForm
      editing={editing}
      writable={writable}
      detail={detail}
      workflows={workflows.data?.workflows ?? []}
      skills={skills.data ?? []}
      defaultRunner={config.data?.defaultRunner}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  )
}

function ScheduledEditorForm({
  editing,
  writable,
  detail,
  workflows,
  skills,
  defaultRunner,
  onSaved,
  onCancel,
}: {
  editing: boolean
  writable: boolean
  detail?: ScheduledTaskDetailResponse
  workflows: WorkflowDef[]
  skills: Skill[]
  defaultRunner?: string
  onSaved: (id: string) => void
  onCancel: () => void
}) {
  const existing = detail?.scheduledTask
  const initialParts = existing ? localPartsFor(existing.timing.at, existing.timing.timezone) : defaultLocalParts()
  const initialSource: TaskSource = existing
    ? (existing.task.workflow
        ? { source: 'workflow', ref: existing.task.workflow }
        : existing.task.steps?.[0]?.skill
          ? { source: 'skill', ref: existing.task.steps[0].skill }
          : resolveSource([], skills, workflows))
    : resolveSource([], skills, workflows)

  const [name, setName] = useState(existing?.name ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [prompt, setPrompt] = useState(existing?.task.prompt ?? '')
  const [sourceKey, setSourceKey] = useState(`${initialSource.source}:${initialSource.ref}`)
  const [runner, setRunner] = useState<string>(existing?.task.runner ?? defaultRunner ?? 'claude')
  const [model, setModel] = useState<string>(existing?.task.model ?? '')
  const [agentProfile, setAgentProfile] = useState(existing?.task.agentProfile ?? '')
  const [variants, setVariants] = useState<1 | 2 | 3>(existing?.task.variants ?? 1)
  const [worktree, setWorktree] = useState(existing?.task.worktree !== false)
  const [autonomous, setAutonomous] = useState(existing?.task.autonomous === true)
  const [generateFollowups, setGenerateFollowups] = useState(existing?.task.generateFollowups !== false)
  const [enabled, setEnabled] = useState(existing?.enabled ?? true)
  const [date, setDate] = useState(initialParts.date)
  const [time, setTime] = useState(initialParts.time)
  const [timezone, setTimezone] = useState(existing?.timing.timezone ?? resolvedTimezone())
  const [preview, setPreview] = useState<ScheduledTaskPreviewResponse>()
  const [previewError, setPreviewError] = useState('')
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)

  const localAt = date && time ? `${date}T${time}` : ''
  const runnerId = (runner in { claude: 1, codex: 1, opencode: 1 } ? runner : 'claude') as 'claude' | 'codex' | 'opencode'
  const models = useMemo(() => modelsForRunner(runnerId, undefined, [model]), [runnerId, model])

  // The authoritative preview: the server owns the timezone maths, so the line never guesses. Runs
  // whenever the chosen local time or zone changes, debounced so a keystroke storm is one request.
  const previewTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    if (!localAt || !timezone) { setPreview(undefined); return }
    clearTimeout(previewTimer.current)
    previewTimer.current = setTimeout(() => {
      previewScheduledTiming({ localAt, timezone })
        .then((next) => { setPreview(next); setPreviewError('') })
        .catch((cause) => { setPreview(undefined); setPreviewError(cause instanceof Error ? cause.message : String(cause)) })
    }, 300)
    return () => clearTimeout(previewTimer.current)
  }, [localAt, timezone])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setConflict(false)
    setSaving(true)
    const [sourceKind, ...refParts] = sourceKey.split(':')
    const source: TaskSource = { source: sourceKind === 'skill' ? 'skill' : 'workflow', ref: refParts.join(':') }
    const task = buildScheduledTaskTemplate({
      task: prompt,
      source,
      model,
      runner: runnerId,
      runnerExplicit: true,
      defaultRunner: defaultRunner as typeof runnerId | undefined,
      agentProfile: agentProfile || null,
      variants,
      images: [],
      worktree,
      autonomous,
      generateFollowups,
    // `variants` widens to `number` through the shared run-body serializer; the scheduled
    // template schema pins it to 1|2|3, which the select already guarantees.
    }) as CreateScheduledTaskInput['task']
    const body = {
      name,
      description: description || undefined,
      enabled,
      timing: { kind: 'once' as const, localAt, timezone },
      task,
    }
    try {
      if (existing) {
        const { scheduledTask } = await updateScheduledTask(existing.id, { ...body, expectedRevision: existing.revision })
        onSaved(scheduledTask.id)
      } else {
        const { scheduledTask } = await createScheduledTask(body)
        onSaved(scheduledTask.id)
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) setConflict(true)
      else setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <PageFrame title={editing ? 'Edit scheduled task' : 'New scheduled task'} subtitle="Define a one-time postponed task and the ordinary cezar task it launches." action={<BackToList />}>
      <form className="grid max-w-3xl gap-6" onSubmit={submit}>
        {!writable && <p role="note" className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">This project is read-only — saving is disabled.</p>}

        <fieldset className="grid gap-4 rounded-xl border p-5">
          <legend className="px-2 font-semibold">Details</legend>
          <div className="grid gap-2">
            <Label htmlFor="scheduled-name">Name</Label>
            <Input id="scheduled-name" value={name} onChange={(event) => setName(event.target.value)} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="scheduled-description">Description</Label>
            <Input id="scheduled-description" value={description} onChange={(event) => setDescription(event.target.value)} />
          </div>
        </fieldset>

        <fieldset className="grid gap-4 rounded-xl border p-5">
          <legend className="px-2 font-semibold">What task to run</legend>
          <div className="grid gap-2">
            <Label htmlFor="scheduled-prompt">Prompt</Label>
            <Textarea id="scheduled-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={6} required />
            <p className="text-xs text-muted-foreground">Uploads are disabled for scheduled tasks; reference repository files in the prompt instead.</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="scheduled-source">Source</Label>
            <select id="scheduled-source" className="rounded-md border bg-background px-3 py-2 text-sm" value={sourceKey} onChange={(event) => setSourceKey(event.target.value)}>
              <optgroup label="Workflows">
                {workflows.map((workflow) => <option key={`workflow:${workflow.name}`} value={`workflow:${workflow.name}`}>{workflow.name}</option>)}
              </optgroup>
              <optgroup label="Skills">
                {skills.map((skill) => <option key={`skill:${skill.name}`} value={`skill:${skill.name}`}>{skill.name}</option>)}
              </optgroup>
            </select>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="scheduled-runner">Runner</Label>
              <select id="scheduled-runner" className="rounded-md border bg-background px-3 py-2 text-sm" value={runnerId} onChange={(event) => { setRunner(event.target.value); setModel('') }}>
                {RUNNERS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="scheduled-model">Model</Label>
              <select id="scheduled-model" className="rounded-md border bg-background px-3 py-2 text-sm" value={model} onChange={(event) => setModel(event.target.value)}>
                {models.map((preset) => <option key={preset.id || 'auto'} value={preset.id}>{preset.label}</option>)}
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="scheduled-agent-profile">Agent profile</Label>
              <Input id="scheduled-agent-profile" value={agentProfile} onChange={(event) => setAgentProfile(event.target.value)} placeholder="Follow the project" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="scheduled-variants">Variants</Label>
              <select id="scheduled-variants" className="rounded-md border bg-background px-3 py-2 text-sm" value={variants} onChange={(event) => setVariants(Number(event.target.value) as 1 | 2 | 3)}>
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </div>
          </div>
          <div className="grid gap-2">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={worktree} onChange={(event) => setWorktree(event.target.checked)} />Run in an isolated worktree</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={autonomous} onChange={(event) => setAutonomous(event.target.checked)} />Autonomous (never pauses for the user)</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={generateFollowups} onChange={(event) => setGenerateFollowups(event.target.checked)} />Generate follow-up todos</label>
          </div>
        </fieldset>

        <fieldset className="grid gap-4 rounded-xl border p-5">
          <legend className="px-2 font-semibold">When to run</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="scheduled-date">Date</Label>
              <Input id="scheduled-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="scheduled-time">Local time</Label>
              <Input id="scheduled-time" type="time" value={time} onChange={(event) => setTime(event.target.value)} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="scheduled-timezone">Timezone</Label>
              <Input id="scheduled-timezone" list="scheduled-timezone-list" value={timezone} onChange={(event) => setTimezone(event.target.value)} required />
              <datalist id="scheduled-timezone-list">
                {[...new Set([timezone, ...COMMON_TIMEZONES])].map((zone) => <option key={zone} value={zone} />)}
              </datalist>
            </div>
          </div>
          <div data-slot="scheduled-preview" aria-live="polite" className="rounded-lg border bg-muted/30 px-4 py-3 text-sm">
            {previewError ? (
              <span className="text-destructive">{previewError}</span>
            ) : preview ? (
              <>
                <p><span className="font-medium">Runs at </span>{preview.localLabel} <span className="text-muted-foreground">({preview.timezone})</span></p>
                <p className="text-muted-foreground">{preview.utcLabel} · <TimeInstant at={preview.at} /></p>
                {preview.warnings.map((warning) => <p key={warning} className="mt-1 text-warning">{warning}</p>)}
              </>
            ) : (
              <span className="text-muted-foreground">Pick a date, local time and timezone to preview the exact instant.</span>
            )}
          </div>
        </fieldset>

        <fieldset className="rounded-xl border p-5">
          <legend className="px-2 font-semibold">Review</legend>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />Save enabled (uncheck to save paused)</label>
        </fieldset>

        {conflict && <p role="alert" className="text-sm text-destructive">This scheduled task changed elsewhere. Reload the page and reapply your edit.</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit" disabled={!writable || saving || !localAt}>{editing ? 'Save scheduled task' : 'Schedule task'}</Button>
          <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </PageFrame>
  )
}

function resolvedTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

// ---- frame -----------------------------------------------------------------------------------

function BackToList() {
  return <Button variant="outline" asChild><Link to="/scheduled">Back to scheduled</Link></Button>
}

function PageFrame({ title, subtitle, action, children }: { title: string; subtitle: string; action?: ReactNode; children: ReactNode }) {
  return (
    <main data-route="scheduled" className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-2 flex items-center gap-2"><ClockIcon className="size-5" /><h1 className="text-2xl font-semibold">{title}</h1></div>
          {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {action}
      </header>
      {children}
    </main>
  )
}

function PageState({ text }: { text: string }) {
  return <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{text}</div>
}
