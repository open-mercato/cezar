import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LifecycleOperationView } from '@open-mercato/cezar-api-client'
import { LifecycleOperationCard, TaskLifecycleCard } from './worktree-lifecycle-operation'

const client = vi.hoisted(() => ({getLifecycleOperation: vi.fn(), getLifecycleOutput: vi.fn(), actOnLifecycleOperation: vi.fn(), getWorktreeLifecycle: vi.fn(), getWorktreeLifecycleDetail: vi.fn()}))
vi.mock('@/api/client', () => client)
let operation: LifecycleOperationView
const operationId = '11111111-1111-4111-8111-111111111111'
function view() {
  return render(<MemoryRouter><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><LifecycleOperationCard operationId={operationId} worktreePath="/project/.ai/cezar/worktrees/task" taskTitle="Lifecycle task" /></QueryClientProvider></MemoryRouter>)
}
beforeEach(() => {
  vi.clearAllMocks()
  operation = {id:operationId, worktreeId:'22222222-2222-4222-8222-222222222222', generation:1, phase:'setup', intent:'create', state:'needs_attention', revision:7, createdAt:'2026-10-10T10:00:00Z', updatedAt:'2026-10-10T10:01:00Z', error:'Command failed', history:[], entries:[{entryId:'33333333-3333-4333-8333-333333333333', label:'Start resources', commandPreview:'docker compose up -d', state:'failed', attempt:1}], allowedActions:['retry','start-anyway','cancel-task']}
  client.getLifecycleOperation.mockImplementation(async () => ({operation}))
  client.getLifecycleOutput.mockResolvedValue({items:[{seq:1,time:'now',executionId:'execution',stream:'stdout',text:'<script>unsafe()</script>'}],nextSeq:1,truncated:true})
  client.actOnLifecycleOperation.mockImplementation(async (_id, input) => { operation = {...operation,revision:8,state:'queued',allowedActions:['stop'],decision:{action:input.action,actor:'local-user',at:'now'}}; return {operation} })
})
afterEach(cleanup)
describe('worktree lifecycle operation recovery', () => {
  it('retries current saved scripts with a fresh request ID and expected revision, then focuses status', async () => {
    view()
    await screen.findByText('Setup needs attention')
    expect(screen.getByText(/Retry loads current saved scripts/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button',{name:'Retry'}))
    await waitFor(() => expect(client.actOnLifecycleOperation).toHaveBeenCalledWith(operationId,expect.objectContaining({action:'retry',expectedRevision:7,requestId:expect.any(String)})))
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Preparing worktree'))
    expect(screen.getByText('The agent starts after worktree preparation finishes.')).toBeTruthy()
  })
  it('requires confirmation for setup bypass and names retained resources when cancelling', async () => {
    view(); await screen.findByText('Setup needs attention')
    fireEvent.click(screen.getByRole('button',{name:'Start task anyway'}))
    expect(client.actOnLifecycleOperation).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog').textContent).toContain('incomplete environment')
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Go back'}))
    fireEvent.click(screen.getByRole('button',{name:'Cancel task'}))
    expect(screen.getByRole('alertdialog').textContent).toContain('resources already created are kept')
  })
  it('confirms force against the actual worktree while preserving reclamation branch scope', async () => {
    operation = {...operation,phase:'teardown',intent:'reclaim',allowedActions:['retry','keep-worktree','force-delete']}
    view(); await screen.findByText('Cleanup needs attention')
    fireEvent.click(screen.getByRole('button',{name:'Force delete'}))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.textContent).toContain('Containers, volumes, and other resources may remain')
    expect(dialog.textContent).toContain('The task branch is kept.')
    expect(dialog.textContent).toContain('Lifecycle task')
    fireEvent.click(within(dialog).getByRole('button',{name:'Force delete'}))
    await waitFor(() => expect(client.actOnLifecycleOperation).toHaveBeenCalledWith(operationId,expect.objectContaining({action:'force-delete'})))
  })
  it('loads bounded output only on expansion and renders untrusted text without live announcements', async () => {
    view(); await screen.findByText('Setup needs attention')
    expect(client.getLifecycleOutput).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button',{name:'Show output'}))
    const output = await screen.findByLabelText('Script output')
    await waitFor(() => expect(output.textContent).toContain('<script>unsafe()</script>'))
    expect(output.querySelector('script')).toBeNull()
    expect(output.hasAttribute('aria-live')).toBe(false)
    expect(screen.getByText('Some earlier output was truncated.')).toBeTruthy()
  })
  it.each(['kept', 'cancelled', 'bypassed', 'completed'] as const)('keeps resolved %s errors historical instead of asking for recovery', async state => {
    operation = {...operation, state, allowedActions: []}
    view()
    await screen.findByText('Previous operation error')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Command failed').closest('details')).not.toBeNull()
    expect(screen.queryByRole('button', {name: 'Retry'})).toBeNull()
  })
  it('restores completed lifecycle history when reopening a prepared task', async () => {
    operation = {...operation,state:'completed',allowedActions:[],error:undefined}
    client.getWorktreeLifecycleDetail.mockResolvedValue({worktree:{history:[operation]}})
    render(<MemoryRouter><QueryClientProvider client={new QueryClient()}><TaskLifecycleCard worktreeId={operation.worktreeId} taskTitle="Prepared task" /></QueryClientProvider></MemoryRouter>)
    expect(await screen.findByText('Worktree ready')).toBeTruthy()
    expect(screen.getByRole('button',{name:'Show output'})).toBeTruthy()
  })
  it('offers only server-authorized actions for an uncertain live process and explains commit failure', async () => {
    operation = {...operation,phase:'teardown',intent:'delete-task',state:'interrupted',failureStage:'commit',allowedActions:[]}
    view(); await screen.findByText('Cleanup needs attention')
    expect(screen.queryByRole('button',{name:'Force delete'})).toBeNull()
    expect(screen.queryByRole('button',{name:'Retry'})).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('Scripts completed, but the worktree transition failed')
  })
})
