import { describe, expect, it } from 'vitest'

import type { ProjectListEntry, RunIndexEntry } from '@open-mercato/cezar-api-client'

import {
  NO_FILTERS,
  UNTAGGED,
  activeFacetCount,
  allStatuses,
  canReset,
  resetCount,
  allWorkflows,
  facetCounts,
  filterGlobalTasks,
  groupGlobalTasks,
  hasActiveFilters,
  tagValuesOf,
  tasksExcludingFacet,
  GROUP_BY_OPTIONS,
  SEARCH_PARAMS,
  DEFAULT_URL_STATE,
  urlStateFromSearchParams,
  urlStateToSearchParams,
  toGlobalTasks,
  toggleFacetValue,
  toggleGroupBy,
  truncatedProjectNames,
  type GlobalTaskFilters,
  type GlobalTasksUrlState,
} from './global-tasks'
import { allProjectTags } from './project-tags'

/**
 * The global Tasks page's behavior, as a table. What matters here and nowhere else:
 * tags belong to PROJECTS (so grouping by tag fans a task out across every tag its repo
 * carries), facets are sets that OR inside and AND across, and a run whose project has left the
 * registry still renders.
 */

function project(overrides: Partial<ProjectListEntry> & { id: string }): ProjectListEntry {
  return {
    name: overrides.id,
    root: `/repos/${overrides.id}`,
    addedAt: '2026-07-01T10:00:00Z',
    lastOpenedAt: '2026-07-01T10:00:00Z',
    source: 'local',
    status: 'ok',
    ...overrides,
  }
}

function run(overrides: Partial<RunIndexEntry> & { id: string; projectId: string }): RunIndexEntry {
  return {
    title: overrides.id,
    status: 'done',
    createdAt: '2026-07-14T10:00:00Z',
    archived: false,
    workflow: 'quick-task',
    ...overrides,
  }
}

// api + web are one piece of work ("storefront"); infra is its own; loose carries no tags.
const PROJECTS: ProjectListEntry[] = [
  project({ id: 'api', name: 'API', tags: ['backend', 'storefront'] }),
  project({ id: 'web', name: 'Web', tags: ['storefront'] }),
  project({ id: 'infra', name: 'Infra', tags: ['infra'] }),
  project({ id: 'loose', name: 'Loose' }),
]

const RUNS: RunIndexEntry[] = [
  run({ id: 'a1', projectId: 'api', title: 'Add checkout endpoint', status: 'running', branch: 'feat/checkout' }),
  run({ id: 'w1', projectId: 'web', title: 'Checkout page', status: 'review', workflow: 'plan-first' }),
  run({ id: 'i1', projectId: 'infra', title: 'Bump the runner', status: 'done' }),
  run({ id: 'l1', projectId: 'loose', title: 'Tidy the scripts', status: 'done' }),
  run({ id: 'old', projectId: 'api', title: 'Filed away', status: 'done', archived: true }),
]

const tasks = toGlobalTasks(RUNS, PROJECTS)
const filters = (overrides: Partial<GlobalTaskFilters> = {}): GlobalTaskFilters => ({
  ...NO_FILTERS,
  ...overrides,
})
const ids = (list: readonly { run: RunIndexEntry }[]) => list.map((task) => task.run.id)

describe('toGlobalTasks', () => {
  it('resolves each run to its project name and the project’s tags', () => {
    const api = tasks.find((task) => task.run.id === 'a1')
    expect(api?.projectName).toBe('API')
    expect(api?.tags).toEqual(['backend', 'storefront'])
  })

  it('keeps a run whose project has left the registry, falling back to the raw id', () => {
    const orphan = toGlobalTasks([run({ id: 'x', projectId: 'gone' })], PROJECTS)[0]
    expect(orphan?.project).toBeUndefined()
    expect(orphan?.projectName).toBe('gone')
    expect(orphan?.tags).toEqual([])
  })

  it('preserves the server’s newest-first order rather than inventing its own', () => {
    expect(ids(tasks)).toEqual(['a1', 'w1', 'i1', 'l1', 'old'])
  })
})

