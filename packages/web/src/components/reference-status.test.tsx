import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { REFERENCE_STATUS_MAX } from '@open-mercato/cezar-api-client'

import {
  __clearRememberedStatusesForTests,
  restoreRememberedStatuses,
  type ReferenceStatusRequest,
} from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { ReferenceChip } from './reference-chip'
import { ReferenceStatusProvider, ReferenceStatusRegistry } from './reference-status'

/**
 * The batching seam under the chips, and the two things it must get right beyond "fetch a status":
 *
 *  - a chip that HAS a status must not lose it when the batch is re-keyed. The query key is the
 *    whole visible set, so typing in a search box, a poll that adds a row, or switching tabs all
 *    mint a cold cache entry — and every chip on screen used to blank until the round trip
 *    finished. Bug report: "sometimes statuses just change to [the plain violet chip]".
 *  - a chip with NO status must say why. Loading, unreachable and not-found looked identical and
 *    silent; each is a different thing to do about it.
 */

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

let answers: unknown[] = []
let asked: string[] = []

beforeEach(() => {
  __clearRememberedStatusesForTests()
  asked = []
  // Re-stubbed per case rather than once: `vi.unstubAllGlobals()` in the teardown below takes
  // this with it. Radix's tooltip arrow measures itself with a ResizeObserver; jsdom has none.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      asked.push(String(input))
      // One scripted answer per request, so a test can make the SECOND fetch fail or hang.
      const next = answers.shift() ?? { available: false, reason: 'no answer scripted' }
      if (next === 'never') return new Promise<Response>(() => {}) // in flight forever
      // Every answer carries the server's recheck cadence; `null` = nothing here can change, which
      // is what keeps these cases from scheduling a refetch mid-assertion.
      return jsonResponse({ recheckAfterMs: null, ...(next as object) })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  answers = []
})

const PR = { kind: 'PR' as const, number: 774, url: 'https://github.com/acme/api/pull/774' }
const REQUESTS: ReferenceStatusRequest[] = [{ projectId: 'api', kind: 'PR', number: 774 }]

function renderChip(requests: readonly ReferenceStatusRequest[] = REQUESTS) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ReferenceStatusProvider projectId="api" requests={requests}>
        <ReferenceChip reference={PR} taskTitle="Add checkout" />
      </ReferenceStatusProvider>
    </QueryClientProvider>,
  )
}

const chip = () => document.querySelector('[data-slot="pr-chip"]')!

/** Opens the hover panel. Focus is the one trigger every input method shares, and it is
 *  idempotent, so calling this twice is safe. */
function openPanel(): void {
  fireEvent.focus(screen.getByRole('link'))
}

/**
 * What the open panel currently says — a SYNCHRONOUS read, deliberately.
 *
 * It used to open and await in one helper, which meant every assertion about it was a `waitFor`
 * wrapped around another `waitFor`. Nested like that the outer poll can hold React's act queue
 * long enough that a settling query never flushes inside it, and the case then fails on whatever
 * the panel said first — "Checking GitHub…" — rather than on what it settles to. Open once, poll
 * a plain read.
 */
const panelText = (): string =>
  document.querySelector('[data-slot="reference-status-card"]')?.textContent ?? ''

/** Open, then wait for the panel to say a thing. */
async function expectPanelToSay(fragment: string): Promise<void> {
  openPanel()
  await waitFor(() => expect(panelText()).toContain(fragment))
}

