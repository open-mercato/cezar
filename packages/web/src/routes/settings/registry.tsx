import {
  BellIcon,
  WebhookIcon,
  BookmarkIcon,
  BotIcon,
  FileCogIcon,
  FolderGit2Icon,
  FoldersIcon,
  KeyboardIcon,
  ListChecksIcon,
  MessageSquareTextIcon,
  PaletteIcon,
  KeyRoundIcon,
  BlocksIcon,
  TicketIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
} from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

import type { Capabilities } from '@open-mercato/cezar-api-client'
import { AgentConfigSection } from './agent-config-section'
import { AgentsGlobalSection } from './agents-global-section'
import { AgentsSection } from './agents-section'
import { AppearanceSection } from './appearance'
import { BehaviourSection } from './behaviour-section'
import { DataPrivacySection } from './data-privacy-section'
import { InstructionsSection } from './instructions-section'
import { KeyboardSection } from './keyboard-section'
import { BookmarkletsSection } from './bookmarklets-section'
import { NotificationsSection } from './notifications-section'
import { ProjectsSection } from './projects-section'
import { TasksSection } from './tasks-section'
import { WorktreesSection } from './worktrees-section'
import { TrackerSection } from './tracker-section'
import { ProjectSecretsSection } from './secrets-section'
import { WebhooksSection } from './webhooks-section'
import { IntegrationsSection } from './integrations-section'

/**
 * The Settings section registry (R6 Step 1.3, spec §"Settings"): the ONE place a section is
 * declared. The shell renders the nav and the routes from this list, so adding a section is one
 * entry here — no layout work, no route wiring.
 *
 * `scope` decides the URL (`/p/<id>/settings/<id>` vs `/settings/global/<id>`), which nav group
 * lists it and which store it writes. The global area is three groups (design doc, Proposal 8):
 * "You" (the person at the keyboard), "Workspace" (the machine), and the project in view.
 *
 * Pages merged by what the user decides about, not where the value is stored; the ids they
 * replaced stay routed as `redirect` entries so every old link and bookmark still lands.
 */

export type SettingsSectionId =
  | 'bookmarklets'
  | 'appearance'
  | 'accounts'
  | 'agents'
  | 'agent-config'
  | 'behaviour'
  | 'data-privacy'
  | 'instructions'
  | 'global-instructions'
  | 'tasks'
  | 'resources'
  | 'worktrees'
  | 'projects'
  | 'notifications'
  | 'manager'
  | 'keyboard'
  | 'skills'
  | 'tracker'
  | 'secrets'
  | 'integrations'
  | 'webhooks'
  | 'workspace-secrets'
  | 'transfer'
  | 'privacy'

/** Which settings area a section belongs to — and therefore which store it writes. */
export type SettingsScope = 'project' | 'global'

/** The global nav's groups, in rail order. */
export type SettingsGroup = 'you' | 'workspace'

export interface SettingsRedirect {
  to: SettingsSectionId
  /** The card the old page became — appended as `#anchor` unless the link carries its own. */
  hash?: string
}

export interface SettingsSection {
  id: SettingsSectionId
  title: string
  /** The one-liner under the title — the page heading and the index cards share it. */
  description: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
  component: ComponentType
  /** `project` → `/p/<projectId>/settings/<id>`, `global` → `/settings/global/<id>`. */
  scope: SettingsScope
  /** Global sections only: the rail group. */
  group?: SettingsGroup
  /** Declared but not yet implemented: no nav entry, no route (the URL is honestly a 404). */
  hidden?: boolean
  /** A page that merged into another: routed (so its URL keeps working), never listed. */
  redirect?: SettingsRedirect
}

/** A merged page's stand-in — `SettingsSectionRoute` navigates before this could render. */
function Redirected() {
  return null
}

const redirected = (id: SettingsSectionId, title: string, redirect: SettingsRedirect): SettingsSection => ({
  id,
  title,
  description: '',
  icon: BotIcon,
  component: Redirected,
  scope: 'global',
  redirect,
})

