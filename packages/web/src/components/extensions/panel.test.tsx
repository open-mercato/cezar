import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionPanelView } from './panel'

const panel = {
  id: 'summary', title: 'Summary', text: '<script>not html</script>',
  blocks: [{ type: 'status' as const, label: 'Done', value: '2' }],
  actions: [{ id: 'refresh', label: 'Refresh' }],
}

afterEach(cleanup)

describe('ExtensionPanelView', () => {
  it('renders declarative content as text and invokes declared actions', async () => {
    const action = vi.fn().mockResolvedValue(undefined)
    render(<ExtensionPanelView panel={panel} onAction={action} />)
    expect(screen.getByText('<script>not html</script>')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(action).toHaveBeenCalledWith('refresh'))
    expect(screen.getByText('Done')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(document.querySelector('script')).toBeNull()
  })
})

it('shows command errors and permits retry', async () => {
  const action = vi.fn().mockRejectedValueOnce(new Error('Worker stopped')).mockResolvedValueOnce(undefined)
  render(<ExtensionPanelView panel={panel} onAction={action} />)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  expect((await screen.findByRole('alert')).textContent).toBe('Worker stopped')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  expect(action).toHaveBeenCalledTimes(2)
})
