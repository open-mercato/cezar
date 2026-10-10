import { useEffect, useRef, useState } from 'react'
import type { LifecycleAction, LifecycleOperationView } from '@open-mercato/cezar-api-client'
import { useLifecycleAction, useLifecycleOperation, useLifecycleOutput, useWorktreeLifecycleDetail } from '@/api/worktree-lifecycle'
import { Link } from '@/lib/project-router'
import { Button } from './ui/button'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './ui/alert-dialog'

const labels: Record<LifecycleAction, string> = {
  retry: 'Retry', 'start-anyway': 'Start task anyway', 'cancel-task': 'Cancel task',
  'keep-worktree': 'Keep worktree', 'force-delete': 'Force delete', stop: 'Stop scripts',
}
const confirmations = new Set<LifecycleAction>(['start-anyway', 'cancel-task', 'keep-worktree', 'force-delete'])
function explanation(action: LifecycleAction, operation: LifecycleOperationView): string {
  switch (action) {
    case 'force-delete': return `Skip remaining cleanup commands and ${operation.intent === 'delete-task' ? 'delete this task and its worktree' : 'remove this worktree'}? Containers, volumes, and other resources may remain. ${operation.intent === 'reclaim' ? 'The task branch is kept.' : 'The managed task branch is removed.'}`
    case 'start-anyway': return 'Start the task with an incomplete environment? Remaining setup commands will be skipped.'
    case 'cancel-task': return 'Cancel this task? The worktree and resources already created are kept; cleanup remains explicit.'
    case 'keep-worktree': return 'Keep this worktree and suppress automatic cleanup for this generation? Some resources may already have been stopped.'
    default: return ''
  }
}
function statusLabel(operation: LifecycleOperationView): string {
  if (operation.state === 'completed') return operation.phase === 'setup' ? 'Worktree ready' : 'Worktree cleanup complete'
  if (operation.state === 'bypassed') return 'Setup bypassed'
  if (operation.state === 'kept') return 'Worktree kept — automatic cleanup suppressed'
  if (operation.state === 'cancelled') return 'Task cancelled — worktree retained'
  if (operation.state === 'needs_attention' || operation.state === 'interrupted') return operation.phase === 'setup' ? 'Setup needs attention' : 'Cleanup needs attention'
  if (operation.state === 'committing') return operation.phase === 'setup' ? 'Finishing worktree preparation' : 'Removing worktree'
  return operation.phase === 'setup' ? 'Preparing worktree' : 'Cleaning up worktree'
}

