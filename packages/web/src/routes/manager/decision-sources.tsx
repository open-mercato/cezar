import { useQueries } from '@tanstack/react-query'
import { Link } from 'react-router'
import { getProjectRun } from '@/api/client'
import { useProjects, useRunsIndex } from '@/api/queries'
import { ReferenceChip } from '@/components/reference-chip'
import { prTaskRuns, ResolveConflictsForPr } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { taskReferences, type TaskReference, type TaskReferenceInput } from '@/lib/tasks-table'
import { runTitle } from '@/lib/task-groups'
import type { ManagerOrigin } from '@/lib/managers'
import type { ManagerMessage, RunRecord } from '@open-mercato/cezar-api-client'
import { taskPath } from './manager-session-card'

export function decisionSources(message: ManagerMessage) {
  const sources = new Map<string, { projectId: string; runId: string }>()
  for (const source of message.sourceTasks ?? []) sources.set(`${source.projectId}/${source.runId}`, source)
  const text = message.kind === 'assistant' ? message.text : message.kind === 'action' ? message.reason ?? '' : ''
  for (const match of text.matchAll(/\[\[task:([^\]/\s]+)\/([^\]\s]+)\]\]/g)) {
    sources.set(`${match[1]}/${match[2]}`, { projectId: match[1]!, runId: match[2]! })
  }
  return [...sources.values()]
}

type IndexRun = NonNullable<ReturnType<typeof useRunsIndex>['data']>['runs'][number]

/** A source task's strongest PR and the issue it works on: one of each, the task tables' order. */
function sourceReferences(run: IndexRun | undefined, repoBase: string | undefined): TaskReference[] {
  if (!run) return []
  const references = taskReferences(run, repoBase)
  return [references.find((reference) => reference.kind === 'PR'), references.find((reference) => reference.kind === 'Issue')]
    .filter((reference): reference is TaskReference => reference?.number !== undefined)
}

const linkClass = 'inline-flex min-w-0 max-w-full break-all min-h-11 items-center rounded-md px-2 text-sm font-medium underline underline-offset-4 outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50'

/** Inside the decision, so its provenance survives a short or clamped model reply. */
export function DecisionSources({ message, origin }: { message: ManagerMessage; origin: ManagerOrigin }) {
  const text = message.kind === 'assistant'
    ? [message.text, ...(message.ask?.questions.map((question) => question.question) ?? [])].join(' ')
    : message.kind === 'action' ? message.reason ?? '' : ''
  const index = useRunsIndex().data
  const projects = useProjects().data?.projects
  // The index keeps 200 tasks a project: a stored source past that cap is read by its id.
  const unlisted = message.kind === 'action' && message.action.type === 'merge-pr' && index
    ? decisionSources(message).filter((source) => (index.truncated ?? []).includes(source.projectId)
      && !index.runs.some((run) => run.projectId === source.projectId && run.id === source.runId))
    : []
  const fetched = useQueries({
    queries: unlisted.map((source) => ({
      queryKey: [source.projectId, 'runs', 'detail', source.runId] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => getProjectRun(source.projectId, source.runId, { signal }),
      retry: false,
    })),
  })
  const pending = fetched.some((query) => query.isPending)
  const extra = fetched.flatMap((query, at) => query.data
    ? [{ ...query.data, projectId: unlisted[at]!.projectId, archived: Boolean(query.data.archived) }]
    : [])
  const runs = !index || pending ? undefined : [...index.runs, ...extra]
  return <DecisionSourceList sources={cardSources(message, runs, projects)} text={text} origin={origin} decisionId={message.id} unlisted={extra as unknown as IndexRun[]} />
}

/**
 * A merge card names only tasks that carry its PR: cards stored before the server checked this
 * named whatever task the manager's turn had read. Unknown until the runs index loads.
 */
