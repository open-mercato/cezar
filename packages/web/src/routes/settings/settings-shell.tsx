import { ArrowLeftIcon, CheckIcon, ChevronRightIcon, ChevronsUpDownIcon, MenuIcon, SlidersHorizontalIcon } from 'lucide-react'
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
import { StatusDot } from '@/components/status-dot'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetTrigger } from '@/components/ui/sheet'
import { Link as ScopedLink, NavLink as ScopedNavLink, pathnameProjectId, scopeTo } from '@/lib/project-router'
import { settingsReturnLocation } from '@/lib/settings-return'
import { cn } from '@/lib/utils'
import { ProjectGeneral } from './project-general'
import { ProjectLocationNav } from './project-location'
import {
  projectRailHint,
  settingsSectionsByScope,
  settingsSectionsInGroup,
  type SettingsScope,
  type SettingsSection,
} from './registry'

/**
 * The unified, full-screen Settings frame (spec 2026-10-13-unified-settings; design doc
 * Proposal 8 "fewer pages, one project at a time").
 *
 * ONE frame serves both URL families — project settings at `/p/<id>/settings/…` and global
 * settings at `/settings/global/…` — with the SAME rail at both: three groups. "You" and
 * "Workspace" are the global sections; "Project" is a switcher naming ONE project followed by
 * that project's pages. The rail no longer lists every registered project as a tree — switching
 * projects is a picker, exactly as the app sidebar does it.
 *
 * The URLs (and therefore the scope provider and the store each section writes) are unchanged
 * from the step-3.5 split; only the presentation moved.
 *
 * Link discipline, unchanged and load-bearing: global links must NOT carry a `/p/<id>` prefix
 * (`/p/<id>/settings/global/appearance` is not a route), so they use the plain react-router
 * components; links into a project's sections are EXPLICITLY scoped with `scopeTo(project.id,
 * …)` — the switcher's whole point is linking into a project that is not the active one.
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

type CapabilityProps = Partial<Pick<Capabilities, 'singleProject' | 'managers' | 'webhooks' | 'webhooksUnavailableReason'>>

/** One project the rail can name. `missing` ones render inert (their panes all 409). */
type RailProject = Pick<ProjectListEntry, 'id' | 'name' | 'status'>

/**
 * Which projects the rail can switch between, and which one it shows, derived from the registry
 * and the URL:
 *  - the REGISTERED projects, most recently opened first (the sidebar's order, so the two agree);
 *  - the one shown is the URL's project on a project page; on a global page the boot project,
 *    else the most recently opened — settings always names SOME project, so its pages are one
 *    click away from anywhere;
 *  - cezar started from a task worktree is the boot project but not a registered one
 *    (`shouldRegisterProject` skips worktrees on purpose). Its own page still shows its sections
 *    — a settings page with no way to its sibling sections is a dead end — but it is never
 *    offered in the list.
 */
function useSettingsProjects(capabilities: CapabilityProps | undefined) {
  const { pathname } = useLocation()
  const registry = useProjects().data
  const health = useHealth().data
  const activeProjectId = pathnameProjectId(pathname)
  const bootProjectId = registry?.bootProject ?? health?.bootProject ?? null

  const projects = React.useMemo<RailProject[]>(
    () =>
      [...(registry?.projects ?? [])]
        .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
        .map(({ id, name, status }) => ({ id, name, status })),
    [registry],
  )

  const current = React.useMemo<RailProject | null>(() => {
    if (activeProjectId !== null) {
      const listed = projects.find((project) => project.id === activeProjectId)
      if (listed) return listed
      // Health's repo facts describe the BOOT project only; any other unknown id (the scope gate
      // lets one through while the registry query is erroring) keeps its raw id as its name.
      const folder =
        activeProjectId === bootProjectId
          ? health?.repo?.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
          : undefined
      return { id: activeProjectId, name: folder || activeProjectId, status: 'ok' }
    }
    return projects.find((project) => project.id === bootProjectId) ?? projects[0] ?? null
  }, [projects, activeProjectId, bootProjectId, health])

  const registered = current !== null && projects.some((project) => project.id === current.id)
  // Nothing to switch between: single-project mode, one project, or a page about an unregistered one.
  const switchable = capabilities?.singleProject !== true && projects.length > 1 && registered
  return { projects, activeProjectId, current, bootProjectId, switchable }
}

