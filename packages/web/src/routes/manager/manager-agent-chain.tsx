import { ArrowLeftRightIcon, BotIcon, ChevronLeftIcon, CircleAlertIcon, CircleCheckIcon, GripVerticalIcon, InfoIcon, PlusIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState, type DragEvent, type FocusEvent, type PointerEvent } from 'react'

import { useAgentProfiles, useHealth, useProviderStatus, useRunnerModels } from '@/api/queries'
import { useUpdateManager } from '@/api/managers'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { toast } from '@/components/ui/toaster'
import { effortLabel } from '@/lib/managers'
import { usableRunners } from '@/lib/provider-status'
import { PHONE_QUERY, useMediaQuery } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'
import { modelsForRunner } from '@/routes/new-task-form'
import {
  DEFAULT_AGENT_ACCOUNT_ID,
  MANAGER_BACKUPS_MAX,
  type ManagerAgentRef,
  type ManagerBackupAgent,
  type ManagerEffort,
  type ManagerMessage,
  type ManagerSummary,
  type Runner,
} from '@open-mercato/cezar-api-client'

import { AccountPicker, ManagerRunnerPicker, ModelPicker, useManagerRunner, type ManagerPatch } from './manager-pickers'

/** One row of the chain as the dialog edits it (spec 2026-11-25-manager-agent-chain). */
interface Row {
  runner?: string
  agentProfile?: string
  model?: string
  effort?: ManagerEffort
}

const FIELD = 'h-11 w-full justify-between rounded-lg border border-border bg-background px-3 text-foreground [&>svg]:order-last [&>span]:min-w-0 [&>span]:flex-1 [&>span]:text-left'

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** `#2 · claude Personal`: the number the settings show, then the agent and account. */
export const agentRefName = (ref: ManagerAgentRef) => `#${ref.slot + 1} · ${ref.runner} ${ref.label ?? ref.profileId}`

const rowsOf = (manager: ManagerSummary): Row[] => [
  {
    ...(manager.runner ? { runner: manager.runner } : {}),
    ...(manager.agentProfile !== undefined ? { agentProfile: manager.agentProfile } : {}),
    ...(manager.model ? { model: manager.model } : {}),
    ...(manager.effort ? { effort: manager.effort } : {}),
  },
  ...(manager.backups ?? []),
]

const toBackup = (row: Row, fallbackRunner: string): ManagerBackupAgent => ({
  runner: (row.runner ?? fallbackRunner) as Runner,
  ...(row.agentProfile !== undefined ? { agentProfile: row.agentProfile } : {}),
  ...(row.model ? { model: row.model } : {}),
  ...(row.effort ? { effort: row.effort } : {}),
})

/** The whole chain as one patch: #1's four fields plus `backups`, so a reorder is atomic. */
function chainPatch(rows: Row[], fallbackRunner: string): ManagerPatch {
  const [first, ...rest] = rows
  return {
    // #1 that followed the workspace default keeps following it.
    runner: first?.runner ?? null,
    agentProfile: first?.agentProfile ?? null,
    model: first?.model ?? null,
    effort: first?.effort ?? null,
    backups: rest.map((row) => toBackup(row, fallbackRunner)),
  }
}

/** A picker's patch applied to one row; a new agent drops its model and account, as on #1. */
function applyPatch(row: Row, patch: ManagerPatch): Row {
  const next: Row = { ...row }
  for (const key of ['runner', 'agentProfile', 'model', 'effort'] as const) {
    if (!(key in patch)) continue
    const value = patch[key]
    if (value === null || value === undefined) delete next[key]
    else (next as Record<string, unknown>)[key] = value
  }
  return next
}

