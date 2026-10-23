import { ArrowLeftIcon, ChevronDownIcon, ChevronRightIcon, MenuIcon, SlidersHorizontalIcon } from 'lucide-react'
import * as React from 'react'
import {
  Link as RouterLink,
  Navigate,
  NavLink as RouterNavLink,
  useLocation,
  useNavigate,
} from 'react-router'
import type { Capabilities, ProjectListEntry } from '@open-mercato/cezar-api-client'

import { useHealth, useProjects, useStarCount, useWorkspaceConfig } from '@/api/queries'
import { StarChip, VersionChip } from '@/components/app-shell'
import { BrandLockup } from '@/components/brand-mark'
import { CommandPaletteHint } from '@/components/command-palette-hint'
import { SidebarDrawer, SidebarFrame, useSidebarWidth } from '@/components/sidebar-frame'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { Sheet, SheetTrigger } from '@/components/ui/sheet'
import { Link as ScopedLink, NavLink as ScopedNavLink, pathnameProjectId, scopeTo } from '@/lib/project-router'
import { settingsReturnLocation } from '@/lib/settings-return'
import { cn } from '@/lib/utils'
import { ProjectGeneral } from './project-general'
import { ProjectLocationNav } from './project-location'
import { settingsSectionsByScope, type SettingsScope, type SettingsSection } from './registry'

/**
 * The unified, full-screen Settings frame (spec 2026-10-13-unified-settings).
 *
 * ONE frame serves both URL families — project settings at `/p/<id>/settings/…` and global
 * settings at `/settings/global/…` — and renders the SAME navigation at both: the global
 * sections, then a "Project settings" tree with one expandable row per registered project.
 * The URLs (and therefore the scope provider and the store each section writes) are unchanged
 * from the step-3.5 split; only the presentation is unified. See the spec for why the URLs
 * stay.
 *
 * The app shell renders no sidebar, drawer or top bar on a settings URL (`isSettingsPathname`),
 * so this frame supplies everything a page needs on its own: a header with the way back, the
 * breadcrumb, the scope chip, the theme toggle (which lived in the sidebar footer) and, on
 * small screens, a search button; a nav column ending in the ⌘K launcher; and the mobile pill
 * row.
 *
 * Link discipline, unchanged and load-bearing: global links must NOT carry a `/p/<id>` prefix
 * (`/p/<id>/settings/global/appearance` is not a route), so they use the plain react-router
 * components; links into a project's sections are EXPLICITLY scoped with `scopeTo(project.id,
 * …)` — the tree's whole point is linking into a project that is not the active one, exactly
 * as `project-groups.tsx` does.
 */

/** The area's URL root — also what `SettingsSkillsRedirect` and the legacy redirects target. */
export function settingsSectionPath(scope: SettingsScope, id: SettingsSection['id']): string {
  return scope === 'global' ? `/settings/global/${id}` : `/settings/${id}`
}

const GLOBAL_INDEX_PATH = '/settings/global'

function projectSettingsPath(projectId: string, sectionId?: SettingsSection['id']): string {
  const base = `/p/${encodeURIComponent(projectId)}/settings`
  return sectionId === undefined ? base : `${base}/${sectionId}`
}

type CapabilityProps = Partial<Pick<Capabilities, 'singleProject'>>

/** One row of the project tree. `missing` rows render inert (their panes all 409). */
type TreeProject = Pick<ProjectListEntry, 'id' | 'name' | 'status'>

/**
 * What the nav's project tree shows, derived from the registry and the URL:
 *  - the REGISTERED projects, most recently opened first (the sidebar's order, so the two
 *    lists agree) — and nothing else. cezar started from a task worktree is the boot project
 *    but not a registered one (`shouldRegisterProject` skips worktrees on purpose), and the
 *    owner's call is that it is not a project to list;
 *  - the one exception is the page ABOUT such a project (`/p/<unregistered>/settings/…`,
 *    which the legacy `/settings/*` redirect can land on): its own sections still render, as
 *    the flat "This project" group, because a settings page with no way to its sibling
 *    sections is a dead end. It gets no row in the tree on any other page;
 *  - `flat` when there is nothing to choose between: single-project mode, or one project.
 */
