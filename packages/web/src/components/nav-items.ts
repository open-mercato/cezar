import {
  GitBranchIcon,
  InboxIcon,
  ListChecksIcon,
  SettingsIcon,
  SparklesIcon,
  WorkflowIcon,
  ZapIcon,
  TicketIcon,
} from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'
import type { TrackerKind } from '@open-mercato/cezar-api-client'

import { TRACKER_PROVIDERS } from '@/lib/tracker-providers'
import { GithubIcon } from '@/components/icons'

export type NavItem = {
  /** Where the item navigates. Also its identity — `activeNavPath` returns this. */
  to: string
  label: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
  /** Path prefixes that light this item up. See `activeNavPath` for the longest-prefix rule. */
  match: string[]
  /** Optional trailing status affordance. Rendering/data stay with the shell. */
  badge?: 'inbox-count' | 'skills-update' | 'tasks-unread'
  /** Forge-gated (R6 Step 1.1): the item exists only while `/api/health` reports the forge
   *  driver available — see `visibleNavItems`. */
  forge?: boolean
  /** Inbox-gated (#471): the item exists only while `/api/health` reports
   *  `capabilities.followups` — the global inbox is opt-in via `CEZ_FOLLOWUPS=1`.
   *  See `visibleNavItems`. */
  inbox?: boolean
  /** Automations-gated: the item exists only while `/api/health` reports
   *  `capabilities.automations` — on by default since spec 2026-09-14-automations-redesign,
   *  off for `CEZ_AUTOMATIONS=0`. It no longer carries the forge gate: a scheduled automation
   *  needs no GitHub remote, so a repo without one still gets the page (with the poll kind
   *  disabled there). See `visibleNavItems`. */
  automations?: boolean
  tracker?: boolean
}

/** The sidebar nav from the spec's "App shell & navigation" section, in mockup order.
 *
 *  `match` exists because a nav item is active for a whole *area*, not just its own URL:
 *  the spec requires Tasks to stay active while a task thread (`/tasks/:id`) or a variant
 *  compare (`/compare/:groupId`) is open.
 */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Tasks', icon: ListChecksIcon, match: ['/', '/tasks', '/compare'], badge: 'tasks-unread' },
  { to: '/inbox', label: 'Inbox', icon: InboxIcon, match: ['/inbox'], badge: 'inbox-count', inbox: true },
  { to: '/git', label: 'Git', icon: GitBranchIcon, match: ['/git'] },
  { to: '/github', label: 'GitHub', icon: GithubIcon, match: ['/github'], forge: true },
  { to: '/tracker', label: 'Tracker', icon: TicketIcon, match: ['/tracker'], tracker: true },
  { to: '/automations', label: 'Automations', icon: ZapIcon, match: ['/automations'], automations: true },
  { to: '/skills', label: 'Skills', icon: SparklesIcon, match: ['/skills'], badge: 'skills-update' },
  { to: '/workflows', label: 'Workflows', icon: WorkflowIcon, match: ['/workflows'] },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, match: ['/settings'] },
]

/** What `/api/health` says exists. All default to `false` — see `visibleNavItems`. */
export type NavAvailability = {
  /** `forge.available` (spec §"GitHub tab (forge tab)"). */
  forge?: boolean
  /** `capabilities.followups` — the opt-in global inbox (#471). */
  inbox?: boolean
  /** `capabilities.automations` — automations, default-on (spec 2026-09-14), `CEZ_AUTOMATIONS=0` off. */
  automations?: boolean
  /** Saved local association; its kind supplies the provider label. */
  tracker?: TrackerKind
}

/**
 * The nav items a surface should actually render: a gated item drops out — nav item AND tab —
 * unless the health payload says its feature is there. The forge-gated GitHub item needs the
 * forge driver (spec §"GitHub tab (forge tab)"); the Inbox item needs `capabilities.followups`,
 * which is off unless `CEZ_FOLLOWUPS=1` (#471); the Automations item needs
 * `capabilities.automations` alone (spec 2026-09-14: on by default, and a schedule needs no
 * forge — the page itself disables the poll kind when there is no GitHub remote).
 *
 * Gates are ANDed per item, never ORed, which is what would let one item carry two of them.
 *
 * Everything defaults to absent while health is still unknown, on the shell's honesty rule: the
 * nav must not claim a tab exists before the server has said so (the Tools menu's forge note
 * explains the GitHub absence). Both the sidebar and the ⌘K palette's Views group render through
 * this, so the two can never disagree.
 */
export function visibleNavItems({
  forge = false,
  inbox = false,
  automations = false,
  tracker,
}: NavAvailability = {}): NavItem[] {
  return NAV_ITEMS.filter((item) =>
    (item.forge ? forge : true)
    && (item.inbox ? inbox : true)
    && (item.automations ? automations : true)
    && (item.tracker ? tracker !== undefined : true))
    .map((item) => item.tracker ? { ...item, label: tracker ? TRACKER_PROVIDERS[tracker].label : item.label } : item)
}

/** Does `pathname` sit inside the area rooted at `prefix`?
 *
 *  Segment-aware on purpose: a plain `startsWith` would make `/git` match `/github`, and
 *  would make the `/` root match literally every route.
 */
function inArea(pathname: string, prefix: string): boolean {
  if (prefix === '/') return pathname === '/'
  return pathname === prefix || pathname.startsWith(prefix + '/')
}

/**
 * The `to` of the nav item that owns `pathname`, or null when no item does (e.g. `/new`,
 * which is a full-screen surface with no nav home).
 *
 * Longest matching prefix wins, which is what disambiguates nested areas: the `/` root only
 * matches the exact path (see `inArea`), so every deeper route falls to its own item —
 * `/settings/agents` lights Settings, `/git/commits` lights Git.
 */
export function activeNavPath(pathname: string): string | null {
  let best: { to: string; length: number } | null = null
  for (const item of NAV_ITEMS) {
    for (const prefix of item.match) {
      if (inArea(pathname, prefix) && (best === null || prefix.length > best.length)) {
        best = { to: item.to, length: prefix.length }
      }
    }
  }
  return best?.to ?? null
}

/** The nav item that owns `pathname` — the mobile top bar titles itself from this. */
export function activeNavItem(pathname: string): NavItem | null {
  const to = activeNavPath(pathname)
  return NAV_ITEMS.find((item) => item.to === to) ?? null
}
