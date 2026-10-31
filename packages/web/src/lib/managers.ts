import type {
  ManagerActionRequest,
  ManagerCommand as ContractManagerCommand,
  ManagerProjects,
  ManagerSummary,
} from '@open-mercato/cezar-api-client'

/** Pure helpers behind the Manager surface (spec `2026-10-31-managers`): no React, no clock. */

/** The mode is the URL, never stored state — so a pasted link and Back can't disagree with it. */
export function isManagerPathname(pathname: string): boolean {
  return pathname === '/manager' || pathname.startsWith('/manager/')
}

// ---- `[[task:…]]` / `[[pr:…]]` -------------------------------------------------------------

type ManagerCommandRow = Pick<ContractManagerCommand, 'summary' | 'output' | 'isError'>

export type ManagerSegment =
  | { kind: 'markdown'; text: string }
  | { kind: 'task'; projectId: string; runId: string }

const TOKEN = /\[\[(task|pr):([^\]/\s]+)\/([^\]\s]+)\]\]/g
const CARD_LINE = /^\s*(?:[-*]\s+)?((?:\[\[task:[^\]/\s]+\/[^\]\s]+\]\]\s*)+)$/
/** A reference the stream has only half delivered; shown raw it flickers as literal brackets. */
const TRAILING_PARTIAL = /\[\[?(?:(?:task|pr)(?::[^\]\n]*)?\]?)?$/

export const TASK_LINK_PREFIX = '#cez-task/'
export const PR_LINK_PREFIX = '#cez-pr/'

/** An inline reference becomes a hash link, which `ManagerLink` paints as a chip: splitting the
 *  markdown around it would break the paragraph or list item it sits in. */
function inlineReferences(line: string): string {
  return line.replace(TOKEN, (_match, kind: string, project: string, id: string) => {
    const path = `${encodeURIComponent(project)}/${encodeURIComponent(id)}`
    return kind === 'pr' ? `[#${id}](${PR_LINK_PREFIX}${path})` : `[task](${TASK_LINK_PREFIX}${path})`
  })
}

const STARTED_TASK = /^\[\[task:([^\]/\s]+)\/([^\]\s]+)\]\]$/gm

/** What `cez-manager task create` printed. Only that command: other output is text anyone wrote. */
function startedTasks(commands: readonly ManagerCommandRow[]): Array<{ projectId: string; runId: string }> {
  return commands
    .filter((command) => !command.isError && /\btask create\b/.test(command.summary))
    .flatMap((command) => [...(command.output ?? '').matchAll(STARTED_TASK)])
    .map((match) => ({ projectId: match[1]!, runId: match[2]! }))
}

/**
 * Every task a reply names or started gets a card, however the agent worded it: alone on its line
 * the card replaces it, in a sentence the chip stays and the card follows that block, and a task
 * it started without naming closes the reply. One card per task. Fenced code is literal.
 */
export function parseManagerText(text: string, commands: readonly ManagerCommandRow[] = []): ManagerSegment[] {
  const segments: ManagerSegment[] = []
  const carded = new Set<string>()
  let pending: Array<{ projectId: string; runId: string }> = []
  let buffer: string[] = []
  let fenced = false
  const card = (projectId: string, runId: string) => {
    if (carded.has(`${projectId}/${runId}`)) return
    carded.add(`${projectId}/${runId}`)
    segments.push({ kind: 'task', projectId, runId })
  }
  const flush = () => {
    const joined = buffer.join('\n').trim()
    if (joined !== '') segments.push({ kind: 'markdown', text: joined })
    buffer = []
    for (const task of pending) card(task.projectId, task.runId)
    pending = []
  }
  for (const line of text.replace(TRAILING_PARTIAL, '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      buffer.push(line)
      continue
    }
    if (fenced) {
      buffer.push(line)
      continue
    }
    const alone = CARD_LINE.exec(line)
    if (!alone) {
      if (pending.length > 0 && line.trim() === '') flush()
      for (const match of line.matchAll(TOKEN)) {
        if (match[1] === 'task') pending.push({ projectId: match[2]!, runId: match[3]! })
      }
      buffer.push(inlineReferences(line))
      continue
    }
    flush()
    for (const match of alone[1]!.matchAll(TOKEN)) card(match[2]!, match[3]!)
  }
  flush()
  for (const task of startedTasks(commands)) card(task.projectId, task.runId)
  return segments
}

