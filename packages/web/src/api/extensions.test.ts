import { afterEach, describe, expect, it, vi } from 'vitest'

import { listExtensionInventory, loadUninstallImpact, uninstallExtension, extensionKeys, listExtensionPlacements, loadExtensionPanel, qualifiedExtensionId, runExtensionCommand } from './extensions'

/** Placements and the `runId` plumbing (spec 2026-11-07-extension-placements): the
 *  typed client must spell the surface selector and the task id exactly as the server validates
 *  them — a query for the panel, a body key for the command. */

const calls: { url: string; init?: RequestInit }[] = []
function serve(body: unknown) {
  calls.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
}
afterEach(() => vi.unstubAllGlobals())

describe('extension placements and task context', () => {
  it('asks for one location, project-scoped', async () => {
    const response = { available: true, extensions: [{ extensionId: 'example', name: 'Example', status: 'running', panels: [], commands: [{ id: 'hello', title: 'Say hello', location: 'palette' }] }] }
    serve(response)
    expect(await listExtensionPlacements('alpha', 'palette')).toEqual(response)
    expect(calls[0]!.url).toBe('/api/v1/p/alpha/extensions/placements?location=palette')
  })

  it('passes the run id to a task panel as a query, and sends none without one', async () => {
    serve({ id: 'notes', title: 'Notes', blocks: [], actions: [] })
    await loadExtensionPanel('alpha', 'example', 'notes', 'r1')
    expect(calls[0]!.url).toBe('/api/v1/p/alpha/extensions/example/panels/notes?runId=r1')
    await loadExtensionPanel('alpha', 'example', 'notes')
    expect(calls[1]!.url.replace(/\?$/, '')).toBe('/api/v1/p/alpha/extensions/example/panels/notes')
  })

  it('names the run in a task command’s body and leaves the key out otherwise', async () => {
    serve({ ok: true, message: 'done' })
    await runExtensionCommand('alpha', 'example', 'summarize', undefined, 'r1')
    expect(calls[0]!.url).toBe('/api/v1/p/alpha/extensions/example/commands/summarize/invoke')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ runId: 'r1' })
    await runExtensionCommand('alpha', 'example', 'refresh', { a: 1 })
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ input: { a: 1 } })
  })

  it('surfaces a refused command as an error, never a silent success', async () => {
    serve({ ok: false, message: 'worker stopped' })
    await expect(runExtensionCommand('alpha', 'example', 'refresh')).rejects.toThrow('worker stopped')
  })

  it('keys every surface under the project, so one WS tick invalidates them all', () => {
    expect(extensionKeys.placements('alpha', 'sidebar').slice(0, 2)).toEqual(extensionKeys.all('alpha'))
    expect(extensionKeys.taskPanel('alpha', 'r1', 'example', 'notes').slice(0, 4)).toEqual([...extensionKeys.taskPanels('alpha', 'r1')])
    expect(qualifiedExtensionId('example', 'notes')).toBe('example/notes')
  })
})

it('loads passive project inventory and global impact and always sends the confirmed revision', async () => {
  serve({ extensions: [] })
  await listExtensionInventory('beta')
  expect(calls[0]!.url).toBe('/api/v1/p/beta/extensions/inventory')
  await loadUninstallImpact('example')
  expect(calls[1]!.url).toBe('/api/v1/extensions/example/uninstall-impact')
  await uninstallExtension('beta', 'example', 'a'.repeat(64))
  expect(calls[2]!.init?.method).toBe('DELETE')
  const url = new URL(calls[2]!.url, 'http://localhost')
  expect(url.searchParams.get('impactRevision')).toBe('a'.repeat(64))
  expect(url.searchParams.get('removeData')).toBe('false')
})
