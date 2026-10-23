import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import type { ApiRun, RunArtifact, RunArtifactsResponse } from '@open-mercato/cezar-api-client'

import { ARTIFACT_IFRAME_SANDBOX, defaultArtifact, readViewFocus } from './assets-model'
import { exitSidebarRail, useSidebarRail } from '@/lib/sidebar-rail'
import { ASSETS_EMPTY_SUBTITLE, ASSETS_EMPTY_TITLE, AssetsView } from './assets-view'

// The docked composer delivers through the chat's own seam; pinned here as a spy.
const seam = vi.hoisted(() => ({ deliver: vi.fn(async (_text: string, _images: unknown[]) => undefined) }))
vi.mock('../task-thread/deliver-prompt', () => ({ useDeliverPrompt: () => seam.deliver }))
vi.mock('../task-thread/follow-up-engine', () => ({
  useContinueAction: () => ({ available: true, canContinue: true, providerPending: false, pills: null, continueWith: vi.fn() }),
}))
vi.mock('../task-thread/active-provider', () => ({ useActiveProviderAvailability: () => ({ usable: true }) }))

const art = (name: string, kind: RunArtifact['kind'], updatedAt: string, title?: string): RunArtifact => ({
  name,
  kind,
  size: 100,
  updatedAt,
  ...(title ? { title } : {}),
})

const DEMO = art('demo.html', 'html', '2026-10-22T10:00:00.000Z', 'Dry-run demo')
const NOTES = art('notes.md', 'markdown', '2026-10-22T11:00:00.000Z', 'Notes')
const SHOT = art('shot.png', 'image', '2026-10-22T09:00:00.000Z')
const BLOB = art('data.bin', 'other', '2026-10-22T08:00:00.000Z')
const DATA = art('data.json', 'json', '2026-10-22T07:00:00.000Z')

let listing: RunArtifactsResponse

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/runs/r1/artifacts')) {
        return new Response(JSON.stringify(listing), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (path.endsWith('/artifacts/notes.md')) return new Response('# Hello notes\n\nBody text.', { status: 200 })
      if (path.endsWith('/artifacts/data.json')) return new Response('{"a": 1}', { status: 200 })
      return new Response('not found', { status: 404 })
    }),
  )
}

function Where() {
  return (
    <>
      <span data-testid="where">{useLocation().pathname}</span>
      <span data-testid="rail">{String(useSidebarRail())}</span>
    </>
  )
}

function mount(path = '/tasks/r1/assets', routed = true, run?: ApiRun) {
  const client = createQueryClient()
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/tasks/:id/assets/:name?" element={<><AssetsView runId="r1" routed={routed} run={run} /><Where /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...view, client }
}

function RailProbe() {
  return <span data-testid="rail-after">{String(useSidebarRail())}</span>
}

const frame = () => document.querySelector<HTMLIFrameElement>('[data-slot="assets-frame"]')