type SettingsProjects = ReturnType<typeof useSettingsProjects>

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

/** A `#card` in the URL (a merged page's old link) scrolls that card into view once it exists. */
function useScrollToHash(): void {
  const { hash, pathname } = useLocation()
  React.useEffect(() => {
    if (!hash) return
    const target = document.getElementById(hash.slice(1))
    target?.scrollIntoView?.({ block: 'start' })
  }, [hash, pathname])
}

/** The app sidebar's nav row, verbatim (h-[34px], 13.5px, muted → foreground on hover).
 *  `shrink-0` is load-bearing: the rows live in a SCROLLING flex column, and a flex item with a
 *  fixed height still shrinks to its text height when the column overflows. */
const navRowClass = (active: boolean, touch = false) =>
  cn(
    'flex h-[34px] shrink-0 items-center gap-2.5 rounded-md px-2.5 text-ui font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
    // In the phone drawer every row is a touch target: 44px, the shell's mobile rule.
    touch && 'h-11',
    active && 'bg-muted font-semibold text-foreground',
  )

/** True inside the phone drawer, where the identical content must meet the 44px touch rule
 *  the drawer's own close button follows; false in the desktop column. */
const TouchTargetsContext = React.createContext(false)

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="shrink-0 px-2.5 pt-3 pb-1 eyebrow text-soft-foreground">
      {children}
    </p>
  )
}

/** One global group's rows: "You" or "Workspace". */
function GlobalGroupLinks({
  sections,
  activeId,
}: {
  sections: SettingsSection[]
  activeId: SettingsSection['id'] | null
}) {
  const touch = React.useContext(TouchTargetsContext)
  return (
    <>
      {sections.map((section) => (
        <RouterNavLink
          key={section.id}
          to={settingsSectionPath('global', section.id)}
          data-section={section.id}
          className={navRowClass(section.id === activeId, touch)}
        >
          <section.icon aria-hidden="true" className="size-4 shrink-0" />
          {section.title}
        </RouterNavLink>
      ))}
    </>
  )
}

/** The shown project's pages, explicitly scoped to THAT project. */
function ProjectSectionLinks({
  project,
  sections,
  active,
  activeId,
}: {
  project: RailProject
  sections: SettingsSection[]
  /** Is this the project the URL names? Only then can a section row be current. */
  active: boolean
  activeId: SettingsSection['id'] | null
}) {
  const touch = React.useContext(TouchTargetsContext)
  return (
    <div className="flex flex-col gap-0.5">
      {/* The project's own index — its General page (folder, registry facts, concurrency,
          Remove; main #772) — first, so every section keeps a way back to it. */}
      <RouterNavLink
        to={projectSettingsPath(project.id)}
        end
        data-slot="settings-project-general"
        data-project={project.id}
        className={navRowClass(active && activeId === null, touch)}
      >
        <SlidersHorizontalIcon aria-hidden="true" className="size-4 shrink-0" />
        General
      </RouterNavLink>
      {sections.map((section) => (
        <RouterNavLink
          key={section.id}
          to={scopeTo(project.id, settingsSectionPath('project', section.id))}
          data-project-section={section.id}
          data-project={project.id}
          className={navRowClass(active && section.id === activeId, touch)}
        >
          <section.icon aria-hidden="true" className="size-4 shrink-0" />
          {section.title}
        </RouterNavLink>
      ))}
    </div>
  )
}

/** A registered project whose folder is gone: nothing to open — every pane behind it 409s —
 *  so the rail says so where the pages would be. Unregistering lives in Projects. */
function MissingProjectNote({ project }: { project: RailProject }) {
  return (
    <p
      data-slot="settings-project-missing"
      data-project={project.id}
      className="px-2.5 py-1.5 text-meta text-soft-foreground"
    >
      {project.name} is gone — remove it in Projects
    </p>
  )
}

