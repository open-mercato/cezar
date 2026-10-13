import { useCallback, useState } from 'react'
import { useParams } from 'react-router'

import { useRun } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'

import { GitTabLoadError, GitTabLoading } from '../task-git/git-tab-loading'
import { RunHeader } from '../task-thread/run-header'
import { BrowserView, reviveBrowserState, type BrowserState } from './browser-view'
import { DesignNotePopup } from './design-note-popup'
import { useDesignNotes } from './design-notes'

/**
 * `/tasks/:id/preview` — the task's app in a frame, with Design Mode (spec
 * `.ai/specs/2026-10-09-design-mode.md`): point at an element, write what should change, and the
 * note goes to the agent with the element's selector, component, box and markup.
 */
export function TaskPreviewRoute() {
  const { id } = useParams<{ id: string }>()
  const run = useRun(id)

  if (run.isPending) return <GitTabLoading tab="preview" />
  if (run.isError) return <GitTabLoadError tab="preview" error={run.error} />
  return (
    <div data-route="task-preview" className="flex h-full min-h-0 flex-col">
      <RunHeader run={run.data} tab="preview" />
      <div className="relative flex min-h-[420px] flex-1 flex-col pt-2">
        <PreviewBody key={run.data.id} run={run.data} />
      </div>
    </div>
  )
}

/** The tabs are this browser's, per task — a preview address is a machine-local thing, like the
 *  dev server it names, so it is not written to the run record. */
export const PREVIEW_TABS_STORAGE_PREFIX = 'cez-preview-tabs:'

function loadTabs(runId: string): BrowserState {
  try {
    const stored = localStorage.getItem(PREVIEW_TABS_STORAGE_PREFIX + runId)
    return reviveBrowserState(stored === null ? null : JSON.parse(stored))
  } catch {
    return reviveBrowserState(null)
  }
}

function PreviewBody({ run }: { run: ApiRun }) {
  const [state, setState] = useState(() => loadTabs(run.id))
  const onChange = useCallback(
    (next: BrowserState) => {
      setState(next)
      try {
        localStorage.setItem(PREVIEW_TABS_STORAGE_PREFIX + run.id, JSON.stringify(next))
      } catch {
        // Storage full or blocked: the tabs still work for this visit.
      }
    },
    [run.id],
  )
  const notes = useDesignNotes(run)

  return (
    <BrowserView
      state={state}
      onChange={onChange}
      onPickElement={notes.addDraft}
      designMarks={notes.marks}
      onDesignEscape={(mark) => {
        if (notes.note(mark)?.phase === 'draft') notes.discard(mark)
      }}
      renderDesignNote={({ mark, close }) => {
        const note = notes.note(mark)
        return note ? <DesignNotePopup note={note} run={run} notes={notes} onClose={close} /> : null
      }}
    />
  )
}
