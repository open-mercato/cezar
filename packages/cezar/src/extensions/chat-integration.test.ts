import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ExtensionManager } from './manager.ts'
import { WebhookService } from '../webhooks/service.ts'
import { WebhookScheduler } from '../webhooks/scheduler.ts'
import { chatProvider, chatTransport } from '../chat/registry.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs() })
it('pairs through an external worker, persists grants, restores without re-pairing and isolates project disable', async () => {
 vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1')
 const root = await mkdtemp(join(tmpdir(), 'extension-chat-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
 execFileSync('git', ['init', '-q'], { cwd: root, timeout: 5000 })
 const source = join(root, 'plugin'); await mkdir(source)
 const input = join(root, 'events.json'), sent = join(root, 'sent.json'); await writeFile(input, '[]'); await writeFile(sent, '[]')
 const manifest = { id: 'test.chat', name: 'Test chat', version: '1.0.0', apiVersion: '0.1', entry: 'index.mjs', capabilities: ['chatProviders'], contributes: { chatProviders: [{ id: 'relay', label: 'Relay', credentials: [{name:'token',label:'Token'}], limits:{maxText:4000,buttonsPerMessage:0,perChatPerSecond:100,perBotPerSecond:100}, discoveryUrl:'https://chat.example.com',groupPrefix:'group:',receiveModel:'ordered' }] } }
 await writeFile(join(source, 'cezar-extension.json'), JSON.stringify(manifest))
 // The fixture platform is file-backed so IPC, host transport, setup and durable inbox are all real.
 await writeFile(join(source, 'index.mjs'), `import {readFile,writeFile} from 'node:fs/promises'; export function activate(c){return c.chat.register('relay',credentials=>({
 identify:async()=>({id:'fixture-bot',username:'relaybot'}),inspect:async id=>({id,kind:'private',eligible:true}),
 send:async(chatId,message)=>{const rows=JSON.parse(await readFile(${JSON.stringify(sent)},'utf8')); rows.push({chatId,message}); await writeFile(${JSON.stringify(sent)},JSON.stringify(rows)); return {chatId,messageId:'sent-'+rows.length}},
 clearButtons:async()=>{},acknowledge:async()=>{},isMember:async()=>true,
 receiveSession:async session=>{while(!session.signal.aborted){const {epoch,nextSequence}=await session.checkpoint();
  const rows=JSON.parse(await readFile(${JSON.stringify(input)},'utf8')).filter(item=>nextSequence===null||item.sequence>=nextSequence);
  for(const row of rows)await session.accept({kind:'ordered',epoch,sequence:row.sequence,...(row.event?{event:row.event}:{})});
  await new Promise(resolve=>setTimeout(resolve,50))}}
 }));}`)
 const dataDir = join(root, '.ai/cezar'), home = join(root, 'home')
 const manager = new ExtensionManager(dataDir, 'project', root, { home }); cleanup.push(() => manager.close())
 const service = (await WebhookService.open({root,dataDir,projectId:'project',mode:'local',serverPorts:()=>[],scheduler:new WebhookScheduler()}))!; cleanup.push(() => service.dispose())
 await manager.install(source); await manager.setEnabled('test.chat', true)
 const provider = 'test.chat/relay', botId = 'fixture-bot'
 const inbound = service.chats.get(provider)!
 expect(inbound).toBeDefined(); expect(chatProvider(provider, '/other')).toBeUndefined()
 const begun = await inbound.beginSetup({token:JSON.stringify({token:'fixture-private-token'}),name:'External chat',dedicatedBot:true})
 const code = new URL(begun.deepLink).searchParams.get('cezar_start')!
 await writeFile(input, JSON.stringify([{sequence:100,event:{kind:'message',id:'setup-event',messageId:'start-message',chat:{id:'private:one',kind:'private'},user:{id:'person',label:'Person'},at:Date.now(),text:'/start '+code,addressed:true}}]))
 await expect.poll(() => inbound.setupStatus(begun.setupId).status, { timeout: 5000 }).toBe('candidate')
 const status = inbound.setupStatus(begun.setupId)
 await inbound.activateSetup(begun.setupId,{activate:true,expectedRevision:status.inboundRevision,candidateUserId:'person',permissions:['respond']})
 expect(inbound.list().grants).toHaveLength(1)
 expect(JSON.parse(await readFile(sent,'utf8')).length).toBeGreaterThan(0)
 const stale = chatTransport(root,provider,JSON.stringify({token:'fixture-private-token'}))!
 await manager.setEnabled('test.chat',false)
 expect(service.chats.has(provider)).toBe(false)
 await expect(stale.send('private:one',{text:'must not send'})).rejects.toThrow()
 await manager.setEnabled('test.chat',true)
 expect(service.chats.get(provider)!.list().grants).toHaveLength(1)
 await expect.poll(() => service.chats.get(provider)!.list().bots[0]?.health.state).toBe('polling')
 await manager.uninstall('test.chat')
 expect(service.chats.has(provider)).toBe(false)
 expect(service.telegram).toBeDefined()
}, 30000)
