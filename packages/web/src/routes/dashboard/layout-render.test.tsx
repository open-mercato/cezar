import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { DashboardLayout } from './layout'
import type { TileId } from './preferences'
afterEach(cleanup)
function layout(ids: TileId[]) {
  render(
    <DashboardLayout
      order={ids}
      modules={Object.fromEntries(ids.map((id) => [id, <div key={id}>{id}</div>]))}
      onOrder={() => {}}
    />,
  )
  return (id: TileId) =>
    document
      .querySelector(`[data-dashboard-module="${id}"]`)!
      .classList.contains('lg:col-span-2')
}
it('pairs adjacent compact widgets and expands an unpaired one before a table', () => {
  const wide = layout(['overview', 'needsYou', 'recent', 'fleet', 'automations', 'portfolio'])
  expect(wide('fleet')).toBe(false)
  expect(wide('automations')).toBe(false)
  cleanup()
  const single = layout(['overview', 'automations', 'portfolio'])
  expect(single('automations')).toBe(true)
})
it('preserves custom order without leaving half-empty rows around wide modules', () => {
  const wide = layout(['fleet', 'portfolio', 'needsYou', 'recent', 'automations'])
  expect(wide('fleet')).toBe(true)
  expect(wide('needsYou')).toBe(false)
  expect(wide('recent')).toBe(false)
  expect(wide('automations')).toBe(true)
  expect(
    [...document.querySelectorAll('[data-dashboard-module]')].map((el) =>
      el.getAttribute('data-dashboard-module'),
    ),
  ).toEqual(['fleet', 'portfolio', 'needsYou', 'recent', 'automations'])
})
