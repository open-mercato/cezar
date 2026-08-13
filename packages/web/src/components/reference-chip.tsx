import {
  ArrowUpRightIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleSlashIcon,
  CircleXIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  MessageSquareWarningIcon,
  type LucideIcon,
} from 'lucide-react'
import type { ReferenceStatus } from '@open-mercato/cezar-api-client'

import { useReferenceStatus } from '@/components/reference-status'
import type { ReferenceStatusEntry } from '@/api/queries'
import { StatusDot } from '@/components/status-dot'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  referenceStatusPresentation,
  type ReferenceStatusPresentation,
  type ReferenceStatusTone,
} from '@/lib/reference-status'
import { cn, isHttpUrl } from '@/lib/utils'

/** Border + text per status tone. `violet` IS the chip's own resting look, which is why a
 *  reference with no status known keeps it: nothing has been learned, so nothing changes. */
const TONE_CLASS: Record<ReferenceStatusTone, string> = {
  success: 'border-success/40 text-success',
  danger: 'border-danger/40 text-danger',
  violet: 'border-violet/35 text-violet',
  info: 'border-info/40 text-info',
  neutral: 'border-border text-muted-foreground',
  // The WHOLE chip goes amber while checks run, not just its dot: "something is happening to this
  // right now" is the state a table is scanned for, and a neutral chip with a coloured dot reads
  // as neutral at a glance. `text-pending-strong`, not `text-pending` — the dot's amber-400 is a
  // fill colour and fails contrast as ink on the light theme, so the ink token darkens per theme.
  pending: 'border-pending-strong/45 text-pending-strong',
}

/** The hover wash, per tone — a LINK chip only; the inert one has nothing to hover into. It
 *  follows the tone rather than staying violet, or a red "checks failing" chip would light up
 *  purple under the pointer. */
const TONE_HOVER: Record<ReferenceStatusTone, string> = {
  success: 'hover:bg-success/10',
  danger: 'hover:bg-danger/10',
  violet: 'hover:bg-violet/10',
  info: 'hover:bg-info/10',
  neutral: 'hover:bg-muted',
  pending: 'hover:bg-pending-strong/10',
}

/** One glyph per status, borrowed from the vocabulary GitHub itself uses, so the icon is legible
 *  before the tooltip is read. `checks-pending` has none: it renders the pulsing dot instead,
 *  which is the design system's own mark for a state that is still moving. */
const STATUS_ICON: Record<ReferenceStatus, LucideIcon | null> = {
  draft: GitPullRequestDraftIcon,
  'review-required': GitPullRequestIcon,
  'changes-requested': MessageSquareWarningIcon,
  'checks-pending': null,
  'checks-failing': CircleXIcon,
  ready: CircleCheckIcon,
  merged: GitMergeIcon,
  closed: GitPullRequestClosedIcon,
  open: CircleDotIcon,
  completed: CircleCheckIcon,
  'not-planned': CircleSlashIcon,
}

/**
 * A task's out-of-app tracker link.
 *
 * Without a `status` this is the neutral chip it has always been: the record itself carries no
 * open/closed state, so PR and issue references share one treatment and say nothing they cannot
 * know. With one — hydrated in batch by `useReferenceStatuses` — the chip additionally carries
 * the state of the thing it points at, in three redundant channels: color (tone), an icon, and a
 * tooltip that spells the status out in words. Three because one is not enough for any of them
 * alone: color is invisible to a colorblind reader, an icon is a rebus until you have learned it,
 * and a tooltip is not there until you go looking for it.
 */
