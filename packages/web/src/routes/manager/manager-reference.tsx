import { createContext, useContext, useMemo } from 'react'

import { useProjects, useRunsIndex } from '@/api/queries'
import { ReferenceChip } from '@/components/reference-chip'
import { ResolveConflictsForPr } from '@/components/reference-conflict-action'
import { UNKNOWN_PROJECT } from '@/lib/managers'
import { runTitle } from '@/lib/task-groups'
import type { ManagerMessage, RunRecord } from '@open-mercato/cezar-api-client'

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
export function ForgeReference({ kind, projectId, number, title }: { kind: 'PR' | 'Issue'; projectId: string; number: number; title?: string }) {
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
      className="align-middle no-underline pointer-coarse:relative pointer-coarse:after:absolute pointer-coarse:after:-inset-3"
    />
  )
}
