import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { PlayIcon } from 'lucide-react'
import { queryScope, type GithubItem } from '@open-mercato/cezar-api-client'
import { createRun } from '@/api/client'
import { queryKeys, useSkills, workspaceQueryKeys } from '@/api/queries'
import { engineRunBody, useResolvedEngine, type EnginePick } from '@/components/engine-pills'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { githubRunBody } from '@/lib/github-task'

export const ISSUE_FIX_SKILL = 'om-auto-fix-issue'
export const ISSUE_FIX_BATCH_LIMIT = 20

/** One bounded ordinary run per issue; the existing scheduler remains the queue (#1621). */
export function useIssueFixActions({ items, queued, contextKey, unavailable, launch }: {
  items: readonly GithubItem[]
  queued: ReadonlyMap<string, string>
  contextKey: string
  unavailable: string | undefined
  launch: (item: GithubItem) => Promise<void>
}) {
  const displayed = useMemo(() => [...new Map(items.filter((item) => item.kind === 'issue')
    .map((item) => [item.url, item])).values()], [items])
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [message, setMessage] = useState('')
  const locked = useRef(false)
  const locallyQueued = useRef(new Map<string, Set<string>>())
  const latest = useRef({ queued, contextKey })
  latest.current = { queued, contextKey }
  useEffect(() => { setIds(new Set()); setConfirm(false); setMessage('') }, [contextKey])
  useEffect(() => {
    const visible = new Set(displayed.map((item) => item.url))
    setIds((current) => {
      const next = new Set([...current].filter((id) => visible.has(id)))
      return next.size === current.size ? current : next
    })
  }, [displayed])
  const isQueued = (url: string) => queued.has(url) || locallyQueued.current.get(contextKey)?.has(url) === true
  const selected = displayed.filter((item) => ids.has(item.url))
  const eligible = selected.filter((item) => !isQueued(item.url))
  const toggle = (url: string) => {
    if (locked.current) return
    setIds((current) => { const next = new Set(current); if (!next.delete(url)) next.add(url); return next })
  }
  const toggleAll = () => {
    if (!locked.current) setIds(selected.length === displayed.length ? new Set() : new Set(displayed.map((item) => item.url)))
  }
  const clear = () => { if (!locked.current) setIds(new Set()) }
  const apply = async (targets: readonly GithubItem[]) => {
    if (locked.current || unavailable !== undefined) return
    const unique = [...new Map(targets.filter((item) => item.kind === 'issue').map((item) => [item.url, item])).values()]
    const alreadyQueued = (url: string) => locallyQueued.current.get(contextKey)?.has(url) === true
      || (latest.current.contextKey === contextKey ? latest.current.queued : queued).has(url)
    const work = unique.filter((item) => !alreadyQueued(item.url))
    if (work.length > ISSUE_FIX_BATCH_LIMIT) {
      setMessage(`Select at most ${ISSUE_FIX_BATCH_LIMIT} issues to queue fixes.`)
      return
    }
    locked.current = true
    setBusy(true)
    setConfirm(false)
    const succeeded = new Set<string>()
    const failures: string[] = []
    let skipped = unique.length - work.length
    try {
      for (const item of work) {
        if (alreadyQueued(item.url)) { skipped++; continue }
        if (latest.current.contextKey === contextKey) setMessage(`Queuing issue #${item.number}…`)
        try {
          // This closure retains the original project's launch function and engine snapshot.
          await launch(item)
          const known = locallyQueued.current.get(contextKey) ?? new Set<string>()
          known.add(item.url)
          locallyQueued.current.set(contextKey, known)
          succeeded.add(item.url)
        } catch (error) {
          failures.push(`#${item.number}: ${error instanceof Error ? error.message.slice(0, 300) : 'Request failed'}`)
        }
      }
      if (latest.current.contextKey === contextKey) {
        setIds((current) => new Set([...current].filter((id) => !succeeded.has(id))))
        setMessage(`${succeeded.size} queued, ${skipped} skipped, ${failures.length} failed.${failures.length ? ` ${failures.join('; ')} Check Tasks before retrying; a failed response may already have created a task.` : ''}`)
      }
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  return { displayed, ids, selected, eligible, busy, confirm, setConfirm, message, unavailable, isQueued, toggle, toggleAll, clear, apply }
}

export type IssueFixActions = ReturnType<typeof useIssueFixActions>

const IssueFixContext = createContext<{ actions: IssueFixActions; engineLabel: string } | null>(null)
export const useIssueFixContext = () => useContext(IssueFixContext)

/** Mounted only for an available Issues list; PR/unavailable views do not discover engines. */
export function IssueFixListProvider({ enabled, ...props }: {
  enabled: boolean; items: readonly GithubItem[]; queued: ReadonlyMap<string, string>; engine: EnginePick;
  onQueued: (url: string, runId: string) => void; children: ReactNode
}) {
  return enabled ? <ActiveIssueFixProvider {...props} /> : <>{props.children}</>
}

function ActiveIssueFixProvider({ items, queued, engine, onQueued, children }: {
  items: readonly GithubItem[]; queued: ReadonlyMap<string, string>; engine: EnginePick;
  onQueued: (url: string, runId: string) => void; children: ReactNode
}) {
  const skills = useSkills()
  const resolved = useResolvedEngine(engine)
  const queryClient = useQueryClient()
  const scope = queryScope()
  const runsKey = queryKeys.runs.all
  const unavailable = skills.isPending ? 'Loading fix skill…'
    : skills.isError ? 'Fix skills are unavailable. Open Skills to retry.'
    : !skills.data.some((skill) => skill.name === ISSUE_FIX_SKILL) ? 'Install om-auto-fix-issue to queue fixes.'
    : resolved.providerPending ? 'Checking agent availability…'
    : !resolved.canRun ? 'Connect an agent to queue fixes.' : undefined
  const actions = useIssueFixActions({ items, queued, contextKey: scope, unavailable, launch: async (item) => {
    const created = await createRun(githubRunBody(item, null, [ISSUE_FIX_SKILL], undefined, engineRunBody(resolved)), scope)
    const run = 'runs' in created ? created.runs.length === 1 ? created.runs[0] : undefined : created
    if (!run) throw new Error('Unexpected task response. Check Tasks before retrying.')
    if (queryScope() === scope) onQueued(item.url, run.id)
    void queryClient.invalidateQueries({ queryKey: runsKey })
    void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.runsIndex })
  } })
  const accountLabel = resolved.account === null ? 'project account default'
    : resolved.accounts.find((account) => account.id === resolved.account)?.label ?? 'selected account'
  const engineLabel = `${resolved.runner} · ${resolved.modelsLocked ? 'agent settings' : resolved.model || 'agent default'} · ${accountLabel}`
  return <IssueFixContext.Provider value={{ actions, engineLabel }}>{children}</IssueFixContext.Provider>
}

