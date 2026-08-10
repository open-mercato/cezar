import { compactTokens } from '@/lib/format'
import { cn } from '@/lib/utils'

interface DirectionalUsageProps {
  inputTokens?: number
  outputTokens?: number
  /** Compact prose (`IN … · OUT …`) or the desktop table's denser (`… / …`) form. */
  variant?: 'compact' | 'table'
  /** Historical compact surfaces disappear when neither direction was persisted. */
  omitWhenUnknown?: boolean
  className?: string
}

function exactTokens(value: number | undefined): string {
  return value === undefined ? 'unknown' : new Intl.NumberFormat().format(value)
}

export function directionalUsageLabel(inputTokens?: number, outputTokens?: number): string {
  return `Input tokens: ${exactTokens(inputTokens)}; output tokens: ${exactTokens(outputTokens)}`
}

export function directionalUsageText(
  inputTokens?: number,
  outputTokens?: number,
  variant: 'compact' | 'table' = 'compact',
): string {
  const input = inputTokens === undefined ? '—' : compactTokens(inputTokens)
  const output = outputTokens === undefined ? '—' : compactTokens(outputTokens)
  return variant === 'table' ? `${input} / ${output}` : `IN ${input} · OUT ${output}`
}

/** One honest input/output rendering shared by header, table, cards, quick lists, and variants. */
export function DirectionalUsage({
  inputTokens,
  outputTokens,
  variant = 'compact',
  omitWhenUnknown = true,
  className,
}: DirectionalUsageProps) {
  if (omitWhenUnknown && inputTokens === undefined && outputTokens === undefined) return null

  return (
    <span
      data-slot="directional-usage"
      aria-label={directionalUsageLabel(inputTokens, outputTokens)}
      className={cn('font-mono tabular-nums', className)}
    >
      {directionalUsageText(inputTokens, outputTokens, variant)}
    </span>
  )
}