function useSettingsTree(capabilities: CapabilityProps | undefined) {
  const { pathname } = useLocation()
  const registry = useProjects().data
  const health = useHealth().data
  const activeProjectId = pathnameProjectId(pathname)
  const bootProjectId = registry?.bootProject ?? health?.bootProject ?? null

  const projects = React.useMemo<TreeProject[]>(() => {
    const listed: TreeProject[] = [...(registry?.projects ?? [])]
      .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
      .map(({ id, name, status }) => ({ id, name, status }))
    if (activeProjectId !== null && !listed.some((project) => project.id === activeProjectId)) {
      // Health's repo facts describe the BOOT project only; any other unknown id (the scope gate
      // lets one through while the registry query is erroring) keeps its raw id as its name.
      const folder =
        activeProjectId === bootProjectId
          ? health?.repo?.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
          : undefined
      listed.unshift({ id: activeProjectId, name: folder || activeProjectId, status: 'ok' })
    }
    return listed
  }, [registry, health, activeProjectId, bootProjectId])

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null
  const registered = activeProject !== null && (registry?.projects ?? []).some((p) => p.id === activeProjectId)
  // Flat when there is one project to show — or when the page is about an UNREGISTERED one:
  // its sections render as "This project" and the registered projects get no rows, so the
  // unregistered one never sits in the list beside them.
  const flat = capabilities?.singleProject === true || projects.length <= 1 || (activeProject !== null && !registered)
  const shown = flat && activeProject !== null && !registered ? [activeProject] : projects
  return { projects: shown, activeProjectId, activeProject, bootProjectId, flat }
}

type SettingsTree = ReturnType<typeof useSettingsTree>

/**
 * `← Back` (and Escape): the last non-settings page the router listener recorded, else the
 * tasks pane of the project in scope. Never `navigate(-1)` — hopping between sections pushes
 * history, and stepping back through every one of them is not "leave settings".
 */
function useLeaveSettings(fallbackProjectId: string | null): () => void {
  const navigate = useNavigate()
  return React.useCallback(() => {
    const recorded = settingsReturnLocation()
    if (recorded !== null) {
      navigate(recorded)
      return
    }
    // A bare `/` is the legacy redirect, which resolves the boot project itself when nothing
    // here can name one.
    navigate(fallbackProjectId === null ? '/' : `/p/${encodeURIComponent(fallbackProjectId)}/`)
  }, [navigate, fallbackProjectId])
}

/** Escape leaves settings — unless something closer owns the key: a form field with focus, or
 *  an open dialog / menu (Radix layers dismiss on Escape, and must get it first). */
function useEscapeToLeave(leave: () => void): void {
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('input, textarea, select, [contenteditable]')) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return
      leave()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [leave])
}

/** The app sidebar's nav row, verbatim (h-[34px], 13.5px, muted → foreground on hover).
 *  `shrink-0` is load-bearing: the rows live in a SCROLLING flex column, and a flex item with a
 *  fixed height still shrinks to its text height when the column overflows — which is exactly
 *  what an open project tree does — so without it every row quietly lost a third of its height
 *  on project pages and the whole nav had to scroll anyway. */
const navRowClass = (active: boolean, touch = false) =>
  cn(
    'flex h-[34px] shrink-0 items-center gap-2.5 rounded-md px-2.5 text-[13.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
    // In the phone drawer every row is a touch target: 44px, the shell's mobile rule.
    touch && 'h-11',
    active && 'bg-muted font-semibold text-foreground',
  )

/** True inside the phone drawer, where the identical content must meet the 44px touch rule
 *  the drawer's own close button follows; false in the desktop column. */
const TouchTargetsContext = React.createContext(false)

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="shrink-0 px-2.5 pt-1 pb-1 text-[10.5px] font-semibold tracking-wide text-soft-foreground uppercase">
      {children}
    </p>
  )
}

