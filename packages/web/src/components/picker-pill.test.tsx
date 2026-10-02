import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PickerPill } from './picker-pill'

afterEach(cleanup)

describe('PickerPill catalog status', () => {
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

  it('matches the value as well as the label, and names an empty result', async () => {
    render(
      <PickerPill
        slot="model-pill"
        ariaLabel="Model"
        label="auto"
        value=""
        onPick={() => {}}
        options={[
          { value: '', label: 'auto' },
          { value: 'openrouter/deepseek/deepseek-chat', label: 'DeepSeek Chat', desc: 'via openrouter' },
          { value: 'openrouter/deepseek/deepseek-r1', label: 'DeepSeek R1', desc: 'via openrouter' },
        ]}
        searchPlaceholder="Search models…"
        emptyLabel="No models found."
      />,
    )

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Model' }))
    const search = await screen.findByRole('searchbox', { name: 'Search models…' })

    // The wire id matches even though the row shows a pretty label — a search that only read the
    // label would miss the model a user typed by its real name.
    fireEvent.change(search, { target: { value: 'deepseek-chat' } })
    expect(screen.getAllByRole('menuitemradio').map((option) => option.textContent)).toEqual([
      expect.stringContaining('DeepSeek Chat'),
    ])

    fireEvent.change(search, { target: { value: 'no-such-model' } })
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0)
    expect(screen.getByText('No models found.')).not.toBeNull()
  })
})
