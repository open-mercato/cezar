import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon, RefreshCwIcon, SparklesIcon, TriangleAlertIcon } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'

import { Link, useActiveProjectId } from '@/lib/project-router'

import { putUiState, refreshSkills } from '@/api/client'
import {
  queryKeys,
  useImportableSkills,
  useSkills,
  useSkillsUpdate,
  useUiState,
  useWorkflows,
} from '@/api/queries'
import type { Skill, UiState } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { SkillDetailBody, SkillSourceTag } from '@/components/skill-detail'
import type { SkillActivation } from '@/components/skill-detail'
import { SkillEmptyHint } from '@/components/skill-empty-hint'
import { SkillsUpdateCard } from '@/components/skills-update-card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { filterSkills, isProjectSkill, orderSkills, skillUsedBy } from '@/lib/skills'
import { cn } from '@/lib/utils'

type SkillCatalogItem = Skill & { enabled: boolean }

function effectiveImported(uiState: UiState | undefined, allNames: readonly string[]): string[] {
  const value = uiState?.importedSkills
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === 'string' && !!name)
    : [...allNames]
}

function skillActivation(
  skill: SkillCatalogItem,
  importableNames: ReadonlySet<string>,
  pending: boolean,
  onToggle: (name: string) => void,
  importableUnavailable = false,
): SkillActivation | undefined {
  const alwaysEnabled =
    skill.source === 'ai' ||
    skill.source === 'cezar' ||
    skill.source === 'agents' ||
    skill.source === 'global'
  const canToggle = skill.source === 'team' && (importableNames.has(skill.name) || importableUnavailable)
  if (!alwaysEnabled && !canToggle) return undefined

  return {
    ariaLabel: alwaysEnabled
      ? `${skill.name} is always enabled`
      : `${skill.enabled ? 'Disable' : 'Enable'} ${skill.name}`,
    checked: alwaysEnabled || skill.enabled,
    disabled: alwaysEnabled || pending || importableUnavailable,
    onCheckedChange: () => onToggle(skill.name),
  }
}

/**
 * `/skills` — the skills catalog and selected skill preview. Open Mercato activation stays inline
 * in the catalog; bookmarklets live in the skill preview that launches them.
 *
 * The standing feedback items stay built in:
 *  - #377 project-first and bold: the list renders through `orderSkills`/`filterSkills`, the
 *    same pure module every picker uses;
 *  - #384 stable scroll/selection: selection lives in the URL (`?skill=<name>`), the rows are
 *    keyed React elements inside one persistent scroll container — a refresh re-renders rows
 *    in place instead of rebuilding the pane, so neither the selection nor the scroll
 *    position can be lost (the legacy innerHTML rebuild lost both).
 */

export function SkillsRoute() {
  return (
    <div data-route="skills" className="flex min-h-full flex-col">
      {/* Desktop header — below `md` the shell's top bar already says "Skills". */}
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Skills</h1>
        <p className="text-[13px] text-muted-foreground">Markdown playbooks agents can follow.</p>
      </header>
      <SkillsCatalog />
    </div>
  )
}

