import {
  normalizeSchedule,
  type AutomationDefinition,
  type AutomationEvent,
  type AutomationKind,
  type AutomationSchedule,
  type AutomationTemplate,
  type CreateAutomationInput,
  type Runner,
  type ScheduleEvery,
} from '@open-mercato/cezar-api-client'

import type { CliDefinition } from '@/lib/automation-cli'
import type { AutomationTemplateDraft } from '@/lib/automation-templates'

/**
 * The editor's form state (spec 2026-09-14-automations-redesign § UI/UX 4), typed on the
 * contract and kept FLAT so every field is one `setDraft` away. Two directions, both pure:
 * `fromDefinition` reads a stored automation into the form, `toBody` writes the form into the
 * request body `POST`/`PUT /automations` take — and `toBody(fromDefinition(x))` is `x` minus
 * what the server owns, which the tests pin.
 *
 * Both kinds' fields live side by side rather than in a union: flipping the segment keeps what
 * the user typed on the other side, so a mis-click costs nothing. `toBody` sends only the
 * active kind's keys (the server refuses a schedule with filters, spec § Data Model).
 */
export interface DraftFilters {
  /** Comma-separated as typed; split on the way out. */
  authors: string
  assignees: string
  anyLabels: string
  allLabels: string
  excludeLabels: string
  /** Required by the server for `issue.labeled` / `issue.unlabeled`. */
  changedLabels: string
  lookbackDays: number
  maxRecords: number
}

export interface EditorDraft {
  name: string
  kind: AutomationKind
  schedule: AutomationSchedule
  events: AutomationEvent[]
  intervalSeconds: number
  filters: DraftFilters
  prompt: string
  workflow: string
  /** `null` = never touched: the project's default runner shows through the pill. */
  runner: Runner | null
  /** `null` = never touched; `''` = auto, explicitly. */
  model: string | null
  autonomous: boolean
  dispatch: boolean
  maxSubtasks: number
  reviewChild: boolean
  enabled: boolean
}

/** The four events the poller reconstructs (Q6: nothing else is offered). */
export const GITHUB_EVENTS: readonly AutomationEvent[] = [
  'pull_request.opened',
  'issue.opened',
  'issue.labeled',
  'issue.unlabeled',
]

export const POLL_MINUTES = [2, 5, 10, 15, 30, 60] as const
export const DISPATCH_SUBTASK_OPTIONS = [1, 2, 4, 6, 8] as const

export const DEFAULT_FILTERS: DraftFilters = {
  authors: '',
  assignees: '',
  anyLabels: '',
  allLabels: '',
  excludeLabels: '',
  changedLabels: '',
  lookbackDays: 7,
  maxRecords: 25,
}

export const DEFAULT_SCHEDULE: AutomationSchedule = { type: 'daily', hour: 4, minute: 0 }

/** A fresh form: paused, daily at 04:00, `quick-task`, autonomous, no dispatch. */
export function newDraft(): EditorDraft {
  return {
    name: '',
    kind: 'schedule',
    schedule: { ...DEFAULT_SCHEDULE },
    events: ['issue.opened'],
    intervalSeconds: 300,
    filters: { ...DEFAULT_FILTERS },
    prompt: '',
    workflow: 'quick-task',
    runner: null,
    model: null,
    autonomous: true,
    dispatch: false,
    maxSubtasks: 4,
    reviewChild: true,
    enabled: false,
  }
}

const joinList = (values: readonly string[] | undefined): string => (values ?? []).join(', ')

/** `a, b ,,c` → `['a', 'b', 'c']`. */
export function splitList(text: string): string[] {
  return text.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
}

export function fromDefinition(definition: AutomationDefinition): EditorDraft {
  const base = newDraft()
  const { task, filters } = definition
  return {
    ...base,
    name: definition.name,
    kind: definition.kind,
    schedule: definition.schedule ? { ...definition.schedule } : base.schedule,
    events: definition.events?.length ? [...definition.events] : base.events,
    intervalSeconds: definition.intervalSeconds ?? base.intervalSeconds,
    filters: filters
      ? {
          authors: joinList(filters.authors),
          assignees: joinList(filters.assignees),
          anyLabels: joinList(filters.anyLabels),
          allLabels: joinList(filters.allLabels),
          excludeLabels: joinList(filters.excludeLabels),
          changedLabels: joinList(filters.changedLabels),
          lookbackDays: filters.lookbackDays,
          maxRecords: filters.maxRecords,
        }
      : base.filters,
    prompt: task.prompt,
    workflow: task.workflow ?? base.workflow,
    runner: task.runner ?? null,
    model: task.model ?? null,
    autonomous: task.autonomous ?? false,
    dispatch: task.dispatch !== undefined,
    maxSubtasks: task.dispatch?.maxSubtasks ?? base.maxSubtasks,
    reviewChild: task.dispatch?.reviewChild ?? base.reviewChild,
    enabled: definition.enabled,
  }
}

/** What the palette hands over: a built-in template or another project's automation. */
export type TemplatePick = Pick<AutomationTemplateDraft, 'name' | 'kind' | 'schedule' | 'events' | 'intervalSeconds' | 'prompt' | 'workflow' | 'dispatch'> & {
  runner?: string
  model?: string
  autonomous?: boolean
}

