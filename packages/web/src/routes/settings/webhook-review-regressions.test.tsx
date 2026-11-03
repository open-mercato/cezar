import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { WebhooksSection } from '@/routes/settings/webhooks-section'
const api = vi.hoisted(() => ({ list: vi.fn(), deliveries: vi.fn(), activity: vi.fn(), test: vi.fn(), retry: vi.fn(), replay: vi.fn(), pause: vi.fn() }))
vi.mock('@/api/client', () => ({ webhookApi: api, getSelfUpdate: async () => ({ version: 'dev', installKind: 'checkout' }) }))
vi.mock('@/api/queries', () => ({ useHealth: () => ({ data: { capabilities: { webhooks: true } } }) }))
const receiver = { kind: 'live', id: 'r', name: 'Alerts', format: 'cezar.json.v1', destination: 'https://example.com/', state: 'active', revision: 1, deliveryRevision: 1, profile: 'minimal', preset: 'attention', events: [], scope: 'every_task', graceSeconds: 180, allowLocalNetwork: false, includeScheduledFailures: false, pendingCount: 0, inFlightCount: 0, consecutiveFailures: 0, lastTest: 'none', activationBlocked: false }
function mount(search: string) { render(<QueryClientProvider client={createQueryClient()}><MemoryRouter initialEntries={['/p/alpha/settings/webhooks'+search]}><WebhooksSection /></MemoryRouter></QueryClientProvider>) }
beforeEach(() => {
 vi.stubGlobal('EventSource', undefined)
 api.list.mockResolvedValue({ receivers: [receiver], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } })
 api.deliveries.mockResolvedValue({ receiver, items: [], total: 0, hasMore: false, timezone: 'UTC' })
 api.activity.mockResolvedValue({ receiver, items: [], total: 0, hasMore: false, timezone: 'UTC' })
})
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })

it('test acceptance preserves a later Add draft', async () => {
 let resolve!: (value: unknown)=>void
 api.test.mockReturnValue(new Promise(r=>{resolve=r}))
 mount('')
 fireEvent.click(await screen.findByRole('button',{name:'Send test'}))
 await waitFor(()=>expect(api.test).toHaveBeenCalledTimes(1))
 fireEvent.click(screen.getByRole('button',{name:'Add receiver'}))
 fireEvent.change(screen.getByLabelText('Name'),{target:{value:'Draft in progress'}})
 await act(async()=>{resolve({deliveryId:'test'})})
 await waitFor(()=>expect(screen.getByRole('button',{name:'Save receiver'})).toHaveProperty('disabled',false))
 expect(screen.getByLabelText('Name')).toHaveProperty('value','Draft in progress')
})
it('retry Cancel restores focus inside the still-open history', async () => {
 api.deliveries.mockResolvedValue({receiver,items:[{deliveryId:'d',eventId:'e',eventType:'task.finished',status:'retrying',createdAt:'2026-01-01T00:00:00Z',attempts:1,retryAllowed:true,replayAllowed:true}],total:1,timezone:'UTC'})
 mount('?endpoint=r&tab=deliveries')
 fireEvent.click(await screen.findByRole('button',{name:/Task finished/}))
 const trigger=screen.getByRole('button',{name:'Retry now'}); trigger.focus(); fireEvent.click(trigger)
 await screen.findByRole('button',{name:'Confirm'})
 await waitFor(()=>expect(screen.getByRole('dialog',{name:'Retry this delivery now?'}).contains(document.activeElement)).toBe(true))
 fireEvent.click(screen.getByRole('button',{name:'Cancel'}))
 await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Retry this delivery now?'})).toBeNull())
 await waitFor(()=>expect(document.activeElement).toBe(trigger))
})

it('editing delivery settings warns an in-flight request may still arrive', async()=>{
 api.list.mockResolvedValue({receivers:[{...receiver,format:'cezar.json.v1',pendingCount:1,inFlightCount:1}],history:[],historyCount:0,changeSequence:0,webhookHealth:{status:'ready'}})
 mount('?endpoint=r&tab=settings');
 fireEvent.change(await screen.findByLabelText('Receiver URL'),{target:{value:'https://new.example.com/hook'}})
 fireEvent.click(screen.getByRole('button',{name:'Review changes'}))
 const dialog=await screen.findByRole('dialog',{name:'Save changes?'})
 expect(dialog.textContent).toMatch(/already sending|in.flight|may still arrive/i)
})

it.each(['slack.v1', 'discord.v1'].flatMap(format => ['http_401', 'http_403'].map(reason => ({ format, reason }))))('native $format $reason gives URL repair advice', async({format, reason})=>{
 api.list.mockResolvedValue({receivers:[{...receiver,format}],history:[],historyCount:0,changeSequence:0,webhookHealth:{status:'ready'}})
 api.test.mockResolvedValue({deliveryId:'test-auth'})
 api.deliveries.mockResolvedValue({receiver:{...receiver,format,state:'disabled'},items:[{deliveryId:'test-auth',status:'failed',reason}],total:1,timezone:'UTC'})
 mount('');fireEvent.click(await screen.findByRole('button',{name:'Send test'}))
 expect(await screen.findByText(/Check.*webhook URL/)).toBeTruthy()
 expect(screen.queryByText(/signing key in its verifier/)).toBeNull()
})

it('custom receiver authentication failure retains signing-key repair advice', async()=>{
 api.test.mockResolvedValue({deliveryId:'test-auth'})
 api.deliveries.mockResolvedValue({receiver:{...receiver,format:'cezar.json.v1'},items:[{deliveryId:'test-auth',status:'failed',reason:'http_401'}],total:1,timezone:'UTC'})
 mount('');fireEvent.click(await screen.findByRole('button',{name:'Send test'}))
 expect(await screen.findByText(/signing key in its verifier/)).toBeTruthy()
})

it('retains native URL advice after the tested receiver is deleted', async()=>{
 api.list.mockResolvedValue({receivers:[{...receiver,format:'discord.v1'}],history:[],historyCount:0,changeSequence:0,webhookHealth:{status:'ready'}})
 api.test.mockResolvedValue({deliveryId:'test-auth'})
 api.deliveries.mockResolvedValue({receiver:{kind:'history',id:'r',name:'Alerts',deletedAt:'2026-10-01T00:00:00Z'},items:[{deliveryId:'test-auth',status:'failed',reason:'http_403'}],total:1,timezone:'UTC'})
 mount('');fireEvent.click(await screen.findByRole('button',{name:'Send test'}))
 expect(await screen.findByText(/Check.*webhook URL/)).toBeTruthy()
 expect(screen.queryByText(/signing key in its verifier/)).toBeNull()
})