function SkillsCatalog() {
  const projectId = useActiveProjectId() ?? ''
  const updateQuery = useSkillsUpdate(projectId, Boolean(projectId))
  const skillsQuery = useSkills()
  const workflowsQuery = useWorkflows()
  const importableQuery = useImportableSkills()
  const [searchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const queryClient = useQueryClient()
  const uiState = useUiState()
  const importable = importableQuery.data ?? []
  const allImportableNames = useMemo(() => importable.map((skill) => skill.name), [importable])
  const importableNames = useMemo(() => new Set(allImportableNames), [allImportableNames])
  const enabledImportable = useMemo(
    () => new Set(effectiveImported(uiState.data, allImportableNames)),
    [uiState.data, allImportableNames],
  )
  const writeChain = useRef<Promise<void>>(Promise.resolve())
  const latestWrite = useRef(0)
  const toggleImportedSkill = useCallback((name: string) => {
    const key = queryKeys.uiState
    const skillsKey = queryKeys.skills
    const current = queryClient.getQueryData<UiState>(key)
    const previous = effectiveImported(current, allImportableNames)
    const next = previous.includes(name) ? previous.filter((entry) => entry !== name) : [...previous, name]

    queryClient.setQueryData(key, { ...current, importedSkills: next })
    const sequence = ++latestWrite.current
    writeChain.current = writeChain.current.then(async () => {
      try {
        const merged = await putUiState({ importedSkills: next }, projectId)
        if (sequence !== latestWrite.current) return
        queryClient.setQueryData(key, merged)
        void queryClient.invalidateQueries({ queryKey: skillsKey })
      } catch (error: unknown) {
        if (sequence !== latestWrite.current) return
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
        void queryClient.invalidateQueries({ queryKey: key })
      }
    })
  }, [allImportableNames, projectId, queryClient])

  const refresh = useMutation({
    mutationFn: () => refreshSkills(),
    onSuccess: (catalog) => {
      // The POST answers the merged catalog — seed the shared query instead of refetching.
      queryClient.setQueryData(queryKeys.skills, catalog)
      toast('Team skills refreshed.')
    },
    onError: (error) => toast(error.message, { tone: 'danger' }),
  })

  if (skillsQuery.isError) {
    return (
      <CenteredState
        icon={<TriangleAlertIcon />}
        tone="danger"
        heading="h2"
        title="Could not load skills"
        subtitle={skillsQuery.error.message}
      />
    )
  }

  const skills = orderSkills(skillsQuery.data ?? [])
  const activeNames = new Set(skills.map((skill) => skill.name))
  const catalog = orderSkills<SkillCatalogItem>([
    ...skills.map((skill) => ({
      ...skill,
      enabled: skill.source === 'team' && importableNames.has(skill.name) ? enabledImportable.has(skill.name) : true,
    })),
    ...importable
      .filter((skill) => !activeNames.has(skill.name))
      .map((skill) => ({ ...skill, enabled: enabledImportable.has(skill.name) })),
  ].sort((a, b) => a.name.localeCompare(b.name)))
  const param = searchParams.get('skill')
  const selected = catalog.find((skill) => skill.name === param) ?? (param === null ? catalog.find((skill) => skill.enabled) : null) ?? null
  const selection = selected?.name ?? null
  const selectedActivation = selected
    ? skillActivation(selected, importableNames, uiState.isPending, toggleImportedSkill, importableQuery.isError)
    : undefined
  const shown = filterSkills(catalog, query)

  return (
    <div data-slot="skills-section" className="flex min-h-full flex-1 items-stretch">
      {/* List pane. Below md it IS the page until a selection is in the URL — the GitHub
          tab's two-surfaces-one-URL rule. */}
      <section
        data-slot="skills-list"
        className={cn(
          'w-full flex-col border-border md:flex md:w-96 md:shrink-0 md:border-r',
          // Pin the pane below the sticky h-14 header so the ROWS scroll inside it (the #384
          // stable-scroll surface) — `var(--spacing)*14` tracks the density token.
          'md:sticky md:top-14 md:max-h-[calc(100dvh-(var(--spacing)*14))]',
          param === null || !selected ? 'flex' : 'hidden md:flex',
        )}
      >
        <div className="flex shrink-0 items-center gap-2 p-3 pb-2">
          <Input
            data-slot="skills-filter"
            placeholder="Filter skills…"
            aria-label="Filter skills"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-8 text-[13px]"
          />
          <button
            type="button"
            data-slot="skills-refresh"
            title="git fetch the team skills repos"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-55"
          >
            <RefreshCwIcon
              aria-hidden="true"
              className={cn('size-3', refresh.isPending && 'motion-safe:animate-spin')}
            />
            Refresh
          </button>
        </div>
        {projectId ? (
          <div className="shrink-0 px-3 pb-2">
            <SkillsUpdateCard projectId={projectId} state={updateQuery.data} loadError={updateQuery.error} />
          </div>
        ) : null}
        {importableQuery.isError ? (
          <div
            data-slot="skills-importable-error"
            role="alert"
            className="mx-3 mb-2 flex shrink-0 items-center justify-between gap-3 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            <p className="min-w-0">
              Could not load the Open Mercato skills catalog. Team skills may be missing until it loads.{' '}
              {importableQuery.error.message}
            </p>
            <Button
              type="button"
              data-action="skills-importable-retry"
              variant="ghost"
              size="sm"
              disabled={importableQuery.isFetching}
              onClick={() => void importableQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : null}

        <ul data-slot="skill-rows" className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
          {skillsQuery.isPending ? (
            <li className="px-2.5 py-2 text-[13px] text-soft-foreground">Loading…</li>
          ) : shown.length > 0 ? (
            shown.map((skill) => (
              <SkillRow
                key={skill.name}
                skill={skill}
                active={selection === skill.name}
                activation={skillActivation(
                  skill,
                  importableNames,
                  uiState.isPending,
                  toggleImportedSkill,
                  importableQuery.isError,
                )}
              />
            ))
          ) : (
            <li className="px-2.5 py-2 text-xs leading-relaxed text-soft-foreground">
              {catalog.length > 0 ? '(no skills match)' : <SkillEmptyHint />}
            </li>
          )}
        </ul>
      </section>

      {/* A selected skill is previewed beside the catalog, or replaces it on mobile. */}
      <section
        data-slot="skills-detail"
        className={cn('min-w-0 flex-1 flex-col', param === null || !selected ? 'hidden md:flex' : 'flex')}
      >
        <div className="min-w-0 flex-1 px-4 py-4 md:px-7 md:py-5">
          {selected ? (
            <>
              {param !== null ? (
                <Link
                  to="/skills"
                  data-slot="skills-back"
                  className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground md:hidden"
                >
                  <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
                  Back to skills
                </Link>
              ) : null}
              <SkillDetailBody
                skill={selected}
                enabled={selected.enabled}
                activation={selectedActivation}
                usedBy={skillUsedBy(workflowsQuery.data?.workflows ?? [], selected.name)}
              />
            </>
          ) : skillsQuery.isPending ? null : (
            <CenteredState
              icon={<SparklesIcon />}
              tone="neutral"
              heading="h2"
              title="No skill selected"
              subtitle="Pick a skill from the catalog."
            />
          )}
        </div>
      </section>
    </div>
  )
}

function SkillRow({
  skill,
  active,
  activation,
}: {
  skill: SkillCatalogItem
  active: boolean
  activation?: SkillActivation
}) {
  const project = isProjectSkill(skill)
  const rowClassName = 'flex min-w-0 flex-1 flex-col gap-0.5 px-2.5 py-2'
  const contents = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        {/* Enabled skills read bold; inactive importable skills are muted. */}
        <span
          className={cn(
            'min-w-0 truncate font-mono text-[13px]',
            skill.enabled ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground',
          )}
        >
          {skill.name}
        </span>
        <SkillSourceTag source={skill.source} teamRepo={skill.team?.repo} className="ml-auto" />
      </span>
      {skill.description ? <span className="line-clamp-2 text-xs text-soft-foreground">{skill.description}</span> : null}
    </>
  )
  return (
    <li className={cn('flex min-w-0 items-start gap-0 rounded-md transition-colors hover:bg-muted', active && 'bg-muted')}>
      {activation ? (
        <Switch
          data-slot="skill-activation"
          aria-label={activation.ariaLabel}
          checked={activation.checked}
          disabled={activation.disabled}
          onCheckedChange={activation.onCheckedChange}
          size="sm"
          className="mt-2.5 ml-2 shrink-0"
        />
      ) : null}
      <Link
        to={`/skills?skill=${encodeURIComponent(skill.name)}`}
        data-slot="skill-row"
        data-skill={skill.name}
        data-project={project ? 'true' : undefined}
        data-enabled={skill.enabled ? 'true' : 'false'}
        aria-current={active ? 'page' : undefined}
        className={rowClassName}
      >
        {contents}
      </Link>
    </li>
  )
}