export function cardSources(
  message: ManagerMessage,
  runs: ReadonlyArray<TaskReferenceInput & { id: string; projectId: string; archived: boolean; createdAt: string }> | undefined,
  projects: ReadonlyArray<{ id: string; repoUrl?: string | undefined }> | undefined,
) {
  const sources = decisionSources(message)
  if (message.kind !== 'action' || message.action.type !== 'merge-pr') return sources
  const { projectId, number } = message.action
  if (!runs) return []
  const tied = new Set(prTaskRuns(runs, projectId, number, projects?.find((entry) => entry.id === projectId)?.repoUrl).map((run) => run.id))
  return sources.filter((source) => source.projectId === projectId && tied.has(source.runId))
}

/** The Source task block, for a chat card and for its row in the Questions inbox alike. */
export function DecisionSourceList({ sources, text, origin, decisionId, returnHint = true, unlisted = [] }: {
  sources: readonly { projectId: string; runId: string }[]
  /** Searched for file names the task's assets may hold (one source only). */
  text: string
  origin: ManagerOrigin
  decisionId: string
  returnHint?: boolean
  /** Source runs the index left out, read by id. */
  unlisted?: readonly IndexRun[]
}) {
  const index = useRunsIndex()
  const projects = useProjects()
  if (!sources.length) return null
  const rows = sources.map((source) => {
    const run = [...(index.data?.runs ?? []), ...unlisted].find((entry) => entry.projectId === source.projectId && entry.id === source.runId)
    const project = projects.data?.projects.find((entry) => entry.id === source.projectId)
    return { ...source, run, project, references: sourceReferences(run, project?.repoUrl) }
  })
  const requests = rows.flatMap((row) => row.references.map((reference) => ({ projectId: row.projectId, kind: reference.kind, number: reference.number! })))
  const files = sources.length === 1 ? [...new Set(text.match(/(?:[a-zA-Z0-9_-]+\/)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*\.(?:html|md|png|jpg|pdf|json)\b/g) ?? [])] : []
  return (
    <div data-slot="decision-sources" className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-muted/30 p-2">
      <p className="text-xs font-medium text-muted-foreground">Source {sources.length === 1 ? 'task' : 'tasks'}</p>
      <ReferenceStatusProvider requests={requests}>
        {rows.map(({ projectId, runId, run, project, references }) => {
          const title = run ? runTitle(run as unknown as RunRecord) : `Task ${runId.slice(0, 8)}`
          const path = taskPath(projectId, runId)
          const state = { manager: { ...origin, decision: decisionId } }
          return (
            <div key={path} className="min-w-0">
              <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 break-words text-sm font-semibold">
                <span className="min-w-0">{title}</span>
                {references.map((reference) => (
                  <ReferenceChip
                    key={`${reference.kind}#${reference.number}`}
                    reference={reference}
                    taskTitle={title}
                    projectId={projectId}
                    {...(reference.kind === 'PR' ? { conflictAction: <ResolveConflictsForPr projectId={projectId} prNumber={reference.number!} /> } : {})}
                    className="no-underline"
                  />
                ))}
              </p>
              <p className="break-words text-xs text-muted-foreground">{project?.name ?? projectId} · {run?.status ?? (index.isPending ? 'Loading task…' : 'Task unavailable or no longer listed')}</p>
              <div className="flex flex-wrap gap-x-2">
                <Link to={`${path}/chat${run?.status === 'waiting' ? '#ask' : '#latest'}`} state={state} className={linkClass}>Inspect task<span className="sr-only">: {run ? runTitle(run as unknown as RunRecord) : runId}</span></Link>
                <Link to={`${path}/assets`} state={state} className={linkClass}>Reports and assets</Link>
                {files.map((name) => <Link key={name} to={`${path}/assets/${encodeURIComponent(name)}`} state={state} className={linkClass}>{name}</Link>)}
              </div>
            </div>
          )
        })}
      </ReferenceStatusProvider>
      {returnHint ? <p className="text-xs text-muted-foreground">Return using “Back to {origin.name}”. Your unanswered decision and draft stay here.</p> : null}
    </div>
  )
}
