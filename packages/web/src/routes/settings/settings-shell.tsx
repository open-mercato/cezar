import { ArrowUpRightIcon, ChevronRightIcon, SlidersHorizontalIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link as RouterLink, NavLink as RouterNavLink } from 'react-router'
import type { Capabilities } from '@open-mercato/cezar-api-client'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemSeparator, ItemTitle } from '@/components/ui/item'
import { Card } from '@/components/ui/card'
import { Link as ScopedLink, NavLink as ScopedNavLink } from '@/lib/project-router'
import { cn } from '@/lib/utils'
import { ProjectGeneral } from './project-general'
import { ProjectLocationNav } from './project-location'
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
 *
 * Both navs lead with a "General" entry pointing at the area INDEX. It is not a registry section
 * — it has no settings of its own — but without it the index is a page you can only reach by
 * arriving: every section links to its siblings and none links back, so the project folder and
 * the cross-link to the other area became unreachable the moment a user clicked anything.
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

/** Sections whose content is a work surface (an editor, a wide table) rather than a form. */
const WIDE_SECTIONS: ReadonlySet<SettingsSection['id']> = new Set(['agent-config', 'projects'])

const navItemClass = (active: boolean) =>
  cn(
    'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13.5px] transition-colors',
    active
      ? 'bg-muted font-medium text-foreground'
      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
  )

function SectionNav({
  scope,
  activeId,
  capabilities,
}: {
  scope: SettingsScope
  activeId: SettingsSection['id'] | null
  capabilities?: Partial<Pick<Capabilities, 'singleProject'>>
}) {
  const { NavLink } = navComponents(scope)
  return (
    <nav
      aria-label="Settings sections"
      data-slot="settings-nav"
      data-scope={scope}
      className="sticky top-0 hidden max-h-[calc(100dvh-3rem)] w-52 shrink-0 flex-col gap-0.5 self-start overflow-y-auto py-8 md:flex"
    >
      <p className="px-2.5 pb-2 text-xs font-medium text-soft-foreground">
        {scope === 'global' ? 'Global settings' : 'Project settings'}
      </p>
      <NavLink
        to={settingsIndexPath(scope)}
        end
        data-slot="settings-nav-index"
        aria-current={activeId === null ? 'page' : undefined}
        className={navItemClass(activeId === null)}
      >
        <SlidersHorizontalIcon aria-hidden="true" className="size-4 shrink-0" />
        General
      </NavLink>
      {visibleSettingsSections(scope, capabilities).map((section) => (
        <NavLink
          key={section.id}
          to={settingsSectionPath(scope, section.id)}
          data-section={section.id}
          aria-current={section.id === activeId ? 'page' : undefined}
          className={navItemClass(section.id === activeId)}
        >
          <section.icon aria-hidden="true" className="size-4 shrink-0" />
          {section.title}
        </NavLink>
      ))}
      {/* The nav footer answers "what am I editing?" — and each area answers it differently.
          Global: settings are per USER, not per repo, said once where the choice to write there
          is being made. Project: WHICH repo, by its absolute path on disk. */}
      <div className="mt-6 border-t border-border pt-4">
        {scope === 'global' ? (
          <p className="px-2.5 text-xs text-soft-foreground">Stored in ~/.cezar</p>
        ) : (
          <>
            <RouterLink
              to={settingsIndexPath('global')}
              className="mb-3 flex h-8 items-center gap-2 rounded-md px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              Global settings
              <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
            </RouterLink>
            <ProjectLocationNav />
          </>
        )}
      </div>
    </nav>
  )
}

/** The mobile stand-in for the left nav: one quiet, scrollable pill row. */
function SectionPills({
  scope,
  activeId,
  capabilities,
}: {
  scope: SettingsScope
  activeId: SettingsSection['id'] | null
  capabilities?: Partial<Pick<Capabilities, 'singleProject'>>
}) {
  const { NavLink } = navComponents(scope)
  const pill = (active: boolean) =>
    cn(
      'flex h-8 shrink-0 items-center rounded-full px-3 text-[13px] font-medium whitespace-nowrap transition-colors',
      active ? 'bg-contrast text-contrast-foreground' : 'bg-muted text-muted-foreground',
    )
  return (
    <nav
      aria-label="Settings sections"
      data-slot="settings-nav-mobile"
      className="-mx-4 flex shrink-0 gap-1.5 overflow-x-auto px-4 pt-4 [scrollbar-width:none] sm:-mx-6 sm:px-6 md:hidden"
    >
      {/* The index is a different route; reaching it from a section is why this entry exists. */}
      <NavLink to={settingsIndexPath(scope)} end data-slot="settings-nav-index" className={pill(activeId === null)}>
        General
      </NavLink>
      {visibleSettingsSections(scope, capabilities).map((section) => (
        <NavLink
          key={section.id}
          to={settingsSectionPath(scope, section.id)}
          data-section={section.id}
          aria-current={section.id === activeId ? 'page' : undefined}
          className={pill(section.id === activeId)}
        >
          {section.title}
        </NavLink>
      ))}
    </nav>
  )
}