/** Shared by task Session and orphan rows: recovery never depends on a task record. */
export function LifecycleOperationCard({operationId, worktreePath, taskTitle}: {operationId: string; worktreePath?: string; taskTitle?: string}) {
  const query = useLifecycleOperation(operationId)
  const mutation = useLifecycleAction(operationId)
  const [confirming, setConfirming] = useState<LifecycleAction | null>(null)
  const [outputOpen, setOutputOpen] = useState(false)
  const output = useLifecycleOutput(operationId, outputOpen)
  const status = useRef<HTMLHeadingElement>(null)
  const [clock, setClock] = useState(Date.now())
  const running = query.data?.operation.state === 'running'
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setClock(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  if (query.isPending) return <p className="text-xs text-muted-foreground">Loading worktree operation…</p>
  if (query.isError) return <p role="alert" className="text-xs text-danger">Worktree operation could not load: {query.error.message}</p>
  const operation = query.data.operation
  const act = async (action: LifecycleAction) => {
    setConfirming(null)
    try {
      await mutation.mutateAsync({action, requestId: crypto.randomUUID(), expectedRevision: operation.revision})
      status.current?.focus()
    } catch { /* The durable operation and inline error remain available for recovery. */ }
  }
  const frames = [...new Map((output.data?.pages.flatMap(page => page.items) ?? []).map(frame => [frame.seq, frame])).values()].sort((a,b) => a.seq - b.seq)
  const active = ['queued', 'running', 'committing'].includes(operation.state)
  return <section data-slot="worktree-lifecycle-operation" className="rounded-lg border border-border bg-card p-3 text-sm">
    <h2 ref={status} tabIndex={-1} className="font-medium outline-none" aria-live="polite">{statusLabel(operation)}</h2>
    {taskTitle ? <p className="mt-1 break-words text-xs text-muted-foreground">{taskTitle}</p> : null}
    {worktreePath ? <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{worktreePath}</p> : null}
    {operation.phase === 'setup' && active ? <p className="mt-1 text-xs text-muted-foreground">The agent starts after worktree preparation finishes.</p> : null}
    {operation.error ? <p role="alert" className="mt-2 break-words text-xs text-danger">{operation.failureStage === 'commit' ? 'Scripts completed, but the worktree transition failed. ' : ''}{operation.error}</p> : null}
    <ol className="mt-3 space-y-2">
      {operation.entries.map(entry => {
        const history = [...operation.history].reverse().find(item => item.entryId === entry.entryId && item.commandPreview === entry.commandPreview)
        const seconds = history ? Math.max(0, Math.round(((history.finishedAt ? Date.parse(history.finishedAt) : clock) - Date.parse(history.startedAt)) / 1000)) : undefined
        return <li key={entry.entryId} className="rounded border border-border px-2 py-1.5">
          <div className="flex flex-wrap justify-between gap-1 text-xs"><span className="break-words font-medium">{entry.label}</span><span className="text-muted-foreground">{entry.state.replaceAll('-', ' ')}{entry.attempt ? ` · attempt ${entry.attempt}` : ''}{seconds !== undefined ? ` · ${seconds}s` : ''}</span></div>
          <pre className="mt-1 whitespace-pre-wrap break-all text-[11px] text-muted-foreground">{entry.commandPreview}</pre>
        </li>
      })}
    </ol>
    {operation.history.length ? <details className="mt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">Attempt history ({operation.history.length})</summary><ol className="mt-2 space-y-2">{operation.history.map(attempt => <li key={attempt.id}><span>{attempt.label} · attempt {attempt.attempt} · {attempt.state}</span><pre className="whitespace-pre-wrap break-all text-[11px] text-muted-foreground">{attempt.commandPreview}</pre>{attempt.reason ? <p className="text-danger">{attempt.reason}</p> : null}</li>)}</ol></details> : null}
    {operation.allowedActions.includes('retry') ? <p className="mt-2 text-xs text-muted-foreground">Retry loads current saved scripts. Unchanged completed commands stay completed; edited commands run again.</p> : null}
    <div className="mt-3 flex flex-wrap gap-2">
      {operation.allowedActions.map(action => <Button key={action} size="sm" variant={action === 'force-delete' || action === 'cancel-task' ? 'danger-ghost' : 'outline'} disabled={mutation.isPending} onClick={() => confirmations.has(action) ? setConfirming(action) : void act(action)}>{labels[action]}</Button>)}
      <Button size="sm" variant="ghost" asChild><Link to={`/settings/worktrees?operation=${encodeURIComponent(operationId)}`}>Edit scripts</Link></Button>
      <Button size="sm" variant="ghost" aria-expanded={outputOpen} onClick={() => setOutputOpen(open => !open)}>{outputOpen ? 'Hide output' : 'Show output'}</Button>
    </div>
    {mutation.isError ? <p role="alert" className="mt-2 text-xs text-danger">{mutation.error.message}</p> : null}
    {outputOpen ? <div className="mt-3">
      {output.isPending ? <p className="text-xs text-muted-foreground">Loading output…</p> : null}
      {output.isError ? <p role="alert" className="text-xs text-danger">Output could not load: {output.error.message}</p> : null}
      {output.data?.pages.some(page => page.truncated) ? <p className="text-xs text-muted-foreground">Some earlier output was truncated.</p> : null}
      <pre aria-label="Script output" className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-[11px]">{frames.map(frame => frame.text).join('') || 'No output recorded.'}</pre>
      {output.hasNextPage ? <Button size="sm" variant="ghost" disabled={output.isFetchingNextPage} onClick={() => void output.fetchNextPage()}>Load more output</Button> : null}
    </div> : null}
    <AlertDialog open={confirming !== null} onOpenChange={open => { if (!open) setConfirming(null) }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{confirming ? labels[confirming] : 'Confirm action'}</AlertDialogTitle>
        <AlertDialogDescription>{confirming ? explanation(confirming, operation) : ''}<span className="mt-2 block break-all font-medium">{taskTitle ?? worktreePath ?? `Worktree operation ${operationId}`}</span></AlertDialogDescription>
      </AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Go back</AlertDialogCancel><AlertDialogAction onClick={() => { if (confirming) void act(confirming) }}>{confirming ? labels[confirming] : 'Continue'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </section>
}


/** Completed preparation remains inspectable after its active gate clears and after reload. */
export function TaskLifecycleCard({worktreeId, operationId, worktreePath, taskTitle}: {worktreeId: string; operationId?: string; worktreePath?: string; taskTitle?: string}) {
  const detail = useWorktreeLifecycleDetail(worktreeId, !operationId)
  const latest = operationId ?? [...(detail.data?.worktree.history ?? [])].sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0]?.id
  if (!latest) return null
  return <LifecycleOperationCard operationId={latest} worktreePath={worktreePath} taskTitle={taskTitle} />
}
