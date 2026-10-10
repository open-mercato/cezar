import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiRun } from '@open-mercato/cezar-api-client'

import type { DesignPick, DesignPicks } from '../task-thread/design-picks'
import { DesignNote, DesignQueues, hasDesignQueues } from './design-dock'

/**
 * The Design Mode note panel (spec `.ai/specs/2026-10-09-design-mode.md` §7-8).
 *
 * What is pinned is the ROUTING: one Send button, four places a note can go, and the one that is
 * chosen decides whether the agent is interrupted, queued behind, reopened, or left alone while a
 * separate task is created. A note sent to the wrong one of those is the bug this panel can have.
 */

const api = vi.hoisted(() => ({
  queueRunPrompt: vi.fn(),
  removeQueuedRunPrompt: vi.fn(),
  sendMessage: vi.fn(),
  continueRun: vi.fn(),
  createRun: vi.fn(),
}))
vi.mock('@/api/client', () => ({
  ...api,
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  },
}))
const { ApiError } = await import('@/api/client')

const runsById = vi.hoisted(() => ({ list: [] as { id: string; title: string; status: string }[] }))
vi.mock('@/api/queries', () => ({
  useWorkflows: () => ({ data: { workflows: [{ name: 'quick-task' }, { name: 'fix-ui' }] } }),
  useRuns: (select: (runs: unknown[]) => unknown) => ({ data: select(runsById.list) }),
}))
vi.mock('@/lib/project-router', () => ({
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}))
const toast = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/toaster', () => ({ toast }))

const PICK: DesignPick = {
  id: 'p1',
  url: 'http://localhost:5173/',
  selector: 'main > button.save',
  tag: 'button',
  text: 'Save',
  html: '<button class="save">Save</button>',
  styles: {},
  rect: { x: 1, y: 2, width: 3, height: 4 },
  viewport: { width: 800, height: 600 },
  components: [],
  source: '',
  mark: 'abc-1',
}

function picksOf(list: DesignPick[]): DesignPicks & { remove: ReturnType<typeof vi.fn<(id: string) => void>> } {
  return {
    ready: true,
    picks: list,
    add: vi.fn(() => true),
    remove: vi.fn<(id: string) => void>(),
    // The real store drops what it handed over only after the action resolved; a rejection
    // propagates and keeps everything — the same contract, without the store.
    submit: async (action) => action(list),
  }
}

const run = (over: Partial<ApiRun>): ApiRun => ({ id: 'run-1', status: 'running', ...over }) as ApiRun

const onClose = vi.fn()
const onTasksCreated = vi.fn()
function Note(props: { run: ApiRun; picks: DesignPicks }) {
  return <DesignNote {...props} onClose={onClose} onTasksCreated={onTasksCreated} />
}

const note = () => screen.getByLabelText('Note for the agent')
const type = (text: string) => fireEvent.change(note(), { target: { value: text } })

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset()
  api.queueRunPrompt.mockResolvedValue({ queued: true, message: { id: 'q1', text: '', createdAt: '' } })
  api.removeQueuedRunPrompt.mockResolvedValue({ removed: true })
  api.sendMessage.mockResolvedValue({ queued: true })
  api.continueRun.mockResolvedValue({ ok: true })
  api.createRun.mockResolvedValue({ id: 'new-1' })
  toast.mockReset()
  onClose.mockReset()
  onTasksCreated.mockReset()
  runsById.list = []
})
afterEach(cleanup)

describe('a note for this session', () => {
  it('joins the PROMPT QUEUE while the agent is working — it does not steer the running turn', async () => {
    render(<Note run={run({ status: 'running' })} picks={picksOf([PICK])} />)
    type('make it bigger')
    fireEvent.click(screen.getByRole('button', { name: 'Queue prompt' }))
    await waitFor(() => expect(api.queueRunPrompt).toHaveBeenCalledTimes(1))
    const [id, message] = api.queueRunPrompt.mock.calls[0] as [string, string]
    expect(id).toBe('run-1')
    // The typed text leads; the element rides behind it.
    expect(message.startsWith('make it bigger\n\nElements selected in the app preview:')).toBe(true)
    expect(message).toContain('`main > button.save`')
    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(api.createRun).not.toHaveBeenCalled()
    await waitFor(() => expect((note() as HTMLTextAreaElement).value).toBe(''))
  })

  it('says it starts right away when the session is idle, through the same queue route', async () => {
    api.queueRunPrompt.mockResolvedValue({ delivered: true })
    render(<Note run={run({ status: 'waiting' })} picks={picksOf([])} />)
    type('next thing')
    fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Prompt sent to the agent.'))
    expect(api.queueRunPrompt).toHaveBeenCalledWith('run-1', 'next thing')
  })

  it('reopens a closed session with the note', async () => {
    render(<Note run={run({ status: 'done' })} picks={picksOf([])} />)
    type('one more fix')
    fireEvent.click(screen.getByRole('button', { name: 'Reopen & send' }))
    await waitFor(() => expect(api.continueRun).toHaveBeenCalledWith('run-1', { text: 'one more fix' }))
    expect(api.queueRunPrompt).not.toHaveBeenCalled()
  })

  it('folds into the first prompt of a task that has not started', async () => {
    render(<Note run={run({ status: 'queued' })} picks={picksOf([])} />)
    type('also this')
    fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }))
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith('run-1', { text: 'also this' }))
  })

  it('falls back to reopening when the session closed under a queue request', async () => {
    api.queueRunPrompt.mockRejectedValue(new ApiError(409, 'session closed'))
    render(<Note run={run({ status: 'waiting' })} picks={picksOf([])} />)
    type('late note')
    fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }))
    await waitFor(() => expect(api.continueRun).toHaveBeenCalledWith('run-1', { text: 'late note' }))
  })

  it('keeps the note and says why when the send is refused', async () => {
    api.queueRunPrompt.mockRejectedValue(new ApiError(409, 'prompt queue is full — 20 prompts at most'))
    render(<Note run={run({ status: 'running' })} picks={picksOf([])} />)
    type('too many')
    fireEvent.click(screen.getByRole('button', { name: 'Queue prompt' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('prompt queue is full — 20 prompts at most', { tone: 'danger' }))
    expect((note() as HTMLTextAreaElement).value).toBe('too many')
    expect(api.continueRun).not.toHaveBeenCalled()
  })
})

