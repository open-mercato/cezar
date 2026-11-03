import type { HealthResponse, ProviderId, ProviderStatusResponse, RunRecord, WorkspaceUiState } from '@open-mercato/cezar-api-client'

import { isAwaitingAnswer, isNeedsYouStatus } from '@/lib/attention'
import { PROVIDER_LABELS } from '@/lib/provider-auth-alert'

/**
 * First-run onboarding (spec 2026-10-26-first-run-onboarding). Every step is DERIVED from state the
 * server already reports; only "the user hid the setup row" is stored (workspace ui-state).
 */

export type SetupStepId = 'worktrees' | 'github'

export interface SetupStep {
  id: SetupStepId
  label: string
  description: string
  action: string
  /** Project-scoped path the step opens. */
  to: string
}

/** Agent CLIs that can run a task right now: signed in and not switched off in Settings. */
export function signedInProviders(status: ProviderStatusResponse | undefined): ProviderId[] {
  return (status?.providers ?? [])
    .filter((row) => row.status === 'connected' && row.enabled !== false)
    .map((row) => row.provider)
}

/** `undefined` while the status is unknown — the first-run screen must not flash the blocking
 *  "sign in" state before the answer arrives. */
export function hasSignedInAgent(status: ProviderStatusResponse | undefined): boolean | undefined {
  if (status === undefined) return undefined
  return signedInProviders(status).length > 0
}

/** The optional setup still worth doing, in the order the chips show it. */
export function pendingSetupSteps(input: {
  /** `undefined` while the project config is loading — not shown until known. */
  worktreeSetupConfigured: boolean | undefined
  forge: HealthResponse['forge'] | undefined
}): SetupStep[] {
  const steps: SetupStep[] = []
  if (input.worktreeSetupConfigured === false) {
    steps.push({ id: 'worktrees', label: 'Prepare worktrees', description: 'Install dependencies and copy env files into every task worktree.', action: 'Set up', to: '/settings/worktrees' })
  }
  // Only a GitHub-hosted project needs `gh`, and only a probe that has answered says it is missing.
  if (input.forge?.available === false) {
    steps.push({ id: 'github', label: 'Connect GitHub', description: 'Pull requests and issues need the GitHub CLI.', action: 'Connect', to: '/github' })
  }
  return steps
}

const SETUP_COMMANDS: Partial<Record<ProviderId, { install: string; login: string }>> = {
  claude: { install: 'npm i -g @anthropic-ai/claude-code', login: 'claude' },
  codex: { install: 'npm i -g @openai/codex', login: 'codex login' },
}

export interface AgentSetupRow {
  provider: ProviderId
  label: string
  /** `missing` = the CLI is not installed; `signed-out` = installed, not logged in. */
  state: 'missing' | 'signed-out'
  /** The one command that gets it running: install when missing, login when signed out. */
  command: string
  /** The login command, for the step after an install. */
  login: string
}

/** The two most common agents, each with the ONE command that gets it running: an install when
 *  the CLI is missing, a login when it is installed but signed out. */
export function agentSetupRows(status: ProviderStatusResponse | undefined): AgentSetupRow[] {
  const byProvider = new Map((status?.providers ?? []).map((row) => [row.provider, row]))
  return (Object.keys(SETUP_COMMANDS) as ProviderId[]).flatMap((provider) => {
    const commands = SETUP_COMMANDS[provider]
    if (!commands) return []
    const row = byProvider.get(provider)
    if (row?.status === 'connected' || row?.enabled === false) return []
    const signedOut = row?.status === 'disconnected'
    return [{ provider, label: PROVIDER_LABELS[provider], state: signedOut ? 'signed-out' : 'missing', command: signedOut ? commands.login : commands.install, login: commands.login }]
  })
}

export type FeaturePreviewId = 'tabs' | 'palette' | 'design' | 'scripts' | 'workflow' | 'automations'

export interface Announcement {
  /** Stable id; a dismissed id never shows again. Name a new one for a new feature. */
  id: string
  title: string
  description: string
  /** The day the feature shipped (YYYY-MM-DD). "New since your last visit" compares against it. */
  releasedAt: string
  /** The miniature "What's new" draws for it. */
  preview: FeaturePreviewId
  /** Where the feature lives — a nav path. Its sidebar item carries a "new" dot until visited. */
  to?: string
  /** The button that opens `to`. */
  action?: string
  /** The big card on the welcome page: its button opens the composer with `task`. */
  hero?: { action: string; task: string }
  needs?: 'designMode' | 'automations'
}