export function templatePick(template: AutomationTemplate): TemplatePick {
  return {
    name: template.name,
    kind: template.kind,
    ...(template.schedule ? { schedule: template.schedule } : {}),
    ...(template.events ? { events: template.events } : {}),
    ...(template.intervalSeconds !== undefined ? { intervalSeconds: template.intervalSeconds } : {}),
    prompt: template.task.prompt,
    ...(template.task.workflow ? { workflow: template.task.workflow } : {}),
    ...(template.task.runner ? { runner: template.task.runner } : {}),
    ...(template.task.model !== undefined ? { model: template.task.model } : {}),
    ...(template.task.autonomous !== undefined ? { autonomous: template.task.autonomous } : {}),
    ...(template.task.dispatch ? { dispatch: template.task.dispatch } : {}),
  }
}

const isRunner = (value: string): value is Runner =>
  value === 'claude' || value === 'codex' || value === 'opencode' || value === 'pi'

/** "Use this": the template fills name, kind, trigger, prompt and task; everything else stays. */
export function applyTemplate(draft: EditorDraft, template: TemplatePick): EditorDraft {
  return {
    ...draft,
    name: template.name,
    kind: template.kind,
    schedule: template.schedule ? { ...template.schedule } : draft.schedule,
    events: template.events?.length ? [...template.events] : draft.events,
    intervalSeconds: template.intervalSeconds ?? draft.intervalSeconds,
    prompt: template.prompt,
    workflow: template.workflow ?? draft.workflow,
    runner: template.runner !== undefined && isRunner(template.runner) ? template.runner : draft.runner,
    model: template.model ?? draft.model,
    autonomous: template.autonomous ?? draft.autonomous,
    dispatch: template.dispatch !== undefined,
    maxSubtasks: template.dispatch?.maxSubtasks ?? draft.maxSubtasks,
    reviewChild: template.dispatch?.reviewChild ?? draft.reviewChild,
  }
}

/** The stored shape of the schedule: only the keys the type reads, so a round trip is exact. */
export function scheduleBody(schedule: AutomationSchedule): AutomationSchedule {
  const s = normalizeSchedule(schedule)
  switch (s.type) {
    case 'hours': return { type: 'hours', every: s.every }
    case 'weekly': return { type: 'weekly', hour: s.hour, minute: s.minute, day: s.day }
    default: return { type: s.type, hour: s.hour, minute: s.minute }
  }
}

export type AutomationBody = Omit<CreateAutomationInput, 'enable'>

/** The request body — the active kind's trigger, and only the task keys that carry a value. */
export function toBody(draft: EditorDraft): AutomationBody {
  const task: AutomationBody['task'] = {
    prompt: draft.prompt,
    ...(draft.workflow ? { workflow: draft.workflow } : {}),
    ...(draft.runner ? { runner: draft.runner } : {}),
    ...(draft.model ? { model: draft.model } : {}),
    autonomous: draft.autonomous,
    ...(draft.dispatch ? { dispatch: { maxSubtasks: draft.maxSubtasks, reviewChild: draft.reviewChild } } : {}),
  }
  if (draft.kind === 'schedule') {
    return { name: draft.name.trim(), kind: 'schedule', schedule: scheduleBody(draft.schedule), task }
  }
  const f = draft.filters
  const list = (text: string, key: keyof AutomationBodyFilters) => {
    const values = splitList(text)
    return values.length > 0 ? { [key]: values } : {}
  }
  return {
    name: draft.name.trim(),
    kind: 'github',
    events: [...draft.events],
    intervalSeconds: draft.intervalSeconds,
    filters: {
      ...list(f.authors, 'authors'),
      ...list(f.assignees, 'assignees'),
      ...list(f.anyLabels, 'anyLabels'),
      ...list(f.allLabels, 'allLabels'),
      ...list(f.excludeLabels, 'excludeLabels'),
      ...list(f.changedLabels, 'changedLabels'),
      lookbackDays: clamp(f.lookbackDays, 1, 90),
      maxRecords: clamp(f.maxRecords, 1, 100),
    },
    task,
  }
}

type AutomationBodyFilters = NonNullable<AutomationBody['filters']>

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** The "Copy as CLI" card's input, straight from the form. */
export function cliDefinitionOf(draft: EditorDraft): CliDefinition {
  const body = toBody(draft)
  return {
    name: body.name,
    kind: draft.kind,
    ...(body.schedule ? { schedule: body.schedule } : {}),
    ...(body.events ? { events: body.events } : {}),
    ...(body.intervalSeconds !== undefined ? { intervalSeconds: body.intervalSeconds } : {}),
    ...(body.filters ? { filters: body.filters } : {}),
    task: body.task,
    ...(draft.enabled ? { enable: true } : {}),
  }
}

/** A label event needs `changedLabels` — the server's rule, surfaced before the 400. */
export function needsChangedLabels(events: readonly AutomationEvent[]): boolean {
  return events.includes('issue.labeled') || events.includes('issue.unlabeled')
}

export const isScheduleEvery = (value: number): value is ScheduleEvery =>
  [1, 2, 3, 4, 6, 8, 12].includes(value)
