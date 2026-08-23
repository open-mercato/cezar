import { describe, expect, it } from 'vitest'

import { NAV_ITEMS, activeNavItem, activeNavPath, visibleNavItems } from './nav-items'

/** Which nav item owns a URL. This is the rule that decides what the user sees lit up, and it
 *  is not a plain equality check — items own areas, and the Settings area nests. */
describe('activeNavPath', () => {
  const cases: Array<[pathname: string, active: string | null]> = [
    // Tasks owns the overview *and* every task surface (spec: "clicking a row opens
    // /tasks/:id with Tasks still active").
    ['/', '/'],
    ['/tasks/abc123', '/'],
    ['/tasks/abc123/changes', '/'],
    ['/tasks/abc123/files', '/'],
    ['/compare/grp-1', '/'],

    ['/inbox', '/inbox'],
    ['/git', '/git'],
    ['/github', '/github'],
    ['/github/issues/42', '/github'],
    ['/github/prs/7', '/github'],
    ['/workflows', '/workflows'],
    ['/workflows/ship-it', '/workflows'],

    // Skills is its own top-level surface now (was /settings/skills).
    ['/skills', '/skills'],

    // The nested Settings area: deeper routes fall to the Settings item.
    ['/settings', '/settings'],
    ['/settings/appearance', '/settings'],
    ['/settings/agents', '/settings'],

    // Full-screen surfaces with no nav home — nothing may light up.
    ['/new', null],
    ['/nope-404', null],
  ]

  for (const [pathname, active] of cases) {
    it(`${pathname} → ${active ?? 'no active item'}`, () => {
      expect(activeNavPath(pathname)).toBe(active)
    })
  }

  // A `startsWith` implementation passes every case above and still fails these two.
  it('does not let /git claim the /github area', () => {
    expect(activeNavPath('/github')).toBe('/github')
  })

  it('does not let the root item claim every route', () => {
    expect(activeNavPath('/git')).toBe('/git')
  })
})

describe('activeNavItem', () => {
  it('returns the item, so the mobile bar can title itself', () => {
    expect(activeNavItem('/tasks/abc123')?.label).toBe('Tasks')
    expect(activeNavItem('/skills')?.label).toBe('Skills')
  })

  it('returns null off-nav', () => {
    expect(activeNavItem('/new')).toBeNull()
  })
})

describe('NAV_ITEMS', () => {
  it('is the nav from the spec, in mockup order', () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      'Tasks',
      'Inbox',
      'Git',
      'GitHub',
      'Automations',
      'Skills',
      'Workflows',
      'Settings',
    ])
  })

  // Every item must be reachable by its own URL, or a click would navigate somewhere that
  // does not light the item the user just clicked.
  it('each item is the active item for its own `to`', () => {
    for (const item of NAV_ITEMS) {
      expect(activeNavPath(item.to)).toBe(item.to)
    }
  })
})

/** The gates: the GitHub item exists exactly while health reports the forge driver (R6 Step 1.1),
 *  the Inbox item exactly while it reports the opt-in `capabilities.followups` (#471), and the
 *  Automations item exactly while it reports a forge AND the opt-in `capabilities.automations`
 *  (#801). Each gate owns ONLY its own item, and all default to absent while health is unknown. */
describe('visibleNavItems', () => {
  const labelsOf = (opts?: Parameters<typeof visibleNavItems>[0]) =>
    visibleNavItems(opts).map((item) => item.label)

  it('with everything available, the full nav renders', () => {
    expect(visibleNavItems({ forge: true, inbox: true, automations: true })).toEqual(NAV_ITEMS)
  })

  it('without a forge, the GitHub AND Automations items drop out', () => {
    expect(labelsOf({ forge: false, inbox: true, automations: true })).toEqual([
      'Tasks',
      'Inbox',
      'Git',
      'Skills',
      'Workflows',
      'Settings',
    ])
  })

  it('without the inbox, exactly the Inbox item drops out (#471)', () => {
    expect(labelsOf({ forge: true, inbox: false, automations: true })).toEqual([
      'Tasks',
      'Git',
      'GitHub',
      'Automations',
      'Skills',
      'Workflows',
      'Settings',
    ])
  })

  it('without the automations opt-in, exactly the Automations item drops out (#801)', () => {
    expect(labelsOf({ forge: true, inbox: true, automations: false })).toEqual([
      'Tasks',
      'Inbox',
      'Git',
      'GitHub',
      'Skills',
      'Workflows',
      'Settings',
    ])
  })

  // The two gates on that one item are ANDed: a forge alone does not resurrect it, which is the
  // whole point of #801 — every project with a GitHub remote used to see the tab.
  it('a forge alone does not bring Automations back', () => {
    expect(labelsOf({ forge: true, inbox: false })).not.toContain('Automations')
  })

  it('drops all three when nothing is available', () => {
    expect(labelsOf({ forge: false, inbox: false, automations: false })).toEqual([
      'Tasks',
      'Git',
      'Skills',
      'Workflows',
      'Settings',
    ])
  })

  it('defaults to absent — the nav claims nothing before health answers', () => {
    expect(labelsOf()).toEqual(labelsOf({ forge: false, inbox: false, automations: false }))
  })

  it('never invents an item — the result is always a subset of NAV_ITEMS, in order', () => {
    for (const forge of [true, false]) {
      for (const inbox of [true, false]) {
        for (const automations of [true, false]) {
          const items = visibleNavItems({ forge, inbox, automations })
          expect(NAV_ITEMS.filter((i) => items.includes(i))).toEqual(items)
        }
      }
    }
  })
})