function RowSummary({ row, fallbackRunner }: { row: Row; fallbackRunner: string }) {
  const runner = (row.runner ?? fallbackRunner) as Runner
  const profiles = useAgentProfiles().data
  const catalog = useRunnerModels(runner)
  const account = row.agentProfile ?? profiles?.defaults?.[runner] ?? DEFAULT_AGENT_ACCOUNT_ID
  const accountLabel = profiles?.profiles.find((entry) => entry.provider === runner && entry.id === account)?.label
    ?? (account === DEFAULT_AGENT_ACCOUNT_ID ? 'Default' : account)
  const model = modelsForRunner(runner, catalog.data, [row.model]).find((entry) => entry.id === (row.model ?? ''))?.label ?? row.model ?? 'auto'
  return (
    <>
      <span className="min-w-0 flex-1 truncate text-left">{runner} · <b className="font-semibold">{accountLabel}</b></span>
      <span data-slot="manager-chain-model" className="shrink-0 rounded-md border border-border bg-muted px-1.5 text-xs max-sm:hidden">
        {model}{runner === 'claude' && row.effort ? ` · ${effortLabel(row.effort)}` : ''}
      </span>
    </>
  )
}

const NO_CONNECTORS_TEXT = 'Connectors are Claude-only. While this agent answers, the Manager works without them.'

function NoConnectorsInfo() {
  const [open, setOpen] = useState(false)
  const descriptionId = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const clearTimer = () => clearTimeout(closeTimer.current)
  const holdsFocus = (node: EventTarget | null) =>
    node instanceof Node && (contentRef.current?.contains(node) || triggerRef.current?.contains(node))
  const scheduleClose = () => {
    if (holdsFocus(document.activeElement)) return
    clearTimer()
    closeTimer.current = setTimeout(() => setOpen(false), 100)
  }
  useEffect(() => () => clearTimeout(closeTimer.current), [])

  return (
    <Popover open={open} onOpenChange={(next) => { clearTimer(); setOpen(next) }}>
      <span id={descriptionId} hidden>{NO_CONNECTORS_TEXT}</span>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          data-slot="manager-chain-no-connectors"
          aria-label="No connectors on this agent"
          aria-describedby={descriptionId}
          // Open-only click: hovering or focusing already opens the popover, so letting Radix's
          // default toggle run would immediately close it on click, tap, or Enter/Space.
          // Outside-tap and Escape still close it via onOpenChange.
          onClick={(event) => {
            event.preventDefault()
            clearTimer()
            setOpen(true)
          }}
          onPointerEnter={(event: PointerEvent) => {
            if (event.pointerType === 'touch') return
            clearTimer()
            setOpen(true)
          }}
          onPointerLeave={(event: PointerEvent) => {
            if (event.pointerType !== 'touch') scheduleClose()
          }}
          onFocus={() => {
            clearTimer()
            setOpen(true)
          }}
          onBlur={(event: FocusEvent) => {
            if (!holdsFocus(event.relatedTarget)) {
              clearTimer()
              setOpen(false)
            }
          }}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-background hover:text-foreground hover:ring-1 hover:ring-border focus-visible:bg-background focus-visible:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:size-11"
        >
          <InfoIcon aria-hidden="true" className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="end"
        side="top"
        data-slot="manager-chain-no-connectors-popover"
        className="w-64 max-w-[calc(100vw-2rem)] p-3 text-xs text-popover-foreground"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={clearTimer}
        onPointerLeave={(event: PointerEvent) => {
          if (event.pointerType !== 'touch') scheduleClose()
        }}
      >
        {NO_CONNECTORS_TEXT}
      </PopoverContent>
    </Popover>
  )
}

function StatusPill({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'plain'; children: string }) {
  return (
    <span
      data-slot="manager-chain-status"
      className={cn(
        'shrink-0 rounded-md border px-1.5 text-xs whitespace-nowrap',
        tone === 'ok' && 'border-success/40 text-success',
        tone === 'warn' && 'border-pending-strong/45 text-pending-strong',
        tone === 'bad' && 'border-danger/40 text-danger',
        tone === 'plain' && 'border-border text-muted-foreground',
      )}
    >
      {children}
    </span>
  )
}

