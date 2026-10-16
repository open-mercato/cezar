import { useMemo } from 'react'
import { useParams } from 'react-router'

import { useHealth, useRun, useRunHandoff } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { useNavigate } from '@/lib/project-router'

import { GitTabLoadError, GitTabLoading } from '../task-git/git-tab-loading'
import { LayoutCards } from '../task-workspace/layout-cards'
import { FIXED_VIEW_ORDER, VIEW_PATHS } from '../task-workspace/layout-state'
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
      <NotesHeader run={run.data} />
      <div className="mx-auto w-full max-w-[var(--measure)] px-3 py-3 md:px-6 md:py-5">
        <NotesBody runId={run.data.id} />
      </div>
    </div>
  )
}

/** The workspace's own tab row, so the header reads the same on every page of a task. A view tab
 *  here navigates to that view's deep link; there are no layouts to switch on this page. */
function NotesHeader({ run }: { run: ApiRun }) {
  const navigate = useNavigate()
  const terminal = useHealth().data?.capabilities?.terminal === true
  const fixedViews = useMemo(
    () => FIXED_VIEW_ORDER.filter((view) => (view !== 'graph' || Boolean(run.workflowDef)) && (view !== 'terminal' || terminal)),
    [run.workflowDef, terminal],
  )
  const tabs = useMemo(
    () => (
      <LayoutCards
        layouts={[]}
        active=""
        fixedViews={fixedViews}
        onSelectFixed={(view) => navigate(`/tasks/${run.id}/${VIEW_PATHS[view]}`)}
        onSelect={noop}
        onRename={noop}
        onClose={noop}
        onCreate={noop}
        notesHref={`/tasks/${run.id}/notes`}
        notesActive
        showLayouts={false}
      />
    ),
    [fixedViews, navigate, run.id],
  )
  return <RunHeader run={run} tab="notes" tabs={tabs} wide />
}

const noop = () => {}

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
