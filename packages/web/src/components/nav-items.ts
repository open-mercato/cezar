import {
  GitBranchIcon,
  InboxIcon,
  ListChecksIcon,
  RadarIcon,
  SettingsIcon,
  SparklesIcon,
  WorkflowIcon,
  ZapIcon,
} from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

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
  /** Autopilot-gated (Control Tower): on by default; `CEZ_AUTOPILOT=0` hides it. */
  autopilot?: boolean
}

/** The sidebar nav from the spec's "App shell & navigation" section, in mockup order.
 *
 *  `match` exists because a nav item is active for a whole *area*, not just its own URL:
 *  the spec requires Tasks to stay active while a task thread (`/tasks/:id`) or a variant
 *  compare (`/compare/:groupId`) is open.
 */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Tasks', icon: ListChecksIcon, match: ['/', '/tasks', '/compare'], badge: 'tasks-unread' },
  { to: '/tower', label: 'Tower', icon: RadarIcon, match: ['/tower'], autopilot: true },
  { to: '/inbox', label: 'Inbox', icon: InboxIcon, match: ['/inbox'], badge: 'inbox-count', inbox: true },
  { to: '/git', label: 'Git', icon: GitBranchIcon, match: ['/git'] },
  { to: '/github', label: 'GitHub', icon: GithubIcon, match: ['/github'], forge: true },
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
  /** `capabilities.autopilot` — Control Tower + Self-Heal, default-on. */
  autopilot?: boolean
}

/**
 * The nav items a surface should actually render: a gated item drops out — nav item AND tab —
 * unless the health payload says its feature is there.
 */
export function visibleNavItems({
  forge = false,
  inbox = false,
  automations = false,
  autopilot = false,
}: NavAvailability = {}): NavItem[] {
  return NAV_ITEMS.filter((item) =>
    (item.forge ? forge : true)
    && (item.inbox ? inbox : true)
    && (item.automations ? automations : true)
    && (item.autopilot ? autopilot : true))
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
