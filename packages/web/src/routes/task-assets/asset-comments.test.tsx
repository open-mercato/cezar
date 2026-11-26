import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AssetComment, DiffComments } from '../task-thread/diff-comments'
import { AssetCommentsLayer, withPicker } from './asset-comments'

/**
 * Comment mode on an HTML asset: the page runs the Design Mode picker, and its picks become review
 * comments in the run's shared store. Driven here through real `postMessage` events from the frame.
 */

afterEach(cleanup)

const SAVED: AssetComment = {
  kind: 'asset',
  id: 'saved-1',
  asset: 'mock.html',
  selector: 'main > h1',
  label: 'Title',
  excerpt: '<h1>Title</h1>',
  body: 'bigger',
}

function fakeStore(initial: AssetComment[]) {
  const store = {
    ready: true,
    assetComments: initial,
    addAsset: vi.fn<DiffComments['addAsset']>(() => 'new-1'),
    update: vi.fn<DiffComments['update']>(() => true),
    remove: vi.fn<DiffComments['remove']>(),
  }
  return store
}

function Host({ store, onActive }: { store: ReturnType<typeof fakeStore>; onActive: (on: boolean) => void }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [active, setActive] = useState(true)
  return (
    <div style={{ position: 'relative' }}>
      <iframe ref={frameRef} title="asset" />
      <AssetCommentsLayer
        frameRef={frameRef}
        frameKey="k"
        asset="mock.html"
        store={store}
        active={active}
        onActiveChange={(on) => {
          setActive(on)
          onActive(on)
        }}
      />
    </div>
  )
}

function mount(initial: AssetComment[] = []) {
  const store = fakeStore(initial)
  const onActive = vi.fn()
  render(<Host store={store} onActive={onActive} />)
  const frame = document.querySelector('iframe')!.contentWindow!
  const sent: Array<Record<string, unknown>> = []
  vi.spyOn(frame, 'postMessage').mockImplementation((message: unknown) => void sent.push(message as Record<string, unknown>))
  const fromPage = (data: Record<string, unknown>, source: Window = frame) =>
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { source: 'cezar-design', ...data }, source }))
    })
  return { store, onActive, sent, fromPage }
}

const PICK = {
  url: '/mock.html',
  selector: 'section.actions > button',
  tag: 'button',
  text: 'Save recipe',
  html: '<button>Save recipe</button>',
  styles: {},
  rect: { x: 10, y: 10, width: 80, height: 30 },
  viewport: { width: 800, height: 600 },
  components: [],
  source: '',
  mark: 'abc123-1',
}

describe('asset comment mode', () => {
  it('asks the server for the picker without disturbing the rest of the URL', () => {
    expect(withPicker('/api/v1/runs/r/artifacts/a.html')).toBe('/api/v1/runs/r/artifacts/a.html?picker=1')
    expect(withPicker('/api/v1/runs/r/artifacts/a.html?v=2')).toBe('/api/v1/runs/r/artifacts/a.html?v=2&picker=1')
  })

  it('switches the picker on and frames every saved comment with its number once the page is ready', () => {
    const { sent, fromPage } = mount([SAVED])
    fromPage({ type: 'ready', url: '/mock.html' })
    expect(sent).toContainEqual({ source: 'cezar-design-host', type: 'set-active', active: true })
    expect(sent).toContainEqual({
      source: 'cezar-design-host',
      type: 'set-marks',
      marks: [{ key: 'saved-1', n: 1, selector: 'main > h1' }],
    })
  })

  it('turns a picked element into a comment with the asset name and the selector', () => {
    const { store, fromPage } = mount()
    fromPage({ type: 'ready' })
    fromPage({ type: 'picked', element: PICK })
    const field = screen.getByRole('textbox', { name: 'Comment for the agent' })
    fireEvent.change(field, { target: { value: '  make it green  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))
    expect(store.addAsset).toHaveBeenCalledWith({
      asset: 'mock.html',
      selector: 'section.actions > button',
      label: 'Save recipe',
      excerpt: '<button>Save recipe</button>',
      body: 'make it green',
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens a saved comment from its marker to edit or delete it', () => {
    const { store, fromPage } = mount([SAVED])
    fromPage({ type: 'ready' })
    fromPage({ type: 'mark-clicked', key: 'saved-1' })
    expect(screen.getByLabelText('Comment 1')).not.toBeNull()
    const field = screen.getByRole('textbox', { name: 'Comment for the agent' }) as HTMLTextAreaElement
    expect(field.value).toBe('bigger')
    fireEvent.change(field, { target: { value: 'much bigger' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(store.update).toHaveBeenCalledWith('saved-1', 'much bigger')

    fromPage({ type: 'mark-clicked', key: 'saved-1' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(store.remove).toHaveBeenCalledWith('saved-1')
    expect(store.update).toHaveBeenCalledTimes(1)
  })

  it('obeys only its own frame, and Esc in the page leaves comment mode', () => {
    const { store, onActive, fromPage } = mount()
    fromPage({ type: 'ready' })
    fromPage({ type: 'picked', element: PICK }, window)
    expect(screen.queryByRole('dialog')).toBeNull()
    fromPage({ type: 'cancel' })
    expect(onActive).toHaveBeenCalledWith(false)
    expect(store.addAsset).not.toHaveBeenCalled()
  })

  it('Esc in the comment field closes only the popup; the next Esc leaves comment mode', () => {
    const { store, onActive, fromPage } = mount()
    fromPage({ type: 'ready' })
    fromPage({ type: 'picked', element: PICK })
    const field = screen.getByRole('textbox', { name: 'Comment for the agent' })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onActive).not.toHaveBeenCalled()
    expect(store.addAsset).not.toHaveBeenCalled()

    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onActive).toHaveBeenCalledWith(false)
  })

  it('Esc outside the field closes an open popup first, keeping an edit to a saved comment', () => {
    const { store, onActive, fromPage } = mount([SAVED])
    fromPage({ type: 'ready' })
    fromPage({ type: 'mark-clicked', key: 'saved-1' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment for the agent' }), { target: { value: 'huge' } })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(store.update).toHaveBeenCalledWith('saved-1', 'huge')
    expect(onActive).not.toHaveBeenCalled()
  })

  it('leaves an Esc another overlay already handled alone', () => {
    const { onActive, fromPage } = mount()
    fromPage({ type: 'ready' })
    const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    handled.preventDefault()
    act(() => void document.body.dispatchEvent(handled))
    expect(onActive).not.toHaveBeenCalled()
  })
})