/**
 * The project switcher: the shown project's name and a chevron; opens a small searchable list
 * of the registered projects with the shown one checked. Picking one lands on the SAME page
 * in that project when a project section is open, else on its General — the switcher is "same
 * question, other repo", never "go somewhere else".
 */
function ProjectSwitcher({
  projects,
  current,
  switchable,
  openSectionId,
}: {
  projects: RailProject[]
  current: RailProject
  switchable: boolean
  openSectionId: SettingsSection['id'] | null
}) {
  const touch = React.useContext(TouchTargetsContext)
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)
  const tone = current.status === 'missing' ? 'danger' : current.status === 'not-git' ? 'pending' : 'success'
  const face = (
    <>
      <StatusDot tone={tone} />
      <span className="min-w-0 flex-1 truncate text-left">{current.name}</span>
    </>
  )
  const faceClass = cn(
    'flex w-full items-center gap-2 rounded-[7px] border border-border bg-card-2 px-2.5 text-ui font-semibold text-foreground',
    touch ? 'h-11' : 'h-9',
  )

  if (!switchable) {
    return (
      <div data-slot="settings-project-switcher" data-project={current.id} data-static="" className={faceClass}>
        {face}
      </div>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="settings-project-switcher"
          data-project={current.id}
          aria-label={`Project: ${current.name}. Switch project`}
          className={cn(faceClass, 'transition-colors hover:bg-muted')}
        >
          {face}
          <ChevronsUpDownIcon aria-hidden="true" className="size-3.5 shrink-0 text-soft-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-64 p-0">
        <Command label="Switch project">
          <CommandInput aria-label="Find a project" placeholder="Find a project…" />
          <CommandList data-slot="settings-project-list" className="max-h-64">
            <CommandEmpty>No project matches.</CommandEmpty>
            {projects.map((project) => {
              const isCurrent = project.id === current.id
              const missing = project.status === 'missing'
              return (
                <CommandItem
                  key={project.id}
                  value={`${project.name} ${project.id}`}
                  data-slot="settings-project-option"
                  data-project={project.id}
                  data-current={isCurrent ? '' : undefined}
                  aria-selected={isCurrent}
                  disabled={missing}
                  onSelect={() => {
                    setOpen(false)
                    if (!isCurrent) navigate(projectSettingsPath(project.id, openSectionId ?? undefined))
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {missing ? (
                    <span className="shrink-0 text-micro text-danger">folder not found</span>
                  ) : isCurrent ? (
                    <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
                  ) : null}
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/**
 * The settings sidebar: the APP sidebar's frame and grammar (264px `bg-sidebar` column, the
 * same header row, row heights and footer), with settings content inside — Back and the brand
 * lockup where the app sidebar has its brand chip, the three labelled groups where it has the
 * nav, and the ⌘K launcher plus theme toggle in the footer where the app sidebar keeps them.
 */
type SidebarProps = {
  scope: SettingsScope
  activeId: SettingsSection['id'] | null
  capabilities: CapabilityProps | undefined
  rail: SettingsProjects
  leave: () => void
}

/** The desktop column: the app sidebar's shared `SidebarFrame` — same width preference, same
 *  drag handle. */
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
 * Escape, backdrop dismiss). Closes on every route change and on widening past `md`.
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
  rail,
  leave,
  headerAction,
}: SidebarProps & {
  /** The drawer's close button. Absent on desktop, which has nothing to close. */
  headerAction?: React.ReactNode
}) {
  const projectSections = settingsSectionsByScope(capabilities).project
  const touch = Boolean(headerAction)
  const globalActive = scope === 'global'
  const health = useHealth().data
  const version = health?.version ?? null
  const latestVersion = health?.latestVersion ?? null
  const stars = useStarCount().data
  const starCount = stars?.available ? (stars.count ?? null) : null
  // White-label branding (main): the same name and logo the app sidebar's lockup and chips show.
  const branding = useWorkspaceConfig().data?.branding
  const brandName = branding?.name ?? 'cezar'
  const brandLogoUrl = branding?.logoUrl ?? null
  const hint = projectRailHint(projectSections)

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
          // h-[26px]: the brand tile's height — the row must be pixel-identical to the app
          // sidebar's.
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
        <div data-slot="settings-nav-group" data-group="you" className="flex flex-col gap-0.5">
          <GroupLabel>You</GroupLabel>
          <GlobalGroupLinks sections={settingsSectionsInGroup('you', capabilities)} activeId={globalActive ? activeId : null} />
        </div>
        <div data-slot="settings-nav-group" data-group="workspace" className="flex flex-col gap-0.5">
          <GroupLabel>Workspace</GroupLabel>
          <GlobalGroupLinks sections={settingsSectionsInGroup('workspace', capabilities)} activeId={globalActive ? activeId : null} />
          {/* Global settings are per USER, not per repo — worth saying once, where the choice to
              write there is being made. */}
          <p className="shrink-0 px-2.5 pt-1 pb-1 text-meta text-soft-foreground">Stored in ~/.cezar</p>
        </div>

        {rail.current ? (
          <div data-slot="settings-nav-group" data-group="project" className="flex shrink-0 flex-col gap-0.5">
            <GroupLabel>Project</GroupLabel>
            <div className="px-0.5 pb-1">
              <ProjectSwitcher
                projects={rail.projects}
                current={rail.current}
                switchable={rail.switchable}
                openSectionId={scope === 'project' ? activeId : null}
              />
            </div>
            {rail.current.status === 'missing' ? (
              <MissingProjectNote project={rail.current} />
            ) : (
              <ProjectSectionLinks
                project={rail.current}
                sections={projectSections}
                active={rail.current.id === rail.activeProjectId}
                activeId={activeId}
              />
            )}
            {hint ? (
              <p data-slot="settings-project-gated-hint" className="px-2.5 pt-2 text-meta leading-snug text-soft-foreground">
                {hint}
              </p>
            ) : null}
          </div>
        ) : null}
        {/* WHICH repo, by its absolute path (main #772) — on a project page only. */}
        {scope === 'project' ? <ProjectLocationNav /> : null}
      </nav>

      {/* The app sidebar's footer, verbatim in shape (#702): the launcher owns line 1, the
          chrome controls line 2. */}
      <div
        data-slot="settings-sidebar-footer"
        className="flex flex-col gap-1.5 border-t border-border px-3.5 py-2.5"
      >
        <CommandPaletteHint />
        <div data-slot="settings-sidebar-footer-controls" className="flex items-center gap-2">
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
 *  area's sections. Project pages lead with the way up to the global settings. */
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
      'rounded-full border px-3 py-1.5 text-ui font-medium whitespace-nowrap transition-colors',
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
            ‹ Workspace
          </RouterLink>
          {/* Never the active pill: the index is a different route, and reaching it from a
              section is the whole reason this entry exists (main #772). */}
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
 *  shell's: the hamburger that opens the drawer, and the title. A `div`, not a `header`: the
 *  page's own header is the heading inside the content. */
function MobileBar({ title, projectName }: { title: string; projectName: string | null }) {
  return (
    <div
      data-slot="settings-mobile-bar"
      // The safe-area inset on the OUTER box and the fixed height on an inner row, as the app's
      // MobileTopBar does.
      className="shrink-0 border-b border-border bg-card pt-[env(safe-area-inset-top)] md:hidden"
    >
      <div className="flex h-[52px] items-center gap-1 px-2">
      <SheetTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label="Open settings menu" className="size-11">
          <MenuIcon aria-hidden="true" className="size-[17px]" />
        </Button>
      </SheetTrigger>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        {projectName ? (
          <>
            <span className="truncate text-body font-semibold text-muted-foreground">{projectName}</span>
            <span aria-hidden="true" className="shrink-0 text-body text-soft-foreground">/</span>
          </>
        ) : null}
        <span className="truncate text-body font-semibold">{title}</span>
      </span>
      </div>
    </div>
  )
}

/**
 * The page's heading and one-liner, at the top of the content column (design doc, Proposal 8):
 * `project / view` on a project page — the project leads because it is the wider context, the
 * view is the page, so it stays the heading. Global pages carry no marker: the rail's groups
 * already say it. Below `md` the mobile bar already titles the page, so the heading hides and
 * only the one-liner stays.
 */
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
  const description = section?.description ?? (scope === 'project' ? 'Project settings' : null)
  return (
    <header data-slot="settings-header" className="flex flex-col gap-1">
      <span className="hidden min-w-0 items-baseline gap-2 md:flex">
        {beside ? (
          <>
            <span data-slot="settings-scope-chip" className="truncate text-xl font-semibold text-muted-foreground">
              {beside}
            </span>
            <span aria-hidden="true" className="shrink-0 text-xl font-normal text-soft-foreground">
              /
            </span>
          </>
        ) : null}
        <h1 className="truncate text-xl font-semibold">{title}</h1>
      </span>
      {description ? (
        <p data-slot="settings-description" className="max-w-[60ch] text-ui text-muted-foreground">
          {description}
        </p>
      ) : null}
    </header>
  )
}

/** The frame around every settings page: sidebar | (mobile bar, pill row, content column).
 *  Fills the shell's scroller so the sidebar stands still while only the page column scrolls. */
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
  const rail = useSettingsProjects(capabilities)
  const leave = useLeaveSettings(rail.activeProjectId ?? rail.bootProjectId)
  useEscapeToLeave(leave)
  useScrollToHash()
  const projectName = (rail.activeProjectId !== null ? rail.current?.name : null) ?? rail.activeProjectId
  const title = section?.title ?? (scope === 'global' ? 'Settings' : projectName ?? 'Settings')
  // On the project INDEX the title IS the project — no second mention beside it.
  const beside = scope === 'project' && section !== null ? projectName : null
  const [menuOpen, setMenuOpen] = React.useState(false)
  const sidebar = { scope, activeId: section?.id ?? null, capabilities, rail, leave }
  return (
    // The Sheet root renders no DOM — it is the context that makes the top bar's hamburger a
    // real SheetTrigger while the open state stays ours to close on navigation.
    <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
      <div data-route={routeName} className="flex h-full min-h-full">
        <SettingsSidebar {...sidebar} />
        <SettingsMobileDrawer {...sidebar} onOpenChange={setMenuOpen} />
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain">
          <MobileBar title={title} projectName={beside} />
          {section ? <SectionPills scope={scope} activeId={section.id} capabilities={capabilities} /> : null}
          {/* The content column (design doc, Proposal 8): 720px, heading and one-liner first. */}
          <div
            data-slot="settings-content"
            className="mx-auto flex w-full max-w-[720px] min-w-0 flex-1 flex-col gap-5 px-4 pt-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:px-8 md:pt-6 md:pb-8"
          >
            <PageHeader scope={scope} section={section} title={title} beside={beside} />
            {children}
          </div>
        </div>
      </div>
    </Sheet>
  )
}

/** One registered section inside the frame — `/p/<id>/settings/<id>` or `/settings/global/<id>`.
 *  A merged page's old id never renders: it hops to the page it became, hash and query intact. */
export function SettingsSectionRoute({
  section,
  scope,
  capabilities,
}: {
  section: SettingsSection
  scope: SettingsScope
  capabilities?: CapabilityProps
}) {
  const location = useLocation()
  if (section.redirect) {
    return (
      <Navigate
        to={{
          pathname: settingsSectionPath(scope, section.redirect.to),
          search: location.search,
          hash: location.hash || (section.redirect.hash ? `#${section.redirect.hash}` : ''),
        }}
        replace
      />
    )
  }
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
 * only repeated the sidebar, so `/settings/global` redirects to the first section instead.
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
      <ProjectGeneral capabilities={capabilities} />
      {/* On desktop the sidebar already lists every section; the cards would be the same
          menu twice. */}
      <ul data-slot="settings-index" className="mt-2 flex w-full flex-col gap-2.5 md:hidden">
        {sections.map((section) => (
          <SectionCard key={section.id} section={section} />
        ))}
      </ul>
    </SettingsFrame>
  )
}
