import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { Link } from 'react-router'

import { useProjects, useRunsIndex } from '@/api/queries'
import { chipClass } from '@/components/chip'
import { ReferenceChip } from '@/components/reference-chip'
import { ResolveConflictsForPr } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider } from '@/components/reference-status'
import {
  inlineReferenceRequests,
  inlineReferenceText,
  parseInlineReferences,
  referenceProjectOf,
  UNKNOWN_PROJECT,
  type InlineReference,
  type ManagerOrigin,
  type ManagerReferenceProject,
} from '@/lib/managers'
import { runTitle } from '@/lib/task-groups'
import { cn } from '@/lib/utils'
import { AskTextContext, type AskTextRenderer } from '@/routes/task-thread/ask-text'
import type { ManagerAsk, ManagerMessage, RunRecord } from '@open-mercato/cezar-api-client'

import { TaskChipLabel, taskPath } from './manager-session-card'

/** Pull request titles the chat already knows, from its merge proposals, keyed `project/number`. */
export const PrTitlesContext = createContext<ReadonlyMap<string, string>>(new Map())

/** Stable while no proposal changes, so a streamed delta does not re-render every chip. */
export function usePrTitles(messages: readonly ManagerMessage[]): ReadonlyMap<string, string> {
  const entries = JSON.stringify(messages.flatMap((message) =>
    message.kind === 'action' && message.action.type === 'merge-pr' && message.action.title
      ? [[`${message.action.projectId}/${message.action.number}`, message.action.title]]
      : []))
  return useMemo(() => new Map(JSON.parse(entries) as Array<[string, string]>), [entries])
}

/** The chat's one PR/issue chip, in a sentence and on a proposal card alike: the same bubble the
 *  task tables show, its status from the surrounding provider. Coarse pointers get a 44 px target. */
export function ForgeReference({ kind, projectId, number, title, tight = false }: {
  kind: 'PR' | 'Issue'
  projectId: string
  number: number
  title?: string
  /** No 44 px halo: inside a pick button it would swallow taps meant to pick. */
  tight?: boolean
}) {
  const project = useProjects().data?.projects.find((entry) => entry.id === projectId)
  const proposed = useContext(PrTitlesContext).get(`${projectId}/${number}`)
  // Named by the reference, not the manager: its title, the task that opened it, else its project.
  const task = useRunsIndex().data?.runs.find((run) =>
    kind === 'PR' && run.projectId === projectId && (run.prNumber === number || run.markerRefs?.pr === number))
  const about = title ?? (kind === 'PR' ? proposed : undefined) ?? (task ? runTitle(task as unknown as RunRecord) : project?.name)
  return (
    <ReferenceChip
      compact
      reference={{ kind, number, ...(project?.repoUrl ? { url: `${project.repoUrl}/${kind === 'PR' ? 'pull' : 'issues'}/${number}` } : {}) }}
      taskTitle={`#${number}${about ? `, ${about}` : ''}`}
      {...(projectId === UNKNOWN_PROJECT ? {} : { projectId })}
      // Either kind: a `#N` guessed as an issue can be a PR, and the chip shows this only then.
      {...(projectId === UNKNOWN_PROJECT
        ? {}
        : { conflictAction: <ResolveConflictsForPr projectId={projectId} prNumber={number} /> })}
      className={cn('align-middle no-underline', !tight && 'pointer-coarse:relative pointer-coarse:after:absolute pointer-coarse:after:-inset-3')}
    />
  )
}

/** A `[[task:…]]` inside a sentence or a card: the task's title, a way into its thread. */
export function TaskReference({ projectId, runId, origin, className }: { projectId: string; runId: string; origin: ManagerOrigin; className?: string }) {
  return (
    <Link to={taskPath(projectId, runId)} state={{ manager: origin }} data-slot="manager-task-chip" className={cn(chipClass, 'inline-flex no-underline', className)}>
      <TaskChipLabel projectId={projectId} runId={runId} />
    </Link>
  )
}

/** The chat's connected projects, for card text a row draws outside the reply's own markdown. */
export const ManagerProjectsContext = createContext<readonly ManagerReferenceProject[]>([])

/** Card text with its references as the chat's chips. They sit above whatever overlays the card
 *  (an option's button), so a click on one opens it rather than picking. */
export function InlineReferences({ pieces, origin, tight = false }: { pieces: readonly InlineReference[]; origin: ManagerOrigin; tight?: boolean }) {
  return pieces.map((piece, index) => {
    if (piece.kind === 'text') return piece.text
    return (
      <span key={index} data-slot="manager-inline-reference" className="relative z-10 inline-flex align-middle">
        {piece.kind === 'task' ? (
          <TaskReference projectId={piece.projectId} runId={piece.runId} origin={origin} />
        ) : (
          <ForgeReference kind={piece.kind === 'pr' ? 'PR' : 'Issue'} projectId={piece.projectId} number={piece.number} tight={tight} />
        )}
      </span>
    )
  })
}

/** One plain text with chips (a proposal's reason), its own status lookup included. */
export function ManagerReferenceText({ text, origin }: { text: string; origin: ManagerOrigin }) {
  const projects = useContext(ManagerProjectsContext)
  const pieces = useMemo(() => parseInlineReferences(text, projects), [text, projects])
  return (
    <ReferenceStatusProvider requests={inlineReferenceRequests([pieces])}>
      <InlineReferences pieces={pieces} origin={origin} />
    </ReferenceStatusProvider>
  )
}

/** Every text a `CEZ:ASK` card shows, so its bare `#12`s resolve against one project. */
function askTexts(ask: Pick<ManagerAsk, 'questions'>): string[] {
  return ask.questions.flatMap((question) => [
    question.question,
    ...question.options.flatMap((option) => [option.label, ...(option.description ? [option.description] : [])]),
  ])
}

/** A manager's `CEZ:ASK` card paints PR, issue and task references as the chat's chips. */
export function ManagerAskText({ ask, origin, children }: { ask: Pick<ManagerAsk, 'questions'>; origin: ManagerOrigin; children: ReactNode }) {
  const projects = useContext(ManagerProjectsContext)
  const { renderer, requests } = useMemo(() => {
    const texts = askTexts(ask)
    const project = referenceProjectOf(texts, projects)
    const parsed = new Map(texts.map((text) => [text, parseInlineReferences(text, projects, project)]))
    const piecesOf = (text: string) => parsed.get(text) ?? parseInlineReferences(text, projects, project)
    const renderer: AskTextRenderer = {
      render: (text, where) => <InlineReferences pieces={piecesOf(text)} origin={origin} tight={where === 'option'} />,
      plain: inlineReferenceText,
      interactive: (text) => piecesOf(text).some((piece) => piece.kind !== 'text'),
    }
    return { renderer, requests: inlineReferenceRequests([...parsed.values()]) }
  }, [ask, projects, origin])
  return (
    <AskTextContext.Provider value={renderer}>
      <ReferenceStatusProvider requests={requests}>{children}</ReferenceStatusProvider>
    </AskTextContext.Provider>
  )
}