/** Undo `inlineReferences`' path, or null for a link that is not a cockpit reference. */
export function parseReferenceLink(href: string | undefined, prefix: string): { projectId: string; id: string } | null {
  if (!href?.startsWith(prefix)) return null
  const [project, id] = href.slice(prefix.length).split('/')
  return project && id ? { projectId: decodeURIComponent(project), id: decodeURIComponent(id) } : null
}

// ---- `/` commands --------------------------------------------------------------------------

export interface ManagerCommand {
  name: string
  description: string
  /** What is sent as the message. Absent: the cockpit handles it through a route. */
  prompt?: string
}

export const MANAGER_COMMANDS: readonly ManagerCommand[] = [
  { name: 'status', description: 'Where things stand', prompt: 'Give me a short status of my connected projects.' },
  { name: 'attention', description: 'What needs me', prompt: 'What needs my attention right now?' },
  { name: 'tasks', description: 'Running and recent tasks', prompt: 'List the running and recently finished tasks.' },
  { name: 'prs', description: 'Open pull requests', prompt: 'List the open pull requests and what each one is waiting for.' },
  { name: 'check', description: 'Run the watch check now' },
  { name: 'stop', description: 'Stop the current turn' },
]

/** The command a whole message spells, or null. `/statusline please` is a message, not a command. */
export function parseManagerCommand(text: string): ManagerCommand | null {
  const match = /^\/([a-z]+)\s*$/.exec(text.trim())
  return match ? (MANAGER_COMMANDS.find((command) => command.name === match[1]) ?? null) : null
}

// ---- labels --------------------------------------------------------------------------------

export function cronLabel(minutes: number): string {
  if (minutes === 0) return 'Off'
  if (minutes < 60) return `${minutes} min`
  if (minutes === 60) return '1 hour'
  if (minutes < 1440) return `${minutes / 60} hours`
  return minutes === 1440 ? '1 day' : `${minutes / 1440} days`
}

export function projectsLabel(projects: ManagerProjects, nameOf: (id: string) => string | undefined): string {
  if (projects === 'all') return 'All projects access'
  if (projects.length === 1) return nameOf(projects[0]!) ?? projects[0]!
  return `${projects.length} projects`
}

export function effortLabel(effort: string | undefined): string {
  return effort ? `${effort[0]!.toUpperCase()}${effort.slice(1)}` : ''
}

/** The sidebar's time column: a clock today, then a day, then a date. */
export function managerTimeLabel(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) / 86_400_000,
  )
  if (days <= 0) return at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (days === 1) return 'Yesterday'
  if (days < 7) return at.toLocaleDateString([], { weekday: 'long' })
  return at.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function actionTitle(action: ManagerActionRequest): string {
  if (action.type === 'merge-pr') return `Merge #${action.number}${action.title ? ` — ${action.title}` : ''}`
  if (action.type === 'enable-automation') return `Enable automation ${action.name ?? action.automationId}`
  return `Add job ${action.name}`
}

// ---- back to the manager -------------------------------------------------------------------

/** Router state a session card leaves on the task it opens. */
export interface ManagerOrigin {
  id: string
  name: string
}

const origins = new Map<string, ManagerOrigin>()

/** A task's tabs are URLs of their own and router state doesn't follow them, so the first arrival
 *  is remembered for the session. */
export function resolveManagerOrigin(runId: string, state: unknown): ManagerOrigin | undefined {
  const origin = (state as { manager?: Partial<ManagerOrigin> } | null | undefined)?.manager
  if (typeof origin?.id === 'string' && typeof origin.name === 'string') {
    origins.set(runId, { id: origin.id, name: origin.name })
  }
  return origins.get(runId)
}

export function clearManagerOrigins(): void {
  origins.clear()
}

export function managerRowPreview(manager: ManagerSummary): string {
  if (manager.pendingActions > 0) {
    return `${manager.pendingActions} ${manager.pendingActions === 1 ? 'approval' : 'approvals'} waiting`
  }
  return manager.preview ?? (manager.status === 'working' ? 'Working…' : 'No messages yet')
}