describe('a chip under a ReferenceStatusProvider', () => {
  it('paints the status the forge answered with', async () => {
    answers = [{ available: true, prs: { 774: 'merged' }, issues: {} }]
    renderChip()
    await waitFor(() => expect(chip().getAttribute('data-status')).toBe('merged'))
  })

  it('KEEPS that status when the batch is re-keyed', async () => {
    // The regression. The second render asks about a different set of numbers — exactly what a
    // keystroke in the search box does — so react-query has no data for the new key. The chip must
    // still show what was already learned about #774 rather than flickering back to neutral.
    answers = [{ available: true, prs: { 774: 'merged' }, issues: {} }, 'never']
    function Harness() {
      const [requests, setRequests] = useState<ReferenceStatusRequest[]>([...REQUESTS])
      return (
        <QueryClientProvider client={createQueryClient()}>
          <button
            type="button"
            onClick={() => setRequests([...REQUESTS, { projectId: 'api', kind: 'PR', number: 900 }])}
          >
            filter
          </button>
          <ReferenceStatusProvider projectId="api" requests={requests}>
            <ReferenceChip reference={PR} taskTitle="Add checkout" />
          </ReferenceStatusProvider>
        </QueryClientProvider>
      )
    }
    render(<Harness />)
    await waitFor(() => expect(chip().getAttribute('data-status')).toBe('merged'))

    fireEvent.click(screen.getByRole('button', { name: 'filter' }))

    // A new request went out for the widened set, and it is still in flight…
    await waitFor(() => expect(asked.length).toBe(2))
    // …and the chip has not moved.
    expect(chip().getAttribute('data-status')).toBe('merged')
  })

  it('finds the status even when the chip guessed the wrong KIND', async () => {
    // A repository numbers its issues and pull requests from one sequence, and `taskReferences`
    // infers the kind from whichever field carried the number — a bare `#774` can land in either.
    // The server files the answer under what the number really IS, so the chip has to read both
    // buckets or a mis-guessed kind reports "not found on this repository" for a live reference.
    answers = [{ available: true, prs: {}, issues: { 774: 'completed' } }]
    renderChip()

    await waitFor(() => expect(chip().getAttribute('data-status')).toBe('completed'))
  })

  it('keeps the last known status when the forge goes away, and says it is dated', async () => {
    answers = [{ available: true, prs: { 774: 'ready' }, issues: {} }]
    const { rerender } = renderChip()
    await waitFor(() => expect(chip().getAttribute('data-status')).toBe('ready'))

    // A second surface asks about the same PR while gh is broken.
    answers = [{ available: false, reason: 'gh CLI not found' }]
    rerender(
      <QueryClientProvider client={createQueryClient()}>
        <ReferenceStatusProvider projectId="api" requests={[...REQUESTS, { projectId: 'api', kind: 'Issue', number: 1 }]}>
          <ReferenceChip reference={PR} taskTitle="Add checkout" />
        </ReferenceStatusProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => expect(document.querySelector('[data-slot="pr-chip"]')).not.toBeNull())
    expect(chip().getAttribute('data-status')).toBe('ready')
    await expectPanelToSay('last known')
  })
})

describe('the conflict axis, from the wire to the chip', () => {
  it('paints the conflict over the status the same answer carried', async () => {
    // The reported case, end to end: green and unmergeable at once. `ready` is still what the
    // server said and stays on the element; what changes is the colour the chip is scanned by.
    answers = [{ available: true, prs: { 774: 'ready' }, issues: {}, conflicts: [774] }]
    renderChip()

    await waitFor(() => expect(chip().getAttribute('data-conflicting')).toBe('true'))
    expect(chip().getAttribute('data-status')).toBe('ready')
    expect(chip().className).toContain('text-conflict')
  })

  it('reads an absent `conflicts` as nothing known, not as "merges cleanly"', async () => {
    // What a server from before the field answers. The chip must look exactly as it did then.
    answers = [{ available: true, prs: { 774: 'ready' }, issues: {} }]
    renderChip()

    await waitFor(() => expect(chip().getAttribute('data-status')).toBe('ready'))
    expect(chip().getAttribute('data-conflicting')).toBeNull()
  })

  it('drops the conflict the moment the forge stops listing it', async () => {
    // Resolved conflicts are the common exit from this state, and a remembered flag that only ever
    // switched ON would leave the chip orange until the tab was closed.
    answers = [
      { available: true, prs: { 774: 'ready' }, issues: {}, conflicts: [774] },
      { available: true, prs: { 774: 'ready' }, issues: {}, conflicts: [] },
    ]
    const { rerender } = renderChip()
    await waitFor(() => expect(chip().getAttribute('data-conflicting')).toBe('true'))

    // A second surface asks about a wider set — a fresh key, a fresh answer, the same PR.
    rerender(
      <QueryClientProvider client={createQueryClient()}>
        <ReferenceStatusProvider projectId="api" requests={[...REQUESTS, { projectId: 'api', kind: 'Issue', number: 1 }]}>
          <ReferenceChip reference={PR} taskTitle="Add checkout" />
        </ReferenceStatusProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => expect(chip().getAttribute('data-conflicting')).toBeNull())
    expect(chip().getAttribute('data-status')).toBe('ready')
  })

  it('keeps the conflict while the forge is unreachable, exactly as it keeps the status', async () => {
    answers = [
      { available: true, prs: { 774: 'ready' }, issues: {}, conflicts: [774] },
      { available: false, reason: 'gh CLI not found' },
    ]
    const { rerender } = renderChip()
    await waitFor(() => expect(chip().getAttribute('data-conflicting')).toBe('true'))

    rerender(
      <QueryClientProvider client={createQueryClient()}>
        <ReferenceStatusProvider projectId="api" requests={[...REQUESTS, { projectId: 'api', kind: 'Issue', number: 1 }]}>
          <ReferenceChip reference={PR} taskTitle="Add checkout" />
        </ReferenceStatusProvider>
      </QueryClientProvider>,
    )

    await expectPanelToSay('last known')
    expect(chip().getAttribute('data-conflicting')).toBe('true')
  })
})