export function ReferenceChip({
  reference,
  taskTitle,
  status: explicitStatus,
  projectId,
  className,
  compact = false,
}: {
  reference: { kind: 'PR' | 'Issue'; number?: number; url?: string }
  taskTitle: string
  /** Absent = nothing known (not fetched, forge unreachable, number not found) — NOT "fine".
   *  Normally left unset: the chip reads its own status from `ReferenceStatusProvider`. */
  status?: ReferenceStatus
  /** Only the global Tasks page needs this: its rows come from different projects, and two of
   *  them may each have a #42. Elsewhere the provider's own project is right. */
  projectId?: string
  className?: string
  /**
   * The narrow sidebar row (#788, option C): the number ALONE — `#402` — with no `Issue ` word
   * and no `PR` label. There the chip is the row's leading identifier and every glyph it spends
   * is a glyph the task's name does not get, and which kind of reference it is stays carried by
   * the accessible name ("Open the pull request for …" / "Open the issue for …") and the
   * `data-slot` — plus the `title` (the URL) on a chip with no status, where nothing richer has
   * claimed the hover. Without a number there is nothing shorter to say, so the kind is the
   * label, exactly as in the full treatment.
   */
  compact?: boolean
}) {
  const { kind, number, url } = reference
  // An explicit `status` wins — it is what a test or a one-off caller passes — and otherwise the
  // surface's provider answers. Outside a provider neither exists and this is the chip the cockpit
  // has always painted.
  const entry = useReferenceStatus(kind, number, projectId)
  const status = explicitStatus ?? entry.status
  // A status this bundle has never heard of resolves to `undefined` here and is then treated
  // exactly like no status at all — the neutral chip, no glyph, no claim in the accessible name.
  // That is what the vocabulary being ADDITIVE means in practice (BACKWARD_COMPATIBILITY.md):
  // a value added server-side after this bundle shipped, or restored from a `sessionStorage`
  // payload a newer bundle wrote, must not be able to take a table down.
  const presentation = referenceStatusPresentation(status)
  const chipClass = cn(
    'inline-flex h-[22px] items-center gap-1 rounded-full border px-2 font-mono text-[11px] font-semibold',
    TONE_CLASS[presentation?.tone ?? 'violet'],
    className,
  )
  const tooltip = statusTooltip(entry, presentation)
  const label = number ? `${!compact && kind === 'Issue' ? 'Issue ' : ''}#${number}` : kind
  const kindWord = kind === 'PR' ? 'pull request' : 'issue'
  // The accessible name carries the status too — a screen reader gets what the color says.
  const ariaLabel = `Open the ${kindWord} for ${taskTitle}${presentation ? ` — ${presentation.label}` : ''}`

  const body = (
    <>
      {/* `presentation ? status : undefined` — one gate for every status channel, so an unknown
          value cannot paint a glyph either. */}
      <StatusGlyph status={presentation ? status : undefined} />
      {label}
    </>
  )

  // href protocol guard (#431): a transcript-scraped non-http URL degrades to inert text.
  const chip =
    !url || !isHttpUrl(url) ? (
      <span
        data-slot={kind === 'PR' ? 'pr-chip' : 'issue-chip'}
        data-status={status}
        aria-label={presentation ? `${kindWord} ${label} — ${presentation.label}` : undefined}
        className={chipClass}
      >
        {body}
      </span>
    ) : (
      <a
        data-slot={kind === 'PR' ? 'pr-chip' : 'issue-chip'}
        data-status={status}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        // The native `title` is the URL only while there is no richer tooltip to show. Once the
        // Radix tooltip below owns the hover it carries the URL itself, and two tooltips on one
        // element is a browser popup fighting a designed one.
        title={tooltip ? undefined : url}
        aria-label={ariaLabel}
        className={cn(chipClass, TONE_HOVER[presentation?.tone ?? 'violet'])}
      >
        {body}
        <ArrowUpRightIcon className="size-2.5" aria-hidden="true" />
      </a>
    )

  if (!tooltip) return chip
  return (
    // Its own provider: this chip renders in the sidebar and the run header as well as inside the
    // task tables, and only the tables happen to sit under a `TooltipProvider`. Nesting providers
    // is legal and free; depending on an ancestor that three of four surfaces do not have is not.
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent side="top" data-slot="reference-status-tooltip" data-tooltip-state={entry.state}>
          <span className="block font-medium">
            {kind === 'PR' ? 'Pull request' : 'Issue'}
            {number ? ` #${number}` : ''} · {tooltip.headline}
          </span>
          <span className="block">{tooltip.detail}</span>
          {/* The URL the native `title` used to carry. Worth keeping: a reference can name a
              DIFFERENT repository than the project on screen (#526), and the host is the only
              thing that says so. */}
          {url && isHttpUrl(url) ? (
            <span className="block opacity-70">{url.replace(/^https?:\/\//, '')}</span>
          ) : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * What the tooltip says — for a known status, and for each of the four ways there can be none.
 *
 * A chip with nothing to show used to say nothing at all, which made every one of these look like
 * the same shrug. They are not: "GitHub is unreachable" is a thing to go and fix, "no such number
 * in this repository" usually means the reference points at another repo, and "checking" is over
 * in a moment. `null` — and only `null` — leaves the chip with its plain URL tooltip, which is the
 * honest answer when nothing has asked about it at all.
 *
 * Takes the PRESENTATION rather than the status, so a value this bundle cannot describe falls
 * through to the state below instead of being described wrongly — or, on a `ready` state, to the
 * plain URL tooltip, which is precisely the pre-status chip.
 */
function statusTooltip(
  entry: ReferenceStatusEntry,
  presentation: ReferenceStatusPresentation | undefined,
): { headline: string; detail: string } | null {
  if (presentation) {
    const { label, hint } = presentation
    // A remembered status while the forge is down is still the best answer there is — but it is
    // dated, and saying so is the difference between trusted and merely confident.
    if (entry.state === 'unavailable') {
      return { headline: label, detail: `last known — GitHub is unreachable${entry.reason ? ` (${entry.reason})` : ''}` }
    }
    return { headline: label, detail: hint }
  }
  switch (entry.state) {
    case 'loading':
      return { headline: 'Checking GitHub…', detail: 'the status of this reference is on its way' }
    case 'unavailable':
      return {
        headline: 'Status unavailable',
        detail: entry.reason ?? 'GitHub could not be reached — the chip says nothing rather than guessing',
      }
    case 'unknown':
      return {
        headline: 'Not found on this repository',
        detail: 'GitHub has no such number here — the reference may point at another repo',
      }
    default:
      return null
  }
}

/** The status channel that is not color: an icon, or — for checks still running — the pulsing dot
 *  the design system reserves for a transitioning state, inside its now-amber chip. */
function StatusGlyph({ status }: { status?: ReferenceStatus }) {
  if (!status) return null
  if (status === 'checks-pending') {
    return <StatusDot tone="pending" pulse className="size-[6px]" aria-hidden="true" />
  }
  const Icon = STATUS_ICON[status]
  return Icon ? <Icon className="size-2.5 shrink-0" aria-hidden="true" /> : null
}
