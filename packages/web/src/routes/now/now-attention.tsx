import type { AttentionItem, AttentionKind, RunRecord } from '@open-mercato/cezar-api-client'
import * as React from 'react'
import { Link } from 'react-router'

import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { RelativeAge } from '@/lib/live-now'
import { inlineReferenceText } from '@/lib/managers'
import { cn } from '@/lib/utils'
import { ManagerReferenceText } from '@/routes/manager/manager-reference'

import { KIND_LABEL, READABLE, itemHref, optionAnswer } from './now-attention-model'
import { DismissButton, SettledReason, SwipeRow, TriageMenu, useRowMenu, type TriageActions } from './now-triage'
import { itemTarget } from './now-triage-model'

/** What a row can do in place; each one is the same call its own page makes. */
export interface AttentionActions {
  answer: (item: AttentionItem, text: string) => Promise<unknown>
  decide: (item: AttentionItem, decision: 'approve' | 'reject') => Promise<unknown>
  markRead: (item: AttentionItem) => Promise<unknown>
}

const TONE: Record<AttentionKind, StatusDotTone> = {
  question: 'info',
  approval: 'info',
  task: 'info',
  review: 'info',
  failed: 'danger',
  message: 'pending',
}

const ROW_CLASS =
  'group/row relative grid grid-cols-[10px_minmax(0,1fr)] items-start gap-x-3 gap-y-2 rounded-[10px] border bg-card px-3.5 py-3 md:grid-cols-[16px_minmax(0,1fr)_auto] md:items-center md:gap-x-3.5'

/** One item of the attention list: who it is from, why it is here, and what resolves it. */
export function AttentionRow({
  item,
  actions,
  source,
  triage,
  run: task,
  hint = false,
}: {
  item: AttentionItem
  actions: AttentionActions
  source?: string | undefined
  /** Dismiss, snooze and the ⋯ menu (spec 2026-11-23-needs-you-triage). */
  triage?: TriageActions | undefined
  /** This project's run behind a task item: its Mark done, Archive and Cancel. */
  run?: RunRecord | undefined
  /** The phone's one-time swipe peek. */
  hint?: boolean
}) {
  const menu = useRowMenu()
  const [busy, setBusy] = React.useState(false)
  const run = (work: () => Promise<unknown>, failed: string) => {
    if (busy) return
    setBusy(true)
    void work().catch((error: unknown) => {
      toast(`${failed}: ${error instanceof Error ? error.message : String(error)}`, { tone: 'danger' })
    }).finally(() => setBusy(false))
  }
  const href = itemHref(item)
  const why = [KIND_LABEL[item.kind], source ?? item.managerName].filter(Boolean).join(' · ')
  const target = itemTarget(item)
  const settled = item.settled
  const row = (
    <article
      data-slot="now-attention-row"
      data-kind={item.kind}
      data-key={item.key}
      data-settled={settled ? settled.why : undefined}
      aria-busy={busy || undefined}
      onContextMenu={triage ? menu.onContextMenu : undefined}
      className={cn(
        ROW_CLASS,
        settled ? 'border-border bg-card/60' : item.kind === 'failed' ? 'border-danger/45' : 'border-info/50',
        !item.counted && !settled && 'opacity-80',
      )}
    >
      {/* The whole row opens the item; the title's chips and the buttons sit above this link. */}
      <Link to={href} data-slot="now-row-link" aria-label={inlineReferenceText(item.title)} className="absolute inset-0 rounded-[10px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" />
      <StatusDot tone={settled ? 'neutral' : TONE[item.kind]} className="pointer-events-none mt-1.5 md:mt-0" aria-label={KIND_LABEL[item.kind]} />
      <div className="pointer-events-none min-w-0">
        <p data-slot="now-title" className={cn('line-clamp-2 text-ui font-medium wrap-anywhere [&_a]:pointer-events-auto', settled ? 'text-muted-foreground' : 'text-foreground')}>
          {item.managerId ? <ManagerReferenceText text={item.title} origin={{ id: item.managerId, name: item.managerName ?? '' }} /> : inlineReferenceText(item.title)}
        </p>
        <div data-slot="now-why" className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-label text-muted-foreground">
          {settled ? <SettledReason settled={settled} /> : null}
          <span className="min-w-0 wrap-anywhere">
            {why} · <RelativeAge at={item.since} />
          </span>
          {item.detail ? <span className="min-w-0 truncate">{inlineReferenceText(item.detail)}</span> : null}
          {!item.counted && !settled && item.kind !== 'failed' ? <span>not counted</span> : null}
        </div>
      </div>
      <div data-slot="now-attention-actions" className="relative col-start-2 flex flex-wrap items-center gap-1.5 md:col-start-auto md:justify-end">
        {settled && triage ? (
          <Button size="sm" variant="ghost" data-slot="now-keep" onClick={() => triage.keep(target)}>
            Still needs me
          </Button>
        ) : null}
        {item.kind === 'question' && item.options?.length && !settled ? (
          item.options.slice(0, 4).map((label) => (
            <Button key={label} size="sm" variant="outline" disabled={busy} data-slot="now-answer-option"
              className="h-auto min-h-[30px] max-w-full py-1 text-left whitespace-normal wrap-anywhere"
              onClick={() => run(() => actions.answer(item, optionAnswer(item, label)), 'Could not send the answer')}>
              {/* The label reads as words (`#12`), never a raw `[[pr:…]]` marker; the answer sends it as written. */}
              {inlineReferenceText(label)}
            </Button>
          ))
        ) : null}
        {item.kind === 'approval' ? (
          <>
            <Button size="sm" disabled={busy} data-slot="now-approve" onClick={() => run(() => actions.decide(item, 'approve'), 'Could not approve')}>
              Approve
            </Button>
            <Button size="sm" variant="outline" disabled={busy} data-slot="now-reject" onClick={() => run(() => actions.decide(item, 'reject'), 'Could not reject')}>
              Reject
            </Button>
          </>
        ) : null}
        <Button asChild size="sm" variant={item.kind === 'question' && !item.options?.length ? 'primary' : 'outline'}>
          <Link to={href} data-slot="now-open">{item.kind === 'question' && !item.options?.length ? 'Answer' : 'Open'}</Link>
        </Button>
        {READABLE.has(item.kind) ? (
          <Button size="sm" variant="ghost" disabled={busy} data-slot="now-mark-read" onClick={() => run(() => actions.markRead(item), 'Could not mark it read')}>
            Mark read
          </Button>
        ) : null}
        {triage ? (
          <>
            <DismissButton target={target} actions={triage} />
            <TriageMenu
              target={target}
              actions={triage}
              href={href}
              copyHref={href}
              manager={item.managerId ? { id: item.managerId, name: item.managerName ?? 'this manager' } : undefined}
              run={task}
              settled={settled} open={menu.open} onOpenChange={menu.setOpen} />
          </>
        ) : null}
      </div>
    </article>
  )
  return triage ? <SwipeRow target={target} actions={triage} hint={hint}>{row}</SwipeRow> : row
}