describe('a chip with no status says which kind of nothing it is', () => {
  it('explains an unreachable forge, with the server’s own reason', async () => {
    answers = [{ available: false, reason: 'gh CLI not found — install it and run `gh auth login`' }]
    renderChip()

    await expectPanelToSay('Status unavailable')
    expect(panelText()).toContain('gh CLI not found')
    expect(chip().getAttribute('data-status')).toBeNull()
  })

  it('explains a number the forge does not have', async () => {
    // Answered, available, and #774 simply is not in the map — usually a reference to another repo.
    answers = [{ available: true, prs: {}, issues: {} }]
    renderChip()

    await expectPanelToSay('Not found on this repository')
  })

  it('says it is still checking while the request is in flight', async () => {
    answers = ['never']
    renderChip()

    await expectPanelToSay('Checking GitHub')
  })

  it('names the URL in the tooltip, which the native title used to carry', async () => {
    answers = [{ available: true, prs: { 774: 'merged' }, issues: {} }]
    renderChip()
    await waitFor(() => expect(chip().getAttribute('data-status')).toBe('merged'))

    await expectPanelToSay('github.com/acme/api/pull/774')
    expect(chip().getAttribute('title')).toBeNull()
  })
})

describe('the app-root registry', () => {
  const chipFor = (number: number, projectId: string) => (
    <ReferenceStatusProvider projectId={projectId} requests={[{ projectId, kind: 'PR', number }]}>
      <ReferenceChip
        reference={{ kind: 'PR', number, url: `https://github.com/acme/${projectId}/pull/${number}` }}
        taskTitle={`task ${number}`}
      />
    </ReferenceStatusProvider>
  )

  it('collapses several surfaces into ONE request per project', async () => {
    // The sidebar, the table and an open run header all paint chips, often the same ones. Each
    // asking for itself was a round trip apiece and a staggered wave of colour.
    answers = [{ available: true, prs: { 1: 'merged', 2: 'ready' }, issues: {} }]
    render(
      <QueryClientProvider client={createQueryClient()}>
        <ReferenceStatusRegistry>
          {chipFor(1, 'api')}
          {chipFor(2, 'api')}
        </ReferenceStatusRegistry>
      </QueryClientProvider>,
    )

    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="pr-chip"][data-status]')).toHaveLength(2),
    )
    const refStatusCalls = asked.filter((path) => path.includes('/github/ref-status'))
    expect(refStatusCalls).toHaveLength(1)
    expect(refStatusCalls[0]).toContain('prs=1%2C2')
  })

  it('still asks per project, since the route is project-scoped', async () => {
    answers = [
      { available: true, prs: { 1: 'merged' }, issues: {} },
      { available: true, prs: { 2: 'ready' }, issues: {} },
    ]
    render(
      <QueryClientProvider client={createQueryClient()}>
        <ReferenceStatusRegistry>
          {chipFor(1, 'api')}
          {chipFor(2, 'web')}
        </ReferenceStatusRegistry>
      </QueryClientProvider>,
    )

    await waitFor(() => expect(asked.filter((p) => p.includes('/github/ref-status'))).toHaveLength(2))
    expect(asked.some((p) => p.includes('/p/api/'))).toBe(true)
    expect(asked.some((p) => p.includes('/p/web/'))).toBe(true)
  })

  it('keeps the NEWEST references when a project overruns the request cap', async () => {
    // The route 400s past `REFERENCE_STATUS_MAX` numbers of one kind, so a surface with more
    // references than that has to drop some — and which ones is not arbitrary. Numbers grow over
    // a repository's life, so the tail worth losing is the oldest; dropping the newest would take
    // the status off exactly the rows somebody is looking at. The list is still sent ascending, so
    // two orderings of one window stay one cache entry.
    const numbers = Array.from({ length: REFERENCE_STATUS_MAX + 5 }, (_, index) => index + 1)
    answers = [{ available: true, prs: {}, issues: {} }]
    render(
      <QueryClientProvider client={createQueryClient()}>
        <ReferenceStatusProvider
          projectId="api"
          requests={numbers.map((number) => ({ projectId: 'api', kind: 'PR' as const, number }))}
        >
          <ReferenceChip reference={PR} taskTitle="Add checkout" />
        </ReferenceStatusProvider>
      </QueryClientProvider>,
    )

    const call = await waitFor(() => {
      const found = asked.find((path) => path.includes('/github/ref-status'))
      if (!found) throw new Error('no ref-status request yet')
      return found
    })
    const sent = new URL(call, 'http://localhost').searchParams.get('prs')!.split(',').map(Number)
    expect(sent).toHaveLength(REFERENCE_STATUS_MAX)
    expect(sent[sent.length - 1]).toBe(REFERENCE_STATUS_MAX + 5) // the newest survived
    expect(sent[0]).toBe(6) // the five oldest are what the cap dropped
    expect([...sent].sort((a, b) => a - b)).toEqual(sent) // ascending, so the key is stable
  })

  it('lets a surface with no registry above it fetch for itself', async () => {
    // Mounting the registry is an optimisation, never a requirement — a bare render still works.
    answers = [{ available: true, prs: { 774: 'merged' }, issues: {} }]
    renderChip()
    await waitFor(() => expect(chip().getAttribute('data-status')).toBe('merged'))
  })
})

