import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'

import { FileActionDialog, type FileAction } from './file-actions'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Records `METHOD path` plus the parsed body, and answers from the table. */
function stubFetch(answers: Record<string, () => Response>) {
  const sent: Array<{ request: string; body: unknown }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const request = `${init.method ?? 'GET'} ${String(input)}`
      sent.push({ request, body: init.body ? JSON.parse(String(init.body)) : undefined })
      return (answers[request] ?? (() => json({ error: `unstubbed: ${request}` }, 404)))()
    }),
  )
  return sent
}

function renderDialog(action: FileAction) {
  const onDone = vi.fn()
  const onClose = vi.fn()
  render(
    <QueryClientProvider client={createQueryClient()}>
      <FileActionDialog runId="r1" action={action} onClose={onClose} onDone={onDone} />
    </QueryClientProvider>,
  )
  return { onDone, onClose }
}

const pathInput = () => screen.getByLabelText('File path') as HTMLInputElement

describe('the Code view file actions', () => {
  it('creates a file beside the one being looked at, and opens it', async () => {
    const sent = stubFetch({
      'POST /api/v1/runs/r1/files?path=src%2Fnew.ts': () => json({ path: 'src/new.ts', size: 0, hash: 'sha256:e' }, 201),
    })
    const { onDone, onClose } = renderDialog({ kind: 'create', dir: 'src' })

    expect(pathInput().value).toBe('src/')
    // A folder is not a file name yet.
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(pathInput(), { target: { value: 'src/new.ts' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(onDone).toHaveBeenCalledWith('src/new.ts'))
    expect(onClose).toHaveBeenCalled()
    expect(sent[0]).toEqual({ request: 'POST /api/v1/runs/r1/files?path=src%2Fnew.ts', body: { content: '' } })
  })

  it('shows a refusal in the server words and stays open', async () => {
    stubFetch({
      'POST /api/v1/runs/r1/files?path=node_modules%2Fx.js': () =>
        json({ error: 'installed dependencies are not editable' }, 409),
    })
    const { onDone, onClose } = renderDialog({ kind: 'create', dir: '' })
    fireEvent.change(pathInput(), { target: { value: 'node_modules/x.js' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('installed dependencies are not editable'))
    expect(onDone).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('renames to the typed path, and has nothing to do while the path is unchanged', async () => {
    const sent = stubFetch({
      'POST /api/v1/runs/r1/files/rename': () => json({ from: 'src/a.ts', to: 'lib/a.ts' }),
    })
    const { onDone } = renderDialog({ kind: 'rename', path: 'src/a.ts' })

    expect(pathInput().value).toBe('src/a.ts')
    expect((screen.getByRole('button', { name: 'Rename' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(pathInput(), { target: { value: 'lib/a.ts' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))

    await waitFor(() => expect(onDone).toHaveBeenCalledWith('lib/a.ts'))
    expect(sent[0]?.body).toEqual({ from: 'src/a.ts', to: 'lib/a.ts' })
  })

  it('deletes only after the confirmation, and clears the selection', async () => {
    const sent = stubFetch({
      'DELETE /api/v1/runs/r1/files?path=src%2Fa.ts': () => json({ path: 'src/a.ts', blob: 'abc123' }),
    })
    const { onDone } = renderDialog({ kind: 'delete', path: 'src/a.ts' })

    expect(screen.getByRole('alertdialog').textContent).toContain('src/a.ts')
    expect(sent).toEqual([]) // opening the dialog deletes nothing

    fireEvent.click(screen.getByRole('button', { name: 'Delete file' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(null))
    expect(sent.map((entry) => entry.request)).toEqual(['DELETE /api/v1/runs/r1/files?path=src%2Fa.ts'])
  })

  it('keeps the delete dialog open with the reason when the server refuses', async () => {
    stubFetch({
      'DELETE /api/v1/runs/r1/files?path=src': () => json({ error: 'not a file: src — directories are not handled here' }, 409),
    })
    const { onDone, onClose } = renderDialog({ kind: 'delete', path: 'src' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete file' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('not a file'))
    expect(onDone).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