describe('option lists', () => {
  it('dedupes tags across projects, case-insensitively, and sorts them', () => {
    expect(allProjectTags(PROJECTS)).toEqual(['backend', 'infra', 'storefront'])
    expect(
      allProjectTags([project({ id: 'a', tags: ['API'] }), project({ id: 'b', tags: ['api'] })]),
    ).toEqual(['API'])
  })

  it('derives workflows and statuses from the tasks actually present', () => {
    expect(allWorkflows(tasks)).toEqual(['plan-first', 'quick-task'])
    expect(allStatuses(tasks)).toEqual(['done', 'review', 'running'])
  })
})

describe('filterGlobalTasks', () => {
  it('splits active from archived', () => {
    expect(ids(filterGlobalTasks(tasks, NO_FILTERS, 'active'))).toEqual(['a1', 'w1', 'i1', 'l1'])
    expect(ids(filterGlobalTasks(tasks, NO_FILTERS, 'archived'))).toEqual(['old'])
  })

  it('ORs values inside one facet', () => {
    const picked = filterGlobalTasks(tasks, filters({ workflows: ['plan-first'] }), 'active')
    expect(ids(picked)).toEqual(['w1'])
    expect(ids(filterGlobalTasks(tasks, filters({ statuses: ['running', 'done'] }), 'active'))).toEqual([
      'a1',
      'i1',
      'l1',
    ])
  })

  it('has no project facet — picking a project is a link to its own page, not a filter', () => {
    expect(Object.keys(NO_FILTERS)).toEqual(['query', 'tags', 'statuses', 'workflows'])
  })

  it('ANDs across facets', () => {
    const picked = filterGlobalTasks(
      tasks,
      filters({ tags: ['storefront'], statuses: ['running'] }),
      'active',
    )
    expect(ids(picked)).toEqual(['a1'])
  })

  it('matches a tag on the PROJECT, so one tag reaches several repos', () => {
    expect(ids(filterGlobalTasks(tasks, filters({ tags: ['storefront'] }), 'active'))).toEqual([
      'a1',
      'w1',
    ])
  })

  it('matches a tag regardless of case', () => {
    expect(ids(filterGlobalTasks(tasks, filters({ tags: ['STOREFRONT'] }), 'active'))).toEqual([
      'a1',
      'w1',
    ])
  })

  it('finds the untagged projects through the sentinel', () => {
    expect(ids(filterGlobalTasks(tasks, filters({ tags: [UNTAGGED] }), 'active'))).toEqual(['l1'])
  })

  it('requires every query token, matching title, project, workflow, branch and tags', () => {
    expect(ids(filterGlobalTasks(tasks, filters({ query: 'checkout' }), 'active'))).toEqual([
      'a1',
      'w1',
    ])
    // Two tokens from two different fields: the project name and the title.
    expect(ids(filterGlobalTasks(tasks, filters({ query: 'web checkout' }), 'active'))).toEqual(['w1'])
    expect(ids(filterGlobalTasks(tasks, filters({ query: 'feat/checkout' }), 'active'))).toEqual(['a1'])
    expect(ids(filterGlobalTasks(tasks, filters({ query: 'infra' }), 'active'))).toEqual(['i1'])
  })

  it('does not match the run id — the table never prints it', () => {
    expect(filterGlobalTasks(tasks, filters({ query: 'a1' }), 'active')).toEqual([])
  })
})

describe('groupGlobalTasks', () => {
  const active = filterGlobalTasks(tasks, NO_FILTERS, 'active')

  it('renders one unlabeled group when grouping is off', () => {
    const groups = groupGlobalTasks(active, 'none')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.label).toBe('')
    expect(ids(groups[0]!.tasks)).toEqual(['a1', 'w1', 'i1', 'l1'])
  })

  it('fans a task out across every tag its project carries', () => {
    const groups = groupGlobalTasks(active, 'tag')
    expect(groups.map((group) => group.label)).toEqual([
      'storefront', // 2 tasks — biggest first
      'backend',
      'infra',
      'Untagged', // always last: leftovers, not a group
    ])
    expect(ids(groups.find((group) => group.label === 'storefront')!.tasks)).toEqual(['a1', 'w1'])
    expect(ids(groups.find((group) => group.label === 'backend')!.tasks)).toEqual(['a1'])
  })

  it('groups by project, status and workflow without fanning out', () => {
    expect(groupGlobalTasks(active, 'project').map((group) => group.label).sort()).toEqual([
      'API',
      'Infra',
      'Loose',
      'Web',
    ])
    const byStatus = groupGlobalTasks(active, 'status')
    expect(byStatus.reduce((total, group) => total + group.tasks.length, 0)).toBe(active.length)
    expect(groupGlobalTasks(active, 'workflow').map((group) => group.key).sort()).toEqual([
      'plan-first',
      'quick-task',
    ])
  })
})