/** One project's five section links, explicitly scoped to THAT project. */
function ProjectSectionLinks({
  project,
  sections,
  active,
  activeId,
  indent,
}: {
  project: TreeProject
  sections: SettingsSection[]
  /** Is this the project the URL names? Only then can a section row be current. */
  active: boolean
  activeId: SettingsSection['id'] | null
  indent: boolean
}) {
  const touch = React.useContext(TouchTargetsContext)
  return (
    <div className={cn('flex flex-col gap-0.5', indent && 'mt-0.5 ml-[14px] border-l border-border pl-2')}>
      {/* The project's own index — its General page (folder, registry facts, concurrency,
          Remove; main #772) — first, so every section keeps a way back to it. */}
      <RouterNavLink
        to={projectSettingsPath(project.id)}
        end
        data-slot="settings-project-general"
        data-project={project.id}
        className={cn(navRowClass(active && activeId === null, touch), !touch && 'h-[30px]', 'text-[13px]')}
      >
        <SlidersHorizontalIcon aria-hidden="true" className="size-3.5 shrink-0" />
        General
      </RouterNavLink>
      {sections.map((section) => {
        const current = active && section.id === activeId
        return (
          <RouterNavLink
            key={section.id}
            to={scopeTo(project.id, settingsSectionPath('project', section.id))}
            data-project-section={section.id}
            data-project={project.id}
            className={cn(navRowClass(current, touch), !touch && 'h-[30px]', 'text-[13px]')}
          >
            <section.icon aria-hidden="true" className="size-3.5 shrink-0" />
            {section.title}
          </RouterNavLink>
        )
      })}
    </div>
  )
}

/** The project's name only — no branch: settings describe the repo, not what is checked out. */
function ProjectRowLabel({ project }: { project: TreeProject }) {
  return <span className="truncate">{project.name}</span>
}

/** A registered project whose folder is gone: nothing to expand into — every pane behind it
 *  409s — so an inert row with the pill and, for a screen reader (the `title` of a non-focusable
 *  element is unreachable), the same hint as visually-hidden text. Unregistering lives in Projects. */
function MissingProjectRow({ project, indent }: { project: TreeProject; indent: boolean }) {
  const hint = `${project.name} is gone — remove it in Projects`
  return (
    <div
      data-slot="settings-project"
      data-project={project.id}
      data-status="missing"
      title={hint}
      className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium opacity-55"
    >
      {indent ? <span className="w-3 shrink-0" aria-hidden="true" /> : null}
      <span className="truncate">{project.name}</span>
      <span className="sr-only">{hint}</span>
      <span className="ml-auto shrink-0 rounded-full bg-danger/15 px-[7px] py-px text-[10px] font-medium text-danger">
        folder not found
      </span>
    </div>
  )
}

/**
 * A registered project in the tree: chevron (toggle), name, sections.
 *
 * The name does what the user most plausibly wants next:
 *  - on a PROJECT page (`onProjectPage` — a section, or the project's General index) and this
 *    being another project, it jumps to the SAME place in this project: `openSectionId` when a
 *    section is open, otherwise this project's General. Either way the previous project folds,
 *    because expansion follows the URL's project;
 *  - otherwise it just reveals (or hides) this project's menu — nothing navigates for a click
 *    whose only intent was to see what is under the row.
 */