beforeEach(() => {
  localStorage.clear()
  listing = { artifacts: [SHOT, DEMO, NOTES], truncated: false }
  stubFetch()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('defaultArtifact', () => {
  it('prefers impact.html, then the newest HTML page, then the newest file', () => {
    const impact = art('impact.html', 'html', '2026-01-01T00:00:00.000Z')
    expect(defaultArtifact([DEMO, impact, NOTES])?.name).toBe('impact.html')
    expect(defaultArtifact([SHOT, DEMO, NOTES])?.name).toBe('demo.html')
    expect(defaultArtifact([SHOT, NOTES])?.name).toBe('notes.md')
    expect(defaultArtifact([])).toBeUndefined()
  })
})

describe('AssetsView', () => {
  it('frames HTML with exactly the sandbox tokens — never allow-same-origin — and the theme fragment', async () => {
    mount()
    await waitFor(() => expect(frame()).not.toBeNull())
    const iframe = frame()!
    const tokens = (iframe.getAttribute('sandbox') ?? '').split(/\s+/).sort()
    expect(tokens).toEqual(['allow-popups', 'allow-popups-to-escape-sandbox', 'allow-scripts'])
    expect(ARTIFACT_IFRAME_SANDBOX).not.toContain('allow-same-origin')
    expect(iframe.hasAttribute('srcdoc')).toBe(false)
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(iframe.getAttribute('title')).toBe('Dry-run demo')
    expect(iframe.getAttribute('src')).toMatch(/^\/api\/v1\/runs\/r1\/artifacts\/demo\.html#theme=(dark|light)$/)
    expect(screen.getByText('sandboxed')).toBeTruthy()
  })

  it('opens the asset the URL names, and the switcher writes the choice back into the URL', async () => {
    mount('/tasks/r1/assets/notes.md')
    await screen.findByText('Hello notes')
    expect(frame()).toBeNull()

    const trigger = screen.getByRole('button', { name: /switch asset/ })
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    const item = await waitFor(() => {
      const found = document.querySelector('[data-asset="demo.html"]')
      if (!found) throw new Error('menu not open')
      return found as HTMLElement
    })
    fireEvent.click(item)

    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/tasks/r1/assets/demo.html'))
    await waitFor(() => expect(frame()).not.toBeNull())
  })

  it('keeps the selection local when the view shares its layout', async () => {
    mount('/tasks/r1/assets', false)
    await waitFor(() => expect(frame()).not.toBeNull())
    fireEvent.pointerDown(screen.getByRole('button', { name: /switch asset/ }), { button: 0, ctrlKey: false })
    const item = await waitFor(() => {
      const found = document.querySelector('[data-asset="notes.md"]')
      if (!found) throw new Error('menu not open')
      return found as HTMLElement
    })
    fireEvent.click(item)
    await screen.findByText('Hello notes')
    expect(screen.getByTestId('where').textContent).toBe('/tasks/r1/assets')
  })

  it('says so honestly when the run published nothing', async () => {
    listing = { artifacts: [], truncated: false }
    mount()
    expect(await screen.findByText(ASSETS_EMPTY_TITLE)).toBeTruthy()
    expect(screen.getByText(ASSETS_EMPTY_SUBTITLE)).toBeTruthy()
    expect(frame()).toBeNull()
  })

  it('renders an image inline, JSON as source and anything else as a download', async () => {
    listing = { artifacts: [SHOT, DATA, BLOB], truncated: false }
    const { unmount } = mount('/tasks/r1/assets/shot.png')
    const img = await waitFor(() => {
      const found = document.querySelector<HTMLImageElement>('[data-slot="assets-image"]')
      if (!found) throw new Error('no image')
      return found
    })
    expect(img.getAttribute('src')).toBe('/api/v1/runs/r1/artifacts/shot.png')
    unmount()

    const json = mount('/tasks/r1/assets/data.json')
    await waitFor(() => expect(document.querySelector('[data-slot="assets-json"]')?.textContent).toContain('"a"'))
    json.unmount()

    mount('/tasks/r1/assets/data.bin')
    expect(await screen.findByText('No preview for this file')).toBeTruthy()
    const download = document.querySelector('[data-action="assets-download-file"]')
    expect(download?.getAttribute('href')).toBe('/api/v1/runs/r1/artifacts/data.bin')
    expect(download?.getAttribute('download')).toBe('data.bin')
  })

  it('reloads the frame when the open asset is rewritten (a new listing from SSE)', async () => {
    const { client } = mount()
    await waitFor(() => expect(frame()).not.toBeNull())
    const before = frame()
    act(() => {
      client.setQueryData(queryKeys.runs.artifacts('r1'), {
        artifacts: [SHOT, { ...DEMO, updatedAt: '2026-10-22T12:00:00.000Z' }, NOTES],
        truncated: false,
      })
    })
    await waitFor(() => expect(frame()).not.toBe(before))
    expect(frame()).not.toBeNull()
  })

  it('Reload remounts the frame; Open and Download point at the raw URL', async () => {
    mount()
    await waitFor(() => expect(frame()).not.toBeNull())
    const before = frame()
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(frame()).not.toBe(before)
    const open = document.querySelector('[data-action="assets-open"]')
    expect(open?.getAttribute('href')).toBe('/api/v1/runs/r1/artifacts/demo.html')
    expect(open?.getAttribute('target')).toBe('_blank')
    expect(open?.getAttribute('rel')).toContain('noopener')
    expect(document.querySelector('[data-action="assets-download"]')?.getAttribute('download')).toBe('demo.html')
  })

  it('Focus folds the sidebar while Assets is shown, is remembered for the view, and lets go on unmount', async () => {
    const { unmount } = mount()
    await waitFor(() => expect(frame()).not.toBeNull())
    const toggle = screen.getByRole('button', { name: 'Focus' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Leave focus' }).getAttribute('aria-pressed')).toBe('true')
    expect(readViewFocus('assets')).toBe(true)
    expect(screen.getByTestId('rail').textContent).toBe('true')

    // The rail's own expand button turns Focus off for the view.
    act(() => exitSidebarRail())
    expect(screen.getByRole('button', { name: 'Focus' }).getAttribute('aria-pressed')).toBe('false')
    expect(readViewFocus('assets')).toBe(false)
    expect(screen.getByTestId('rail').textContent).toBe('false')

    // Remembered for the view: the next visit opens focused…
    fireEvent.click(screen.getByRole('button', { name: 'Focus' }))
    unmount()
    mount()
    await waitFor(() => expect(screen.getByTestId('rail').textContent).toBe('true'))
    // …and nothing holds the rail once the view is gone.
    cleanup()
    render(<RailProbe />)
    expect(screen.getByTestId('rail-after').textContent).toBe('false')
  })
})

const IMPACT = art('impact.html', 'html', '2026-10-22T12:00:00.000Z', 'Impact')
const v = (version: number) => ({ version, updatedAt: `2026-10-22T0${version}:00:00.000Z`, files: ['impact.html', 'review.json'] })

describe('AssetsView — versions (R4)', () => {
  it('lists versions newest first; an older one loads ?v= in the frame, and back to current returns', async () => {
    listing = { artifacts: [IMPACT, DEMO], truncated: false, versions: [v(1), v(2), v(3)] }
    mount('/tasks/r1/assets/impact.html')
    await waitFor(() => expect(frame()?.getAttribute('src')).toMatch(/\/artifacts\/impact\.html#theme=/))
    const trigger = screen.getByRole('button', { name: /Version v3/ })
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    const items = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('[data-version]')]
      if (found.length === 0) throw new Error('menu not open')
      return found
    })
    expect(items.map((item) => item.getAttribute('data-version'))).toEqual(['3', '2', '1'])
    expect(items[0]?.textContent).toContain('current')
    fireEvent.click(items[1]!)

    await waitFor(() => expect(frame()?.getAttribute('src')).toMatch(/\/artifacts\/impact\.html\?v=2#theme=/))
    expect(screen.getByText(/Viewing v2/)).toBeTruthy()
    expect(document.querySelector('[data-action="assets-open"]')?.getAttribute('href')).toBe('/api/v1/runs/r1/artifacts/impact.html?v=2')

    fireEvent.click(screen.getByRole('button', { name: 'back to current' }))
    await waitFor(() => expect(frame()?.getAttribute('src')).toMatch(/\/artifacts\/impact\.html#theme=/))
    expect(document.querySelector('[data-slot="assets-viewing-version"]')).toBeNull()
  })

  it('offers no version menu for a file that was never revised', async () => {
    listing = { artifacts: [IMPACT, DEMO], truncated: false, versions: [v(1), v(2)] }
    mount('/tasks/r1/assets/demo.html')
    await waitFor(() => expect(frame()).not.toBeNull())
    expect(document.querySelector('[data-action="assets-versions"]')).toBeNull()
  })
})

const RUN = { id: 'r1', status: 'done', steps: [] } as unknown as ApiRun
const refMessage = (data: unknown, source: MessageEventSource | null) =>
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source }))
  })
const chip = () => document.querySelector('[data-slot="assets-ask-ref"]')

describe('AssetsView — Ask bridge and docked composer (R4)', () => {
  beforeEach(() => {
    seam.deliver.mockClear()
    listing = { artifacts: [IMPACT], truncated: false }
  })

  it('docks the composer only when the view knows the run', async () => {
    mount('/tasks/r1/assets/impact.html')
    await waitFor(() => expect(frame()).not.toBeNull())
    expect(document.querySelector('[data-slot="assets-ask"]')).toBeNull()
  })

  it('ignores a message from any window but the Assets frame', async () => {
    mount('/tasks/r1/assets/impact.html', true, RUN)
    await waitFor(() => expect(frame()).not.toBeNull())
    refMessage({ type: 'cezar.artifact.ref', ref: 'cap-a', label: 'Gate' }, window)
    expect(chip()).toBeNull()
  })

  it('drops unknown or malformed shapes from the frame itself', async () => {
    mount('/tasks/r1/assets/impact.html', true, RUN)
    await waitFor(() => expect(frame()).not.toBeNull())
    const source = frame()!.contentWindow
    refMessage({ type: 'send', text: 'do it' }, source)
    refMessage({ type: 'cezar.artifact.ref', ref: '', label: 'x' }, source)
    refMessage('cezar.artifact.ref', source)
    expect(chip()).toBeNull()
    expect(seam.deliver).not.toHaveBeenCalled()
  })

  it('a reference from the frame is only a removable chip — capped, and nothing is sent', async () => {
    mount('/tasks/r1/assets/impact.html', true, RUN)
    await waitFor(() => expect(frame()).not.toBeNull())
    refMessage({ type: 'cezar.artifact.ref', ref: 'cap-a', label: 'L'.repeat(5_000) }, frame()!.contentWindow)
    await waitFor(() => expect(chip()).not.toBeNull())
    expect(chip()!.textContent).toContain('cap-a')
    expect(chip()!.textContent).toContain('L'.repeat(200))
    expect(chip()!.textContent).not.toContain('L'.repeat(201))
    expect(seam.deliver).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove reference' }))
    expect(chip()).toBeNull()
    expect(seam.deliver).not.toHaveBeenCalled()
  })

  it('Send delivers the prefixed text through the chat seam and clears the chip', async () => {
    mount('/tasks/r1/assets/impact.html', true, RUN)
    await waitFor(() => expect(frame()).not.toBeNull())
    refMessage({ type: 'cezar.artifact.ref', ref: 'cap-review-gate', label: 'Review gate' }, frame()!.contentWindow)
    await waitFor(() => expect(chip()).not.toBeNull())
    const input = document.querySelector<HTMLTextAreaElement>('[data-slot="assets-ask-input"]')!
    fireEvent.change(input, { target: { value: 'Is this right?' } })
    expect(seam.deliver).not.toHaveBeenCalled()
    fireEvent.click(document.querySelector('[data-action="assets-ask-send"]')!)
    await waitFor(() =>
      expect(seam.deliver).toHaveBeenCalledWith('About cap-review-gate ("Review gate"): Is this right?', []),
    )
    await waitFor(() => expect(chip()).toBeNull())
    expect(input.value).toBe('')
  })
})