describe('facet counts', () => {
  it('counts a facet against the list the OTHER facets leave', () => {
    // Tags are pinned to `storefront`; the workflow counts must reflect that, so a workflow with
    // no storefront work says 0 instead of promising rows that are not there.
    const current = filters({ tags: ['storefront'] })
    const counts = facetCounts(
      tasksExcludingFacet(tasks, current, 'active', 'workflows'),
      (task) => [task.run.workflow],
    )
    expect(counts.get('plan-first')).toBe(1)
    expect(counts.get('quick-task')).toBe(1)
    // `i1`/`l1` are outside the storefront tag, so their workflow does not count twice.
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(2)
  })

  it('counts the untagged bucket through the same value function the filter uses', () => {
    const counts = facetCounts(filterGlobalTasks(tasks, NO_FILTERS, 'active'), tagValuesOf)
    expect(counts.get('storefront')).toBe(2)
    expect(counts.get(UNTAGGED)).toBe(1)
  })

  it('excludes only the named facet, keeping the rest applied', () => {
    const current = filters({ statuses: ['done'], tags: [UNTAGGED] })
    // Dropping the status facet leaves the tag one in force.
    expect(ids(tasksExcludingFacet(tasks, current, 'active', 'statuses'))).toEqual(['l1'])
  })
})

describe('group-by is a toggle, not a radio', () => {
  it('offers no "None" option — nothing pressed IS not grouped', () => {
    expect(GROUP_BY_OPTIONS.map((option) => option.value)).toEqual([
      'project',
      'tag',
      'status',
      'workflow',
    ])
  })

  it('turns a grouping on, and releases it when it is already the one in force', () => {
    expect(toggleGroupBy('none', 'tag')).toBe('tag')
    expect(toggleGroupBy('tag', 'tag')).toBe('none')
    // Pressing a different one switches rather than releasing.
    expect(toggleGroupBy('tag', 'project')).toBe('project')
  })
})

describe('filter state helpers', () => {
  it('toggles a value in and out without mutating', () => {
    const before = ['a']
    expect(toggleFacetValue(before, 'b')).toEqual(['a', 'b'])
    expect(toggleFacetValue(before, 'a')).toEqual([])
    expect(before).toEqual(['a'])
  })

  it('counts only facet values, not the query', () => {
    expect(activeFacetCount(filters({ query: 'x' }))).toBe(0)
    expect(activeFacetCount(filters({ tags: ['a'], statuses: ['b'], workflows: ['c'] }))).toBe(3)
  })

  it('treats a non-empty query as an active filter', () => {
    expect(hasActiveFilters(NO_FILTERS)).toBe(false)
    expect(hasActiveFilters(filters({ query: '  ' }))).toBe(false)
    expect(hasActiveFilters(filters({ query: 'x' }))).toBe(true)
    expect(hasActiveFilters(filters({ tags: [UNTAGGED] }))).toBe(true)
  })
})

describe('canReset / resetCount', () => {
  it('covers a grouping applied with no filters at all', () => {
    // Otherwise the button hides and the table sits boxed up with nothing to click.
    expect(canReset({ filters: NO_FILTERS, groupBy: 'none' })).toBe(false)
    expect(canReset({ filters: NO_FILTERS, groupBy: 'tag' })).toBe(true)
    expect(canReset({ filters: filters({ tags: ['a'] }), groupBy: 'none' })).toBe(true)
    expect(canReset({ filters: filters({ query: 'x' }), groupBy: 'none' })).toBe(true)
  })

  it('counts every narrowing the button will undo, grouping and query included', () => {
    // The reported bug: one tag plus a grouping is TWO things applied, and the button said (1).
    expect(resetCount({ filters: filters({ tags: ['a'] }), groupBy: 'tag' })).toBe(2)
    expect(resetCount({ filters: NO_FILTERS, groupBy: 'none' })).toBe(0)
    expect(resetCount({ filters: filters({ query: 'x' }), groupBy: 'none' })).toBe(1)
    // Whitespace is not a filter.
    expect(resetCount({ filters: filters({ query: '  ' }), groupBy: 'none' })).toBe(0)
    expect(
      resetCount({
        filters: filters({ query: 'x', tags: ['a', 'b'], statuses: ['done'] }),
        groupBy: 'project',
      }),
    ).toBe(5)
  })
})

