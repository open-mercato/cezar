import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { ChatReceiveServices } from './chat-session.ts'
import type { ReceiveJournal, ChatConnectionOptions } from '../chat/connection.ts'
function fixture() {
 const epoch = randomUUID(); let nextOffset: number | null = 40
 const journal: ReceiveJournal = {
  recover: vi.fn(async () => {}), assertReady: vi.fn(), prepareReceive: vi.fn(async () => {}),
  snapshot: () => ({epoch, nextOffset}), duplicate: (_e, s) => nextOffset !== null && s < nextOffset,
  finish: vi.fn(async (_e, s) => { nextOffset = s + 1 }), touch: vi.fn(async () => {}), flush: vi.fn(async () => {}),
 }
 const options: ChatConnectionOptions = { accept: vi.fn(async () => {}), process: vi.fn(async () => {}), needed: () => true, assertCredentials: vi.fn(async () => {}), onHealth: vi.fn() }
 const controller = new AbortController()
 const service = new ChatReceiveServices(journal, options, controller.signal, () => true, 'ordered')
 return { service, journal, options, controller, epoch }
}
it('checkpoints native ordered no-ops only after flush and rejects stale epochs', async () => {
 const f = fixture()
 await expect(f.service.dispatch('accept', {kind:'ordered',epoch:f.epoch,sequence:40})).resolves.toEqual({disposition:'accepted',checkpoint:{epoch:f.epoch,nextSequence:41}})
 expect(f.options.process).not.toHaveBeenCalled()
 expect(f.journal.flush).toHaveBeenCalled()
 await expect(f.service.dispatch('accept',{kind:'ordered',epoch:randomUUID(),sequence:41})).rejects.toThrow()
 expect(f.journal.finish).toHaveBeenCalledTimes(1)
})
it('preserves native command/title/pairing semantics and acknowledges only durable prefix', async () => {
 const f = fixture()
 const event = {kind:'message',id:'update:40',chat:{id:'-10',kind:'group'},user:{id:'12',label:'Human'},messageId:'30',at:1,text:'/task@bot hello',addressed:true,command:{kind:'command',name:'task',args:'hello'},title:'Group',pairingEligible:false}
 await f.service.dispatch('accept',{kind:'ordered',epoch:f.epoch,sequence:40,event})
 expect(f.options.process).toHaveBeenCalledWith(expect.objectContaining({sequence:40,message:expect.objectContaining({command:event.command,chat:{...event.chat,title:'Group'},pairingEligible:false})}),f.epoch)
 vi.mocked(f.journal.flush).mockRejectedValueOnce(Error('disk'))
 await expect(f.service.dispatch('accept',{kind:'ordered',epoch:f.epoch,sequence:41})).rejects.toThrow('disk')
})
it('rejects cross-model delivery and denies choices after async revocation', async () => {
 const f = fixture(); let resolve!: (value: {name:string,value:string}[])=>void
 f.options.nativeCommands = {tasks: () => new Promise(r => {resolve=r})}
 const interaction = await f.service.dispatch('openInteraction',{kind:'task-autocomplete',eventId:'e',chat:{id:'c',kind:'private'},user:{id:'u',label:'U'},at:Date.now()}) as {handle:string}
 const pending = f.service.dispatch('taskChoices',{handle:interaction.handle,query:''})
 await vi.waitFor(() => expect(resolve).toBeDefined()); f.controller.abort(); resolve([{name:'secret',value:'id'}])
 await expect(pending).rejects.toThrow()
 await expect(f.service.dispatch('accept',{kind:'event',event:{kind:'membership',id:'e',chat:{id:'c',kind:'private'},reason:'removed'}})).rejects.toThrow()
})
