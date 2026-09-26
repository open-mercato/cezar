import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Feed } from './feed'
import { DashboardEntryContext } from './state'
vi.mock('@/api/dashboard', () => ({ useDashboardFeed: () => ({
  data: { rows: [], sources: [], coverage: { projects: [] } },
}) }))
afterEach(cleanup)
function view(entry: string, filter: 'all' | 'tasks' = 'all') {
  return <DashboardEntryContext.Provider value={entry}>
    <Feed filter={filter} setFilter={vi.fn()} count={6} more={vi.fn()} />
  </DashboardEntryContext.Provider>
}
it('restores the feed inner scroll on return to the same history entry', () => {
  const first = render(view('scroll-back'))
  const region = screen.getByRole('region', { name: 'Recent results list' })
  region.scrollTop = 352
  fireEvent.scroll(region)
  first.unmount()
  render(view('scroll-back'))
  expect(screen.getByRole('region', { name: 'Recent results list' }).scrollTop).toBe(352)
})
it('keeps feed filter and history entry scroll positions independent', () => {
  const mounted = render(view('scroll-filters'))
  const region = screen.getByRole('region', { name: 'Recent results list' })
  region.scrollTop = 125
  fireEvent.scroll(region)
  mounted.rerender(view('scroll-filters', 'tasks'))
  expect(region.scrollTop).toBe(0)
  region.scrollTop = 240
  fireEvent.scroll(region)
  mounted.rerender(view('scroll-filters'))
  expect(region.scrollTop).toBe(125)
  mounted.unmount()
  render(view('new-entry'))
  expect(screen.getByRole('region', { name: 'Recent results list' }).scrollTop).toBe(0)
})
it('accepts a clamped position when refreshed results shrink, then remembers user scrolling', () => {
  const first = render(view('scroll-shrink'))
  let region = screen.getByRole('region', { name: 'Recent results list' })
  region.scrollTop = 352
  fireEvent.scroll(region)
  first.unmount()
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!
  const positions = new WeakMap<Element, number>()
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get() { return positions.get(this) ?? 0 },
    set(value: number) { positions.set(this, Math.min(100, value)) },
  })
  try {
    const second = render(view('scroll-shrink'))
    region = screen.getByRole('region', { name: 'Recent results list' })
    expect(region.scrollTop).toBe(100)
    region.scrollTop = 20
    fireEvent.scroll(region)
    second.unmount()
    render(view('scroll-shrink'))
    expect(screen.getByRole('region', { name: 'Recent results list' }).scrollTop).toBe(20)
  } finally {
    cleanup()
    Object.defineProperty(Element.prototype, 'scrollTop', descriptor)
  }
})