/** Newest first. Every entry is a feature that shipped on `main`, dated by its merge. */
const ANNOUNCEMENTS: readonly Announcement[] = [
  {
    id: 'task-tabs-2026-10',
    preview: 'tabs',
    title: 'Task tabs and layouts',
    description: 'Chat, Changes, Preview and Terminal as tabs in every task. Save a layout by name.',
    releasedAt: '2026-10-19',
  },
  {
    id: 'task-palette-2026-10',
    preview: 'palette',
    title: 'Task palette',
    description: 'Press ⌘P in a task to act on it or jump to another one.',
    releasedAt: '2026-10-18',
  },
  {
    id: 'design-mode-2026-10',
    preview: 'design',
    title: 'Design Mode',
    description: 'Point at any element of your running app and tell the agent what to change.',
    releasedAt: '2026-10-17',
    hero: { action: 'Try it', task: 'Start the app’s dev server so I can review it in Preview.' },
    needs: 'designMode',
  },
  {
    id: 'worktree-scripts-2026-10',
    preview: 'scripts',
    action: 'Set up scripts',
    title: 'Worktree scripts',
    description: 'Install dependencies and copy env files into every new task worktree.',
    releasedAt: '2026-10-17',
    to: '/settings/worktrees',
  },
  {
    id: 'workflow-editor-2026-10',
    preview: 'workflow',
    action: 'Open Workflows',
    title: 'Workflow editor',
    description: 'Build a workflow as a graph of steps and run it on a task.',
    releasedAt: '2026-10-08',
    to: '/workflows',
  },
  {
    id: 'automations-2026-09',
    preview: 'automations',
    action: 'Open Automations',
    title: 'Automations',
    description: 'Start tasks on a schedule or from GitHub events, written as a prompt.',
    releasedAt: '2026-09-15',
    to: '/automations',
    needs: 'automations',
  },
]

export interface Capabilities {
  designMode: boolean | undefined
  automations?: boolean | undefined
}

function offered(entry: Announcement, capabilities: Capabilities): boolean {
  if (entry.needs === 'designMode') return capabilities.designMode === true
  if (entry.needs === 'automations') return capabilities.automations === true
  return true
}

/** The big card on the welcome page: the newest hero announcement the user has not closed. */
export function currentAnnouncement(input: {
  dismissed: readonly string[] | undefined
  designMode: boolean | undefined
}): (Announcement & { hero: NonNullable<Announcement['hero']> }) | null {
  const closed = new Set(input.dismissed ?? [])
  const next = ANNOUNCEMENTS.find((entry) => entry.hero && !closed.has(entry.id) && offered(entry, input))
  return next?.hero ? { ...next, hero: next.hero } : null
}

// ---- Coming back after a while ------------------------------------------------------------------

const DAY_MS = 86_400_000
/** Away this long, and the tasks page says what happened meanwhile. */
export const RETURNING_AFTER_DAYS = 14
/** The welcome-back card stays this long after the return, unless closed. */
const WELCOME_BACK_DAYS = 3
/** A visit stamp is written at most this often. */
const VISIT_WRITE_MS = 3_600_000
/** A feature stops wearing its sidebar dot this long after it shipped, visited or not. */
const NEW_DOT_DAYS = 60

type Onboarding = NonNullable<WorkspaceUiState['onboarding']>

function time(iso: string | undefined): number | null {
  if (!iso) return null
  const at = new Date(iso).getTime()
  return Number.isNaN(at) ? null : at
}

/** What to write for this page load, or null when nothing changes. A visit after
 *  `RETURNING_AFTER_DAYS` also records where the user came back from. */
export function visitPatch(onboarding: Onboarding | undefined, now: number): Partial<Onboarding> | null {
  const stamp = new Date(now).toISOString()
  const last = time(onboarding?.lastVisitAt)
  if (last === null) return { firstVisitAt: onboarding?.firstVisitAt ?? stamp, lastVisitAt: stamp }
  if (now - last < VISIT_WRITE_MS) return null
  if (now - last < RETURNING_AFTER_DAYS * DAY_MS) return { lastVisitAt: stamp }
  return { lastVisitAt: stamp, returnedFrom: onboarding?.lastVisitAt, returnedAt: stamp }
}

