import { HourglassIcon, XIcon } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'

import type { ApiRun, WaitEdge } from '@open-mercato/cezar-api-client'
import { useCancelWait, useDeclareWait, useHealth, useProjects, useRunsForProject } from '@/api/queries'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/ui/toaster'
import { deriveAttention } from '@/lib/attention'
import { Link, useActiveProjectId } from '@/lib/project-router'
import { runTitle } from '@/lib/task-groups'
import {
  DEFAULT_WAIT_TIMEOUT_MINUTES,
  pendingWaits,
  timeLeftLabel,
  waitCandidates,
  waitTargetPath,
} from '@/lib/waits'

/**
 * Cross-task waits in the cockpit (spec `.ai/specs/2026-10-05-cross-task-waits.md` § UI/UX):
 *
 *  - `TaskWaitsLine` — on a waiter's header, one row per pending wait: the target with its live
 *    status, the time left before the deadline, and **Stop waiting**;
 *  - `CreatedByLine` — on a task another task created and waits for (Phase 2), who created it;
 *  - `WaitForTaskDialog` — the user's "Wait for task…": project → its unsettled runs → timeout.
 *
 * Every one of them is hidden while `capabilities.taskWaits` is false. No new live channel: the
 * waiter's record (and its `waits`) arrives over the existing SSE run stream.
 */

/** True while the server has cross-task waits on. Absent capabilities fail closed. */
export function useTaskWaitsAvailable(): boolean {
  return useHealth().data?.capabilities?.taskWaits === true
}

/** A run list, or nothing — a project whose list has not loaded (or answered something else)
 *  simply shows no live status, never a crash in the header. */
function listOf(data: unknown): ApiRun[] {
  return Array.isArray(data) ? (data as ApiRun[]) : []
}

/** Re-render once a minute so "times out in …" stays honest without a timer per edge. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** One pending wait: target (live status when its project's runs are cached), deadline, stop. */
function WaitRow({ run, edge, now }: { run: ApiRun; edge: WaitEdge; now: number }) {
  const activeProjectId = useActiveProjectId()
  const bootProjectId = useHealth().data?.bootProject
  const targetRuns = useRunsForProject(edge.target.projectId, bootProjectId)
  const target = listOf(targetRuns.data).find((candidate) => candidate.id === edge.target.runId)
  const attention = target ? deriveAttention(target) : null
  const cancel = useCancelWait(run.id)
  const crossProject = waitTargetPath(edge, activeProjectId, bootProjectId).startsWith('/p/')
  const title = target ? runTitle(target) : edge.targetTitle
  return (
    <div data-slot="task-wait" data-wait-id={edge.id} className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
      <HourglassIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="shrink-0">Waiting for</span>
      <Link
        to={waitTargetPath(edge, activeProjectId, bootProjectId)}
        data-slot="task-wait-target"
        className="inline-flex min-w-0 items-center gap-1.5 truncate font-medium text-foreground hover:underline"
        title={`${edge.target.projectId} / ${title}${attention ? ` — ${attention.label}` : ''}`}
      >
        {attention ? <StatusDot tone={attention.tone} pulse={attention.pulse} aria-label={attention.label} role="img" /> : null}
        <span className="truncate">
          {crossProject ? <span className="text-muted-foreground">{edge.target.projectId} / </span> : null}
          {title}
        </span>
      </Link>
      <span data-slot="task-wait-deadline" className="shrink-0 tabular-nums">
        · times out in {timeLeftLabel(edge.deadline, now)}
      </span>
      <Button
        variant="ghost"
        size="sm"
        data-slot="stop-waiting"
        className="h-6 px-1.5 text-xs"
        disabled={cancel.isPending}
        onClick={() =>
          cancel.mutate(edge.id, {
            onError: (error) => toast(error instanceof Error ? error.message : 'Could not stop the wait', { tone: 'danger' }),
          })
        }
      >
        <XIcon aria-hidden="true" />
        Stop waiting
      </Button>
    </div>
  )
}

/** Every pending wait of `run`, or nothing — including while the capability is off. */
export function TaskWaitsLine({ run }: { run: ApiRun }) {
  const available = useTaskWaitsAvailable()
  const now = useMinuteClock()
  const pending = pendingWaits(run)
  if (!available || pending.length === 0) return null
  return (
    <div data-slot="task-waits" role="status">
      {pending.map((edge) => (
        <WaitRow key={edge.id} run={run} edge={edge} now={now} />
      ))}
    </div>
  )
}

/** "Created by <project> / <task>" on a task another task created and waits for (Phase 2). */
export function CreatedByLine({ run }: { run: ApiRun }) {
  const available = useTaskWaitsAvailable()
  const activeProjectId = useActiveProjectId()
  const bootProjectId = useHealth().data?.bootProject
  const creatorRef = run.waitedBy
  const creatorRuns = useRunsForProject(creatorRef?.projectId ?? 'default', bootProjectId)
  if (!available || !creatorRef) return null
  const creator = listOf(creatorRuns.data).find((candidate) => candidate.id === creatorRef.runId)
  const attention = creator ? deriveAttention(creator) : null
  return (
    <div data-slot="created-by" className="mt-1 flex min-w-0 items-center gap-2 overflow-hidden text-xs text-muted-foreground">
      <span className="shrink-0">Created by</span>
      <Link
        to={waitTargetPath({ target: creatorRef }, activeProjectId, bootProjectId)}
        data-slot="created-by-link"
        className="inline-flex min-w-0 items-center gap-1.5 truncate hover:text-foreground"
      >
        {attention ? <StatusDot tone={attention.tone} pulse={attention.pulse} /> : null}
        <span className="truncate">
          {creatorRef.projectId} / {creator ? runTitle(creator) : creatorRef.runId.slice(0, 8)}
        </span>
      </Link>
    </div>
  )
}