function ProjectTreeRow({
  project,
  sections,
  activeProjectId,
  activeId,
  openSectionId,
  onProjectPage,
  expanded,
  onToggle,
}: {
  project: TreeProject
  sections: SettingsSection[]
  activeProjectId: string | null
  activeId: SettingsSection['id'] | null
  /** The open section when it is a PROJECT one — the target a name click switches to. */
  openSectionId: SettingsSection['id'] | null
  /** Is the current page about some project (section or General)? Only then does a name click
   *  switch projects; on a global page it just reveals the menu. */
  onProjectPage: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const active = project.id === activeProjectId
  const touch = React.useContext(TouchTargetsContext)
  // Unique per INSTANCE: below `md` the hidden desktop column and the open drawer both render
  // this row, and `aria-controls` must not point at the hidden twin.
  const bodyId = `settings-project-${React.useId()}-${project.id}`
  const switchTo =
    !active && onProjectPage ? projectSettingsPath(project.id, openSectionId ?? undefined) : null

  if (project.status === 'missing') return <MissingProjectRow project={project} indent />

  return (
    <div
      data-slot="settings-project"
      data-project={project.id}
      data-status={project.status}
      data-expanded={expanded ? '' : undefined}
    >
      <div className={cn('flex items-center rounded-md', active && activeId === null && 'bg-muted')}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          // Only while the body is rendered: a reference to an id that is not in the DOM is an
          // a11y error, and a collapsed row has no body.
          aria-controls={expanded ? bodyId : undefined}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${project.name}`}
          className={cn(
            'flex shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            touch ? 'size-11' : 'size-7',
          )}
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={cn('size-3 transition-transform', !expanded && '-rotate-90')}
          />
        </button>
        {switchTo !== null ? (
          <RouterLink
            to={switchTo}
            data-slot="settings-project-link"
            title={`Open ${project.name}'s ${sections.find((s) => s.id === openSectionId)?.title ?? 'General'}`}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground',
              touch && 'min-h-11',
            )}
          >
            <ProjectRowLabel project={project} />
          </RouterLink>
        ) : (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            // Only while the body is rendered: a reference to an id that is not in the DOM is an
          // a11y error, and a collapsed row has no body.
          aria-controls={expanded ? bodyId : undefined}
            data-slot="settings-project-toggle"
            className={cn(
              'flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-[13px] font-semibold transition-colors',
              touch && 'min-h-11',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <ProjectRowLabel project={project} />
          </button>
        )}
      </div>
      {expanded ? (
        <div id={bodyId}>
          <ProjectSectionLinks
            project={project}
            sections={sections}
            active={active}
            activeId={activeId}
            indent
          />
        </div>
      ) : null}
    </div>
  )
}

/**
 * The settings sidebar: the APP sidebar's frame and grammar (264px `bg-sidebar` column, the
 * same header row, row heights and footer), with settings content inside — Back and the brand
 * lockup where the app sidebar has its brand chip, the two labelled groups where it has the
 * nav, and the ⌘K launcher plus theme toggle in the footer where the app sidebar keeps them.
 * Reusing the frame is what makes leaving settings feel like the sidebar came back rather than
 * like a different app.
 */
type SidebarProps = {
  scope: SettingsScope
  activeId: SettingsSection['id'] | null
  capabilities: CapabilityProps | undefined
  tree: SettingsTree
  leave: () => void
}

/** The desktop column: the app sidebar's shared `SidebarFrame` — same width preference, same
 *  drag handle — around the settings content. No title-bar inset: this column renders inside
 *  the main region, which already sits below the desktop shell's title strip. */
function SettingsSidebar(props: SidebarProps) {
  const [width, onWidthChange] = useSidebarWidth()
  return (
    <SidebarFrame slot="settings-sidebar" width={width} onWidthChange={onWidthChange}>
      <SettingsSidebarContent {...props} />
    </SidebarFrame>
  )
}

/**
 * The `<md` frame for the SAME content: an overlay drawer, opened by the hamburger in the
 * settings top bar — the app shell's own drawer pattern (Radix Sheet: dialog role, focus trap,
 * Escape, backdrop dismiss). Without it a phone could not reach the other sections at all:
 * the top bar's Back leaves settings, and the pill row only lists the CURRENT area.
 *
 * Closes on every route change (a picked section must not stay covered by the drawer that
 * picked it) and on widening past `md`, where the real column takes over.
 */
