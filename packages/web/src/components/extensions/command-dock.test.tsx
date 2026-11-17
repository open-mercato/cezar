import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExtensionPlacement, ExtensionPlacementCommand } from '@open-mercato/cezar-api-client'
import { useExtensionCommandDock } from './command-dock'
const invoke = vi.hoisted(() => vi.fn())
vi.mock('@/api/extensions', async original => ({ ...await original<object>(), runExtensionCommand: invoke }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
const extension = { extensionId: 'example', name: 'Example' } as ExtensionPlacement
const command = (id: string) => ({ id, title: id }) as ExtensionPlacementCommand
function deferred() {
  let resolve!: (value: { message: string }) => void
  let reject!: (error: Error) => void
  const promise = new Promise<{ message: string }>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
it.each(['success', 'failure'])('ignores an older %s after a newer command result', async outcome => {
  const old = deferred(), fresh = deferred()
  invoke.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  const { result } = renderHook(useExtensionCommandDock)
  let first!: Promise<void>, second!: Promise<void>
  act(() => { first = result.current.run('old-project', extension, command('old')) })
  act(() => { second = result.current.run('new-project', extension, command('new')) })
  await act(async () => { fresh.resolve({ message: 'latest' }); await second })
  await act(async () => { if (outcome === 'success') old.resolve({ message: 'stale' }); else old.reject(new Error('stale failure')); await first })
  expect(result.current.state).toEqual({ phase: 'done', projectId: 'new-project', label: 'Example: new' })
  expect(result.current.result?.message).toBe('latest')
})
it.each(['success', 'failure'])('keeps a pending command dismissed after %s', async outcome => {
  const pending = deferred(); invoke.mockReturnValueOnce(pending.promise)
  const { result } = renderHook(useExtensionCommandDock)
  let running!: Promise<void>
  act(() => { running = result.current.run('project', extension, command('run')) })
  act(() => result.current.dismiss())
  await act(async () => { if (outcome === 'success') pending.resolve({ message: 'late' }); else pending.reject(new Error('late')); await running })
  expect(result.current.state).toBeUndefined()
  expect(result.current.result).toBeUndefined()
})
it('displays a current failure and allows a subsequent success', async () => {
  invoke.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce({ message: 'Recovered' })
  const { result } = renderHook(useExtensionCommandDock)
  await act(() => result.current.run('p', extension, command('first')))
  expect(result.current.state).toMatchObject({ phase: 'failed', error: 'Unavailable' })
  await act(() => result.current.run('p', extension, command('retry')))
  expect(result.current.state?.phase).toBe('done')
  expect(result.current.result?.message).toBe('Recovered')
})
