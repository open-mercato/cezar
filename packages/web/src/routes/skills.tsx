import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon, DownloadIcon, RefreshCwIcon, SearchIcon, SparklesIcon, TriangleAlertIcon, ZapIcon } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'

import { Link } from '@/lib/project-router'

import { refreshSkills } from '@/api/client'
import { queryKeys, useImportableSkills, useProjects, useSkills, useWorkflows } from '@/api/queries'
import { useProjectScope } from '@/api/project-scope-context'
import type { Skill } from '@open-mercato/cezar-api-client'
import { ContextSidebar } from '@/components/context-sidebar'
import { Page, PageBody, PageHeader } from '@/components/page'
import { ImportSkillsPanel } from '@/components/skills-import-panel'
import { SkillDetailBody, SkillSourceTag } from '@/components/skill-detail'
import { SkillEmptyHint } from '@/components/skill-empty-hint'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
import { useIsMobile } from '@/hooks/use-mobile'
import { filterSkills, isProjectSkill, orderSkills, skillUsedBy } from '@/lib/skills'
import { cn } from '@/lib/utils'
import { BookmarkletPanel } from './settings/bookmarklets-section'

/**
 * `/skills` — the skills catalog as its own top-level surface (was `/settings/skills`, moved
 * out of the Settings shell so it stops carrying the settings sub-nav): catalog + detail +
 * Refresh + the bookmarklet panel. `/settings/skills` now redirects here (routes.tsx) so pasted
 * links keep working. Skills are playbooks agents follow, not a knob — so this is a page, not a
 * settings section.
 *
 * Master–detail through the shell: the catalog (search, source filter, rows, the two pinned
 * panels) is this screen's contextual sidebar, and the page is the selected skill.
 *
 * The two standing feedback items stay built in:
 *  - #377 project-first and bold: the list renders through `orderSkills`/`filterSkills`, the
 *    same pure module every picker uses;
 *  - #384 stable scroll/selection: selection lives in the URL (`?skill=<name>`), the rows are
 *    keyed React elements inside one persistent scroll container — a refresh re-renders rows
 *    in place instead of rebuilding the pane, so neither the selection nor the scroll
 *    position can be lost (the legacy innerHTML rebuild lost both).
 *
 * The pinned "Run from GitHub" entry (spec 011 — must not drown under a long team catalog)
 * opens the bookmarklet panel via the legacy `__bm` sentinel in the same query param.
 */

const BOOKMARKLETS = '__bm'
const IMPORT = '__import'
/** Radix Select has no empty-string item: this stands for "no source filter". */
const ALL_SOURCES = '__all'

export function SkillsRoute() {
  return (
    <Page data-route="skills">
      <SkillsCatalog />
    </Page>
  )
}

