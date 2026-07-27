import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'

import { COMMIT_VIRTUALIZE_THRESHOLD, CommitList, type CommitListItem } from './commit-list'

/**
 * The commit log's two rendering tiers. Same shape as the diff's tests: jsdom lays nothing
 * out, so virtua can be observed mounting but not windowing — what is pinned here is the
 * threshold switch and that the flat tier keeps every row skippable.
 */

beforeEach(() => {
  // virtua measures with a ResizeObserver; jsdom has none and never lays anything out.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const commits = (count: number): CommitListItem[] =>
  Array.from({ length: count }, (_, index) => ({
    sha: `sha${index}`,
    shaLabel: `sha${index}`.slice(0, 8),
    subject: `commit ${index}`,
    author: 'ada',
    when: '2h ago',
    href: `/git/commits/sha${index}`,
  }))

function renderList(count: number) {
  return render(
    <MemoryRouter>
      <CommitList slot="repo-commits" commits={commits(count)} />
    </MemoryRouter>,
  )
}

describe('CommitList', () => {
  it('renders every row flat below the threshold, each content-visibility hinted', () => {
    renderList(5)

    const list = document.querySelector('[data-slot="repo-commits"]')!
    expect(list.getAttribute('data-virtualized')).toBe('false')
    expect(document.querySelectorAll('[data-slot="commit-row"]')).toHaveLength(5)
    expect(list.firstElementChild!.className).toContain('[content-visibility:auto]')
  })

  it('links each row to its commit diff, labelled by sha and subject', () => {
    renderList(2)

    const first = document.querySelector<HTMLAnchorElement>('[data-slot="commit-row"]')!
    expect(first.getAttribute('href')).toBe('/git/commits/sha0')
    expect(first.dataset.sha).toBe('sha0')
    expect(first.textContent).toContain('commit 0')
    expect(first.textContent).toContain('ada')
  })

  it('switches to virtua past the threshold, bounding the DOM', () => {
    renderList(COMMIT_VIRTUALIZE_THRESHOLD + 1)

    expect(document.querySelector('[data-slot="repo-commits"]')!.getAttribute('data-virtualized')).toBe('true')
    // The whole point: hundreds of commits, and virtua mounts only its window (none, under
    // jsdom's zero-height viewport) rather than every row.
    expect(document.querySelectorAll('[data-slot="commit-row"]').length).toBeLessThan(
      COMMIT_VIRTUALIZE_THRESHOLD,
    )
  })

  it('stays flat exactly at the threshold', () => {
    renderList(COMMIT_VIRTUALIZE_THRESHOLD)

    expect(document.querySelector('[data-slot="repo-commits"]')!.getAttribute('data-virtualized')).toBe('false')
  })
})