function SettingsMobileDrawer({ onOpenChange, ...props }: SidebarProps & {
  onOpenChange: (open: boolean) => void
}) {
  const { pathname } = useLocation()
  React.useEffect(() => {
    onOpenChange(false)
  }, [pathname, onOpenChange])
  React.useEffect(() => {
    const query = window.matchMedia?.('(min-width: 768px)')
    if (!query) return
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) onOpenChange(false)
    }
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [onOpenChange])
  return (
    <SidebarDrawer slot="settings-mobile-drawer" title="Settings navigation">
      {(closeButton) => <SettingsSidebarContent {...props} headerAction={closeButton} />}
    </SidebarDrawer>
  )
}

/** Everything inside the settings sidebar — framed by `SettingsSidebar` on desktop and by
 *  `SettingsMobileDrawer` below `md`, so the two can never drift apart. */
function SettingsSidebarContent({
  scope,
  activeId,
  capabilities,
  tree,
  leave,
  headerAction,
}: SidebarProps & {
  /** The drawer's close button. Absent on desktop, which has nothing to close. */
  headerAction?: React.ReactNode
}) {
  const { global, project } = settingsSectionsByScope(capabilities)
  const touch = Boolean(headerAction)
  // Expansion is derived from the URL — the active project is open — plus transient toggles.
  // Deliberately not persisted: nothing to configure. The toggles are keyed to the project the
  // URL named when they were made: switching projects reuses this route element, and a fold
  // made on project A's page must not follow the user to project B and back.
  const active = tree.activeProjectId
  const [toggled, setToggled] = React.useState<{ project: string | null; map: Record<string, boolean> }>({
    project: active,
    map: {},
  })
  const map = toggled.project === active ? toggled.map : {}
  const isExpanded = (id: string) => map[id] ?? id === active
  const toggle = (id: string) =>
    setToggled((prev) => {
      const base = prev.project === active ? prev.map : {}
      return { project: active, map: { ...base, [id]: !(base[id] ?? id === active) } }
    })
  const globalActive = scope === 'global'
  const [only] = tree.projects
  const health = useHealth().data
  const version = health?.version ?? null
  const latestVersion = health?.latestVersion ?? null
  const stars = useStarCount().data
  const starCount = stars?.available ? (stars.count ?? null) : null
  // White-label branding (main): the same name and logo the app sidebar's lockup and chips show.
  const branding = useWorkspaceConfig().data?.branding
  const brandName = branding?.name ?? 'cezar'
  const brandLogoUrl = branding?.logoUrl ?? null

  return (
    <TouchTargetsContext.Provider value={touch}>
    <div
      data-slot="settings-sidebar-content"
      className="flex min-h-0 flex-1 flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
    >
      {/* The app sidebar's header row — brand lockup first, exactly where it sits there — with
          Back where the repo chip would be, and the drawer's close button after it. */}
      <div className="flex items-center gap-[9px] px-3.5 pt-3.5 pb-2.5">
        <BrandLockup name={brandName} logoUrl={brandLogoUrl} />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-slot="settings-back"
          title="Back (Esc)"
          onClick={leave}
          // h-[26px]: the brand tile's height. A taller control would grow this row and shift
          // the logo down the moment settings opens — the row must be pixel-identical to the
          // app sidebar's.
          className={cn('-mr-2 ml-auto shrink-0', touch ? 'h-11' : 'h-[26px]')}
        >
          <ArrowLeftIcon aria-hidden="true" className="size-4" />
          Back
        </Button>
        {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
      </div>

      <nav
        aria-label="Settings sections"
        data-slot="settings-nav"
        data-scope={scope}
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2.5 py-1.5"
      >
        <GroupLabel>General settings</GroupLabel>
        {/* No "General" row here: the global index has no content of its own and redirects to
            the first section (spec 2026-10-13-unified-settings). */}
        {global.map((section) => {
          const current = globalActive && section.id === activeId
          return (
            <RouterNavLink
              key={section.id}
              to={settingsSectionPath('global', section.id)}
              data-section={section.id}
              className={navRowClass(current, touch)}
            >
              <section.icon aria-hidden="true" className="size-4 shrink-0" />
              {section.title}
            </RouterNavLink>
          )
        })}
        {/* Global settings are per USER, not per repo — worth saying once, where the choice to
            write there is being made. */}
        <p className="shrink-0 px-2.5 pt-1 pb-2 text-[11px] text-soft-foreground">Stored in ~/.cezar</p>

        {tree.projects.length > 0 ? (
          <div data-slot="settings-project-tree" className="mt-1 flex shrink-0 flex-col gap-0.5 border-t border-border pt-3">
            {tree.flat && only ? (
              <>
                {/* "This project" only when the page IS about it; on a global page the single
                    project is named, since the page is not about any project. */}
                <GroupLabel>{only.id === active ? 'This project' : only.name}</GroupLabel>
                {only.status === 'missing' ? (
                  <MissingProjectRow project={only} indent={false} />
                ) : (
                  <ProjectSectionLinks
                    project={only}
                    sections={project}
                    active={only.id === active}
                    activeId={activeId}
                    indent={false}
                  />
                )}
              </>
            ) : (
              <>
                <GroupLabel>Project settings</GroupLabel>
                {tree.projects.map((entry) => (
                  <ProjectTreeRow
                    key={entry.id}
                    project={entry}
                    sections={project}
                    activeProjectId={tree.activeProjectId}
                    activeId={activeId}
                    openSectionId={scope === 'project' ? activeId : null}
                    onProjectPage={scope === 'project'}
                    expanded={isExpanded(entry.id)}
                    onToggle={() => toggle(entry.id)}
                  />
                ))}
              </>
            )}
          </div>
        ) : null}
        {/* WHICH repo, by its absolute path (main #772) — on a project page only. */}
        {scope === 'project' ? <ProjectLocationNav /> : null}
      </nav>

      {/* The app sidebar's footer, verbatim in shape (#702): the launcher owns line 1, the
          chrome controls line 2. Settings has no other sidebar, so this is what keeps the
          palette findable by click (the chord works regardless) and the theme one tap away. */}
      <div
        data-slot="settings-sidebar-footer"
        className="flex flex-col gap-1.5 border-t border-border px-3.5 py-2.5"
      >
        <CommandPaletteHint />
        <div data-slot="settings-sidebar-footer-controls" className="flex items-center gap-2">
          {/* The app footer's chips, same data: the version (and its update affordance) and the
              star ask. Health is cached by the shell; the star count by its own query. */}
          {version ? <VersionChip version={version} latestVersion={latestVersion} brandName={brandName} /> : null}
          {starCount === null ? null : <StarChip count={starCount} />}
          <ThemeToggle className="ml-auto" />
        </div>
      </div>
    </div>
    </TouchTargetsContext.Provider>
  )
}

/** The mobile stand-in for the nav column: one segmented, scrollable pill row of the CURRENT
 *  area's sections. Project pages lead with the way up to General settings. */
function SectionPills({
  scope,
  activeId,
  capabilities,
}: {
  scope: SettingsScope
  activeId: SettingsSection['id']
  capabilities: CapabilityProps | undefined
}) {
  const sections = settingsSectionsByScope(capabilities)[scope]
  const NavLink = scope === 'global' ? RouterNavLink : ScopedNavLink
  const pillClass = (active: boolean) =>
    cn(
      'rounded-full border px-3 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors',
      active ? 'border-transparent bg-contrast text-contrast-foreground' : 'border-border bg-card text-muted-foreground',
    )
  return (
    <nav
      aria-label="Sections of this area"
      data-slot="settings-nav-mobile"
      className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-border px-3 py-2.5 md:hidden"
    >
      {scope === 'project' ? (
        <>
          <RouterLink to={GLOBAL_INDEX_PATH} data-slot="settings-all-pill" className={pillClass(false)}>
            ‹ General settings
          </RouterLink>
          {/* Never the active pill: the index is a different route, and reaching it from a
              section is the whole reason this entry exists (main #772). Project scope only —
              the global index is a redirect, not a page. */}
          <NavLink to="/settings" end data-slot="settings-nav-index" className={pillClass(false)}>
            General
          </NavLink>
        </>
      ) : null}
      {sections.map((section) => (
        <NavLink
          key={section.id}
          to={settingsSectionPath(scope, section.id)}
          data-section={section.id}
          className={pillClass(section.id === activeId)}
        >
          {section.title}
        </NavLink>
      ))}
    </nav>
  )
}

/** Below `md` the sidebar is a drawer, so the page carries a top bar shaped like the app
 *  shell's: the hamburger that opens the drawer, and the title. Search and the theme toggle
 *  are NOT repeated here — the drawer's footer carries them, as the sidebar footer does on
 *  desktop. A `div`, not a `header`: the density e2e measures the route's first `header`,
 *  which is the page header. */
function MobileBar({ title, projectName }: { title: string; projectName: string | null }) {
  return (
    <div
      data-slot="settings-mobile-bar"
      // The safe-area inset on the OUTER box and the fixed height on an inner row, as the app's
      // MobileTopBar does: on one border-box element the inset would eat into the 52px and
      // leave the 44px menu button a sliver under a notch.
      className="shrink-0 border-b border-border bg-card pt-[env(safe-area-inset-top)] md:hidden"
    >
      <div className="flex h-[52px] items-center gap-1 px-2">
      {/* A real SheetTrigger, as in the app shell: Radix restores focus here on close and
          wires aria-haspopup / aria-expanded / aria-controls. The drawer holds Back. */}
      <SheetTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label="Open settings menu" className="size-11">
          <MenuIcon aria-hidden="true" className="size-[17px]" />
        </Button>
      </SheetTrigger>
      <span className="min-w-0 flex-1">
        <PageTitle title={title} projectName={projectName} as="span" />
      </span>
      </div>
    </div>
  )
}

/** The title as the page and the mobile bar both say it: the section, then — on a project
 *  page — the project it belongs to, muted, right beside it. Not a chip in the far corner (the
 *  old shell's "Global settings" chip was the only precedent, and it read as unrelated to the
 *  title); not a breadcrumb either. Global pages carry no marker: the sidebar's "General
 *  settings" group already says it. */
function PageTitle({ title, projectName, as: Heading }: {
  title: string
  projectName: string | null
  as: 'h1' | 'span'
}) {
  const size = Heading === 'h1' ? 'text-base' : 'text-[14.5px]'
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      {/* Breadcrumb shape, owner's call: `project / view`. The project leads because it is the
          wider context; the view is the page, so it stays the heading. */}
      {projectName ? (
        <>
          <span data-slot="settings-scope-chip" className={cn('truncate font-semibold text-muted-foreground', size)}>
            {projectName}
          </span>
          <span aria-hidden="true" className={cn('shrink-0 font-normal text-soft-foreground', size)}>
            /
          </span>
        </>
      ) : null}
      <Heading className={cn('truncate font-semibold', size)}>{title}</Heading>
    </span>
  )
}