function SkillsCatalog() {
  const skillsQuery = useSkills()
  const workflowsQuery = useWorkflows()
  const importableQuery = useImportableSkills()
  const [searchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<string>(ALL_SOURCES)
  const isMobile = useIsMobile()
  const queryClient = useQueryClient()
  const projects = useProjects()
  const scope = useProjectScope()
  const updateProjectId = scope.projectId ?? projects.data?.bootProject ?? ''

  const refresh = useMutation({
    mutationFn: () => refreshSkills(),
    onSuccess: (catalog) => {
      queryClient.setQueryData(queryKeys.skills, catalog)
      toast('Team skills refreshed.')
    },
    onError: (error) => toast(error.message, { tone: 'danger' }),
  })

  const skills = orderSkills(skillsQuery.data ?? [])
  const canImport = (importableQuery.data?.length ?? 0) > 0
  // `?skill=` is validated against the live catalog; anything unknown falls back to the first
  // skill, then to whichever pinned panel exists.
  const param = searchParams.get('skill')
  const selection =
    param === BOOKMARKLETS || param === IMPORT
      ? param
      : param !== null && skills.some((skill) => skill.name === param)
        ? param
        : (skills[0]?.name ?? (canImport ? IMPORT : BOOKMARKLETS))
  const selected = skills.find((skill) => skill.name === selection) ?? null
  const sources: string[] = [...new Set(skills.map((skill) => skill.source))]
  // A filter naming a source the catalog no longer has (after a refresh) falls back to all.
  const sourceFilter = source !== ALL_SOURCES && sources.includes(source) ? source : ALL_SOURCES
  const shown = filterSkills(skills, query).filter((skill) => sourceFilter === ALL_SOURCES || skill.source === sourceFilter)

  // The catalog lives in the contextual sidebar: search, the source filter, every skill, and the
  // two pinned panels. Selection stays in the URL (`?skill=`), so the rows are plain links.
  const sidebar = (
    <ContextSidebar>
      <SidebarHeader className="gap-3 p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="px-1 text-[15px] font-semibold text-foreground">Skills</h2>
          {skills.length > 0 ? (
            <span className="px-1 text-xs text-muted-foreground tabular-nums">
              {shown.length === skills.length ? skills.length : `${shown.length} / ${skills.length}`}
            </span>
          ) : null}
        </div>
        <SidebarInput
          type="search"
          data-slot="skills-filter"
          placeholder="Filter skills…"
          aria-label="Filter skills"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {sources.length > 1 ? (
          <Select value={sourceFilter} onValueChange={setSource}>
            <SelectTrigger size="sm" aria-label="Filter by source" data-slot="skills-source-filter" className="w-full bg-background shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_SOURCES}>All sources</SelectItem>
              {sources.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="pt-0">
          <SidebarGroupContent>
            <SidebarMenu data-slot="skill-rows">
              {skillsQuery.isPending ? (
                <li role="status" aria-label="Loading…" className="flex flex-col gap-2 p-2">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-3/4" />
                </li>
              ) : skillsQuery.isError ? (
                <li className="px-2 py-2 text-xs text-muted-foreground">The skills did not load.</li>
              ) : shown.length > 0 ? (
                shown.map((skill) => <SkillNavRow key={skill.path} skill={skill} active={selection === skill.name} />)
              ) : (
                <li className="px-2 py-3 text-[13px] leading-relaxed text-pretty text-muted-foreground">
                  {skills.length > 0 ? 'No skills match.' : <SkillEmptyHint />}
                </li>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          {canImport ? (
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={selection === IMPORT}>
                <Link
                  to={`/skills?skill=${IMPORT}`}
                  data-slot="import-skills-row"
                  aria-current={selection === IMPORT ? 'page' : undefined}
                  title="Choose which open-mercato skills appear in your catalog."
                >
                  <DownloadIcon aria-hidden="true" />
                  <span>Manage skills</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={selection === BOOKMARKLETS}>
              <Link
                to={`/skills?skill=${BOOKMARKLETS}`}
                data-slot="bookmarklets-row"
                aria-current={selection === BOOKMARKLETS ? 'page' : undefined}
                title="One-click skill launch from any GitHub PR or issue."
              >
                <ZapIcon aria-hidden="true" />
                <span>Run from GitHub</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </ContextSidebar>
  )

  const header = (
    <PageHeader
      title="Skills"
      description="Markdown playbooks agents can follow."
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-slot="skills-refresh"
          title="git fetch the team skills repos"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          <RefreshCwIcon aria-hidden="true" className={cn(refresh.isPending && 'motion-safe:animate-spin')} />
          Refresh
        </Button>
      }
    />
  )

  if (skillsQuery.isError) {
    return (
      <>
        {sidebar}
        {header}
        <PageBody>
          <Alert variant="destructive">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertTitle>Could not load skills</AlertTitle>
            <AlertDescription>{skillsQuery.error.message}</AlertDescription>
          </Alert>
        </PageBody>
      </>
    )
  }

  // On a phone the sidebar is a closed sheet, so with no selection in the URL the page itself
  // is the list — the two-surfaces-one-URL rule this screen always had below md.
  const listInMain = isMobile && param === null

  return (
    <>
      {sidebar}
      {header}
      <PageBody data-slot="skills-section">
        {listInMain ? (
          <section data-slot="skills-list" className="flex min-w-0 flex-col gap-3">
            <InputGroup className="shrink-0">
              <InputGroupAddon>
                <SearchIcon aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                placeholder="Filter skills…"
                aria-label="Filter skills"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </InputGroup>
            <ul className="flex flex-col gap-0.5">
              {skillsQuery.isPending ? (
                <li role="status" aria-label="Loading…" className="flex flex-col gap-2 p-2">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                </li>
              ) : shown.length > 0 ? (
                shown.map((skill) => <SkillRow key={skill.path} skill={skill} active={false} />)
              ) : (
                <li className="px-3 py-4 text-[13px] leading-relaxed text-pretty text-muted-foreground">
                  {skills.length > 0 ? 'No skills match.' : <SkillEmptyHint />}
                </li>
              )}
            </ul>
            <div className="flex flex-wrap gap-2 border-t border-border pt-3">
              {canImport ? (
                <Button asChild variant="outline" size="sm">
                  <Link to={`/skills?skill=${IMPORT}`}>
                    <DownloadIcon aria-hidden="true" />
                    Manage skills
                  </Link>
                </Button>
              ) : null}
              <Button asChild variant="outline" size="sm">
                <Link to={`/skills?skill=${BOOKMARKLETS}`}>
                  <ZapIcon aria-hidden="true" />
                  Run from GitHub
                </Link>
              </Button>
            </div>
          </section>
        ) : (
          <section data-slot="skills-detail" className="flex min-w-0 flex-col">
            <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2 self-start md:hidden">
              <Link to="/skills" data-slot="skills-back">
                <ArrowLeftIcon aria-hidden="true" />
                Back to the list
              </Link>
            </Button>

            {selection === IMPORT ? (
              <ImportSkillsPanel projectId={updateProjectId} />
            ) : selection === BOOKMARKLETS ? (
              <BookmarkletPanel skills={skills} />
            ) : selected ? (
              <SkillDetailBody
                skill={selected}
                usedBy={skillUsedBy(workflowsQuery.data?.workflows ?? [], selected.name)}
              />
            ) : skillsQuery.isPending ? (
              <Skeleton className="h-72 w-full rounded-xl" />
            ) : (
              <Empty className="min-h-72 rounded-xl border border-dashed border-border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <SparklesIcon />
                  </EmptyMedia>
                  <EmptyTitle>No skill selected</EmptyTitle>
                  <EmptyDescription>Pick a skill from the catalog.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </section>
        )}
      </PageBody>
    </>
  )
}

/** A catalog row in the contextual sidebar: the name, its source, and the description beneath. */
function SkillNavRow({ skill, active }: { skill: Skill; active: boolean }) {
  const project = isProjectSkill(skill)
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} className="h-auto py-2">
        <Link
          to={`/skills?skill=${encodeURIComponent(skill.name)}`}
          data-slot="skill-row"
          data-skill={skill.name}
          data-project={project ? 'true' : undefined}
          aria-current={active ? 'page' : undefined}
          title={skill.description ?? skill.name}
          className="flex-col items-stretch gap-0.5"
        >
          <span className="flex min-w-0 items-center gap-2">
            {/* Project skills read bold (#377) — the visual half of the ordering rule. */}
            <span className={cn('min-w-0 truncate font-mono text-[13px]', project ? 'font-semibold' : 'font-medium')}>
              {skill.name}
            </span>
            <SkillSourceTag source={skill.source} className="ml-auto" />
          </span>
          {skill.description ? (
            <span className="truncate text-xs font-normal text-muted-foreground">{skill.description}</span>
          ) : null}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

function SkillRow({ skill, active }: { skill: Skill; active: boolean }) {
  const project = isProjectSkill(skill)
  return (
    <li>
      <Link
        to={`/skills?skill=${encodeURIComponent(skill.name)}`}
        data-slot="skill-row"
        data-skill={skill.name}
        data-project={project ? 'true' : undefined}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex flex-col gap-0.5 rounded-md px-2.5 py-2 transition-colors hover:bg-muted/60',
          active && 'bg-muted hover:bg-muted',
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          {/* Project skills read bold (#377) — the visual half of the ordering rule. */}
          <span
            className={cn(
              'min-w-0 truncate font-mono text-[13px]',
              project || active ? 'font-semibold text-foreground' : 'font-medium text-foreground/85',
            )}
          >
            {skill.name}
          </span>
          <SkillSourceTag source={skill.source} className="ml-auto" />
        </span>
        {skill.description ? (
          <span className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</span>
        ) : null}
      </Link>
    </li>
  )
}
