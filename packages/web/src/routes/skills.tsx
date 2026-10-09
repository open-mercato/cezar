import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon, DownloadIcon, RefreshCwIcon, SearchIcon, SparklesIcon, TriangleAlertIcon, ZapIcon } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'

import { Link } from '@/lib/project-router'

import { refreshSkills } from '@/api/client'
import { queryKeys, useImportableSkills, useProjects, useSkills, useWorkflows } from '@/api/queries'
import { useProjectScope } from '@/api/project-scope-context'
import type { Skill } from '@open-mercato/cezar-api-client'
import { Page, PageBody, PageHeader } from '@/components/page'
import { ImportSkillsPanel } from '@/components/skills-import-panel'
import { SkillDetailBody, SkillSourceTag } from '@/components/skill-detail'
import { SkillEmptyHint } from '@/components/skill-empty-hint'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
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
  const shown = filterSkills(skills, query)

  const header = (
    <PageHeader
      title="Skills"
      description="Markdown playbooks agents can follow."
      actions={
        <>
          {canImport ? (
            <Button asChild variant={selection === IMPORT ? 'secondary' : 'outline'} size="sm">
              <Link
                to={`/skills?skill=${IMPORT}`}
                data-slot="import-skills-row"
                aria-current={selection === IMPORT ? 'page' : undefined}
                title="Choose which open-mercato skills appear in your catalog."
              >
                <DownloadIcon aria-hidden="true" />
                Manage skills
              </Link>
            </Button>
          ) : null}
          <Button asChild variant={selection === BOOKMARKLETS ? 'secondary' : 'outline'} size="sm">
            <Link
              to={`/skills?skill=${BOOKMARKLETS}`}
              data-slot="bookmarklets-row"
              aria-current={selection === BOOKMARKLETS ? 'page' : undefined}
              title="One-click skill launch from any GitHub PR or issue."
            >
              <ZapIcon aria-hidden="true" />
              Run from GitHub
            </Link>
          </Button>
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
            {/* Three labelled buttons do not fit a phone's header row. */}
            <span className="max-sm:sr-only">Refresh</span>
          </Button>
        </>
      }
    />
  )

  if (skillsQuery.isError) {
    return (
      <>
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

  return (
    <>
      {header}
      <PageBody
        data-slot="skills-section"
        className="grid items-start gap-6 md:grid-cols-[19rem_minmax(0,1fr)] lg:grid-cols-[21rem_minmax(0,1fr)]"
      >
        {/* List pane. Below md it IS the page until a selection is in the URL — the GitHub
            tab's two-surfaces-one-URL rule. */}
        <section
          data-slot="skills-list"
          className={cn(
            'min-w-0 flex-col gap-3 md:sticky md:top-4 md:flex md:max-h-[calc(100dvh-5rem)]',
            param === null ? 'flex' : 'hidden md:flex',
          )}
        >
          <InputGroup className="shrink-0">
            <InputGroupAddon>
              <SearchIcon aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              data-slot="skills-filter"
              placeholder="Filter skills…"
              aria-label="Filter skills"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {skills.length > 0 ? (
              <InputGroupAddon align="inline-end" className="text-xs tabular-nums">
                {shown.length === skills.length ? skills.length : `${shown.length} / ${skills.length}`}
              </InputGroupAddon>
            ) : null}
          </InputGroup>

          <Card flush className="min-h-0 md:flex-1">
            <ul data-slot="skill-rows" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
              {skillsQuery.isPending ? (
                <li role="status" aria-label="Loading…" className="flex flex-col gap-2 p-2">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-3/4" />
                </li>
              ) : shown.length > 0 ? (
                shown.map((skill) => <SkillRow key={skill.path} skill={skill} active={selection === skill.name} />)
              ) : (
                <li className="px-3 py-4 text-[13px] leading-relaxed text-pretty text-muted-foreground">
                  {skills.length > 0 ? 'No skills match.' : <SkillEmptyHint />}
                </li>
              )}
            </ul>
          </Card>
        </section>

        {/* Detail pane. Hidden below md until the URL carries a selection. */}
        <section
          data-slot="skills-detail"
          className={cn('min-w-0 flex-col', param === null ? 'hidden md:flex' : 'flex')}
        >
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
            <Card className="gap-0 px-5 py-5 sm:px-7 sm:py-6">
              <SkillDetailBody
                skill={selected}
                usedBy={skillUsedBy(workflowsQuery.data?.workflows ?? [], selected.name)}
              />
            </Card>
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
      </PageBody>
    </>
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
