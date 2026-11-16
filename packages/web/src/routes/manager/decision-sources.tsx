import { Link } from 'react-router'
import { useProjects, useRunsIndex } from '@/api/queries'
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

const linkClass = 'inline-flex min-w-0 max-w-full break-all min-h-11 items-center rounded-md px-2 text-sm font-medium underline underline-offset-4 outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50'

/** Inside the decision, so its provenance survives a short or clamped model reply. */
export function DecisionSources({ message, origin }: { message: ManagerMessage; origin: ManagerOrigin }) {
  const index = useRunsIndex()
  const projects = useProjects()
  const sources = decisionSources(message)
  if (!sources.length) return null
  const text = message.kind === 'assistant'
    ? [message.text, ...(message.ask?.questions.map((question) => question.question) ?? [])].join(' ')
    : message.kind === 'action' ? message.reason ?? '' : ''
  const files = sources.length === 1 ? [...new Set(text.match(/(?:[a-zA-Z0-9_-]+\/)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*\.(?:html|md|png|jpg|pdf|json)\b/g) ?? [])] : []
  return (
    <div data-slot="decision-sources" className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-muted/30 p-2">
      <p className="text-xs font-medium text-muted-foreground">Source {sources.length === 1 ? 'task' : 'tasks'}</p>
      {sources.map(({ projectId, runId }) => {
        const run = index.data?.runs.find((entry) => entry.projectId === projectId && entry.id === runId)
        const project = projects.data?.projects.find((entry) => entry.id === projectId)
        const path = taskPath(projectId, runId)
        const state = { manager: { ...origin, decision: message.id } }
        return (
          <div key={path} className="min-w-0">
            <p className="break-words text-sm font-semibold">{run ? runTitle(run as unknown as RunRecord) : `Task ${runId.slice(0, 8)}`}</p>
            <p className="break-words text-xs text-muted-foreground">{project?.name ?? projectId} · {run?.status ?? (index.isPending ? 'Loading task…' : 'Task unavailable or no longer listed')}</p>
            <div className="flex flex-wrap gap-x-2">
              <Link to={`${path}/chat${run?.status === 'waiting' ? '#ask' : '#latest'}`} state={state} className={linkClass}>Inspect task<span className="sr-only">: {run ? runTitle(run as unknown as RunRecord) : runId}</span></Link>
              <Link to={`${path}/assets`} state={state} className={linkClass}>Reports and assets</Link>
              {files.map((name) => <Link key={name} to={`${path}/assets/${encodeURIComponent(name)}`} state={state} className={linkClass}>{name}</Link>)}
            </div>
          </div>
        )
      })}
      <p className="text-xs text-muted-foreground">Return using “Back to {origin.name}”. Your unanswered decision and draft stay here.</p>
    </div>
  )
}