describe('URL state', () => {
  const state = (over: Partial<GlobalTasksUrlState> = {}): GlobalTasksUrlState => ({
    ...DEFAULT_URL_STATE,
    ...over,
  })
  const roundTrip = (over: Partial<GlobalTasksUrlState> = {}) =>
    urlStateFromSearchParams(urlStateToSearchParams(state(over)))

  it('emits nothing for a bare page, so /tasks stays a bare /tasks', () => {
    expect(urlStateToSearchParams(DEFAULT_URL_STATE).toString()).toBe('')
  })

  it('round-trips every facet, the grouping and the view', () => {
    const over = {
      filters: {
        query: 'checkout',
        tags: ['storefront', 'infra'],
        statuses: ['running', 'review'],
        workflows: ['plan-first'],
      },
      groupBy: 'tag' as const,
      view: 'archived' as const,
    }
    expect(roundTrip(over)).toEqual(state(over))
  })

  it('repeats a key per value rather than joining them', () => {
    // A separator would be breakable by a tag that contains it; repeating cannot be.
    const params = urlStateToSearchParams(state({ filters: filters({ tags: ['a,b', 'c'] }) }))
    expect(params.getAll(SEARCH_PARAMS.tag)).toEqual(['a,b', 'c'])
  })

  it('carries the untagged bucket as its own flag', () => {
    // Not a `tag` value: the sentinel's leading space would serialize confusingly, and spelled
    // without it, it would be ambiguous with a repo actually tagged `untagged`.
    const params = urlStateToSearchParams(state({ filters: filters({ tags: [UNTAGGED, 'infra'] }) }))
    expect(params.get(SEARCH_PARAMS.untagged)).toBe('1')
    expect(params.getAll(SEARCH_PARAMS.tag)).toEqual(['infra'])
    expect(urlStateFromSearchParams(params).filters.tags).toEqual(['infra', UNTAGGED])
  })

  it('spells only the archived view, because active is the default', () => {
    expect(urlStateToSearchParams(state({ view: 'active' })).has(SEARCH_PARAMS.archived)).toBe(false)
    expect(urlStateToSearchParams(state({ view: 'archived' })).get(SEARCH_PARAMS.archived)).toBe('1')
    expect(urlStateFromSearchParams(new URLSearchParams('archived=1')).view).toBe('archived')
    expect(urlStateFromSearchParams(new URLSearchParams('')).view).toBe('active')
  })

  it('trims the query and omits an empty one', () => {
    expect(urlStateToSearchParams(state({ filters: filters({ query: '   ' }) })).toString()).toBe('')
    expect(
      urlStateToSearchParams(state({ filters: filters({ query: '  hi  ' }) })).get(
        SEARCH_PARAMS.query,
      ),
    ).toBe('hi')
  })

  it('omits the grouping when there is none, and names it when there is', () => {
    expect(urlStateToSearchParams(DEFAULT_URL_STATE).has(SEARCH_PARAMS.groupBy)).toBe(false)
    expect(urlStateToSearchParams(state({ groupBy: 'project' })).get(SEARCH_PARAMS.groupBy)).toBe(
      'project',
    )
  })

  it('forgives whatever a pasted or hand-edited URL carries', () => {
    // An unknown grouping is not grouped — never a blank page.
    expect(urlStateFromSearchParams(new URLSearchParams('group=bogus')).groupBy).toBe('none')
    expect(urlStateFromSearchParams(new URLSearchParams(''))).toEqual(DEFAULT_URL_STATE)
    // Empty values are dropped rather than becoming a filter matching nothing.
    expect(urlStateFromSearchParams(new URLSearchParams('tag=&status=')).filters).toEqual(NO_FILTERS)
    expect(urlStateFromSearchParams(new URLSearchParams('untagged=yes')).filters.tags).toEqual([])
    // Anything but the exact flag is the default view.
    expect(urlStateFromSearchParams(new URLSearchParams('archived=yes')).view).toBe('active')
  })
})

describe('truncatedProjectNames', () => {
  it('names the capped projects, falling back to the raw id', () => {
    expect(truncatedProjectNames(['api', 'gone'], PROJECTS)).toEqual(['API', 'gone'])
  })
})
