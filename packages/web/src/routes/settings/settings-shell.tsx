import { ChevronRightIcon } from 'lucide-react'
import { Link as RouterLink, NavLink as RouterNavLink } from 'react-router'
import type { Capabilities } from '@open-mercato/cezar-api-client'
import { Link as ScopedLink, NavLink as ScopedNavLink } from '@/lib/project-router'
import { cn } from '@/lib/utils'
import { visibleSettingsSections, type SettingsScope, type SettingsSection } from './registry'

/**
 * The registry-driven Settings shell (R6 Step 1.3, spec §"Settings").
 *
 * Layout, both driven by the same `visibleSettingsSections(scope)` so they can never disagree:
 *  - desktop (`md:`): a left section nav beside the section's content;
 *  - mobile: a segmented pill row above the content (the area index renders the stacked
 *    section list instead — the drill-in page small screens expect).
 *
 * ONE shell serves both areas since the multi-project split (step 3.5): project settings at
 * `/p/<projectId>/settings/…` and global settings at `/settings/global/…`. The `scope` prop is
 * the whole difference, and it decides two things:
 *  - which sections the nav lists (the registry's `scope` field), and
 *  - how links are built. Project links are project-relative and go through the SCOPED
 *    `project-router` wrappers, which prefix the active `/p/<id>`. Global links must NOT be
 *    prefixed — `/settings/global/*` lives outside every project — so they use the plain
 *    react-router components. Routing a global link through the scoped wrapper would mint
 *    `/p/<id>/settings/global/appearance`, which is not a route.
 *
 * Every section is its own URL, so the h1 is the SECTION title — that is what the page is
 * about; "Settings" is the area. Hidden registry entries are not routed, so their URLs are
 * honest 404s until the section ships.
 */

/** The area's URL root — also what `SettingsSkillsRedirect` and the legacy redirects target. */
export function settingsSectionPath(scope: SettingsScope, id: SettingsSection['id']): string {
  return scope === 'global' ? `/settings/global/${id}` : `/settings/${id}`
}

function settingsIndexPath(scope: SettingsScope): string {
  return scope === 'global' ? '/settings/global' : '/settings'
}

/** Global links bypass the project prefix; project links get it. See the header comment. */
function navComponents(scope: SettingsScope) {
  return scope === 'global'
    ? { Link: RouterLink, NavLink: RouterNavLink }
    : { Link: ScopedLink, NavLink: ScopedNavLink }
}

function SectionNav({
  scope,
  activeId,
  capabilities,
}: {
  scope: SettingsScope
  activeId: SettingsSection['id'] | null
  capabilities?: Pick<Capabilities, 'singleProject'>
}) {
  const { NavLink } = navComponents(scope)
  return (
    <nav
      aria-label="Settings sections"
      data-slot="settings-nav"
      data-scope={scope}
      className="hidden w-52 shrink-0 flex-col gap-1 border-r border-border p-3 md:flex"
    >
      {visibleSettingsSections(scope, capabilities).map((section) => (
        <NavLink
          key={section.id}
          to={settingsSectionPath(scope, section.id)}
          data-section={section.id}
          aria-current={section.id === activeId ? 'page' : undefined}
          className={cn(
            'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors',
            section.id === activeId
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
          )}
        >
          <section.icon aria-hidden="true" className="size-4 shrink-0" />
          {section.title}
        </NavLink>
      ))}
      {/* The mockup's footer label: global settings are per USER, not per repo — worth saying
          once, where the choice to write there is being made. */}
      {scope === 'global' ? (
        <p className="mt-auto px-2.5 pt-3 text-[11px] text-soft-foreground">Stored in ~/.cezar</p>
      ) : null}
    </nav>
  )
}

