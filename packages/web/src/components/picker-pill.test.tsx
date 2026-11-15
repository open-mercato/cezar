import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PICKER_SEARCH_THRESHOLD, PickerPill } from './picker-pill'

describe('PickerPill catalog status', () => {
  afterEach(cleanup)

  it('constrains long descriptions so narrow menus can wrap them', async () => {
    render(
      <PickerPill
        slot="model-pill"
        ariaLabel="Model"
        label="auto"
        value="long-model"
        onPick={() => {}}
        options={[
          {
            value: 'long-model',
            label: 'Long model',
            desc: 'A model description supplied by the CLI that must wrap instead of widening the menu.',
          },
        ]}
      />,
    )

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Model' }))
    const description = await screen.findByText(
      'A model description supplied by the CLI that must wrap instead of widening the menu.',
    )

    expect(description.className).toContain('max-w-')
    expect(description.className).toContain('whitespace-normal')
    expect(description.className).toContain('break-words')
  })

  it('keeps radio options selectable and renders a disabled status row', async () => {
    render(
      <PickerPill
        slot="model-pill"
        ariaLabel="Model"
        label="auto"
        value=""
        onPick={() => {}}
        options={[{ value: '', label: 'auto' }, { value: 'gpt-future', label: 'Future' }]}
        status="Using cached Codex model list"
      />,
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Model' }))
    expect(await screen.findAllByRole('menuitemradio')).toHaveLength(2)
    expect(screen.getByText('Using cached Codex model list').closest('[data-disabled]')).not.toBeNull()
  })

  it('moves from a filtered search into the options for keyboard selection', async () => {
    const onPick = vi.fn()
    render(
      <PickerPill
        slot="branch-pill"
        ariaLabel="Base branch"
        label="main"
        value="main"
        onPick={onPick}
        options={[
          { value: 'main', label: 'main' },
          { value: 'feature/search', label: 'feature/search' },
        ]}
        searchPlaceholder="Search branches…"
      />,
    )

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Base branch' }))
    const search = await screen.findByRole('searchbox', { name: 'Search branches…' })
    fireEvent.change(search, { target: { value: 'feature' } })
    fireEvent.keyDown(search, { key: 'ArrowDown' })

    const option = screen.getByRole('menuitemradio', { name: 'feature/search' })
    expect(document.activeElement).toBe(option)
    fireEvent.keyDown(option, { key: 'Enter' })
    await waitFor(() => expect(onPick).toHaveBeenCalledWith('feature/search'))
  })

  it('shows no search box on a short list', async () => {
    const options = Array.from({ length: PICKER_SEARCH_THRESHOLD }, (_, i) => ({ value: `m-${i}`, label: `Model ${i}` }))
    render(<PickerPill slot="model-pill" ariaLabel="Model" label="auto" value="m-0" onPick={() => {}} options={options} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Model' }))
    expect(await screen.findAllByRole('menuitemradio')).toHaveLength(PICKER_SEARCH_THRESHOLD)
    expect(screen.queryByRole('searchbox')).toBeNull()
  })

  it('filters a long model list by label or id, case-insensitive, and Enter picks the top match', async () => {
    const onPick = vi.fn()
    const options = [
      ...Array.from({ length: PICKER_SEARCH_THRESHOLD }, (_, i) => ({ value: `filler/m-${i}`, label: `Filler ${i}` })),
      { value: 'openrouter/qwen3-coder', label: 'Qwen3 Coder' },
      { value: 'anthropic/claude-opus', label: 'Claude Opus' },
    ]
    render(<PickerPill slot="model-pill" ariaLabel="Model" label="auto" value="filler/m-0" onPick={onPick} options={options} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Model' }))
    const search = await screen.findByRole('searchbox', { name: 'Search…' })

    // Enter with nothing typed keeps the current pick.
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onPick).not.toHaveBeenCalled()

    fireEvent.change(search, { target: { value: 'QWEN' } })
    expect(screen.getAllByRole('menuitemradio').map((option) => option.textContent)).toEqual(['Qwen3 Coder'])

    fireEvent.change(search, { target: { value: 'anthropic/' } })
    expect(screen.getAllByRole('menuitemradio').map((option) => option.textContent)).toEqual(['Claude Opus'])

    // Enter that confirms IME composition is not a pick.
    fireEvent.keyDown(search, { key: 'Enter', isComposing: true })
    expect(onPick).not.toHaveBeenCalled()

    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith('anthropic/claude-opus')
    await waitFor(() => expect(screen.queryByRole('searchbox')).toBeNull())
  })

  it('windows a long branch list instead of mounting every row', async () => {
    // virtua measures with a ResizeObserver; jsdom has none and lays nothing out.
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    const options = Array.from({ length: 5000 }, (_, i) => ({ value: `branch-${i}`, label: `branch-${i}` }))
    render(
      <PickerPill
        slot="branch-pill"
        ariaLabel="Base branch"
        label="main"
        value="branch-0"
        onPick={() => {}}
        options={options}
        searchPlaceholder="Search branches…"
      />,
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Base branch' }))
    const search = await screen.findByRole('searchbox', { name: 'Search branches…' })
    expect(screen.queryAllByRole('menuitemradio').length).toBeLessThan(200)

    fireEvent.change(search, { target: { value: 'branch-4999' } })
    expect(screen.getAllByRole('menuitemradio').map((option) => option.textContent)).toEqual(['branch-4999'])
    vi.unstubAllGlobals()
  })
})