function RowEditor({ row, slot, count, fallbackRunner, canReorder, onChange, onMove, onPrimary, onRemove }: {
  row: Row
  slot: number
  count: number
  fallbackRunner: string
  canReorder: boolean
  onChange: (patch: ManagerPatch) => void
  onMove: () => void
  onPrimary: () => void
  onRemove: () => void
}) {
  const runner = row.runner ?? fallbackRunner
  // A #1 that follows the default stays unpinned, so picking that agent still pins it.
  const selection = {
    ...(row.runner ? { runner: row.runner } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.effort ? { effort: row.effort } : {}),
    ...(row.agentProfile !== undefined ? { agentProfile: row.agentProfile } : {}),
  }
  return (
    <div data-slot="manager-chain-editor" className="space-y-3 rounded-xl border border-border bg-popover p-3 sm:ml-7">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-1.5">
          <p className="text-xs text-muted-foreground">Agent</p>
          <ManagerRunnerPicker {...selection} onChange={onChange} className={FIELD} />
        </div>
        <div className="min-w-0 space-y-1.5">
          <p className="text-xs text-muted-foreground">Account</p>
          <AccountPicker {...selection} onChange={onChange} className={FIELD} />
        </div>
        <div className="min-w-0 space-y-1.5 sm:col-span-2">
          <p className="text-xs text-muted-foreground">Model and effort</p>
          <ModelPicker {...selection} onChange={onChange} className={FIELD} modelOnly />
        </div>
      </div>
      {runner !== 'claude' ? <p className="text-xs text-muted-foreground">Connectors and file writes are Claude-only; on {runner} this Manager answers without them.</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {slot > 0 ? (
          <>
            <Button variant="outline" size="sm" className="pointer-coarse:h-11" data-action="manager-chain-up" disabled={!canReorder} onClick={onMove}>Move up</Button>
            <Button variant="outline" size="sm" className="pointer-coarse:h-11" data-action="manager-chain-primary" disabled={!canReorder} onClick={onPrimary}>Make primary</Button>
            <Button variant="ghost" size="sm" className="ml-auto text-danger hover:text-danger pointer-coarse:h-11" data-action="manager-chain-remove" onClick={onRemove}>Remove</Button>
          </>
        ) : count > 1 ? <p className="text-xs text-muted-foreground">#1 is the primary: it answers whenever it can.</p> : null}
      </div>
    </div>
  )
}

/**
 * "This Manager" as an ordered list: #1 the primary, the rest backups (spec 2026-11-25-manager-agent-chain,
 * design 1C). Every change is one PATCH of the whole chain.
 */
export function AgentChainSection({ manager, onPatch, initialEditing }: { manager: ManagerSummary; onPatch: (patch: ManagerPatch) => void; initialEditing?: number }) {
  const fallbackRunner = useManagerRunner(manager.runner)
  const phone = useMediaQuery(PHONE_QUERY)
  const profiles = useAgentProfiles().data
  const providerStatus = useProviderStatus()
  const usable = usableRunners(providerStatus.data).filter((runner) => runner !== 'pi')
  const health = useHealth()
  const update = useUpdateManager(manager.id)
  const [editing, setEditing] = useState<number | null>(initialEditing ?? null)
  const [dragging, setDragging] = useState<number | null>(null)
  const rows = rowsOf(manager)
  // An unpinned #1 moved down is saved with the default runner: wait until that is known.
  const canReorder = rows[0]?.runner !== undefined || health.data !== undefined
  const active = manager.activeAgent?.agent.slot ?? 0
  const grants = Object.values(manager.connectors ?? {}).some((grant) => grant.level !== 'off')
  const save = (next: Row[]) => onPatch(chainPatch(next, fallbackRunner))
  const move = (from: number, to: number) => {
    if (from === to) return
    // A #1 that followed the default needs a runner of its own once it is a backup.
    const next = rows.map((row, index) => (index === 0 ? { ...row, runner: row.runner ?? fallbackRunner } : row))
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved!)
    save(next)
    setEditing(to)
  }
  // "Make primary" swaps: the old #1 takes the row's place (design 1C).
  const swapToFirst = (slot: number) => {
    const next = [...rows]
    ;[next[0], next[slot]] = [next[slot]!, { ...next[0]!, runner: next[0]!.runner ?? fallbackRunner }]
    save(next)
    setEditing(0)
  }
  const keyOf = (row: Row) => `${row.runner ?? fallbackRunner}|${row.agentProfile ?? DEFAULT_AGENT_ACCOUNT_ID}`
  const add = () => {
    const used = new Set(rows.map(keyOf))
    // The first agent and account the chain does not have yet.
    const candidates = usable.flatMap((runner) => [
      { runner },
      ...(profiles?.profiles ?? []).filter((account) => account.provider === runner && !account.pending && account.id !== DEFAULT_AGENT_ACCOUNT_ID).map((account) => ({ runner, agentProfile: account.id })),
    ])
    const fresh = candidates.find((candidate) => !used.has(keyOf(candidate)))
    if (!fresh) {
      toast('Every agent and account you have is already in the chain.', { tone: 'danger' })
      return
    }
    save([...rows, fresh])
    setEditing(rows.length)
  }
  const statusOf = (slot: number) => {
    if (rows.length > 1 && slot === active) return <StatusPill tone="ok">answering</StatusPill>
    if (slot === 0 && manager.activeAgent) {
      return manager.activeAgent.reason === 'auth'
        ? <StatusPill tone="bad">sign in</StatusPill>
        : <StatusPill tone="warn">{manager.activeAgent.primaryBackAt ? `out until ${clock(manager.activeAgent.primaryBackAt)}` : 'unavailable'}</StatusPill>
    }
    return null
  }
  const editor = (slot: number) => (
    <RowEditor
      row={rows[slot]!}
      slot={slot}
      count={rows.length}
      fallbackRunner={fallbackRunner}
      canReorder={canReorder}
      // #1's own fields patch as they always did; a backup's edit rewrites the list.
      onChange={(patch) => (slot === 0 ? onPatch(patch) : save(rows.map((row, index) => (index === slot ? applyPatch(row, patch) : row))))}
      onMove={() => move(slot, slot - 1)}
      onPrimary={() => swapToFirst(slot)}
      onRemove={() => { save(rows.filter((_, index) => index !== slot)); setEditing(null) }}
    />
  )
  // A phone pushes the row's editor as its own page (design 1C, phone).
  if (phone && editing !== null && rows[editing]) {
    return (
      <section aria-label="Manager chat agent" data-slot="manager-chain" className="space-y-3 rounded-xl border border-border p-4">
        <button type="button" className="flex min-h-11 items-center gap-1.5 text-sm font-semibold" onClick={() => setEditing(null)}>
          <ChevronLeftIcon aria-hidden="true" className="size-4" />
          {editing === 0 ? 'Primary agent #1' : `Backup agent #${editing + 1}`}
        </button>
        {editor(editing)}
      </section>
    )
  }
  return (
    <section aria-label="Manager chat agent" data-slot="manager-chain" className="space-y-3 rounded-xl border border-border p-4">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold"><BotIcon aria-hidden="true" className="size-4 text-muted-foreground" />This Manager</h3>
        {rows.length > 1 ? <p className="mt-1 text-xs text-muted-foreground">The first agent that can reply does. The ones below take over when it’s out of limits or can’t sign in.</p> : null}
      </div>
      <ol className="space-y-1.5">
        {rows.map((row, slot) => {
          const status = statusOf(slot)
          const showNoConnectors = (row.runner ?? fallbackRunner) !== 'claude' && grants
          return (
            <li
              key={`${slot}-${keyOf(row)}`}
              className="space-y-1.5"
              onDragOver={(event: DragEvent) => { if (dragging !== null) event.preventDefault() }}
              onDrop={() => { if (dragging !== null) move(dragging, slot); setDragging(null) }}
            >
              <div
                className={cn(
                  'flex min-h-11 w-full items-center gap-1 rounded-lg border border-border bg-background px-2 text-sm hover:bg-muted has-[[data-slot="manager-chain-row"]:focus-visible]:ring-[3px] has-[[data-slot="manager-chain-row"]:focus-visible]:ring-ring/50',
                  editing === slot && 'border-primary ring-1 ring-primary',
                )}
              >
                <button
                  type="button"
                  data-slot="manager-chain-row"
                  data-slot-index={slot}
                  aria-expanded={editing === slot}
                  draggable={!phone && rows.length > 1 && canReorder}
                  onDragStart={() => setDragging(slot)}
                  onDragEnd={() => setDragging(null)}
                  onClick={() => setEditing(editing === slot ? null : slot)}
                  className="flex min-h-11 min-w-0 flex-1 items-center gap-2 outline-none"
                >
                  {rows.length > 1 && !phone ? <GripVerticalIcon aria-hidden="true" className="size-3.5 shrink-0 cursor-grab text-muted-foreground" /> : null}
                  <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-md text-xs', slot === 0 ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground')}>{slot + 1}</span>
                  <RowSummary row={row} fallbackRunner={fallbackRunner} />
                  {status}
                </button>
                {showNoConnectors ? <NoConnectorsInfo /> : null}
              </div>
              {!phone && editing === slot ? editor(slot) : null}
            </li>
          )
        })}
      </ol>
      {rows.length <= MANAGER_BACKUPS_MAX ? (
        <button type="button" data-action="manager-chain-add" disabled={!providerStatus.data} className="flex min-h-8 items-center gap-1.5 text-sm text-primary pointer-coarse:min-h-11 disabled:opacity-50" onClick={add}>
          <PlusIcon aria-hidden="true" className="size-3.5" />
          Add backup agent
        </button>
      ) : null}
      {rows.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span className="flex-1">After a switch, go back to #1</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" data-slot="manager-chain-failback" className="pointer-coarse:h-11">
                {manager.failback === 'manual' ? 'Only when I switch' : 'When it’s available'}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup value={manager.failback ?? 'available'} onValueChange={(next) => onPatch({ failback: next === 'manual' ? 'manual' : null })}>
                <DropdownMenuRadioItem value="available">When it’s available</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="manual">Only when I switch</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
      {manager.activeAgent ? (
        <div data-slot="manager-chain-active" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span className="flex-1">Answering with #{manager.activeAgent.agent.slot + 1} since {clock(manager.activeAgent.since)}</span>
          <Button variant="outline" size="sm" className="pointer-coarse:h-11" disabled={update.isPending} onClick={() => update.mutate({ switchToPrimary: true }, { onError: (error) => toast(error.message, { tone: 'danger' }) })}>
            Switch back to #1 now
          </Button>
        </div>
      ) : null}
    </section>
  )
}