describe('statuses survive a reload', () => {
  it('repaints from sessionStorage instead of flashing neutral', async () => {
    // The flicker one level up from the re-keyed batch: a refresh had every chip go neutral and
    // then colour in a beat later, for statuses already sitting on this machine.
    answers = [{ available: true, prs: { 774: 'merged' }, issues: {} }]
    renderChip()
    await waitFor(() => expect(chip().getAttribute('data-status')).toBe('merged'))
    // The save is coalesced behind a timer; let it land.
    await waitFor(() => expect(window.sessionStorage.getItem('cez.reference-statuses.v1')).toContain('merged'))

    const persisted = window.sessionStorage.getItem('cez.reference-statuses.v1')!
    expect(JSON.parse(persisted)).toContainEqual(['api\u0000PR#774', 'merged'])
  })

  it('reads them back at load, and shrugs off a payload it cannot use', () => {
    // `restoreRememberedStatuses` runs once at module load — not a moment a test can observe, so
    // it is exercised directly. Everything here is best-effort: a corrupt or future-version
    // payload must degrade to "nothing remembered", never break the cockpit.
    window.sessionStorage.setItem('cez.reference-statuses.v1', JSON.stringify([['api\u0000PR#774', 'merged']]))
    expect(restoreRememberedStatuses()).toEqual([['api\u0000PR#774', 'merged']])

    window.sessionStorage.setItem('cez.reference-statuses.v1', 'not json at all')
    expect(restoreRememberedStatuses()).toEqual([])

    window.sessionStorage.setItem('cez.reference-statuses.v1', JSON.stringify({ shape: 'from a later version' }))
    expect(restoreRememberedStatuses()).toEqual([])

    window.sessionStorage.setItem('cez.reference-statuses.v1', JSON.stringify([['ok', 'merged'], ['bad'], 42]))
    expect(restoreRememberedStatuses()).toEqual([['ok', 'merged']])
  })

  it('drops a status this bundle has never heard of', () => {
    // `sessionStorage` outlives a reload in the same tab, so a newer cockpit's payload can be
    // read back by an older one after a rollback. The vocabulary is additive by contract, and
    // "additive" has to mean the unknown value is forgotten here rather than painted with a
    // presentation that does not exist.
    window.sessionStorage.setItem(
      'cez.reference-statuses.v1',
      JSON.stringify([
        ['api PR#774', 'merged'],
        ['api PR#775', 'queued-for-merge'],
      ]),
    )
    expect(restoreRememberedStatuses()).toEqual([['api PR#774', 'merged']])
  })

  it('paints a status from a LATER server as the neutral chip, not a crash', async () => {
    // The same additive promise from the other direction: an open tab holding an older bundle
    // when the server upgrades receives values it cannot describe, and `unwrap` does not
    // re-validate the payload against the contract.
    answers = [{ available: true, prs: { 774: 'queued-for-merge' }, issues: {} }]
    renderChip()

    await waitFor(() => expect(chip().getAttribute('data-status')).toBe('queued-for-merge'))
    expect(chip().className).toContain('text-violet')
    expect(chip().getAttribute('aria-label')).toBe('Open the pull request for Add checkout')
  })
})
