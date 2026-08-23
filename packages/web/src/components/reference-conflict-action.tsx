import { useState } from 'react'
import type { ApiRun } from '@open-mercato/cezar-api-client'

import { useProjectRun } from '@/api/queries'
import { ReferenceChip, useCloseReferenceCard } from '@/components/reference-chip'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { runTitle } from '@/lib/task-groups'
import { useAskAnswer } from '@/routes/task-thread/ask-answer'
import { resolveConflictsPrompt } from '@/routes/task-thread/run-actions'

/**
 * "Resolve conflicts" — the one thing every surface hands to a conflicting chip's panel.
 *
 * One component, and that is the point: the chip was already shared (same orange, same glyph,
 * same words wherever a reference is painted) while the ACTION was the task page's alone. Four
 * copies of "build the prompt, pick the delivery seam, disable it with a reason, toast the
 * failure" is four chances for one page to send differently-worded text or to swallow an error.
 *
 * It is only ever MOUNTED inside an open panel (`conflictAction` is a node, see `ReferenceChip`),
 * which is what lets a hundred-row table pass it per row for free: no delivery exists until a
 * user hovers a chip that is actually conflicting.
 */
export function ResolveConflictsButton({
  run,
  projectId,
  prNumber,
}: {
  run: ApiRun
  /** Named only by a surface standing OUTSIDE this run's project — the global Tasks page, whose
   *  rows span the registry. Elsewhere the scope is already right. */
  projectId?: string
  prNumber?: number
}) {
  // Whichever seam this run's state allows — a live message, or a continue for a task parked at
  // review. Offering a prompt that only worked on a running task would offer it exactly when it
  // could not be taken: a conflicting PR is usually attached to a task that has already finished.
  const delivery = useAskAnswer(run, projectId)
  const close = useCloseReferenceCard()
  const [busy, setBusy] = useState(false)
  const pending = busy || delivery.isPending
  const blocked = Boolean(delivery.blockedBy)

  const press = async () => {
    if (pending || blocked) return
    // Read BEFORE the send: delivering flips a parked task to `running`, and by the time the
    // promise resolves the record no longer says which seam it travelled on.
    const reopened = delivery.mode === 'resume'
    setBusy(true)
    try {
      const failure = await delivery.send(resolveConflictsPrompt(prNumber))
      // Both outcomes are announced where the user acted, because the panel is gone by the time
      // this resolves and three of the four surfaces that offer this button do not show the
      // transcript the prompt lands in. Saying that a FINISHED task was reopened matters most:
      // that is a state change the user did not explicitly ask for and would otherwise discover
      // from a status pill quietly turning green.
      if (failure) toast(failure, { tone: 'danger' })
      else {
        toast(
          `${reopened ? 'Task reopened' : 'Sent to the task'} — resolving conflicts${
            prNumber ? ` in PR #${prNumber}` : ''
          }`,
        )
        close()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {/* The CTA variant, not `outline`: an outline button on this panel is a card-coloured
          rectangle on a card-coloured surface (`--popover` IS `--card`), which is how it read as
          an invisible black box. This is the only thing in the panel meant to be pressed. */}
      <Button
        type="button"
        size="sm"
        data-slot="reference-conflict-action"
        disabled={blocked || pending}
        onClick={() => void press()}
        className="h-7 w-full text-xs"
      >
        {pending ? 'Sending…' : 'Resolve conflicts'}
      </Button>
      {/* Only the REFUSAL is spelled out. What the button will do is the button's own words —
          quoting the prompt underneath said the same thing twice, at four times the length. */}
      {blocked && delivery.reason ? <span className="block opacity-70">{delivery.reason}</span> : null}
    </>
  )
}

/**
 * The same button for a row that only has an ID — the cross-project case.
 *
 * The global Tasks index ships a deliberately slim entry (no `steps`, no `runner`), and whether a
 * finished task can be reopened is a question only the full record answers. So it fetches one —
 * but only here, inside a panel that is already open, which is the whole reason the action is a
 * lazily mounted node: a hundred-row table costs nothing until somebody hovers a chip that is
 * actually conflicting, and then costs exactly one record.
 */
export function ResolveConflictsForRun({
  projectId,
  runId,
  prNumber,
}: {
  projectId: string
  runId: string
  prNumber?: number
}) {
  const run = useProjectRun(projectId, runId)
  if (!run.data) {
    return (
      <Button type="button" size="sm" disabled className="h-7 w-full text-xs">
        {run.isError ? 'Unavailable' : 'Loading…'}
      </Button>
    )
  }
  return <ResolveConflictsButton run={run.data} projectId={projectId} prNumber={prNumber} />
}

/**
 * A reference chip for a row that HAS its run record — the chip plus the action, in one call.
 *
 * What the tasks tables render, so a conflicting pull request behaves the same whether the user
 * is looking at the task or at the list it came from. The task page keeps the bare `ReferenceChip`
 * because it paints several references and builds its own nodes; everywhere else a row has
 * exactly one reference and this is the whole of it.
 */
export function TaskReferenceChip({
  run,
  reference,
  className,
  compact = false,
}: {
  run: ApiRun
  reference: { kind: 'PR' | 'Issue'; number?: number; url?: string }
  className?: string
  /** The narrow sidebar row — the chip's own abbreviation. The panel it opens is the full one:
   *  there is room for words in a panel wherever the row it hangs off is. */
  compact?: boolean
}) {
  return (
    <ReferenceChip
      reference={reference}
      taskTitle={runTitle(run)}
      conflictAction={<ResolveConflictsButton run={run} prNumber={reference.number} />}
      className={className}
      compact={compact}
    />
  )
}