const REASON: Record<string, string> = {
  'usage-limit': 'is out of usage limits',
  held: 'is out of usage limits',
  auth: 'can’t sign in',
  billing: 'is out of credits',
  'missing-cli': 'could not start',
}

/** The quiet (i) by the Manager's name while a backup answers; the details live in its popover. */
export function ActiveAgentInfo({ manager, onOpenSettings }: { manager: ManagerSummary; onOpenSettings: () => void }) {
  const update = useUpdateManager(manager.id)
  const runner = useManagerRunner(manager.runner)
  const profiles = useAgentProfiles().data
  const active = manager.activeAgent
  if (!active) return null
  // #1 is the manager's own agent and account.
  const account = manager.agentProfile ?? profiles?.defaults?.[runner] ?? DEFAULT_AGENT_ACCOUNT_ID
  const label = profiles?.profiles.find((entry) => entry.provider === runner && entry.id === account)?.label ?? (account === DEFAULT_AGENT_ACCOUNT_ID ? 'Default' : account)
  const primary = `#1 ${runner} · ${label}`
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="manager-active-agent"
          aria-label={`Answering with backup #${active.agent.slot + 1}`}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-pending-strong outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:size-11"
        >
          <InfoIcon aria-hidden="true" className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] space-y-2 text-sm" data-slot="manager-active-agent-popover">
        <p className="font-semibold">Answering with backup #{active.agent.slot + 1}</p>
        <p className="text-xs text-muted-foreground">{active.agent.runner} · {active.agent.label ?? active.agent.profileId}{active.agent.model ? ` · ${active.agent.model}` : ''}</p>
        <p>
          {primary} {REASON[active.reason] ?? 'is unavailable'}
          {active.primaryBackAt ? <> until <b>{clock(active.primaryBackAt)}</b></> : null}.
          {manager.failback === 'manual' ? ' The Manager stays on the backup until you switch back.' : ' The Manager goes back to it then.'}
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="outline" className="pointer-coarse:h-11" disabled={update.isPending} onClick={() => update.mutate({ switchToPrimary: true }, { onError: (error) => toast(error.message, { tone: 'danger' }) })}>
            Switch back now
          </Button>
          <Button size="sm" variant="outline" className="pointer-coarse:h-11" onClick={onOpenSettings}>Agent settings</Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** The label a reply carries when a backup wrote it; replies from #1 carry none. */