/** The welcome-back card: shown for a few days after a return, until closed. */
export function welcomeBackSince(onboarding: Onboarding | undefined, now: number): string | null {
  const returnedAt = time(onboarding?.returnedAt)
  const from = onboarding?.returnedFrom
  if (returnedAt === null || time(from) === null || !from) return null
  if (now - returnedAt > WELCOME_BACK_DAYS * DAY_MS) return null
  const closed = time(onboarding?.welcomeBackClosedAt)
  return closed !== null && closed >= returnedAt ? null : from
}

/** Features that shipped after `since`, newest first. */
export function announcementsSince(since: string, capabilities: Capabilities): Announcement[] {
  const from = time(since) ?? Number.POSITIVE_INFINITY
  return ANNOUNCEMENTS.filter((entry) => (time(entry.releasedAt) ?? 0) > from && offered(entry, capabilities))
}

/** Sidebar paths that carry a "new" dot: a feature that shipped after the user started, that they
 *  have not opened, and that is still recent. Never on a first visit — everything is new then. */
export function newFeaturePaths(onboarding: Onboarding | undefined, capabilities: Capabilities, now: number): Map<string, string> {
  const started = time(onboarding?.firstVisitAt)
  const paths = new Map<string, string>()
  if (started === null) return paths
  const seen = new Set(onboarding?.dismissedAnnouncements ?? [])
  for (const entry of ANNOUNCEMENTS) {
    const released = time(entry.releasedAt)
    if (!entry.to || released === null || seen.has(entry.id) || !offered(entry, capabilities)) continue
    if (released <= started || now - released > NEW_DOT_DAYS * DAY_MS) continue
    if (!paths.has(entry.to)) paths.set(entry.to, entry.id)
  }
  return paths
}

/** Whether a nav item (its `to`) owns a feature path: `/settings` owns `/settings/worktrees`. */
export function navOwnsPath(navTo: string, path: string): boolean {
  return navTo !== '/' && (path === navTo || path.startsWith(`${navTo}/`))
}

/** Tasks that wait on the user, most recently touched first. */
export function tasksNeedingYou(runs: readonly RunRecord[]): RunRecord[] {
  const touched = (run: RunRecord) => time(run.finishedAt) ?? time(run.startedAt) ?? time(run.createdAt) ?? 0
  return runs.filter((run) => !run.archived && isNeedsYouStatus(run)).sort((a, b) => touched(b) - touched(a))
}

/**
 * The one sentence under "Welcome back": what is ready for the user and what is new, said as good
 * news — never how long they were gone. Null when there is nothing to say, and then no card shows.
 */
export function welcomeBackSentence(
  waiting: ReadonlyArray<Pick<RunRecord, 'status' | 'awaitingAnswerSince' | 'worktreeLifecycle'>>,
  newFeatures: number,
): string | null {
  const first = waiting[0]
  const tasks = !first
    ? null
    : waiting.length > 1
      ? `${waiting.length} tasks are waiting for you`
      : first.status === 'review'
        ? 'One task is ready for your review'
        : first.status === 'waiting' || isAwaitingAnswer(first)
          ? 'One task is waiting for your answer'
          : 'One task needs a look'
  const news = newFeatures === 0 ? null : newFeatures === 1 ? 'there is a new feature to try' : `there are ${newFeatures} new features to try`
  if (tasks && news) return `${tasks}, and ${news}.`
  if (tasks) return `${tasks}.`
  if (news) return `${news.charAt(0).toUpperCase()}${news.slice(1)}.`
  return null
}

/** How far back the sidebar's "What's new" reaches. */
const WHATS_NEW_DAYS = 90

/** Everything "What's new" lists from the sidebar: recent, offered, newest first. */
export function recentAnnouncements(capabilities: Capabilities, now: number): Announcement[] {
  return ANNOUNCEMENTS.filter((entry) => {
    const released = time(entry.releasedAt)
    return released !== null && now - released <= WHATS_NEW_DAYS * DAY_MS && offered(entry, capabilities)
  })
}

/** The dot on the sidebar's "What's new": something shipped after the user started and after they
 *  last opened it. Never on a first visit. */
export function whatsNewHasUnseen(onboarding: Onboarding | undefined, capabilities: Capabilities, now: number): boolean {
  const started = time(onboarding?.firstVisitAt)
  if (started === null) return false
  const since = Math.max(started, time(onboarding?.whatsNewSeenAt) ?? 0)
  return recentAnnouncements(capabilities, now).some((entry) => (time(entry.releasedAt) ?? 0) > since)
}