export function IssueFixListToolbar() {
  const context = useIssueFixContext()
  return context ? <IssueFixToolbar {...context} /> : null
}

function SelectionCheckbox({ checked, mixed = false, label, disabled, onChange }: {
  checked: boolean; mixed?: boolean; label: string; disabled: boolean; onChange: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed }, [mixed])
  return <input ref={ref} type="checkbox" checked={checked} aria-label={label} disabled={disabled}
    onChange={onChange} className="size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-ring" />
}

export function IssueFixRowControls({ item, actions, queued }: { item: GithubItem; actions: IssueFixActions; queued: boolean }) {
  const alreadyQueued = queued || actions.isQueued(item.url)
  return <span className="absolute top-2 right-2 z-10 inline-flex items-center gap-1" data-slot="issue-fix-controls">
    <SelectionCheckbox label={`Select issue #${item.number}`} checked={actions.ids.has(item.url)} disabled={actions.busy}
      onChange={() => actions.toggle(item.url)} />
    <Button type="button" size="icon-sm" variant="ghost" aria-label={`Queue fix for issue #${item.number}`}
      title={alreadyQueued ? 'Already queued' : actions.unavailable ?? 'Queue fix with om-auto-fix-issue'}
      disabled={actions.busy || alreadyQueued || actions.unavailable !== undefined} onClick={() => void actions.apply([item])}>
      <PlayIcon className="size-3.5" aria-hidden="true" />
    </Button>
  </span>
}

export function IssueFixToolbar({ actions, engineLabel }: { actions: IssueFixActions; engineLabel: string }) {
  const count = actions.eligible.length
  const overLimit = count > ISSUE_FIX_BATCH_LIMIT
  return <>
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs" data-slot="issue-fix-toolbar">
      <SelectionCheckbox label="Select displayed issues" checked={actions.displayed.length > 0 && actions.selected.length === actions.displayed.length}
        mixed={actions.selected.length > 0 && actions.selected.length < actions.displayed.length} disabled={actions.busy || actions.displayed.length === 0} onChange={actions.toggleAll} />
      <span>{actions.selected.length ? `${actions.selected.length} selected` : 'Select issues'}</span>
      {actions.selected.length > 0 ? <>
        <Button type="button" variant="outline" size="sm" disabled={actions.busy || count === 0 || overLimit || actions.unavailable !== undefined}
          onClick={() => actions.setConfirm(true)}>Queue fixes ({count})</Button>
        <Button type="button" variant="ghost" size="sm" disabled={actions.busy} onClick={actions.clear}>Clear selection</Button>
      </> : null}
      {actions.unavailable ? <p className="w-full text-muted-foreground">{actions.unavailable}</p> : null}
      {overLimit ? <p className="w-full text-muted-foreground">Select at most {ISSUE_FIX_BATCH_LIMIT} eligible issues.</p> : null}
      <p role="status" aria-label="Issue fix status" aria-live="polite" className="w-full empty:hidden break-words text-muted-foreground">{actions.message}</p>
    </div>
    <Dialog open={actions.confirm} onOpenChange={actions.setConfirm}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Queue {count} issue fixes?</DialogTitle>
          <DialogDescription>One task per issue using {ISSUE_FIX_SKILL}. The existing scheduler controls when tasks start. Agent tasks may use paid tokens.</DialogDescription>
        </DialogHeader>
        <p className="break-words text-sm text-muted-foreground">Engine: {engineLabel}</p>
        <ul className="max-h-64 overflow-y-auto text-sm">{actions.eligible.map((item) => <li key={item.url} className="py-1 break-words">#{item.number} {item.title}</li>)}</ul>
        <p className="text-xs text-muted-foreground">{actions.selected.length - count} already queued issues skipped. Check Tasks before retrying a failed request.</p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => actions.setConfirm(false)}>Cancel</Button>
          <Button type="button" disabled={actions.busy || count === 0 || overLimit || actions.unavailable !== undefined}
            onClick={() => void actions.apply(actions.selected)}>Queue {count} tasks</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