/** The mobile stand-in for the left nav: one segmented, scrollable pill row. */
function SectionPills({
  scope,
  activeId,
  capabilities,
}: {
  scope: SettingsScope
  activeId: SettingsSection['id']
  capabilities?: Pick<Capabilities, 'singleProject'>
}) {
  const { NavLink } = navComponents(scope)
  return (
    <nav
      aria-label="Settings sections"
      data-slot="settings-nav-mobile"
      className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-border px-3 py-2.5 md:hidden"
    >
      {visibleSettingsSections(scope, capabilities).map((section) => (
        <NavLink
          key={section.id}
          to={settingsSectionPath(scope, section.id)}
          data-section={section.id}
          aria-current={section.id === activeId ? 'page' : undefined}
          className={cn(
            'rounded-full border px-3 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors',
            section.id === activeId
              ? 'border-transparent bg-contrast text-contrast-foreground'
              : 'border-border bg-card text-muted-foreground',
          )}
        >
          {section.title}
        </NavLink>
      ))}
    </nav>
  )
}

/** One registered section inside the shell — `/p/<id>/settings/<id>` or `/settings/global/<id>`. */
export function SettingsSectionRoute({
  section,
  scope,
  capabilities,
}: {
  section: SettingsSection
  scope: SettingsScope
  capabilities?: Pick<Capabilities, 'singleProject'>
}) {
  const Body = section.component
  return (
    <div
      data-route={scope === 'global' ? `settings-global-${section.id}` : `settings-${section.id}`}
      className="flex min-h-full flex-col"
    >
      {/* Desktop header — below `md` the shell's top bar already says "Settings". The
          breadcrumb is what tells the two areas apart at a glance (mockup: "Global settings"). */}
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">{section.title}</h1>
        <p className="text-[13px] text-soft-foreground">{section.description}</p>
        {scope === 'global' ? (
          <span data-slot="settings-scope-chip" className="ml-auto text-[11px] text-soft-foreground">
            Global settings
          </span>
        ) : null}
      </header>
      <div className="flex flex-1 flex-col md:flex-row">
        <SectionNav scope={scope} activeId={section.id} capabilities={capabilities} />
        <SectionPills scope={scope} activeId={section.id} capabilities={capabilities} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Body />
        </div>
      </div>
    </div>
  )
}

/** The area's index: the same registry rendered as a stacked list of cards (the mobile drill-in
 *  page; on desktop it sits beside the nav as a plain directory). */
export function SettingsIndexRoute({ scope, capabilities }: {
  scope: SettingsScope
  capabilities?: Pick<Capabilities, 'singleProject'>
}) {
  const { Link } = navComponents(scope)
  const global = scope === 'global'
  return (
    <div data-route={global ? 'settings-global' : 'settings'} className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">{global ? 'Global settings' : 'Settings'}</h1>
        <p className="text-[13px] text-soft-foreground">
          {global
            ? 'Preferences for you and this machine, shared by every project.'
            : 'Configure this project and its agents.'}
        </p>
      </header>
      <div className="flex flex-1 flex-col md:flex-row">
        <SectionNav scope={scope} activeId={null} capabilities={capabilities} />
        {/* No second h1 for small screens: the app shell's mobile top bar already titles the
            page "Settings" from the nav registry. */}
        <div className="flex min-w-0 flex-1 flex-col p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5">
          <ul data-slot="settings-index" className="mx-auto flex w-full max-w-2xl flex-col gap-2.5">
            {visibleSettingsSections(scope, capabilities).map((section) => (
              <li key={section.id}>
                <Link
                  to={settingsSectionPath(scope, section.id)}
                  data-section={section.id}
                  className="flex items-center gap-3.5 rounded-lg border border-border bg-card p-4 shadow-xs transition-colors hover:bg-card-2"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
                    <section.icon aria-hidden="true" className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">{section.title}</span>
                    <span className="block text-xs text-soft-foreground">{section.description}</span>
                  </span>
                  <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-soft-foreground" />
                </Link>
              </li>
            ))}
          </ul>
          {/* The cross-link between the two areas, both ways: the split is only discoverable if
              each half says where the other one is. */}
          <p className="mx-auto mt-4 w-full max-w-2xl text-[12px] text-soft-foreground">
            {global ? (
              <>Agents, worktrees, bookmarklets and prompt templates are per project.</>
            ) : (
              <>
                Appearance, notifications, host resources and the project registry live in{' '}
                <RouterLink
                  to={settingsIndexPath('global')}
                  data-slot="settings-global-link"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Global settings
                </RouterLink>
                .
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  )
}
