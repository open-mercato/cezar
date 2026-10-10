import { ListOrderedIcon, ListTodoIcon, XIcon } from 'lucide-react'
import { useCallback, useState } from 'react'

import { ApiError, continueRun, createRun, queueRunPrompt, removeQueuedRunPrompt, sendMessage } from '@/api/client'
import { useRuns, useWorkflows } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Link } from '@/lib/project-router'

import { messageWithDesignPicks, pickLabel, type DesignPick, type DesignPicks } from '../task-thread/design-picks'

/**
 * The Design Mode note and its queues (spec `.ai/specs/2026-10-09-design-mode.md` §7-8).
 *
 * `DesignNote` is the popup the Browser column shows beside a picked element; `DesignQueues` is
 * the strip under the page that lists what the notes turned into.
 *
 * One review of the app, many notes: point at elements (each gets a number, here and on the
 * page), say what should change, choose where the note goes, repeat. A note goes to one of TWO
 * queues, and they are listed apart because they are different things:
 *
 *  - the session's PROMPT QUEUE — more work for THIS task's agent, in this task's worktree. The
 *    prompts run one after another: each starts only when the work before it has ended.
 *  - cezar's TASK QUEUE — a separate task with its own workflow, worktree and branch, started
 *    from the project's base and scheduled like any other task.
 *
 * The picks themselves live in the run's shared list (`useDesignPicks`), so the Chat composer
 * shows the same elements as chips and either place can send them.
 */

type Target = 'session' | 'task'

/** Where a note for the session actually goes, which depends on what the session is doing. */
function sessionRoute(status: ApiRun['status']): { path: 'queue' | 'fold' | 'continue'; action: string; hint: string } {
  if (status === 'running') {
    return { path: 'queue', action: 'Queue prompt', hint: 'The agent is working — this joins the prompt queue and starts when the current work ends.' }
  }
  if (status === 'waiting') {
    return { path: 'queue', action: 'Send prompt', hint: 'The session is idle — this starts right away. Add more and they run one after another.' }
  }
  if (status === 'queued') {
    return { path: 'fold', action: 'Add to prompt', hint: 'This task has not started yet — the note is added to its first prompt.' }
  }
  return { path: 'continue', action: 'Reopen & send', hint: 'The session is closed — this reopens it with the note.' }
}

