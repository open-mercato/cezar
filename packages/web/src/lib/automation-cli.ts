import { cronOf, type AutomationDispatch, type AutomationEvent, type AutomationFilters, type AutomationSchedule } from '@open-mercato/cezar-api-client'

/**
 * The editor's "Copy as CLI" card (spec 2026-09-14-automations-redesign Q1): the flag form of
 * `cez automation add` when the definition is expressible in flags, the JSON form of
 * `cez automation create` otherwise. Both build the same request body server-side, so either
 * line recreates exactly what the cockpit would save.
 *
 * Flag-expressible: any schedule; a poll whose filters are at most `anyLabels` (`--label`) and
 * `authors` (`--author`) at their default lookback and cap. Everything else — assignees, all-of
 * labels, exclusions, a custom lookback — falls back to JSON, which carries it all.
 */
export interface CliDefinition {
  name: string
  kind: 'github' | 'schedule'
  schedule?: AutomationSchedule
  events?: AutomationEvent[]
  intervalSeconds?: number
  filters?: Partial<AutomationFilters>
  task: {
    prompt: string
    workflow?: string
    runner?: string
    model?: string
    autonomous?: boolean
    dispatch?: AutomationDispatch
  }
  enable?: boolean
}

const shellQuote = (value: string): string => `"${value.replace(/(["\\$`!])/g, '\\$1')}"`

/** `5m` / `1h` / `6h` / `24h` for the `--every` flag; falls back to seconds when uneven. */
export function everyFlag(seconds: number): string {
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

export function flagExpressible(definition: CliDefinition): boolean {
  if (definition.kind === 'schedule') return !!definition.schedule
  if (!definition.events?.length) return false
  const filters = definition.filters ?? {}
  const extra = (['assignees', 'allLabels', 'excludeLabels', 'changedLabels'] as const).some((key) => (filters[key]?.length ?? 0) > 0)
  if (extra) return false
  if (filters.lookbackDays !== undefined && filters.lookbackDays !== 7) return false
  if (filters.maxRecords !== undefined && filters.maxRecords !== 25) return false
  return true
}

/** The flag form. Callers check `flagExpressible` first; an inexpressible poll gets JSON. */
export function cliFlagsOf(definition: CliDefinition): string {
  const parts = ['cez automation add', `--name ${shellQuote(definition.name || 'untitled')}`]
  if (definition.kind === 'schedule' && definition.schedule) {
    parts.push(`--cron ${shellQuote(cronOf(definition.schedule))}`)
  } else {
    parts.push(`--on ${(definition.events ?? []).join(',')}`)
    parts.push(`--every ${everyFlag(definition.intervalSeconds ?? 300)}`)
    for (const label of definition.filters?.anyLabels ?? []) parts.push(`--label ${shellQuote(label)}`)
    for (const author of definition.filters?.authors ?? []) parts.push(`--author ${shellQuote(author)}`)
  }
  const { task } = definition
  if (task.workflow) parts.push(`--workflow ${shellQuote(task.workflow)}`)
  if (task.runner) parts.push(`--runner ${shellQuote(task.runner)}`)
  if (task.model) parts.push(`--model ${shellQuote(task.model)}`)
  if (task.autonomous === false) parts.push('--no-autonomous')
  else if (task.autonomous) parts.push('--autonomous')
  if (task.dispatch) {
    parts.push('--dispatch')
    if (task.dispatch.maxSubtasks !== undefined) parts.push(`--max-subtasks ${task.dispatch.maxSubtasks}`)
    if (task.dispatch.reviewChild) parts.push('--review-child')
  }
  if (definition.enable) parts.push('--enable')
  parts.push(`--prompt ${shellQuote(task.prompt || '…')}`)
  return parts.join(' ')
}

/** The JSON form: the create body, single-quoted for a POSIX shell. */
export function cliJsonOf(definition: CliDefinition): string {
  const body: Record<string, unknown> = {
    name: definition.name || 'untitled',
    kind: definition.kind,
    ...(definition.kind === 'schedule'
      ? { schedule: definition.schedule }
      : { events: definition.events, intervalSeconds: definition.intervalSeconds ?? 300, filters: { lookbackDays: 7, maxRecords: 25, ...definition.filters } }),
    task: definition.task,
    ...(definition.enable ? { enable: true } : {}),
  }
  return `cez automation create --json '${JSON.stringify(body).replace(/'/g, `'\\''`)}'`
}

/** What the card prints. */
export function cliOf(definition: CliDefinition): string {
  return flagExpressible(definition) ? cliFlagsOf(definition) : cliJsonOf(definition)
}
