import { CheckIcon, PlayIcon, PowerIcon, SendIcon, XIcon } from 'lucide-react'
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ManagerSummary } from '@open-mercato/cezar-api-client'

import { useSetManagerActive, useSetManagersActive } from '@/api/managers'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { toast } from '@/components/ui/toaster'
import { cronLabel, isInactive, managerMessageTime } from '@/lib/managers'

import { ManagerAvatar } from './manager-avatar'

/**
 * Deactivating and reactivating a manager (spec 2026-11-19-manager-deactivate, design § 03): the
 * five confirms, one promise-based hook that shows them, and the actions every toggle site shares.
 */

export type ActivityRequest =
  | { kind: 'deactivate'; manager: ManagerSummary }
  | { kind: 'reactivate'; manager: ManagerSummary }
  /** Sending to an inactive manager: one confirm, cancelling keeps the draft. */
  | { kind: 'send'; manager: ManagerSummary }
  /** `/check` on an inactive manager: reactivating runs one check, not a chat turn. */
  | { kind: 'check'; manager: ManagerSummary }
  /** Answering an inactive manager's question: the chosen answer is shown. */
  | { kind: 'answer'; manager: ManagerSummary; answer: string }
  | { kind: 'bulk'; managers: readonly ManagerSummary[] }