export function ReplyAgentLabel({ message }: { message: Extract<ManagerMessage, { kind: 'assistant' }> }) {
  return (
    <>
      {message.agent && message.agent.slot > 0 ? (
        <span data-slot="manager-reply-agent" className="rounded-md border border-border bg-muted px-1.5 text-micro">{agentRefName(message.agent)}</span>
      ) : null}
      {message.cutOff ? <span data-slot="manager-cut-off" className="text-danger">cut off</span> : null}
    </>
  )
}

/** A switch notice: why the chain moved and to whom. */
export function AgentSwitchNotice({ message, managerId }: { message: Extract<ManagerMessage, { kind: 'notice' }>; managerId: string }) {
  const update = useUpdateManager(managerId)
  const change = message.agentSwitch!
  const back = change.reason === 'back' || change.reason === 'manual'
  const Icon = back ? CircleCheckIcon : change.reason === 'auth' ? CircleAlertIcon : ArrowLeftRightIcon
  return (
    <div data-slot="manager-agent-switch" data-reason={change.reason} className="flex items-start gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5 text-sm">
      <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', back ? 'text-success' : 'text-pending-strong')} />
      <div className="min-w-0 flex-1 space-y-2">
        <p>
          {back ? (
            <>{change.reason === 'manual' ? 'Switched back to ' : 'Back on '}<b>{agentRefName(change.to)}</b>.</>
          ) : (
            <>
              <b>{agentRefName(change.from)}</b> {REASON[change.reason] ?? 'is unavailable'}
              {change.until ? <> until <b>{clock(change.until)}</b></> : null}. Continuing with <b>{agentRefName(change.to)}</b>
              {change.to.model ? ` (${change.to.model})` : ''}.
              {change.lost?.includes('connectors') ? <span className="text-muted-foreground"> Connectors are off on {change.to.runner}.</span> : null}
            </>
          )}
        </p>
        {!back ? (
          <Button size="sm" variant="outline" className="pointer-coarse:h-11" disabled={update.isPending} onClick={() => update.mutate({ switchToPrimary: true }, { onError: (error) => toast(error.message, { tone: 'danger' }) })}>
            Switch back now
          </Button>
        ) : null}
      </div>
    </div>
  )
}