export function DesignNote({
  run,
  picks,
  onClose,
  onTasksCreated,
}: {
  run: ApiRun
  picks: DesignPicks
  /** Hide the popup. The note is not discarded: its elements stay marked and stay in the list. */
  onClose: () => void
  /** New tasks came out of a note — the host lists them in the task queue strip. */
  onTasksCreated: (ids: string[]) => void
}) {
  const [text, setText] = useState('')
  const [target, setTarget] = useState<Target>('session')
  const [workflow, setWorkflow] = useState('quick-task')
  const [worktree, setWorktree] = useState(true)
  const [busy, setBusy] = useState(false)

  const workflows = useWorkflows({ enabled: target === 'task' })
  const workflowNames = (workflows.data?.workflows ?? []).map((entry) => entry.name)
  const route = sessionRoute(run.status)
  const canSend = !busy && (text.trim() !== '' || picks.picks.length > 0)

  const send = useCallback(async () => {
    setBusy(true)
    try {
      await picks.submit(async (held) => {
        const message = messageWithDesignPicks(text.trim(), held)
        if (target === 'task') {
          const result = await createRun({ workflow, task: message, worktree })
          const runs = 'runs' in result ? result.runs : [result]
          onTasksCreated(runs.map((entry) => entry.id))
          toast('Task added to the task queue.')
          return
        }
        if (route.path === 'fold') {
          await sendMessage(run.id, { text: message })
          toast('Added to the task’s first prompt.')
          return
        }
        if (route.path === 'continue') {
          await continueRun(run.id, { text: message })
          toast('Session reopened with your note.')
          return
        }
        try {
          const result = await queueRunPrompt(run.id, message)
          toast('delivered' in result ? 'Prompt sent to the agent.' : 'Prompt added to the queue.')
        } catch (error) {
          // The session closed between the last status this panel saw and the send. Reopening it
          // with the note is what the user asked for in every sense that matters.
          if (!(error instanceof ApiError) || error.status !== 409 || !/session closed/.test(error.message)) throw error
          await continueRun(run.id, { text: message })
          toast('Session reopened with your note.')
        }
      })
      setText('')
    } catch (error) {
      toast(error instanceof Error && error.message ? error.message : 'Could not send the note.', { tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }, [onTasksCreated, picks, route.path, run.id, target, text, workflow, worktree])

  return (
    <div data-slot="design-note" className="flex flex-col gap-2 p-2.5 text-xs">
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <PickList picks={picks.picks} onRemove={picks.remove} />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Close note"
          title="Close — the elements stay selected"
          onClick={onClose}
        >
          <XIcon aria-hidden="true" />
        </Button>
      </div>

      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canSend) {
            event.preventDefault()
            void send()
          }
        }}
        placeholder={picks.picks.length > 0 ? 'What should change about the selected elements?' : 'Describe a change — or click elements in the page first'}
        aria-label="Note for the agent"
        // The popup appears because the user just pointed at something to talk about.
        autoFocus
        rows={2}
        className="min-h-14 resize-none text-[13px] md:text-[13px]"
      />

      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={target}
          onValueChange={(value) => {
            if (value === 'session' || value === 'task') setTarget(value)
          }}
          aria-label="Where this note goes"
        >
          <ToggleGroupItem value="session" className="gap-1.5 px-2.5 text-xs">
            <ListOrderedIcon aria-hidden="true" className="size-3.5" />
            This session
          </ToggleGroupItem>
          <ToggleGroupItem value="task" className="gap-1.5 px-2.5 text-xs">
            <ListTodoIcon aria-hidden="true" className="size-3.5" />
            New task
          </ToggleGroupItem>
        </ToggleGroup>

        {target === 'task' ? (
          <>
            <NativeSelect
              size="sm"
              aria-label="Workflow for the new task"
              value={workflow}
              onChange={(event) => setWorkflow(event.target.value)}
              className="text-xs"
            >
              {/* The built-in is always offered, so the select is usable before the list arrives. */}
              {(workflowNames.includes(workflow) ? workflowNames : [workflow, ...workflowNames]).map((name) => (
                <NativeSelectOption key={name} value={name}>
                  {name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <label className="flex items-center gap-1.5 text-soft-foreground">
              <Switch checked={worktree} onCheckedChange={setWorktree} aria-label="Run in an isolated worktree" />
              Worktree
            </label>
          </>
        ) : null}

        <Button type="button" size="sm" disabled={!canSend} onClick={() => void send()} className="ml-auto">
          {target === 'task' ? 'Create task' : route.action}
        </Button>
      </div>

      <p data-slot="design-dock-hint" className="text-soft-foreground">
        {target === 'task'
          ? 'A separate task in cezar’s task queue, started from the project’s base branch — it does not see this task’s uncommitted changes.'
          : route.hint}
      </p>
    </div>
  )
}

/** Whether there is anything for `DesignQueues` to show — the host renders no strip otherwise. */
export function hasDesignQueues(run: ApiRun, createdTasks: readonly string[]): boolean {
  return (run.promptQueue?.length ?? 0) > 0 || createdTasks.length > 0
}

/** The two queues the notes feed, side by side and never mixed. */
export function DesignQueues({ run, createdTasks }: { run: ApiRun; createdTasks: readonly string[] }) {
  const promptQueue = run.promptQueue ?? []
  const sessionLive = run.status === 'running' || run.status === 'waiting'
  const created = createdTasks

  const removeQueued = useCallback(
    (msgId: string) => {
      removeQueuedRunPrompt(run.id, msgId).catch((error: unknown) => {
        toast(error instanceof Error && error.message ? error.message : 'Could not remove the prompt.', { tone: 'danger' })
      })
    },
    [run.id],
  )

  return (
    <div data-slot="design-queues" className="max-h-44 overflow-y-auto bg-background px-3 py-2.5 text-xs">
        <div className="grid gap-2.5 sm:grid-cols-2">
          {promptQueue.length > 0 ? (
            <section data-slot="design-prompt-queue" aria-label="Prompt queue of this session">
              <QueueHeading icon={<ListOrderedIcon aria-hidden="true" className="size-3.5" />}>
                Prompt queue · this session ({promptQueue.length})
              </QueueHeading>
              <p className="mb-1 text-soft-foreground">
                {sessionLive
                  ? 'Run one after another, each when the work before it ends.'
                  : 'Not delivered — the session ended first. Reopen it and they run in order.'}
              </p>
              <ol className="flex flex-col gap-1">
                {promptQueue.map((entry, index) => (
                  <li key={entry.id} className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 py-0.5 pr-0.5 pl-2">
                    <span className="shrink-0 font-medium text-muted-foreground">{index + 1}.</span>
                    <span className="min-w-0 flex-1 truncate" title={entry.text}>
                      {firstLine(entry.text)}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove queued prompt ${index + 1}`}
                      onClick={() => removeQueued(entry.id)}
                    >
                      <XIcon aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
          {created.length > 0 ? <CreatedTasks ids={created} /> : null}
        </div>
    </div>
  )
}

/** The elements of the note being written, numbered as the page numbers them. */
function PickList({ picks, onRemove }: { picks: readonly DesignPick[]; onRemove: (id: string) => void }) {
  if (picks.length === 0) {
    return (
      <p data-slot="design-dock-empty" className="text-soft-foreground">
        Click elements in the page to add them to this note.
      </p>
    )
  }
  return (
    <ul data-slot="design-dock-picks" aria-label="Selected elements" className="flex flex-wrap gap-1.5">
      {picks.map((pick, index) => (
        <li
          key={pick.id}
          data-slot="design-dock-pick"
          title={pick.selector}
          className="flex h-7 max-w-[240px] items-center gap-1.5 overflow-hidden rounded-md border border-border bg-muted/40 pl-1 text-foreground"
        >
          <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-primary px-1 text-[11px] font-bold text-primary-foreground">
            {index + 1}
          </span>
          <span className="min-w-0 truncate font-medium">{pickLabel(pick)}</span>
          <Button
            type="button"
            variant="ghost"
            aria-label={`Remove element ${index + 1}, ${pickLabel(pick)}`}
            onClick={() => onRemove(pick.id)}
            className="h-full rounded-none px-1.5 text-soft-foreground"
          >
            <XIcon aria-hidden="true" className="size-3.5" />
          </Button>
        </li>
      ))}
    </ul>
  )
}

function QueueHeading({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h3 className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
      {icon}
      {children}
    </h3>
  )
}

/** The tasks this panel created, with the status cezar's scheduler currently gives each. */
function CreatedTasks({ ids }: { ids: readonly string[] }) {
  const runs = useRuns((all) => all.filter((entry) => ids.includes(entry.id)))
  const byId = new Map((runs.data ?? []).map((entry) => [entry.id, entry]))
  return (
    <section data-slot="design-task-queue" aria-label="Tasks created from this review">
      <QueueHeading icon={<ListTodoIcon aria-hidden="true" className="size-3.5" />}>
        Task queue · cezar ({ids.length})
      </QueueHeading>
      <p className="mb-1 text-soft-foreground">Separate tasks — scheduled by cezar, each in its own worktree.</p>
      <ol className="flex flex-col gap-1">
        {ids.map((id) => {
          const entry = byId.get(id)
          return (
            <li key={id} className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1">
              <StatusDot tone={statusTone(entry?.status)} pulse={entry?.status === 'running'} />
              <Link to={`/tasks/${encodeURIComponent(id)}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
                {entry?.title ?? 'New task'}
              </Link>
              <span className="shrink-0 text-soft-foreground">{entry?.status ?? 'queued'}</span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function statusTone(status: ApiRun['status'] | undefined): 'success' | 'pending' | 'danger' | 'neutral' {
  if (status === 'done' || status === 'review') return 'success'
  if (status === 'failed' || status === 'cancelled') return 'danger'
  if (status === 'running' || status === 'waiting') return 'pending'
  return 'neutral'
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? text
}