/** The frame both routes share: nav on the left, one comfortable column on the right. */
function SettingsFrame({
  route,
  scope,
  activeId,
  capabilities,
  title,
  description,
  wide = false,
  children,
}: {
  route: string
  scope: SettingsScope
  activeId: SettingsSection['id'] | null
  capabilities?: Partial<Pick<Capabilities, 'singleProject'>>
  title: ReactNode
  description: ReactNode
  wide?: boolean
  children: ReactNode
}) {
  return (
    <div
      data-route={route}
      className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-4 sm:px-6 md:flex-row md:gap-10 lg:px-8"
    >
      <SectionNav scope={scope} activeId={activeId} capabilities={capabilities} />
      <SectionPills scope={scope} activeId={activeId} capabilities={capabilities} />
      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col pt-6 pb-[calc(2.5rem+env(safe-area-inset-bottom))] md:pt-8',
          wide ? null : 'max-w-3xl',
        )}
      >
        <header data-slot="page-header" className="space-y-1 pb-6">
          <h1 className="text-[22px] leading-7 font-semibold text-foreground">{title}</h1>
          <p className="max-w-2xl text-sm text-pretty text-muted-foreground">{description}</p>
        </header>
        {children}
      </div>
    </div>
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
  capabilities?: Partial<Pick<Capabilities, 'singleProject'>>
}) {
  const Body = section.component
  return (
    <SettingsFrame
      route={scope === 'global' ? `settings-global-${section.id}` : `settings-${section.id}`}
      scope={scope}
      activeId={section.id}
      capabilities={capabilities}
      title={section.title}
      description={section.description}
      wide={WIDE_SECTIONS.has(section.id)}
    >
      <Body />
    </SettingsFrame>
  )
}

/** The area's index. Project: the General page (folder, facts, limits, danger zone). Global: a
 *  directory of the sections. On small screens both also list the sections — there is no nav. */
export function SettingsIndexRoute({ scope, capabilities }: {
  scope: SettingsScope
  capabilities?: Partial<Pick<Capabilities, 'singleProject'>>
}) {
  const { Link } = navComponents(scope)
  const global = scope === 'global'
  const sections = visibleSettingsSections(scope, capabilities)
  return (
    <SettingsFrame
      route={global ? 'settings-global' : 'settings'}
      scope={scope}
      activeId={null}
      capabilities={capabilities}
      title={global ? 'Global settings' : 'General'}
      description={
        global
          ? 'Preferences for you and this machine, shared by every project.'
          : 'What this project is, where it lives and how hard it may push the machine.'
      }
    >
      <div className="flex flex-col gap-8">
        {/* `capabilities` travels because the registry half of that page is exactly what
            single-project mode disables, the same gate `visibleSettingsSections` applies. */}
        {global ? null : <ProjectGeneral capabilities={capabilities} />}
        {/* On desktop the left nav already lists every section, so in the project area the
            directory would be the same menu twice. Small screens have no nav — there it IS it. */}
        <Card flush data-slot="settings-index" className={cn(global ? null : 'md:hidden')}>
          <ItemGroup>
            {sections.map((section, index) => (
              <div key={section.id}>
                {index > 0 ? <ItemSeparator /> : null}
                <Item asChild size="sm" className="rounded-none">
                  <Link to={settingsSectionPath(scope, section.id)} data-section={section.id}>
                    <ItemMedia variant="icon">
                      <section.icon aria-hidden="true" />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{section.title}</ItemTitle>
                      <ItemDescription>{section.description}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <ChevronRightIcon aria-hidden="true" className="size-4 text-soft-foreground" />
                    </ItemActions>
                  </Link>
                </Item>
              </div>
            ))}
          </ItemGroup>
        </Card>
        {/* The cross-link between the two areas, both ways: the split is only discoverable if
            each half says where the other one is. */}
        <p className="text-[13px] text-muted-foreground">
          {global ? (
            <>Agents, worktrees, bookmarklets and prompt templates are per project.</>
          ) : (
            <>
              Appearance, notifications, host resources and the project registry live in{' '}
              <RouterLink
                to={settingsIndexPath('global')}
                data-slot="settings-global-link"
                className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
              >
                Global settings
              </RouterLink>
              .
            </>
          )}
        </p>
      </div>
    </SettingsFrame>
  )
}