export interface ActivityChoice {
  catchUp: boolean
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

function Group({ tone, label, children }: { tone?: 'stop' | 'go'; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2.5 text-left">
      <span className={tone === 'stop' ? 'eyebrow text-danger' : tone === 'go' ? 'eyebrow text-success' : 'eyebrow text-muted-foreground'}>{label}</span>
      {children}
    </div>
  )
}

function Line({ tone, children }: { tone: 'stop' | 'go'; children: ReactNode }) {
  const Icon = tone === 'stop' ? XIcon : CheckIcon
  return (
    <li className="flex items-start gap-2 text-sm">
      <Icon aria-hidden="true" className={tone === 'stop' ? 'mt-0.5 size-3.5 shrink-0 text-danger' : 'mt-0.5 size-3.5 shrink-0 text-success'} />
      <span>{children}</span>
    </li>
  )
}

function Title({ manager, children }: { manager?: ManagerSummary | undefined; children: ReactNode }) {
  return (
    <AlertDialogTitle className="flex items-center gap-2.5 text-left">
      {manager ? <ManagerAvatar avatar={manager.avatar} mascot={manager.mascot} inactive={isInactive(manager)} className="size-7" sizes="28px" /> : <PowerIcon aria-hidden="true" className="size-5 shrink-0" />}
      <span className="min-w-0">{children}</span>
    </AlertDialogTitle>
  )
}

function stopsLine(manager: ManagerSummary): string {
  const enabled = manager.jobs.filter((job) => job.enabled).length
  const checks = manager.cronMinutes > 0 ? `Checks every ${cronLabel(manager.cronMinutes)}` : 'Checks'
  return enabled > 0 ? `${checks} and ${plural(enabled, 'saved job')}` : checks
}

function WhileInactive({ manager }: { manager: ManagerSummary }) {
  const since = manager.inactive ? managerMessageTime(manager.inactive.since) : ''
  return (
    <Group label={since ? `While inactive · since ${since}` : 'While inactive'}>
      <p className="text-sm text-muted-foreground">Task cards and automation reports that arrived are in its chat. Checks and job runs were skipped.</p>
    </Group>
  )
}

/** One confirm per request kind; `onConfirm` gets the reactivate dialog's Catch me up. */
export function ManagerActivityDialog({
  request,
  onConfirm,
  onCancel,
  onCloseAutoFocus,
}: {
  request: ActivityRequest | null
  onConfirm: (choice: ActivityChoice) => void
  onCancel: () => void
  onCloseAutoFocus?: ((event: Event) => void) | undefined
}) {
  const [catchUp, setCatchUp] = useState(false)
  const body = request ? dialogBody(request, catchUp, setCatchUp) : null
  return (
    <AlertDialog open={request !== null} onOpenChange={(open) => { if (!open) onCancel() }}>
      <AlertDialogContent data-slot="manager-activity-dialog" data-kind={request?.kind} {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}>
        {body ? (
          <>
            <AlertDialogHeader>
              {body.title}
              <AlertDialogDescription className="text-left">{body.description}</AlertDialogDescription>
            </AlertDialogHeader>
            {body.extra}
            <AlertDialogFooter>
              <AlertDialogCancel className="pointer-coarse:min-h-11">Cancel</AlertDialogCancel>
              <AlertDialogAction
                data-slot="manager-activity-confirm"
                className="pointer-coarse:min-h-11"
                onClick={() => {
                  onConfirm({ catchUp: request?.kind === 'reactivate' && catchUp })
                  setCatchUp(false)
                }}
              >
                {body.icon}
                {body.action}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  )
}

function dialogBody(request: ActivityRequest, catchUp: boolean, setCatchUp: (next: boolean) => void): { title: ReactNode; description: ReactNode; extra?: ReactNode; action: string; icon: ReactNode } {
  if (request.kind === 'bulk') {
    const count = request.managers.length
    return {
      title: <Title>Deactivate all {plural(count, 'active manager')}?</Title>,
      description: 'For a laptop going to sleep or a server saving cost. Each keeps its chat, memory and jobs; tasks they started keep running.',
      extra: (
        <>
          <ul aria-label="Managers to deactivate" className="flex flex-wrap gap-1.5">
            {request.managers.map((manager) => <li key={manager.id} className="rounded-full border border-border bg-muted px-2 py-px text-meta text-muted-foreground">{manager.name}</li>)}
          </ul>
          <Group tone="stop" label="Stops for all of them">
            <p className="text-sm text-muted-foreground">Checks, jobs, follow-up turns, notifications, model calls.</p>
          </Group>
        </>
      ),
      action: 'Deactivate all',
      icon: <PowerIcon aria-hidden="true" />,
    }
  }
  const { manager } = request
  if (request.kind === 'deactivate') {
    return {
      title: <Title manager={manager}>Deactivate {manager.name}?</Title>,
      description: 'It keeps its chat, memory, jobs and settings. Nothing runs and no model is called until you reactivate it.',
      extra: (
        <>
          <Group tone="stop" label="Stops">
            <ul className="flex flex-col gap-1.5">
              <Line tone="stop">{stopsLine(manager)}</Line>
              <Line tone="stop">Follow-up turns on its tasks — their updates are kept for later</Line>
              <Line tone="stop">Notifications from this manager</Line>
            </ul>
          </Group>
          <Group tone="go" label="Keeps going">
            <ul className="flex flex-col gap-1.5">
              <Line tone="go">Tasks it started, and automations that report to it</Line>
              <Line tone="go">Its approvals — you can still answer them; its questions can still be dismissed</Line>
            </ul>
          </Group>
          {manager.status === 'working' ? (
            <p data-slot="manager-activity-working" className="rounded-md bg-pending/12 px-2.5 py-1.5 text-label text-foreground">{manager.name} is working right now; that turn stops.</p>
          ) : null}
        </>
      ),
      action: 'Deactivate',
      icon: <PowerIcon aria-hidden="true" />,
    }
  }
  if (request.kind === 'answer') {
    return {
      title: <Title manager={manager}>Reactivate {manager.name} and answer?</Title>,
      description: <>Your answer — <b className="text-foreground">“{request.answer}”</b> — starts its next turn, so {manager.name} has to be active. Checks and jobs restart from now.</>,
      extra: <p className="text-label text-muted-foreground">Don’t want to spend a turn? Cancel and use <b>Dismiss</b> instead: it closes the question and {manager.name} stays inactive.</p>,
      action: 'Reactivate and answer',
      icon: <SendIcon aria-hidden="true" />,
    }
  }
  const send = request.kind === 'send'
  const check = request.kind === 'check'
  return {
    title: <Title manager={manager}>{send ? `Reactivate ${manager.name} and send?` : check ? `Reactivate ${manager.name} and check?` : `Reactivate ${manager.name}?`}</Title>,
    description: `${send ? 'Your message starts its next turn. ' : check ? 'A single check runs now: one model call. ' : ''}Checks and jobs restart from now — nothing overdue fires at once.`,
    extra: (
      <>
        <WhileInactive manager={manager} />
        {send || check ? null : (
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border px-3 py-2.5 text-sm has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50">
            <input type="checkbox" data-slot="manager-activity-catch-up" className="mt-0.5 size-4 accent-primary" checked={catchUp} onChange={(event) => setCatchUp(event.target.checked)} />
            <span>
              <b>Catch me up</b>
              <span className="block text-label text-muted-foreground">Run one check now and summarise what happened. One model call.</span>
            </span>
          </label>
        )}
      </>
    ),
    action: send ? 'Reactivate and send' : check ? 'Reactivate and check' : 'Reactivate',
    icon: send ? <SendIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />,
  }
}

/** Ask with a confirm and wait for the answer: the choice, or null when cancelled. */
export function useActivityConfirm(onCloseAutoFocus?: (event: Event) => void): { confirmActivity: (request: ActivityRequest) => Promise<ActivityChoice | null>; dialog: ReactNode } {
  const [request, setRequest] = useState<ActivityRequest | null>(null)
  const resolver = useRef<((choice: ActivityChoice | null) => void) | undefined>(undefined)
  const settle = useCallback((choice: ActivityChoice | null) => {
    resolver.current?.(choice)
    resolver.current = undefined
    setRequest(null)
  }, [])
  // What had focus when the confirm opened (an answer chip, a send button): the dialog was not opened
  // by a trigger of its own, so on close Radix would drop focus to <body>.
  const opener = useRef<{ element: HTMLElement | null; card: HTMLElement | null }>({ element: null, card: null })
  const confirmActivity = useCallback((next: ActivityRequest) => new Promise<ActivityChoice | null>((resolve) => {
    resolver.current?.(null)
    resolver.current = resolve
    const element = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    opener.current = { element, card: element?.closest<HTMLElement>('[data-question-key], [data-slot="manager-ask"]') ?? null }
    setRequest(next)
  }), [])
  const closeFocus = useCallback((event: Event) => {
    onCloseAutoFocus?.(event)
    if (event.defaultPrevented) return
    const { element, card } = opener.current
    opener.current = { element: null, card: null }
    // The chip itself when it is still there (cancelled); else what replaced it on its card (sent).
    const target = element?.isConnected ? element
      : card?.isConnected ? card.querySelector<HTMLElement>('[data-slot="question-outcome"]') ?? (card.hasAttribute('tabindex') ? card : null)
      : null
    if (!target) return
    event.preventDefault()
    target.focus({ preventScroll: true })
  }, [onCloseAutoFocus])
  const dialog = <ManagerActivityDialog request={request} onConfirm={(choice) => settle(choice)} onCancel={() => settle(null)} onCloseAutoFocus={closeFocus} />
  return { confirmActivity, dialog }
}

/** The toggle every surface shares: confirm, PATCH, then say what happened. */
export function useManagerActivityActions(onCloseAutoFocus?: (event: Event) => void) {
  const { confirmActivity, dialog } = useActivityConfirm(onCloseAutoFocus)
  const one = useSetManagerActive()
  const many = useSetManagersActive()
  const deactivate = useCallback(async (manager: ManagerSummary) => {
    if (!(await confirmActivity({ kind: 'deactivate', manager }))) return
    await one.mutateAsync({ id: manager.id, active: false }).then(
      () => toast(`${manager.name} is inactive — nothing runs until you reactivate it.`),
      (error: unknown) => toast(errorMessage(error), { tone: 'danger' }),
    )
  }, [confirmActivity, one])
  const reactivate = useCallback(async (manager: ManagerSummary) => {
    const choice = await confirmActivity({ kind: 'reactivate', manager })
    if (!choice) return
    await one.mutateAsync({ id: manager.id, active: true, ...(choice.catchUp ? { catchUp: true } : {}) }).then(
      () => toast(choice.catchUp ? `${manager.name} is active again and is catching up.` : `${manager.name} is active again.`),
      (error: unknown) => toast(errorMessage(error), { tone: 'danger' }),
    )
  }, [confirmActivity, one])
  const deactivateAll = useCallback(async (managers: readonly ManagerSummary[]) => {
    const active = managers.filter((manager) => !isInactive(manager))
    if (active.length === 0 || !(await confirmActivity({ kind: 'bulk', managers: active }))) return
    await many.mutateAsync({ active: false }).then(
      () => toast('All managers are inactive. Nothing runs until you reactivate them.'),
      (error: unknown) => toast(errorMessage(error), { tone: 'danger' }),
    )
  }, [confirmActivity, many])
  // Reactivating is quiet and costs nothing, so the bulk form needs no confirm (design § 02).
  const reactivateAll = useCallback(async (managers: readonly ManagerSummary[]) => {
    const inactive = managers.filter(isInactive)
    if (inactive.length === 0) return
    await many.mutateAsync({ active: true }).then(
      () => toast('All managers are active again.'),
      (error: unknown) => toast(errorMessage(error), { tone: 'danger' }),
    )
  }, [many])
  const toggle = useCallback((manager: ManagerSummary) => (isInactive(manager) ? reactivate(manager) : deactivate(manager)), [deactivate, reactivate])
  return useMemo(() => ({ deactivate, reactivate, toggle, deactivateAll, reactivateAll, confirmActivity, dialog }), [deactivate, reactivate, toggle, deactivateAll, reactivateAll, confirmActivity, dialog])
}

/** The menu row's words and icon for a manager's current state. */
export function activityMenuLabel(manager: ManagerSummary): { label: string; Icon: typeof PowerIcon } {
  return isInactive(manager) ? { label: 'Reactivate…', Icon: PlayIcon } : { label: 'Deactivate…', Icon: PowerIcon }
}
