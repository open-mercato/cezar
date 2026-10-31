import {
  BellIcon,
  WebhookIcon,
  BookmarkIcon,
  BotIcon,
  FileCogIcon,
  FolderGit2Icon,
  FoldersIcon,
  GaugeIcon,
  IdCardIcon,
  PackageCheckIcon,
  KeyboardIcon,
  ListChecksIcon,
  MessageSquareTextIcon,
  PaletteIcon,
  KeyRoundIcon,
  BlocksIcon,
  TicketIcon,
  ShieldCheckIcon,
} from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

import type { Capabilities } from '@open-mercato/cezar-api-client'
import { AccountsSection } from './accounts-section'
import { AgentConfigSection } from './agent-config-section'
import { AgentsSection } from './agents-section'
import { AppearanceSection } from './appearance'
import { GlobalInstructionsSection } from './global-instructions-section'
import { InstructionsSection } from './instructions-section'
import { KeyboardSection } from './keyboard-section'
import { BookmarkletsSection } from './bookmarklets-section'
import { NotificationsSection } from './notifications-section'
import { PrivacySection } from './privacy-section'
import { ProjectsSection } from './projects-section'
import { ResourcesSection } from './resources-section'
import { SkillsSection } from './skills-section'
import { TasksSection } from './tasks-section'
import { WorktreesSection } from './worktrees-section'
import { TrackerSection } from './tracker-section'
import { ProjectSecretsSection, WorkspaceSecretsSection } from './secrets-section'
import { WebhooksSection } from './webhooks-section'
import { IntegrationsSection } from './integrations-section'

/**
 * The Settings section registry (R6 Step 1.3, spec §"Settings"): the ONE place a section is
 * declared. The shell renders the section nav and the routes from this list, so adding a
 * section later is one entry here — no layout work, no route wiring.
 *
 * Since the multi-project split (step 3.5, spec §"Settings split") every entry also declares
 * its `scope`, and that single field decides everything downstream — which URL the section
 * lives at (`/p/<id>/settings/<id>` vs `/settings/global/<id>`), which nav lists it, and which
 * store it writes. The rule of thumb: does the setting describe THIS REPO (agents, instructions,
 * tasks, worktrees, bookmarklets) or the person/machine (appearance, notifications, host
 * resources, the project registry)?
 *
 * `hidden` sections are declared but not routed and not listed: MCP now lives inside Agent
 * config as a per-agent subsection.
 */

export type SettingsSectionId =
  | 'bookmarklets'
  | 'appearance'
  | 'accounts'
  | 'agents'
  | 'agent-config'
  | 'instructions'
  | 'global-instructions'
  | 'tasks'
  | 'resources'
  | 'worktrees'
  | 'projects'
  | 'notifications'
  | 'keyboard'
  | 'skills'
  | 'tracker'
  | 'secrets'
  | 'integrations'
  | 'webhooks'
  | 'workspace-secrets'
  | 'privacy'

/** Which settings area a section belongs to — and therefore which store it writes. */
export type SettingsScope = 'project' | 'global'

export interface SettingsSection {
  id: SettingsSectionId
  title: string
  /** The one-liner under the title — the shell's desktop header and the index cards share it. */
  description: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
  component: ComponentType
  /** `project` → `/p/<projectId>/settings/<id>`, `global` → `/settings/global/<id>`. */
  scope: SettingsScope
  /** Declared but not yet implemented: no nav entry, no route (the URL is honestly a 404). */
  hidden?: boolean
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  // ---- project scope (`/p/<projectId>/settings/…`) — settings that describe THIS repo -------
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
    id: 'integrations',
    title: 'External integrations',
    description: 'Third-party tools cezar installs and wires into this project — test frameworks first.',
    icon: BlocksIcon,
    component: IntegrationsSection,
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
    id: 'instructions',
    title: 'Instructions',
    description: 'What you write for the models: system prompt, branch naming, prompt templates.',
    icon: MessageSquareTextIcon,
    component: InstructionsSection,
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
  // ---- global scope (`/settings/global/…`) — the user and the machine, in mockup order -----
  {
    id: 'appearance',
    title: 'Appearance',
    description: 'Theme, accent and density.',
    icon: PaletteIcon,
    component: AppearanceSection,
    scope: 'global',
  },
  {
    id: 'notifications',
    title: 'Notifications',
    description: 'Browser notifications when an agent needs you.',
    icon: BellIcon,
    component: NotificationsSection,
    scope: 'global',
  },
  {
    id: 'keyboard',
    title: 'Keyboard',
    description: 'Shortcuts for task commands.',
    icon: KeyboardIcon,
    component: KeyboardSection,
    scope: 'global',
  },
  {
    id: 'resources',
    title: 'Resources',
    description: 'Parallel tasks and per-task memory limit, across every project.',
    icon: GaugeIcon,
    component: ResourcesSection,
    scope: 'global',
  },
  {
    id: 'skills',
    title: 'Skills',
    description: 'Updates for skills installed on this machine.',
    icon: PackageCheckIcon,
    component: SkillsSection,
    scope: 'global',
  },
  {
    id: 'global-instructions',
    title: 'Instructions',
    description: 'A system prompt for every task in every project; a project’s own wins where they conflict.',
    icon: MessageSquareTextIcon,
    component: GlobalInstructionsSection,
    scope: 'global',
  },
  {
    id: 'workspace-secrets',
    title: 'Secrets',
    description: 'Encrypted values shared by every project on this machine — never for agents.',
    icon: KeyRoundIcon,
    component: WorkspaceSecretsSection,
    scope: 'global',
  },
  {
    id: 'accounts',
    title: 'Agent accounts',
    description: 'Second logins, and the agent and models a project uses when it has chosen none.',
    icon: IdCardIcon,
    component: AccountsSection,
    scope: 'global',
  },
  {
    id: 'projects',
    title: 'Projects',
    description: 'The workspace registry and where GitHub checkouts land.',
    icon: FoldersIcon,
    component: ProjectsSection,
    scope: 'global',
  },
  {
    id: 'privacy',
    title: 'Privacy',
    description: 'Whether cezar shares usage data with its maintainers. Off unless you turn it on.',
    icon: ShieldCheckIcon,
    component: PrivacySection,
    scope: 'global',
  },
]

/**
 * What one settings area's nav and route table actually show — hidden sections drop out
 * entirely, and so does everything belonging to the OTHER scope. The two areas are rendered by
 * the same shell, so this filter is the only thing keeping them apart.
 */
export function visibleSettingsSections(
  scope: SettingsScope,
  capabilities?: Partial<Pick<Capabilities, 'singleProject'>>,
): SettingsSection[] {
  return SETTINGS_SECTIONS.filter(
    (section) =>
      !section.hidden &&
      section.scope === scope &&
      !(capabilities?.singleProject === true && section.id === 'projects'),
  )
}

/** Both areas at once — what the unified nav (spec 2026-10-13-unified-settings) renders: the
 *  global sections as flat rows, the project sections under every project in the tree. */
export function settingsSectionsByScope(
  capabilities?: Partial<Pick<Capabilities, 'singleProject'>>,
): Record<SettingsScope, SettingsSection[]> {
  return {
    global: visibleSettingsSections('global', capabilities),
    project: visibleSettingsSections('project', capabilities),
  }
}