/** The page header: the current page's title (with its project) and one-liner. Desktop only —
 *  below `md` the mobile bar already titles the page, and saying it twice one row apart is what
 *  the first cut did. `h-14` is measured by the density e2e. */
function PageHeader({
  scope,
  section,
  title,
  beside,
}: {
  scope: SettingsScope
  section: SettingsSection | null
  title: string
  beside: string | null
}) {
  return (
    <header
      data-slot="settings-header"
      className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex"
    >
      <PageTitle title={title} projectName={beside} as="h1" />
      {section ? (
        <p className="min-w-0 truncate text-[13px] text-soft-foreground">{section.description}</p>
      ) : scope === 'project' ? (
        <p className="text-[13px] text-soft-foreground">Project settings</p>
      ) : null}
    </header>
  )
}

/** The frame around every settings page: sidebar | (page header, pill row, content). Fills the
 *  shell's scroller so the sidebar stands still while only the page column scrolls. */
function SettingsFrame({
  scope,
  section,
  capabilities,
  routeName,
  children,
}: {
  scope: SettingsScope
  section: SettingsSection | null
  capabilities: CapabilityProps | undefined
  routeName: string
  children: React.ReactNode
}) {
  const tree = useSettingsTree(capabilities)
  const leave = useLeaveSettings(tree.activeProjectId ?? tree.bootProjectId)
  useEscapeToLeave(leave)
  const projectName = tree.activeProject?.name ?? tree.activeProjectId
  const title = section?.title ?? (scope === 'global' ? 'Settings' : projectName ?? 'Settings')
  // On the project INDEX the title IS the project — no second mention beside it.
  const beside = scope === 'project' && section !== null ? projectName : null
  const [menuOpen, setMenuOpen] = React.useState(false)
  const sidebar = { scope, activeId: section?.id ?? null, capabilities, tree, leave }
  return (
    // The Sheet root renders no DOM — it is the context that makes the top bar's hamburger a
    // real SheetTrigger while the open state stays ours to close on navigation.
    <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
      <div data-route={routeName} className="flex h-full min-h-full">
        <SettingsSidebar {...sidebar} />
        <SettingsMobileDrawer {...sidebar} onOpenChange={setMenuOpen} />
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain">
          <MobileBar title={title} projectName={beside} />
          <PageHeader scope={scope} section={section} title={title} beside={beside} />
          {section ? <SectionPills scope={scope} activeId={section.id} capabilities={capabilities} /> : null}
          <div className="flex min-w-0 flex-1 flex-col">{children}</div>
        </div>
      </div>
    </Sheet>
  )
}