/**
 * "Wait for task…" — the user's wait on a running or parked task. Picks a registered project
 * (this one first), then one of its unsettled runs (searchable by title or id prefix), and a
 * timeout prefilled with the engine's 24 h default. The declaration is the USER's: the agent is
 * told who asked, and woken when the target settles.
 */
export function WaitForTaskDialog({
  run,
  open,
  onOpenChange,
}: {
  run: ApiRun
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const projects = useProjects()
  const bootProjectId = useHealth().data?.bootProject ?? projects.data?.bootProject
  const activeProjectId = useActiveProjectId()
  const ownProject = activeProjectId ?? bootProjectId ?? 'default'
  const [projectId, setProjectId] = useState(ownProject)
  const [query, setQuery] = useState('')
  const [targetId, setTargetId] = useState<string | null>(null)
  const [minutes, setMinutes] = useState(String(DEFAULT_WAIT_TIMEOUT_MINUTES))
  const declare = useDeclareWait(run.id)
  const ids = { project: useId(), search: useId(), timeout: useId(), list: useId() }

  // A fresh pick each time the dialog opens.
  useEffect(() => {
    if (!open) return
    setProjectId(ownProject)
    setQuery('')
    setTargetId(null)
    setMinutes(String(DEFAULT_WAIT_TIMEOUT_MINUTES))
  }, [open, ownProject])

  const runs = useRunsForProject(projectId, bootProjectId)
  const sameProject = projectId === ownProject
  const candidates = useMemo(
    () => waitCandidates(listOf(runs.data), sameProject ? run.id : null, query).slice(0, 50),
    [runs.data, sameProject, run.id, query],
  )
  const timeout = Number(minutes)
  const timeoutValid = Number.isInteger(timeout) && timeout >= 1 && timeout <= 7 * 24 * 60
  const registry = (projects.data?.projects ?? []).filter((project) => project.status !== 'missing')

  const submit = () => {
    if (!targetId || !timeoutValid) return
    declare.mutate(
      { target: { projectId, runId: targetId }, timeoutMinutes: timeout },
      {
        onSuccess: (answer) => {
          if (answer.kind === 'settled') {
            toast(`"${answer.outcome.title}" has already settled (${answer.outcome.status}) — nothing to wait for.`)
          } else {
            toast(`Waiting for "${answer.edge.targetTitle}".`)
          }
          onOpenChange(false)
        },
        onError: (error) => toast(error instanceof Error ? error.message : 'Could not start the wait', { tone: 'danger' }),
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="wait-for-task-dialog" className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Wait for another task</DialogTitle>
          <DialogDescription>
            This task parks without holding a slot and wakes with the other task&apos;s outcome when it
            settles — or when the timeout passes.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor={ids.project}>Project</Label>
            <select
              id={ids.project}
              data-slot="wait-project"
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value)
                setTargetId(null)
              }}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {registry.some((project) => project.id === ownProject) ? null : <option value={ownProject}>This project</option>}
              {registry.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.search}>Task</Label>
            <Input
              id={ids.search}
              data-slot="wait-search"
              placeholder="Search by title or id"
              value={query}
              aria-controls={ids.list}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div
              id={ids.list}
              role="listbox"
              aria-label="Tasks you can wait for"
              data-slot="wait-candidates"
              className="max-h-56 overflow-y-auto rounded-md border border-border"
            >
              {candidates.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  {runs.isPending ? 'Loading tasks…' : 'No unfinished task matches.'}
                </p>
              ) : (
                candidates.map((candidate) => {
                  const attention = deriveAttention(candidate)
                  const selected = candidate.id === targetId
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      data-slot="wait-candidate"
                      data-run-id={candidate.id}
                      onClick={() => setTargetId(candidate.id)}
                      className={
                        'flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none' +
                        (selected ? ' bg-muted font-medium' : '')
                      }
                    >
                      <StatusDot tone={attention.tone} pulse={attention.pulse} aria-label={attention.label} role="img" />
                      <span className="min-w-0 flex-1 truncate">{runTitle(candidate)}</span>
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{candidate.id.slice(0, 8)}</span>
                    </button>
                  )
                })
              )}
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.timeout}>Timeout (minutes)</Label>
            <Input
              id={ids.timeout}
              data-slot="wait-timeout"
              type="number"
              inputMode="numeric"
              min={1}
              max={7 * 24 * 60}
              value={minutes}
              aria-invalid={!timeoutValid}
              onChange={(event) => setMinutes(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" data-slot="wait-submit" disabled={!targetId || !timeoutValid || declare.isPending}>
              <HourglassIcon aria-hidden="true" />
              Wait for it
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