export const SETTINGS_SECTIONS: SettingsSection[] = [
  // ---- project scope (`/p/<projectId>/settings/…`) — settings that describe THIS repo -------
  {
    id: 'instructions',
    title: 'Instructions',
    description: 'What you write for the models: system prompt, branch naming, prompt templates.',
    icon: MessageSquareTextIcon,
    component: InstructionsSection,
    scope: 'project',
  },
  {
    id: 'tracker',
    title: 'Issue tracker',
    description: 'Connect this project to Jira or Linear.',
    icon: TicketIcon,
    component: TrackerSection,
    scope: 'project',
  },
  {
    id: 'secrets',
    title: 'Secrets',
    description: 'Encrypted values for this project’s check steps and cezar — never for agents.',
    icon: KeyRoundIcon,
    component: ProjectSecretsSection,
    scope: 'project',
  },
  {
    id: 'webhooks',
    title: 'Webhooks',
    description: 'Send task updates to Slack, Discord or your own endpoint.',
    icon: WebhookIcon,
    component: WebhooksSection,
    scope: 'project',
  },
  {
    id: 'agents',
    title: 'Agents',
    description: 'Providers, default runner and models.',
    icon: BotIcon,
    component: AgentsSection,
    scope: 'project',
  },
  {
    id: 'tasks',
    title: 'Tasks',
    description: 'Development model, landing, required checks, base branch, review, live titles.',
    icon: ListChecksIcon,
    component: TasksSection,
    scope: 'project',
  },
  {
    id: 'agent-config',
    title: 'Agent config',
    description: 'Edit the coding agents’ own config files, per scope.',
    icon: FileCogIcon,
    component: AgentConfigSection,
    scope: 'project',
  },
  {
    id: 'worktrees',
    title: 'Worktrees',
    description: 'How many finished task worktrees this project keeps on disk.',
    icon: FolderGit2Icon,
    component: WorktreesSection,
    scope: 'project',
  },
  {
    id: 'bookmarklets',
    title: 'Bookmarklets',
    description: 'Launch skills from a GitHub PR or issue.',
    icon: BookmarkIcon,
    component: BookmarkletsSection,
    scope: 'project',
  },
  {
    id: 'integrations',
    title: 'External integrations',
    description: 'Third-party tools cezar installs and wires into this project — test frameworks first.',
    icon: BlocksIcon,
    component: IntegrationsSection,
    scope: 'project',
  },
  // ---- global scope (`/settings/global/…`), "You": the person at the keyboard --------------
  {
    id: 'appearance',
    title: 'Appearance',
    description: 'Instance name and logo, theme, density and reading width.',
    icon: PaletteIcon,
    component: AppearanceSection,
    scope: 'global',
    group: 'you',
  },
  {
    id: 'keyboard',
    title: 'Keyboard',
    description: 'Shortcuts for task commands, with their current bindings.',
    icon: KeyboardIcon,
    component: KeyboardSection,
    scope: 'global',
    group: 'you',
  },
  {
    id: 'notifications',
    title: 'Notifications',
    description: 'Browser notifications when an agent needs you.',
    icon: BellIcon,
    component: NotificationsSection,
    scope: 'global',
    group: 'you',
  },
  // ---- "Workspace": the machine and everything shared by its projects ----------------------
  {
    id: 'agents',
    title: 'Agents',
    description:
      'Which coding agents run your tasks, with which logins, models and skills. A project can override any of this in its own Agents page.',
    icon: BotIcon,
    component: AgentsGlobalSection,
    scope: 'global',
    group: 'workspace',
  },
  {
    id: 'behaviour',
    title: 'Behaviour',
    description: 'How hard this machine works, how monitoring wakes up, and which approvals ask you first.',
    icon: SlidersHorizontalIcon,
    component: BehaviourSection,
    scope: 'global',
    group: 'workspace',
  },
  {
    id: 'data-privacy',
    title: 'Data & privacy',
    description: 'Secrets shared by every project, configuration transfer, and what cezar shares with its maintainers.',
    icon: ShieldCheckIcon,
    component: DataPrivacySection,
    scope: 'global',
    group: 'workspace',
  },
  {
    id: 'projects',
    title: 'Projects',
    description: 'The workspace registry and where GitHub checkouts land.',
    icon: FoldersIcon,
    component: ProjectsSection,
    scope: 'global',
    group: 'workspace',
  },
  // ---- merged pages: routed so old links land on the card they became ----------------------
  redirected('manager', 'Manager', { to: 'behaviour', hash: 'manager' }),
  redirected('resources', 'Resources', { to: 'behaviour', hash: 'resources' }),
  redirected('accounts', 'Agent accounts', { to: 'agents', hash: 'accounts' }),
  redirected('skills', 'Skills', { to: 'agents', hash: 'skills' }),
  redirected('global-instructions', 'Instructions', { to: 'agents', hash: 'global-instructions' }),
  redirected('workspace-secrets', 'Secrets', { to: 'data-privacy', hash: 'workspace-secrets' }),
  redirected('transfer', 'Transfer', { to: 'data-privacy', hash: 'transfer' }),
  redirected('privacy', 'Privacy', { to: 'data-privacy', hash: 'privacy' }),
]

/** The old id → new page map, for tests and for anything that links by id. */
export const SETTINGS_REDIRECTS: ReadonlyMap<SettingsSectionId, SettingsRedirect> = new Map(
  SETTINGS_SECTIONS.flatMap((section) => (section.redirect ? [[section.id, section.redirect] as const] : [])),
)

type GateCapabilities = Partial<Pick<Capabilities, 'singleProject' | 'managers'>>

/**
 * What one settings area's ROUTE TABLE shows: hidden sections drop out, and so does everything
 * belonging to the other scope. Redirect entries stay in — a merged page's URL must keep
 * answering — and the nav filters them out again (`settingsSectionsByScope`).
 */
export function visibleSettingsSections(scope: SettingsScope, capabilities?: GateCapabilities): SettingsSection[] {
  return SETTINGS_SECTIONS.filter(
    (section) =>
      !section.hidden &&
      section.scope === scope &&
      !(capabilities?.singleProject === true && section.id === 'projects'),
  )
}

/** Both areas at once — what the nav renders: the global sections in their groups, the project
 *  sections under the project in view. Never a redirect entry. */
export function settingsSectionsByScope(capabilities?: GateCapabilities): Record<SettingsScope, SettingsSection[]> {
  return {
    global: visibleSettingsSections('global', capabilities).filter((section) => !section.redirect),
    project: visibleSettingsSections('project', capabilities).filter((section) => !section.redirect),
  }
}

/** The global sections of one rail group, in registry order. */
export function settingsSectionsInGroup(group: SettingsGroup, capabilities?: GateCapabilities): SettingsSection[] {
  return settingsSectionsByScope(capabilities).global.filter((section) => section.group === group)
}

/** The rail's one-line hint under the project pages — only when some page IS gated away. */
export function projectRailHint(visible: readonly SettingsSection[]): string | null {
  const gated = SETTINGS_SECTIONS.filter(
    (section) =>
      section.scope === 'project' && !section.hidden && !section.redirect && !visible.some((v) => v.id === section.id),
  )
  if (gated.length === 0) return null
  const names = gated.map((section) => section.title)
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${list} ${names.length === 1 ? 'appears' : 'appear'} when the project unlocks ${names.length === 1 ? 'it' : 'them'}`
}