/** One registered section inside the frame — `/p/<id>/settings/<id>` or `/settings/global/<id>`. */
export function SettingsSectionRoute({
  section,
  scope,
  capabilities,
}: {
  section: SettingsSection
  scope: SettingsScope
  capabilities?: CapabilityProps
}) {
  const Body = section.component
  return (
    <SettingsFrame
      scope={scope}
      section={section}
      capabilities={capabilities}
      routeName={scope === 'global' ? `settings-global-${section.id}` : `settings-${section.id}`}
    >
      <Body />
    </SettingsFrame>
  )
}

const cardClass =
  'flex items-center gap-3.5 rounded-lg border border-border bg-card p-4 shadow-xs transition-colors hover:bg-card-2'

function SectionCard({ section }: { section: SettingsSection }) {
  return (
    <li>
      <ScopedLink to={settingsSectionPath('project', section.id)} data-section={section.id} className={cardClass}>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
          <section.icon aria-hidden="true" className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{section.title}</span>
          <span className="block text-xs text-soft-foreground">{section.description}</span>
        </span>
        <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-soft-foreground" />
      </ScopedLink>
    </li>
  )
}

/**
 * The area's index. The PROJECT index is a page (main #772): the folder, the registry facts,
 * the concurrency ceiling and Remove, plus — below `md` only — the section cards, since a phone
 * has no sidebar beside them. The GLOBAL index has no content of its own: a card list there
 * only repeated the sidebar, so `/settings/global` redirects to the first section instead,
 * keeping every link to it (footer gear, ⌘K, the project pages' General settings pill) working.
 */
export function SettingsIndexRoute({ scope, capabilities }: {
  scope: SettingsScope
  capabilities?: CapabilityProps
}) {
  const location = useLocation()
  const sections = settingsSectionsByScope(capabilities)[scope]
  if (scope === 'global') {
    // Appearance is never hidden, so the first global section always exists.
    const first = sections[0]!
    return (
      <Navigate
        to={{ pathname: settingsSectionPath('global', first.id), search: location.search, hash: location.hash }}
        replace
      />
    )
  }
  return (
    <SettingsFrame scope={scope} section={null} capabilities={capabilities} routeName="settings">
      <div className="flex min-w-0 flex-1 flex-col p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5">
        <ProjectGeneral capabilities={capabilities} />
        {/* On desktop the sidebar already lists every section; the cards would be the same
            menu twice. */}
        <ul data-slot="settings-index" className="mx-auto mt-7 flex w-full max-w-2xl flex-col gap-2.5 md:hidden">
          {sections.map((section) => (
            <SectionCard key={section.id} section={section} />
          ))}
        </ul>
      </div>
    </SettingsFrame>
  )
}
