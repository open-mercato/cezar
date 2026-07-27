import { BotIcon, ChevronDownIcon } from 'lucide-react'

import type {
  HarnessLedgerResponse,
  HarnessModelRecord,
  HarnessPhaseRecord,
} from '@open-mercato/cezar-api-client'
import { Pill } from '@/components/pill'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { cn } from '@/lib/utils'

import { activeHarnessPhase } from './harness-state'

const PHASE_LABELS: Record<string, string> = {
  preflight: 'Preflight',
  qualify: 'Qualify',
  diagnose: 'Diagnose',
  spec: 'Spec',
  'spec-review-1': 'Council',
  implement: 'Implement',
  validate: 'Validate',
  review: 'Council',
  stage: 'Stage',
}

function toneOf(status: string | undefined): StatusDotTone {
  if (
    status === 'done' ||
    status === 'completed' ||
    status === 'ready' ||
    status === 'staged' ||
    status === 'gated'
  ) {
    return 'success'
  }
  if (
    status === 'running' ||
    status === 'pending' ||
    status === 'unknown' ||
    status === 'planned' ||
    status === 'claimed' ||
    status === 'implementing' ||
    status === 'reviewing' ||
    status === 'fixing' ||
    status === 'awaiting_validation'
  ) return 'pending'
  if (
    status === 'failed' ||
    status === 'blocked' ||
    status === 'aborted' ||
    status === 'missing' ||
    status === 'interrupted'
  ) {
    return 'danger'
  }
  return 'neutral'
}

function phaseLabel(phase: HarnessPhaseRecord): string {
  return PHASE_LABELS[phase.id] ?? phase.name ?? phase.id
}

function elapsed(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  const seconds = Math.round(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}m${rest ? ` ${rest}s` : ''}`
}

/** Compact, horizontally scrollable phase progress. It derives entirely from the durable
 *  ledger + the existing run SSE feed, so a ten-hour run survives route changes and reloads. */
export function HarnessPhaseRail({ ledger }: { ledger: HarnessLedgerResponse }) {
  const phases = ledger.phases
  if (phases.length === 0) return null
  return (
    <div
      data-slot="harness-phase-rail"
      aria-label="Harness phases"
      className="border-b border-border bg-background px-4 py-2 md:px-6"
    >
      <ol className="mx-auto flex w-full max-w-[820px] items-center gap-1 overflow-x-auto pb-0.5">
        {phases.map((phase, index) => (
          <li key={phase.id} className="flex shrink-0 items-center gap-1">
            {index > 0 ? <span aria-hidden="true" className="px-0.5 text-xs text-soft-foreground">›</span> : null}
            <span
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] font-medium',
                phase.status === 'running'
                  ? 'border-pending/60 bg-pending/10 text-foreground'
                  : 'border-border bg-card text-muted-foreground',
              )}
              title={phase.error}
            >
              <StatusDot tone={toneOf(phase.status)} pulse={phase.status === 'running'} />
              {phaseLabel(phase)}
              {phase.attempts > 1 ? <span className="tabular-nums">· {phase.attempts}×</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function modelRole(model: HarnessModelRecord): string {
  if (model.roles.includes('host')) return 'host'
  if (model.roles.includes('implementer')) return 'worker'
  if (model.roles.includes('reviewer')) return 'reviewer'
  return model.roles[0] ?? 'model'
}

/** Live model roster dock from the mockups: readiness, role, binding, invocation count and
 *  accumulated paid duration are visible without mixing orchestration events into chat. */
export function HarnessModelsDock({ ledger }: { ledger: HarnessLedgerResponse }) {
  if (ledger.models.length === 0) return null
  const working = ledger.invocations.filter((invocation) => invocation.status === 'running').length
  const active = activeHarnessPhase(ledger)
  return (
    <details
      data-slot="harness-models-dock"
      // Once every model is idle this becomes reference material, so the transcript gets
      // the dock space back. An active invocation opens it automatically.
      open={working > 0}
      className="group rounded-xl border border-border bg-card shadow-xs"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 text-xs [&::-webkit-details-marker]:hidden">
        <BotIcon aria-hidden="true" className="size-3.5 text-soft-foreground" />
        <span className="font-semibold text-foreground">Models</span>
        <span className="text-soft-foreground">
          · {working} working · {Math.max(0, ledger.models.length - working)} standing by
        </span>
        {active ? <Pill className="ml-auto max-w-44 truncate">{phaseLabel(active)}</Pill> : null}
        <ChevronDownIcon aria-hidden="true" className="size-3.5 text-soft-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-border px-3.5 py-1">
        {ledger.models.map((model) => {
          const invocation = [...ledger.invocations].reverse().find(
            (entry) =>
              entry.binding.model === model.id ||
              entry.reviewerId === model.id ||
              `${entry.binding.runner}/${entry.binding.model || 'auto'}` === model.id ||
              (model.id === 'claude' && entry.binding.runner === 'claude'),
          )
          return (
            <div
              key={model.id}
              className="grid min-w-0 grid-cols-[auto_minmax(5rem,.8fr)_minmax(7rem,1fr)_minmax(0,2fr)_auto] items-center gap-2 border-b border-border/70 py-2 text-xs last:border-0 max-sm:grid-cols-[auto_1fr_auto]"
            >
              <StatusDot
                tone={toneOf(invocation?.status ?? model.readiness)}
                pulse={invocation?.status === 'running'}
              />
              <span className="truncate font-semibold text-foreground">{model.id}</span>
              <span className="truncate font-mono text-[10.5px] text-soft-foreground max-sm:hidden">
                {model.binding ?? model.family ?? 'default'}
              </span>
              <span className="min-w-0 truncate text-muted-foreground max-sm:col-start-2">
                <span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-[9px] font-semibold tracking-wide uppercase">
                  {modelRole(model)}
                </span>
                {invocation?.status === 'running'
                  ? invocation.phaseId
                  : model.readinessDetail ?? model.readiness}
              </span>
              <span className="text-right text-[10.5px] text-soft-foreground tabular-nums">
                {model.invocations > 0 ? `${model.invocations} · ${elapsed(model.totalDurationMs)}` : '—'}
              </span>
            </div>
          )
        })}
      </div>
    </details>
  )
}

export { elapsed, phaseLabel, toneOf }