describe('a note as a new task', () => {
  it('creates a separate task with the chosen workflow and worktree, and touches no session', async () => {
    render(<Note run={run({ status: 'running' })} picks={picksOf([PICK])} />)
    type('rework the header')
    fireEvent.click(screen.getByRole('radio', { name: /New task/ }))
    fireEvent.change(screen.getByLabelText('Workflow for the new task'), { target: { value: 'fix-ui' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    await waitFor(() => expect(api.createRun).toHaveBeenCalledTimes(1))
    const [input] = api.createRun.mock.calls[0] as [{ workflow: string; task: string; worktree: boolean }]
    expect(input.workflow).toBe('fix-ui')
    expect(input.worktree).toBe(true)
    expect(input.task).toContain('rework the header')
    expect(input.task).toContain('`main > button.save`')
    expect(api.queueRunPrompt).not.toHaveBeenCalled()
    expect(api.continueRun).not.toHaveBeenCalled()
  })

  it('hands the created task to the host, which lists it in the task queue', async () => {
    render(<Note run={run({ status: 'running' })} picks={picksOf([])} />)
    type('rework the header')
    fireEvent.click(screen.getByRole('radio', { name: /New task/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    await waitFor(() => expect(onTasksCreated).toHaveBeenCalledWith(['new-1']))
  })
})

describe('the note itself', () => {
  it('numbers the selected elements and removes one on its ✕', () => {
    const picks = picksOf([PICK, { ...PICK, id: 'p2', selector: 'main > p.price', mark: 'abc-2' }])
    render(<Note run={run({})} picks={picks} />)
    const items = screen.getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual(['1button.save', '2p.price'])
    fireEvent.click(screen.getByRole('button', { name: 'Remove element 2, p.price' }))
    expect(picks.remove).toHaveBeenCalledWith('p2')
  })

  it('cannot be sent empty, but elements alone are a note', () => {
    const { unmount } = render(<Note run={run({})} picks={picksOf([])} />)
    expect((screen.getByRole('button', { name: 'Queue prompt' }) as HTMLButtonElement).disabled).toBe(true)
    unmount()
    render(<Note run={run({})} picks={picksOf([PICK])} />)
    expect((screen.getByRole('button', { name: 'Queue prompt' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('closes without discarding anything', () => {
    const picks = picksOf([PICK])
    render(<Note run={run({})} picks={picks} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close note' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(picks.remove).not.toHaveBeenCalled()
  })
})

describe('the queues strip', () => {
  it('lists the session prompt queue and the cezar task queue apart', () => {
    runsById.list = [{ id: 'new-1', title: 'Rework the header', status: 'queued' }]
    render(
      <DesignQueues
        run={run({ status: 'running', promptQueue: [{ id: 'q1', text: 'first queued prompt\nmore', createdAt: '' }] })}
        createdTasks={['new-1']}
      />,
    )
    const tasks = screen.getByRole('region', { name: 'Tasks created from this review' })
    expect(tasks.textContent).toContain('Task queue · cezar (1)')
    expect(tasks.textContent).toContain('Rework the header')
    const prompts = screen.getByRole('region', { name: 'Prompt queue of this session' })
    expect(prompts.textContent).toContain('Prompt queue · this session (1)')
    expect(prompts.textContent).toContain('first queued prompt')
    expect(prompts.textContent).not.toContain('Rework the header')
  })

  it('removes a queued prompt, and says an ended session left its queue undelivered', () => {
    render(
      <DesignQueues
        run={run({ status: 'cancelled', promptQueue: [{ id: 'q1', text: 'never ran', createdAt: '' }] })}
        createdTasks={[]}
      />,
    )
    expect(screen.getByRole('region', { name: 'Prompt queue of this session' }).textContent).toContain('Not delivered')
    fireEvent.click(screen.getByRole('button', { name: 'Remove queued prompt 1' }))
    expect(api.removeQueuedRunPrompt).toHaveBeenCalledWith('run-1', 'q1')
  })

  it('is only worth a strip when one of the queues has something in it', () => {
    expect(hasDesignQueues(run({}), [])).toBe(false)
    expect(hasDesignQueues(run({ promptQueue: [{ id: 'q', text: 't', createdAt: '' }] }), [])).toBe(true)
    expect(hasDesignQueues(run({}), ['new-1'])).toBe(true)
  })
})
