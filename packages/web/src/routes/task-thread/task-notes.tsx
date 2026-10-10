import { useParams } from 'react-router'

import { useRun, useRunHandoff } from '@/api/queries'

import { GitTabLoadError, GitTabLoading } from '../task-git/git-tab-loading'
import { Markdown } from './markdown'
import { RunHeader } from './run-header'

/**
 * `/tasks/:id/notes` — the handoff journal (spec 007) as its own tab: what the agent did and
 * what's left. It used to be a toggle in the header's action row that unfolded a capped panel
 * above the thread; it is content, not an action, so it gets a tab and the whole page to read in.
 */
export function TaskNotesRoute() {
  const { id } = useParams<{ id: string }>()
  const run = useRun(id)

  if (run.isPending) return <GitTabLoading tab="notes" />
  if (run.isError) return <GitTabLoadError tab="notes" error={run.error} />
  return (
    <div data-route="task-notes" className="flex min-h-full flex-col">
      <RunHeader run={run.data} tab="notes" />
      <div className="mx-auto w-full max-w-[var(--measure)] px-3 py-3 md:px-6 md:py-5">
        <NotesBody runId={run.data.id} />
      </div>
    </div>
  )
}

function NotesBody({ runId }: { runId: string }) {
  const handoff = useRunHandoff(runId)
  return (
    <div data-slot="notes-panel">
      {handoff.isPending ? (
        <p className="text-xs text-soft-foreground">Loading notes…</p>
      ) : handoff.isError ? (
        <p className="text-xs text-danger">{handoff.error.message}</p>
      ) : handoff.data.trim().length > 0 ? (
        <Markdown>{handoff.data}</Markdown>
      ) : (
        <p className="text-xs text-soft-foreground">
          No notes yet — the handoff file is seeded when the task starts.
        </p>
      )}
    </div>
  )
}
