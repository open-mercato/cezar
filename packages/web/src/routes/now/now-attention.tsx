import type { AttentionItem, AttentionKind } from '@open-mercato/cezar-api-client'
import * as React from 'react'
import { Link } from 'react-router'

import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { RelativeAge } from '@/lib/live-now'
import { cn } from '@/lib/utils'

import { KIND_LABEL, READABLE, itemHref, optionAnswer } from './now-attention-model'

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
  'grid grid-cols-[10px_minmax(0,1fr)] items-start gap-x-3 gap-y-2 rounded-[10px] border bg-card px-3.5 py-3 md:grid-cols-[16px_minmax(0,1fr)_auto] md:items-center md:gap-x-3.5'

/** One item of the attention list: who it is from, why it is here, and what resolves it. */
export function AttentionRow({ item, actions, source }: { item: AttentionItem; actions: AttentionActions; source?: string | undefined }) {
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
  return (
    <article
      data-slot="now-attention-row"
      data-kind={item.kind}
      data-key={item.key}
      aria-busy={busy || undefined}
      className={cn(ROW_CLASS, item.kind === 'failed' ? 'border-danger/45' : 'border-info/50', !item.counted && 'opacity-80')}
    >
      <StatusDot tone={TONE[item.kind]} className="mt-1.5 md:mt-0" aria-label={KIND_LABEL[item.kind]} />
      <div className="min-w-0">
        <Link to={href} className="line-clamp-2 text-ui font-medium text-foreground">
          {item.title}
        </Link>
        <div data-slot="now-why" className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-label text-muted-foreground">
          <span>
            {why} · <RelativeAge at={item.since} />
          </span>
          {item.detail ? <span className="min-w-0 truncate">{item.detail}</span> : null}
          {!item.counted && item.kind !== 'failed' ? <span>not counted</span> : null}
        </div>
      </div>
      <div data-slot="now-attention-actions" className="col-start-2 flex flex-wrap gap-1.5 md:col-start-auto md:justify-end">
        {item.kind === 'question' && item.options?.length ? (
          item.options.slice(0, 4).map((label) => (
            <Button key={label} size="sm" variant="outline" disabled={busy} data-slot="now-answer-option"
              onClick={() => run(() => actions.answer(item, optionAnswer(item, label)), 'Could not send the answer')}>
              {label}
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
      </div>
    </article>
  )
}
