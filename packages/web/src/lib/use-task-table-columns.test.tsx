import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { useTaskTableColumns } from './use-task-table-columns'

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }))
vi.mock('@/components/ui/toaster', () => ({ toast: toastMock }))

const fetchMock = vi.fn<typeof fetch>()

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function Harness() {
  const columns = useTaskTableColumns()
  return (
    <>
      <output data-testid="loading">{String(columns.isPending)}</output>
      {(['status', 'branch', 'workflow'] as const).map((id) => (
        <button
          key={id}
          type="button"
          aria-label={`toggle ${id}`}
          aria-pressed={columns.isExpanded(id)}
          onClick={() => columns.toggleColumn(id)}
        >
          {id}
        </button>
      ))}
    </>
  )
}

function renderHarness() {
  const client = createQueryClient()
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    ),
  }
}

const pressed = (id: string) => screen.getByRole('button', { name: `toggle ${id}` }).getAttribute('aria-pressed')
const putCalls = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  toastMock.mockReset()
  vi.unstubAllGlobals()
})

describe('useTaskTableColumns', () => {
  it('does not write before initial state loads, then preserves its nested siblings', async () => {
    const initial = deferred<Response>()
    fetchMock.mockImplementation(async (_input, init) => {
      if (init?.method === 'PUT') {
        return json({
          taskTable: {
            expandedColumns: { branch: true },
            futureSibling: 'preserve-after-load',
          },
        })
      }
      return initial.promise
    })
    renderHarness()

    expect(screen.getByTestId('loading').textContent).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'toggle branch' }))
    expect(putCalls()).toHaveLength(0)

    initial.resolve(
      json({
        taskTable: {
          expandedColumns: { branch: false },
          futureSibling: 'preserve-after-load',
        },
      }),
    )
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))
    fireEvent.click(screen.getByRole('button', { name: 'toggle branch' }))

    const put = await waitFor(() => {
      const call = putCalls()[0]
      if (!call) throw new Error('PUT not started')
      return call
    })
    expect(JSON.parse(String(put[1]?.body))).toEqual({
      taskTable: {
        expandedColumns: { branch: true },
        futureSibling: 'preserve-after-load',
      },
    })
  })

  it('updates optimistically and writes the whole taskTable with keepalive', async () => {
    let stored = {
      futureTopLevel: true,
      taskTable: {
        expandedColumns: { branch: false, futureColumn: true },
        futureSibling: { density: 'tiny' },
      },
    }
    fetchMock.mockImplementation(async (_input, init) => {
      if (init?.method === 'PUT') {
        stored = { ...stored, ...JSON.parse(String(init.body)) }
      }
      return json(stored)
    })
    renderHarness()

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))
    expect(pressed('branch')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'toggle branch' }))
    await waitFor(() => expect(pressed('branch')).toBe('true'))

    const put = await waitFor(() => {
      const call = putCalls()[0]
      if (!call) throw new Error('PUT not started')
      return call
    })
    expect(JSON.parse(String(put[1]?.body))).toEqual({
      taskTable: {
        expandedColumns: { branch: true, futureColumn: true },
        futureSibling: { density: 'tiny' },
      },
    })
    expect(put[1]?.keepalive).toBe(true)
  })

  it('serializes rapid toggles and ignores an older response while a newer choice is pending', async () => {
    const first = deferred<Response>()
    const second = deferred<Response>()
    let putIndex = 0
    fetchMock.mockImplementation(async (_input, init) => {
      if (init?.method !== 'PUT') {
        return json({ taskTable: { expandedColumns: { branch: false }, futureSibling: 'keep' } })
      }
      putIndex += 1
      return putIndex === 1 ? first.promise : second.promise
    })
    renderHarness()

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))
    fireEvent.click(screen.getByRole('button', { name: 'toggle branch' }))
    fireEvent.click(screen.getByRole('button', { name: 'toggle workflow' }))
    await waitFor(() => {
      expect(pressed('branch')).toBe('true')
      expect(pressed('workflow')).toBe('false')
    })
    await waitFor(() => expect(putCalls()).toHaveLength(1))

    first.resolve(json({ taskTable: { expandedColumns: { branch: true } } }))
    await waitFor(() => expect(putCalls()).toHaveLength(2))
    expect(pressed('workflow')).toBe('false')
    expect(JSON.parse(String(putCalls()[1]?.[1]?.body))).toEqual({
      taskTable: {
        expandedColumns: { branch: true, workflow: false },
        futureSibling: 'keep',
      },
    })

    second.resolve(
      json({ taskTable: { expandedColumns: { branch: true, workflow: false }, futureSibling: 'keep' } }),
    )
    await waitFor(() => expect(pressed('workflow')).toBe('false'))
  })

  it('toasts, invalidates, and returns to persisted truth when the newest write fails', async () => {
    const failed = deferred<Response>()
    let gets = 0
    fetchMock.mockImplementation(async (_input, init) => {
      if (init?.method === 'PUT') return failed.promise
      gets += 1
      return json({ taskTable: { expandedColumns: { branch: false } } })
    })
    renderHarness()

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))
    fireEvent.click(screen.getByRole('button', { name: 'toggle branch' }))
    await waitFor(() => expect(pressed('branch')).toBe('true'))
    failed.resolve(json({ error: 'read-only home' }, 500))
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('read-only home', { tone: 'danger' }))
    await waitFor(() => expect(gets).toBeGreaterThan(1))
    await waitFor(() => expect(pressed('branch')).toBe('false'))
  })

  it('refuses to write a fixed column', async () => {
    fetchMock.mockResolvedValue(json({}))
    renderHarness()
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))

    fireEvent.click(screen.getByRole('button', { name: 'toggle status' }))
    expect(pressed('status')).toBe('true')
    expect(putCalls()).toHaveLength(0)
  })
})
