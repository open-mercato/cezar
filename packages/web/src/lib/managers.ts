import type {
  ManagerTurnKind,
  ManagerAccess,
  ManagerMessage,
  ManagerActionRequest,
  ManagerCommand as ContractManagerCommand,
  ManagerConfirm,
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

const TOKEN = /\[\[(task|pr|issue):([^\]/\s]+)\/([^\]\s]+)\]\]/g
const CARD_LINE = /^\s*(?:[-*]\s+)?((?:\[\[task:[^\]/\s]+\/[^\]\s]+\]\]\s*)+)$/
/** A reference the stream has only half delivered; shown raw it flickers as literal brackets. */
const TRAILING_PARTIAL = /\[\[?(?:(?:task|pr|issue)(?::[^\]\n]*)?\]?)?$/

export const TASK_LINK_PREFIX = '#cez-task/'
export const PR_LINK_PREFIX = '#cez-pr/'
export const ISSUE_LINK_PREFIX = '#cez-issue/'
/** A bare `#12` in a chat that spans repositories: still a bubble, just not a link. */
export const UNKNOWN_PROJECT = '_'

export interface ManagerReferenceProject {
  id: string
  name?: string
  repoUrl?: string
}

/** Not a fragment, an entity or a markdown link's own text. */
const BARE_NUMBER = /(?<![\w/#&[])#(\d{1,7})\b/g
const PR_WORD_BEFORE = /\b(?:PRs?|pull requests?)\s*$/i
const GITHUB_URL = /(?<![("<[])(https:\/\/github\.com\/[^\s/]+\/[^\s/]+)\/(pull|issues)\/(\d+)(?![\w/])/g
const INLINE_CODE = /(`[^`]*`)/
/** `frontends/2902` or `frontends#2902`: it names its project, so it is safe to resolve when that
 *  project is connected. Not a path, a URL, a marker's inside or a markdown link's text or target. */
const PROJECT_NUMBER = /(?<![\w./:#@[-])(?<!\]\()([A-Za-z0-9][\w.-]*)[/#](\d{1,7})(?![\w/\]])/g

/** A connected project named by its id, else by a name no other connected project shares: two
 *  clones of one repo can both be `frontends`, and a guess would link the wrong one. */
function namedProject(name: string, projects: readonly ManagerReferenceProject[]): ManagerReferenceProject | undefined {
  const wanted = name.toLowerCase()
  const byId = projects.find((project) => project.id.toLowerCase() === wanted)
  if (byId) return byId
  const byName = projects.filter((project) => project.name?.toLowerCase() === wanted)
  return byName.length === 1 ? byName[0] : undefined
}

/** An inline reference becomes a hash link, which `ManagerLink` paints as a chip: splitting the
 *  markdown around it would break the paragraph or list item it sits in. */
function inlineReferences(line: string): string {
  return line.replace(TOKEN, (_match, kind: string, project: string, id: string) => {
    const path = `${encodeURIComponent(project)}/${encodeURIComponent(id)}`
    if (kind === 'task') return `[task](${TASK_LINK_PREFIX}${path})`
    return `[#${id}](${kind === 'pr' ? PR_LINK_PREFIX : ISSUE_LINK_PREFIX}${path})`
  })
}

/** The project a bare `#12` belongs to: the one this reply names, else the only one connected. */
function replyProject(text: string, projects: readonly ManagerReferenceProject[]): string {
  const named = [...text.matchAll(TOKEN)][0]?.[2]
  return named ?? (projects.length === 1 ? projects[0]!.id : UNKNOWN_PROJECT)
}

/** Agents write bare numbers and GitHub URLs as often as tokens, so those become the same bubble.
 *  An unknown kind links as an issue: GitHub redirects `/issues/N` to a pull request. */
function bareReferences(line: string, project: string, projects: readonly ManagerReferenceProject[]): string {
  return line.split(INLINE_CODE).map((part, index) => {
    if (index % 2 === 1) return part
    const linked = part.replace(GITHUB_URL, (url, repo: string, kind: string, number: string) => {
      const owner = projects.find((candidate) => candidate.repoUrl === repo)
      if (!owner) return url
      return `[#${number}](${kind === 'pull' ? PR_LINK_PREFIX : ISSUE_LINK_PREFIX}${encodeURIComponent(owner.id)}/${number})`
    }).replace(PROJECT_NUMBER, (match, name: string, number: string, at: number, whole: string) => {
      const owner = namedProject(name, projects)
      if (!owner) return match
      const prefix = PR_WORD_BEFORE.test(whole.slice(0, at)) ? PR_LINK_PREFIX : ISSUE_LINK_PREFIX
      return `[#${number}](${prefix}${encodeURIComponent(owner.id)}/${number})`
    })
    return linked.replace(BARE_NUMBER, (match, number: string, at: number, whole: string) => {
      const prefix = PR_WORD_BEFORE.test(whole.slice(0, at)) ? PR_LINK_PREFIX : ISSUE_LINK_PREFIX
      return `[${match}](${prefix}${encodeURIComponent(project)}/${number})`
    })
  }).join('')
}

/** These links arrive in agent text that may quote anyone: a stray `%` must not crash the chat. */
function decoded(part: string): string | null {
  try {
    return decodeURIComponent(part)
  } catch {
    return null
  }
}

/** Every reference a reply paints, for the status lookup that colours its chips. */
export function managerReferences(segments: readonly ManagerSegment[]): Array<{ projectId: string; kind: 'PR' | 'Issue'; number: number }> {
  const seen = new Map<string, { projectId: string; kind: 'PR' | 'Issue'; number: number }>()
  for (const segment of segments) {
    if (segment.kind !== 'markdown') continue
    for (const match of segment.text.matchAll(/\(#cez-(pr|issue)\/([^/)]+)\/(\d+)\)/g)) {
      const projectId = decoded(match[2]!)
      if (projectId === null || projectId === UNKNOWN_PROJECT) continue
      const kind = match[1] === 'pr' ? 'PR' : 'Issue'
      seen.set(`${projectId} ${kind} ${match[3]}`, { projectId, kind, number: Number(match[3]) })
    }
  }
  return [...seen.values()]
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
export function parseManagerText(
  text: string,
  commands: readonly ManagerCommandRow[] = [],
  projects: readonly ManagerReferenceProject[] = [],
): ManagerSegment[] {
  const project = replyProject(text, projects)
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
      buffer.push(inlineReferences(bareReferences(line, project, projects)))
      continue
    }
    flush()
    for (const match of alone[1]!.matchAll(TOKEN)) card(match[2]!, match[3]!)
  }
  flush()
  for (const task of startedTasks(commands)) card(task.projectId, task.runId)
  return segments
}

// ---- references in card text ---------------------------------------------------------------

/** A run of card text: plain words, or a reference that paints as the chat's chip. */
export type InlineReference =
  | { kind: 'text'; text: string }
  | { kind: 'pr' | 'issue'; projectId: string; number: number }
  | { kind: 'task'; projectId: string; runId: string }

const REFERENCE_NUMBER = /^\d{1,7}$/

/** The project a card's bare `#12` belongs to: the one any of its texts names, else the only one. */
export function referenceProjectOf(texts: readonly string[], projects: readonly ManagerReferenceProject[]): string {
  return replyProject(texts.join('\n'), projects)
}

/** What the user reads where a marker cannot be a chip: `#12`, never brackets or nothing. The
 *  server measures card limits with the same words (`askVisibleText` in `core/ask.ts`). */
function markerText(kind: string, id: string): string {
  if (kind === 'task') return `task ${id.slice(0, 8)}`
  if (REFERENCE_NUMBER.test(id)) return `#${id}`
  return `${kind === 'pr' ? 'PR' : 'issue'} ${id}`
}

/** Bare `#12`s, `project/12`s and GitHub URLs in a stretch of card text, resolved as `bareReferences` does. */
function bareInline(text: string, project: string, projects: readonly ManagerReferenceProject[]): InlineReference[] {
  const out: InlineReference[] = []
  const pushText = (value: string) => {
    if (value === '') return
    const last = out.at(-1)
    if (last?.kind === 'text') last.text += value
    else out.push({ kind: 'text', text: value })
  }
  text.split(INLINE_CODE).forEach((part, index) => {
    if (index % 2 === 1) return pushText(part)
    const pattern = new RegExp(`${GITHUB_URL.source}|${BARE_NUMBER.source}|${PROJECT_NUMBER.source}`, 'g')
    let at = 0
    for (const match of part.matchAll(pattern)) {
      const start = match.index
      let reference: InlineReference | null = null
      if (match[1] !== undefined) {
        const owner = projects.find((candidate) => candidate.repoUrl === match[1])
        if (owner) reference = { kind: match[2] === 'pull' ? 'pr' : 'issue', projectId: owner.id, number: Number(match[3]) }
      } else if (match[5] !== undefined) {
        const owner = namedProject(match[5], projects)
        if (owner) reference = { kind: PR_WORD_BEFORE.test(part.slice(0, start)) ? 'pr' : 'issue', projectId: owner.id, number: Number(match[6]) }
      } else if (project !== UNKNOWN_PROJECT) {
        // A card has no use for a chip that links nowhere: an unknown project stays words.
        reference = { kind: PR_WORD_BEFORE.test(part.slice(0, start)) ? 'pr' : 'issue', projectId: project, number: Number(match[4]) }
      }
      if (!reference) continue
      pushText(part.slice(at, start))
      out.push(reference)
      at = start + match[0].length
    }
    pushText(part.slice(at))
  })
  return out
}

/**
 * Card text (a `CEZ:ASK` question or option, a proposal's reason) is plain, not markdown, so it is
 * split rather than rewritten into links. Markers and bare `#12`s follow the chat's rules, but only
 * a connected project becomes a chip: anything else falls back to the words it stands for.
 */
export function parseInlineReferences(
  text: string,
  projects: readonly ManagerReferenceProject[],
  project: string = referenceProjectOf([text], projects),
): InlineReference[] {
  const out: InlineReference[] = []
  const pushText = (value: string) => {
    for (const piece of bareInline(value, project, projects)) {
      const last = out.at(-1)
      if (piece.kind === 'text' && last?.kind === 'text') last.text += piece.text
      else out.push(piece)
    }
  }
  let at = 0
  for (const match of text.matchAll(TOKEN)) {
    const [raw, kind, projectId, id] = match as unknown as [string, string, string, string]
    pushText(text.slice(at, match.index))
    at = match.index + raw.length
    const connected = projects.some((candidate) => candidate.id === projectId)
    if (connected && kind === 'task') out.push({ kind: 'task', projectId, runId: id })
    else if (connected && REFERENCE_NUMBER.test(id)) out.push({ kind: kind as 'pr' | 'issue', projectId, number: Number(id) })
    else {
      const last = out.at(-1)
      const words = markerText(kind, id)
      if (last?.kind === 'text') last.text += words
      else out.push({ kind: 'text', text: words })
    }
  }
  pushText(text.slice(at))
  return out
}

/** The words a card text reads as, every marker swapped for what its chip says (`#12`). */
export function inlineReferenceText(text: string): string {
  return text.replace(TOKEN, (_raw, kind: string, _project: string, id: string) => markerText(kind, id))
}

/** Every PR and issue some card texts paint, for the status lookup that colours their chips. */
export function inlineReferenceRequests(parts: readonly InlineReference[][]): Array<{ projectId: string; kind: 'PR' | 'Issue'; number: number }> {
  const seen = new Map<string, { projectId: string; kind: 'PR' | 'Issue'; number: number }>()
  for (const piece of parts.flat()) {
    if (piece.kind !== 'pr' && piece.kind !== 'issue') continue
    const kind = piece.kind === 'pr' ? 'PR' : 'Issue'
    seen.set(`${piece.projectId} ${kind} ${piece.number}`, { projectId: piece.projectId, kind, number: piece.number })
  }
  return [...seen.values()]
}

/** Undo `inlineReferences`' path, or null for a link that is not a cockpit reference. */
export function parseReferenceLink(href: string | undefined, prefix: string): { projectId: string; id: string } | null {
  if (!href?.startsWith(prefix)) return null
  const [project, id] = href.slice(prefix.length).split('/')
  const projectId = project ? decoded(project) : null
  const reference = id ? decoded(id) : null
  return projectId && reference ? { projectId, id: reference } : null
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

/** The newest reply when it is a failed chat turn, with what the user asked it; else undefined. */
export function retryOf(messages: readonly ManagerMessage[]): { messageId: string; text: string } | undefined {
  let at = messages.length - 1
  while (at >= 0 && messages[at]!.kind !== 'assistant' && messages[at]!.kind !== 'user') at -= 1
  const last = messages[at]
  if (last?.kind !== 'assistant' || last.turn !== 'chat' || !last.error || last.streaming) return undefined
  const asked: string[] = []
  // Everything typed during a turn folded into it, so the run of user messages before it is the question.
  for (let index = at - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.kind === 'assistant') break
    if (message.kind === 'user' && message.text.trim()) asked.unshift(message.text.trim())
  }
  return asked.length > 0 ? { messageId: last.id, text: asked.join('\n\n') } : undefined
}

/** Ids of the newest auth-failed chat turn per account since its last reconnect: those draw the
 *  live reconnect card, older ones a quiet line (spec 2026-11-18-inline-account-reconnect, one card
 *  per account). Only chat turns: a reconnect replays those, never a watch or a job. */
export function liveAuthFailures(messages: readonly ManagerMessage[]): ReadonlySet<string> {
  const newest = new Map<string, string>()
  for (const message of messages) {
    if (message.kind !== 'assistant' || message.turn !== 'chat') continue
    if (message.authFailure) newest.set(`${message.authFailure.provider}:${message.authFailure.profileId}`, message.id)
    else if (message.reconnectedFrom) newest.delete(`${message.reconnectedFrom.provider}:${message.reconnectedFrom.profileId}`)
  }
  return new Set(newest.values())
}

// ---- labels --------------------------------------------------------------------------------

export function cronLabel(minutes: number): string {
  if (minutes === 0) return 'Off'
  if (minutes < 60) return `${minutes} min`
  if (minutes === 60) return '1 hour'
  if (minutes < 1440) return `${minutes / 60} hours`
  return minutes === 1440 ? '1 day' : `${minutes / 1440} days`
}

/** The access half of the projects caption: "write", "read-only" or how many are read-only. */
export function accessLabel(access: readonly ManagerAccess[]): string {
  const read = access.filter((entry) => entry === 'read').length
  if (access.length === 0) return ''
  if (read === 0) return 'write'
  return read === access.length ? 'read-only' : `${read} read-only`
}

export function projectsLabel(projects: ManagerProjects, nameOf: (id: string) => string | undefined): string {
  if (projects === 'all') return 'All projects'
  if (projects.length === 1) return nameOf(projects[0]!) ?? projects[0]!
  return `${projects.length} projects`
}

export function effortLabel(effort: string | undefined): string {
  return effort ? `${effort[0]!.toUpperCase()}${effort.slice(1)}` : ''
}

/** The sidebar's time column: a clock today, then a day, then a date. */
/** A chat message's clock: unlike the sidebar's label, an older day keeps its hour too. */
export function managerMessageTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (at.toDateString() === now.toDateString()) return time
  return `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

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
  switch (action.type) {
    case 'merge-pr': return `Merge #${action.number}${action.title ? ` — ${action.title}` : ''}`
    case 'enable-automation': return `Enable automation ${action.name ?? action.automationId}`
    case 'add-job': return `Add job ${action.name}`
    case 'connector-call': return `${action.connectorName ?? action.connector}: ${action.tool}`
  }
}

/** The types Settings → Manager can switch off. Anything else, including a type from a newer
 *  server, always confirms. */
export const MANAGER_CONFIRM_TYPES = ['merge-pr', 'enable-automation', 'add-job', 'connector-call'] as const

/** Fails safe (mobile spec, Confirmation setting): only an explicit `false` on a known type skips
 *  the step. It removes a step in the cockpit; the card and its tap stay. */
/** A manager's own answer per type, else the global one (the setting before it was per manager). */
export function managerConfirmOf(own: ManagerConfirm | undefined, global: ManagerConfirm | undefined): ManagerConfirm {
  return { ...global, ...own }
}

export function actionConfirms(setting: ManagerConfirm | undefined, type: string): boolean {
  const known = MANAGER_CONFIRM_TYPES.find((entry) => entry === type)
  return known === undefined || setting?.[known] !== false
}

// ---- back to the manager -------------------------------------------------------------------

/** Router state a session card leaves on the task it opens. */
export interface ManagerOrigin {
  id: string
  name: string
  /** The manager's filtered Tasks table the task was opened from (`/tasks?manager=…`). */
  tasks?: string
  decision?: string
}

const origins = new Map<string, ManagerOrigin>()

/** A task's tabs are URLs of their own and router state doesn't follow them, so the first arrival
 *  is remembered for the session. */
export function resolveManagerOrigin(runId: string, state: unknown): ManagerOrigin | undefined {
  const origin = managerOriginOf(state)
  if (origin) origins.set(runId, origin)
  return origins.get(runId)
}

/** The manager this history entry was opened from, if any. */
export function managerOriginOf(state: unknown): ManagerOrigin | undefined {
  const origin = (state as { manager?: Partial<ManagerOrigin> } | null | undefined)?.manager
  if (typeof origin?.id !== 'string' || typeof origin.name !== 'string') return undefined
  const tasks = typeof origin.tasks === 'string' && origin.tasks.startsWith('/tasks?') ? origin.tasks : undefined
  return { id: origin.id, name: origin.name, ...(tasks ? { tasks } : {}), ...(typeof origin.decision === 'string' ? { decision: origin.decision } : {}) }
}

export function clearManagerOrigins(): void {
  origins.clear()
}

/** Why a manager's dot shows: an approval or a question waits on the user, or only news. */
export type ManagerAttention = 'needs-you' | 'unread'

type AttentionCounts = Pick<ManagerSummary, 'unread' | 'pendingActions' | 'pendingQuestions'>

export function managerAttention(manager: AttentionCounts): ManagerAttention | null {
  if (manager.pendingActions > 0 || manager.pendingQuestions > 0) return 'needs-you'
  return manager.unread > 0 ? 'unread' : null
}

/** The strongest reason across managers: one waiting approval outranks any amount of news. */
export function managersAttention(managers: readonly (AttentionCounts & Pick<ManagerSummary, 'inactive'>)[] | undefined): ManagerAttention | null {
  let found: ManagerAttention | null = null
  for (const manager of managers ?? []) {
    // An inactive manager's approvals still wait on the user; its questions and news do not.
    const attention = isInactive(manager) ? (manager.pendingActions > 0 ? 'needs-you' : null) : managerAttention(manager)
    if (attention === 'needs-you') return attention
    found ??= attention
  }
  return found
}

/** The cockpit's attention grammar (`lib/attention.ts`): blue waits on you, violet is unread news. */
export const MANAGER_ATTENTION_DOT: Record<ManagerAttention, string> = { 'needs-you': 'bg-info', unread: 'bg-violet' }

/** Screen-reader words for the dot, read as part of the row's name. */
export const MANAGER_ATTENTION_TEXT: Record<ManagerAttention, string> = { 'needs-you': ', needs you', unread: ', unread' }

// ---- deactivation (spec 2026-11-19-manager-deactivate) -------------------------------------

export const isInactive = (manager: Pick<ManagerSummary, 'inactive'> | undefined): boolean => manager?.inactive !== undefined

/** The dot an inactive manager shows while it holds cards: grey, never the blue that waits on you. */
export const MANAGER_INACTIVE_DOT = 'bg-muted-foreground'

/** Active managers, then the inactive ones under their divider; each half keeps its order. */
export function splitByActivity<T extends Pick<ManagerSummary, 'inactive'>>(managers: readonly T[]): { active: T[]; inactive: T[] } {
  return { active: managers.filter((manager) => !isInactive(manager)), inactive: managers.filter(isInactive) }
}

export function inactiveSinceLabel(manager: Pick<ManagerSummary, 'inactive'>, now: Date = new Date()): string {
  const since = manager.inactive ? managerMessageTime(manager.inactive.since, now) : ''
  return since ? `Inactive · since ${since}` : 'Inactive'
}

export function managerRowPreview(manager: ManagerSummary): string {
  if (isInactive(manager)) return inactiveSinceLabel(manager)
  // Counts open ask cards, and one card can hold several questions: word it per answer.
  if (manager.pendingQuestions > 0) {
    return manager.pendingQuestions === 1 ? 'Waiting for your answer' : `Waiting for ${manager.pendingQuestions} answers`
  }
  if (manager.pendingActions > 0) {
    return `${manager.pendingActions} ${manager.pendingActions === 1 ? 'approval' : 'approvals'} waiting`
  }
  return manager.preview ?? (manager.status === 'working' ? 'Working…' : 'No messages yet')
}

const ANNOUNCE_LIMIT = 200

/** What a screen reader hears when a reply settles: who, then the gist as plain text. */
export function managerReplyAnnouncement(name: string, message: Extract<ManagerMessage, { kind: 'assistant' }>): string {
  if (message.error) return `${name} failed: ${message.error}`
  if (message.resumeAt) return `${name} hit a usage limit and resumes automatically at ${new Date(message.resumeAt).toLocaleString()}.`
  const text = message.text
    .replace(/^\s*CEZ:ASK .*$/gm, '')
    .replace(TOKEN, (_match, kind: string, _project: string, id: string) => (kind === 'task' ? 'a task' : `#${id}`))
    .replace(/```[\s\S]*?(```|$)/g, ' code ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*#+\s/gm, '')
    .replace(/[*_`>|~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const gist = text.length > ANNOUNCE_LIMIT ? `${text.slice(0, ANNOUNCE_LIMIT).replace(/\s\S*$/, '')}…` : text
  const ask = message.ask ? ` ${message.ask.questions.length === 1 ? 'A question' : `${message.ask.questions.length} questions`} for you.` : ''
  const stopped = message.stopped ? ' Response stopped.' : ''
  return `${name} replied${gist ? `: ${gist}` : '.'}${stopped}${ask}`
}

// ---- the screen around the chat (design 2026-11, Proposal 10) ------------------------------

type NeedsYouCounts = Pick<ManagerSummary, 'pendingActions' | 'pendingQuestions'>

/** Approvals plus open questions: what the Needs-you strip and the sidebar badge count. */
export function needsYouCount(manager: NeedsYouCounts): number {
  return manager.pendingActions + manager.pendingQuestions
}

/** "2 approvals · 1 question", or '' when nothing waits. */
export function needsYouLabel(manager: NeedsYouCounts): string {
  const parts: string[] = []
  if (manager.pendingActions > 0) parts.push(`${manager.pendingActions} ${manager.pendingActions === 1 ? 'approval' : 'approvals'}`)
  if (manager.pendingQuestions > 0) parts.push(`${manager.pendingQuestions} ${manager.pendingQuestions === 1 ? 'question' : 'questions'}`)
  return parts.join(' · ')
}

export type CheckFailureKind = 'usage' | 'auth' | 'network' | 'exit' | 'unknown'

export interface CheckFailure {
  kind: CheckFailureKind
  /** One plain sentence; the raw message stays underneath it in mono. */
  sentence: string
  /** Usage and sign-in failures are the account's: offer another one. */
  switchAccount: boolean
}

const USAGE = /usage limit|rate limit|quota|too many requests|\b429\b|session limit|limit reached|out of (?:extra )?usage/i
const AUTH = /not (?:logged|signed) in|unauthori[sz]ed|authenticat|api key|\b401\b|\b403\b|\blog ?in\b|credential|token expired|forbidden|sign in/i
const NETWORK = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|fetch failed|offline|socket hang up|timed out|timeout|unreachable/i
const EXIT = /exit(?:ed)?(?: with)?(?: code)? (\d+)/i

/** Why a watch or job turn failed, in words the card can say. Order matters: a usage limit often
 *  arrives as an exit code too, and the account is what the user can change. */
export function checkFailureCause(error: string): CheckFailure {
  if (USAGE.test(error)) return { kind: 'usage', sentence: "The agent's account hit its usage limit, so this check did not run.", switchAccount: true }
  if (AUTH.test(error)) return { kind: 'auth', sentence: "The agent's account is not signed in, so this check could not start.", switchAccount: true }
  if (NETWORK.test(error)) return { kind: 'network', sentence: 'The agent could not reach its provider, so this check did not finish.', switchAccount: false }
  const exit = EXIT.exec(error)
  if (exit) return { kind: 'exit', sentence: `The agent's CLI exited with code ${exit[1]} before the check finished.`, switchAccount: false }
  return { kind: 'unknown', sentence: 'This check failed before it finished.', switchAccount: false }
}

/** "the watch check", "the job Nightly", "your message": what the status line says it works on. */
export function turnKindLabel(message: { turn: ManagerTurnKind; jobName?: string | undefined } | undefined): string {
  if (!message) return ''
  if (message.turn === 'watch') return 'the watch check'
  if (message.turn === 'job') return message.jobName ? `the job ${message.jobName}` : 'a job'
  return 'your message'
}

/** The reply a turn is writing right now, if the chat holds it. */
export function streamingReply(messages: readonly ManagerMessage[]): Extract<ManagerMessage, { kind: 'assistant' }> | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.kind === 'assistant' && message.streaming) return message
  }
  return undefined
}

/** "in 9 min", "now", or '' for no or an unreadable instant. */
export function nextCheckLabel(nextCheckAt: string | undefined, now: Date): string {
  if (!nextCheckAt) return ''
  const at = Date.parse(nextCheckAt)
  if (Number.isNaN(at)) return ''
  const minutes = Math.ceil((at - now.getTime()) / 60_000)
  if (minutes <= 0) return 'now'
  if (minutes < 60) return `in ${minutes} min`
  if (minutes < 1440) return `in ${Math.round(minutes / 60)} h`
  return `in ${Math.round(minutes / 1440)} d`
}

/** "write", "read-only" or "mixed" across the projects a manager reaches. */
export function accessSummary(access: readonly ManagerAccess[]): string {
  if (access.length === 0) return ''
  const read = access.filter((entry) => entry === 'read').length
  if (read === 0) return 'write'
  return read === access.length ? 'read-only' : 'mixed'
}

/** The header's sub line: "Watching Alpha, Beta · write · every 15 min · next check in 9 min". */
export function watchingLine(input: {
  names: readonly string[]
  access: readonly ManagerAccess[]
  cronMinutes: number
  nextCheckAt?: string | undefined
  now: Date
}): string {
  const { names, cronMinutes } = input
  const watching = names.length === 0 ? 'Watching nothing yet' : names.length <= 3 ? `Watching ${names.join(', ')}` : `Watching ${names.length} projects`
  const parts = [watching, accessSummary(input.access)]
  if (cronMinutes === 0) parts.push('checks off')
  else {
    parts.push(`every ${cronLabel(cronMinutes)}`)
    const next = nextCheckLabel(input.nextCheckAt, input.now)
    if (next) parts.push(`next check ${next}`)
  }
  return parts.filter(Boolean).join(' · ')
}

/** The rail's footer: "3 managers · 7 projects watched". The summary carries lifetime spend only,
 *  so no "today" figure is claimed. */
export function managerRailSummary(managers: readonly Pick<ManagerSummary, 'connectedProjectIds'>[]): string {
  const projects = new Set(managers.flatMap((manager) => manager.connectedProjectIds)).size
  return `${managers.length} ${managers.length === 1 ? 'manager' : 'managers'} · ${projects} ${projects === 1 ? 'project' : 'projects'} watched`
}

/** "every 15 min", "every 2 hours", "daily": a job's own cadence. */
export function everyLabel(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? 'daily' : `every ${minutes / 1440} days`
  if (minutes % 60 === 0) return minutes === 60 ? 'hourly' : `every ${minutes / 60} hours`
  return `every ${minutes} min`
}

/** Every task the loaded replies carded, newest reply first, once each (the Watching panel's
 *  "Tasks it started"). Only the chat knows: a run record carries no manager origin. */
export function cardedTasks(messages: readonly ManagerMessage[]): Array<{ projectId: string; runId: string }> {
  const seen = new Set<string>()
  const tasks: Array<{ projectId: string; runId: string }> = []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.kind !== 'assistant') continue
    for (const segment of parseManagerText(message.text, message.commands)) {
      if (segment.kind !== 'task' || seen.has(`${segment.projectId}/${segment.runId}`)) continue
      seen.add(`${segment.projectId}/${segment.runId}`)
      tasks.push({ projectId: segment.projectId, runId: segment.runId })
    }
  }
  return tasks
}

export type LastCheckResult = 'reported' | 'quiet' | 'failed'

/** A minute of slack: the check is stamped before the reply it writes. */
const CHECK_SLACK_MS = 60_000

/**
 * What the last check left behind, from the transcript alone: a watch reply at or after it
 * reported (or failed); none, in a transcript that reaches back past it, means it was quiet
 * (spec, Watching: a quiet turn leaves no message). Unknown while older pages could still hold it.
 */
export function lastCheckResult(
  messages: readonly ManagerMessage[],
  lastCheckAt: string | undefined,
  loadedAll: boolean,
): LastCheckResult | undefined {
  if (!lastCheckAt) return undefined
  const since = Date.parse(lastCheckAt) - CHECK_SLACK_MS
  if (Number.isNaN(since)) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    const at = Date.parse(message.at)
    if (Number.isNaN(at) || at < since) break
    if (message.kind === 'assistant' && message.turn === 'watch' && !message.streaming) return message.error ? 'failed' : 'reported'
  }
  const oldest = messages[0] ? Date.parse(messages[0].at) : Number.NaN
  return loadedAll || oldest < since ? 'quiet' : undefined
}
