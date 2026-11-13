import { SecretStore } from '../workspace/secrets.ts'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { extensionManifestSchema } from '@open-mercato/cezar-contract'
import { ExtensionHost } from './host.ts'
const roots: string[] = []
const hosts: ExtensionHost[] = []
afterEach(async () => { for (const host of hosts) await host.deactivate('test'); for (const root of roots) await rm(root, { recursive: true, force: true }) })
async function fixture(code: string) {
 const root = await mkdtemp(join(tmpdir(), 'extension-host-')); roots.push(root)
 // A handler written as `run(id, input, context)` becomes the one declared command.
 const bind = /function run\(/.test(code) ? "\nexport function activate(c){c.commands.register('read',(input,ctx)=>run('read',input,ctx))}" : ''
 const entry = join(root, 'index.mjs'); await writeFile(entry, code + bind)
 const host = new ExtensionHost(); hosts.push(host)
 const manifest = extensionManifestSchema.parse({
  id: 'test',
  name: 'Test',
  version: '1',
  apiVersion: '0.1',
  entry: 'index.mjs',
  capabilities: ['commands', 'panels', 'taskEvents'],
  contributes: { commands: [{ id: 'read', label: 'Read' }], panels: [{ id: 'summary', title: 'Summary' }] }
 })
 return { host, instance: { id: 'test', manifest, entry, projectId: 'project-a' } }
}
it('provides the project host API to registered commands across process IPC', async () => {
 const { host, instance } = await fixture(
  `export default { activate(context) { context.commands.register('read', async () => ({ message: JSON.stringify(await context.tasks.list()) })); } }`
 )
 await host.activate({ ...instance, dispatch: async (method: string) => { if (method === 'tasks.list') return [{ id: 'a' }]; throw Error('unknown') } })
 await expect(host.invoke('test', 'read', {})).resolves.toEqual({ message: '[{"id":"a"}]' })
})
it('hands a task-located panel the host-asserted runId and a settings panel nothing at all', async () => {
 const { host, instance } = await fixture(
  `export default { activate(context) { context.panels.register('summary', (...args) => ({ id: 'summary', title: JSON.stringify(args) })); } }`
 )
 await host.activate(instance)
 await expect(host.panel('test', 'summary')).resolves.toEqual({ id: 'summary', title: '[]' })
 await expect(host.panel('test', 'summary', 'run-1')).resolves.toEqual({ id: 'summary', title: '[{"runId":"run-1"}]' })
 await expect(host.panel('test', 'summary', '../escape')).rejects.toThrow()
})
it('folds the host-asserted runId into a command input', async () => {
 const { host, instance } = await fixture(
  `export default { activate(context) { context.commands.register('read', async input => ({ message: JSON.stringify(input ?? null) })); } }`
 )
 await host.activate(instance)
 await expect(host.invoke('test', 'read', { a: 1 })).resolves.toEqual({ message: '{"a":1}' })
 await expect(host.invoke('test', 'read', undefined)).resolves.toEqual({ message: 'null' })
 await expect(host.invoke('test', 'read', { a: 1 }, undefined, 'run-1')).resolves.toEqual({ message: '{"a":1,"runId":"run-1"}' })
 await expect(host.invoke('test', 'read', undefined, undefined, 'run-1')).resolves.toEqual({ message: '{"runId":"run-1"}' })
})
it('keeps console output on the stderr tail the host prints on a crash', async () => {
 const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
 const { host, instance } = await fixture(`function run() { console.log('from log'); console.error('from error'); process.exit(6) }`)
 await host.activate(instance)
 await expect(host.invoke('test', 'read', {})).rejects.toThrow()
 await expect.poll(() => logged.mock.calls.flat().join('\n')).toMatch(/from log\nfrom error/)
 logged.mockRestore()
})
it('hands a registered command its context', async () => {
 const { host, instance } = await fixture(`function run(id, input, context) { return { message: context.projectId }; }`)
 await host.activate(instance)
 await expect(host.invoke('test', 'read', {})).resolves.toEqual({ message: 'project-a' })
})
it('rejects pending calls promptly when disabled and rejects future calls', async () => {
 const { host, instance } = await fixture(`async function run(id, input, context) { await context.logger.info('started'); return new Promise(() => {}); }`)
 let started!: () => void
 const running = new Promise<void>(resolve => { started = resolve })
 await host.activate({ ...instance, dispatch: async () => { started(); return null } })
 const pending = expect(host.invoke('test', 'read', {})).rejects.toThrow(/stopp|disabled/)
 await running
 await Promise.all([host.deactivate('test'), pending])
 await expect(host.invoke('test', 'read', {})).rejects.toThrow(/active/)
})
it('rejects undeclared registrations at activation', async () => {
 const { host, instance } = await fixture(`export default { activate(context) { context.commands.register('undeclared', () => {}); } }`)
 await expect(host.activate(instance)).rejects.toThrow(/declared/)
})
it('delivers task events to a worker and releases its host subscription on disable', async () => {
 const { host, instance } = await fixture(
  `let resolveEvent; const event = new Promise(resolve => { resolveEvent = resolve }); export function activate(context) { context.taskEvents.subscribe(resolveEvent); context.commands.register('read', async () => ({ message: (await event).type })); }`
 )
 let listener: ((event: unknown) => void) | undefined
 let released = false
 await host.activate({ ...instance, subscribe: callback => { listener = callback; return () => { released = true; listener = undefined } } })
 const result = host.invoke('test', 'read', {})
 listener?.({ type: 'updated' })
 await expect(result).resolves.toEqual({ message: 'updated' })
 await host.deactivate('test')
 expect(released).toBe(true)
 expect(listener).toBeUndefined()
})
it('drops malformed provider failure details without terminating the worker', async () => {
 const { host, instance } = await fixture(
  `function run(id,input){if(input.fail)throw Object.assign(Error('provider refused'),{failure:{kind:'rate_limited',retryAfterMs:0}});return {message:'alive'};}`
 )
 await host.activate(instance)
 await expect(host.invoke('test','read',{fail:true})).rejects.toThrow('provider refused')
 await expect(host.invoke('test','read',{})).resolves.toEqual({message:'alive'})
})
it('retries an adapter factory after a transient asynchronous rejection', async () => {
 const { host, instance } = await fixture(
  `export function activate(c){let attempt=0;c.chat.register('chat',async()=>{if(++attempt===1)throw Error('temporary');return {identify:async()=>({id:'bot',username:'Bot'})}});}`
 )
 instance.manifest = extensionManifestSchema.parse({
  ...instance.manifest,
  capabilities: ['commands', 'panels', 'chatProviders'],
  contributes: {
   ...instance.manifest.contributes,
   chatProviders: [
    {
     id: 'chat',
     label: 'Chat',
     credentials: [{ name: 'token', label: 'Token' }],
     discoveryUrl: 'https://example.com',
     limits: { maxText: 1000, buttonsPerMessage: 0, perChatPerSecond: 1, perBotPerSecond: 1 },
     receiveModel: 'ordered'
    }
   ]
  }
 })
 await host.activate(instance)
 const call = {providerId:'chat',botHandle:'dce3f484-d031-4ec2-b7cb-17e72c814af9',credential:'{"token":"test"}',operation:'identify',input:{}}
 await expect(host.chat('test',call)).rejects.toThrow('temporary')
 await expect(host.chat('test',call)).resolves.toEqual({id:'bot',username:'Bot'})
})
it('answers an oversized host reply with an error instead of killing the worker', async () => {
 const { host, instance } = await fixture(
  `export default { activate(context) { context.commands.register('read', async () => { try { await context.tasks.list() } catch (e) { return { message: e.message } } return { message: 'listed' } }); } }`
 )
 await host.activate({ ...instance, dispatch: async () => 'x'.repeat(2 * 1024 * 1024) })
 await expect(host.invoke('test', 'read', {})).resolves.toEqual({ message: 'Host response exceeds the IPC frame limit' })
 await expect(host.invoke('test', 'read', {})).resolves.toBeDefined()
})
it('survives stray stdout writes from extension code', async () => {
 const { host, instance } = await fixture(
  `process.stdout.write('loading\\n'); export default { activate(context) { process.stdout.write('{"not":"rpc"}\\n'); context.commands.register('read', async () => { process.stdout.write('progress 50%\\n'); return { message: 'still alive' } }); } }`
 )
 await host.activate(instance)
 await expect(host.invoke('test', 'read', {})).resolves.toEqual({ message: 'still alive' })
})
it('gives extension workers the same proxy/CA allowlist as bundled workers, never other env', async () => {
 const saved = { proxy: process.env.HTTPS_PROXY, secret: process.env.CEZ_TEST_SECRET }
 process.env.HTTPS_PROXY = 'http://proxy:3128'; process.env.CEZ_TEST_SECRET = 'nope'
 try {
  const { host, instance } = await fixture(
   `function run() { return { message: JSON.stringify([process.env.HTTPS_PROXY, process.env.CEZ_TEST_SECRET ?? null]) }; }`
  )
  await host.activate(instance)
  await expect(host.invoke('test', 'read', {})).resolves.toEqual({ message: '["http://proxy:3128",null]' })
 } finally {
  if (saved.proxy === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = saved.proxy
  if (saved.secret === undefined) delete process.env.CEZ_TEST_SECRET; else process.env.CEZ_TEST_SECRET = saved.secret
 }
})
it('a worker that dies during activation only rejects activate, never reports a failure too', async () => {
 const { host, instance } = await fixture(`process.exit(4)`)
 const failures: Error[] = []
 await expect(host.activate({ ...instance, onFailure: error => { failures.push(error) } })).rejects.toThrow(/exit/)
 expect(failures).toEqual([])
})
it('reports an unexpected exit after activation', async () => {
 const { host, instance } = await fixture(`function run() { process.exit(6) }`)
 const failures: Error[] = []
 await host.activate({ ...instance, onFailure: error => { failures.push(error) } })
 await expect(host.invoke('test', 'read', {})).rejects.toThrow(/exit/)
 await expect.poll(() => failures.length).toBe(1)
})
it('redacts remembered secrets from both stdout and stderr crash diagnostics', async () => {
 const { host, instance } = await fixture(
  `async function run(id,input,c) { const secret=await c.secrets.get('token'); process.stdout.write('stdout '+secret+'\\n'); process.stderr.write('stderr '+secret+'\\n',()=>process.exit(7)); return new Promise(()=>{}); }`
 )
 const secret = 'synthetic-crash-secret-98234'
 const logs: string[] = []
 const original = console.error
 console.error = (...args) => { logs.push(args.join(' ')) }
 try {
  await host.activate({
   ...instance,
   dispatch: async () => secret,
   sanitize: value => typeof value === 'string' ? value.replaceAll(secret, '[REDACTED]') : value
  })
  await expect(host.invoke('test', 'read', {})).rejects.toThrow(/exit/)
  expect(logs.join('\n')).toContain('[REDACTED]')
  expect(logs.join('\n')).not.toContain(secret)
 } finally { console.error = original }
})
it.each(['abort', 'revoke'])('fences a real adapter delayed wire effect after %s', async mode => {
 const { host, instance } = await fixture(`export function activate(c) {
 let release; const gate=new Promise(r=>release=r);
 c.commands.register('read',()=>{release();return {message:'released'}});
 c.chat.register('chat',()=>({send:async(chatId,message,operation)=>{
   await c.logger.info('preparing'); await gate;
   await operation?.assertActive();
   operation?.signal.throwIfAborted();
   await c.storage.set('wire-effect',message.text);
   return {chatId,messageId:'sent'};
 }})); }`)
 instance.manifest = extensionManifestSchema.parse({
  ...instance.manifest,
  capabilities: ['commands', 'panels', 'chatProviders'],
  contributes: {
   ...instance.manifest.contributes,
   chatProviders: [
    {
     id: 'chat',
     label: 'Chat',
     credentials: [{ name: 'token', label: 'Token' }],
     discoveryUrl: 'https://example.com',
     limits: { maxText: 1000, buttonsPerMessage: 0, perChatPerSecond: 1, perBotPerSecond: 1 },
     receiveModel: 'ordered'
    }
   ]
  }
 })
 let started!:()=>void
 const preparing = new Promise<void>(r=>{started=r})
 const effects: unknown[] = []
 const controller=new AbortController()
 let valid=true
 await host.activate({
  ...instance,
  dispatch: async (method, params) => {
   if (method === 'logger.info') started()
   if (method === 'storage.set') effects.push(params)
   return null
  }
 })
 const pending = host
  .chat(
   'test',
   {
    providerId: 'chat',
    botHandle: 'dce3f484-d031-4ec2-b7cb-17e72c814af9',
    credential: '{}',
    operation: 'send',
    input: { chatId: 'room', message: { text: 'private' } }
   },
   { signal: controller.signal, valid: () => valid }
  )
  .catch(error => error)
 await preparing
 if(mode==='abort')controller.abort();else valid=false
 await host.invoke('test','read',{})
 const result=await pending
 expect(result).toBeInstanceOf(Error)
 // The command releases preparation; give the worker's host call a complete IPC round trip.
 await host.invoke('test','read',{})
 expect(effects).toEqual([])
})

it.each(['line', 'chunk', 'tail', 'multiline', 'overflow'])('redacts actual host stderr before %s boundaries', async boundary => {
 const { ExtensionHostContext } = await import('./context.ts')
 const secret = boundary === 'multiline' ? 'SECRET_FIRST_LINE'.repeat(3) + '\nSECRET_SECOND_LINE' : 'SYNTHETIC_SECRET_1234567890'
 const payload = boundary === 'tail' ? secret + '\n' + ('x'.repeat(480) + '\n').repeat(8) + 'x'.repeat(240)
   : boundary === 'overflow' ? 'x'.repeat(65520) + secret + 'x'.repeat(100000)
   : 'x'.repeat(480) + secret + '\n'
 const { host, instance } = await fixture(`async function run() {
   const text = ${JSON.stringify(payload)};
   process.stderr.write(text.slice(0, 490));
   await new Promise(r => setTimeout(r, 30));
   process.stderr.write(text.slice(490), () => process.exit(7));
   return new Promise(() => {});
 }`)
 const context = new ExtensionHostContext({
  secrets: new SecretStore(),
  dataDir: instance.entry,
  projectId: 'project-a',
  projectRoot: instance.entry,
  extensionId: 'test',
  permissions: []
 })
 context.rememberSecret(secret)
 const logs: string[] = []
 const { vi } = await import('vitest')
 const spy = vi.spyOn(console, 'error').mockImplementation((...args) => { logs.push(args.join(' ')) })
 try {
   await host.activate({ ...instance, sanitize: value => context.redact(value) })
   await expect(host.invoke('test', 'read', {})).rejects.toThrow(/exited/)
   const output = logs.join('\n')
   expect(output).toContain('last stderr')
   for (const fragment of ['SYNTHETIC', 'SECRET_', '1234', '7890', 'SECOND_LINE']) expect(output).not.toContain(fragment)
   expect(output.length).toBeLessThan(4500)
 } finally { spy.mockRestore() }
})

it('rejects a crashed host call promptly and suppresses incomplete stderr held by a descendant', async () => {
 const { ExtensionHostContext } = await import('./context.ts')
 const { vi } = await import('vitest')
 const { host, instance } = await fixture(`
   import { spawn } from 'node:child_process';
   async function run(id, input, context) {
     const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:['ignore', process.stdout, process.stderr]});
     await context.logger.info(String(child.pid));
     process.stderr.write('PARTIAL_SECRET', () => process.exit(7));
     return new Promise(() => {});
   }`)
 const context = new ExtensionHostContext({
  secrets: new SecretStore(),
  dataDir: instance.entry,
  projectId: 'project-a',
  projectRoot: instance.entry,
  extensionId: 'test',
  permissions: []
 })
 context.rememberSecret('PARTIAL_SECRET_WITH_MORE_BYTES')
 let descendant = 0
 let failures = 0
 const logs: string[] = []
 const spy = vi.spyOn(console, 'error').mockImplementation((...args) => { logs.push(args.join(' ')) })
 try {
   await host.activate({...instance, sanitize: value => context.redact(value), onFailure: () => { failures++ },
     dispatch: async (_method, params) => { descendant = Number((params as {message: string}).message) }})
   const result = host.invoke('test', 'read', {}).catch(error => error as Error)
   await expect.poll(() => failures, {timeout: 2_000}).toBe(1)
   expect((await result as Error).message).toContain('exited')
   expect(descendant).toBeGreaterThan(0)
   // The descendant remains alive throughout both assertions; it cannot gate failure or diagnostics.
   process.kill(descendant, 0)
   await expect.poll(() => logs.join('\n'), {timeout: 2_000}).toContain('stderr omitted')
   expect(logs.join('\n')).not.toContain('PARTIAL_SECRET')
 } finally {
   if (descendant) { try { process.kill(descendant, 'SIGKILL') } catch {} }
   await host.deactivate('test')
   spy.mockRestore()
 }
})
it('runs public receive sessions through scoped services and drains cancellation before reuse', async () => {
 const { host, instance } = await fixture(`export function activate(c){let factories=0;c.chat.register('chat',()=>{const ordinal=++factories;return {
 identify:async()=>({id:String(ordinal),username:'Bot'}),
 receiveSession:async s=>{await s.accept({probe:true});await new Promise(r=>s.signal.addEventListener('abort',r,{once:true}));}
 }});}`)
 instance.manifest = extensionManifestSchema.parse({
  ...instance.manifest,
  capabilities: ['commands', 'panels', 'chatProviders'],
  contributes: {
   ...instance.manifest.contributes,
   chatProviders: [
    {
     id: 'chat',
     label: 'Chat',
     credentials: [{ name: 'token', label: 'Token' }],
     discoveryUrl: 'https://example.com',
     limits: { maxText: 1000, buttonsPerMessage: 0, perChatPerSecond: 1, perBotPerSecond: 1 },
     receiveModel: 'ordered'
    }
   ]
  }
 })
 await host.activate(instance)
 const botHandle = 'dce3f484-d031-4ec2-b7cb-17e72c814af9'
 const params = {providerId:'chat',botHandle,credential:'{"token":"first"}',operation:'identify',input:{}}
 expect(await host.chat('test',params)).toEqual({id:'1',username:'Bot'})
 expect(await host.chat('test',{...params,credential:'{"token":"refreshed"}'})).toEqual({id:'1',username:'Bot'})
 const controller = new AbortController(); let accepted!: () => void
 const started = new Promise<void>(r => {accepted=r})
 const run = host.receiveSession(
  'test',
  { ...params, operation: 'receiveSession' },
  {
   signal: controller.signal,
   service: async (method, input) => {
    expect(method).toBe('accept')
    expect(input).toEqual({ probe: true })
    accepted()
   }
  }
 )
 const stopped = expect(run).rejects.toThrow('cancelled')
 await started; controller.abort(); await stopped
 expect(await host.chat('test',params)).toEqual({id:'1',username:'Bot'})
})
it('does not apply the ordinary RPC deadline to a live receiver', async () => {
 const { host, instance } = await fixture(
  `export function activate(c){c.chat.register('chat',()=>({receiveSession:async s=>{await s.health({state:'polling'});await new Promise(r=>s.signal.addEventListener('abort',r,{once:true}));},identify:async()=>({id:'bot',username:'Bot'})}));}`
 )
 instance.manifest = extensionManifestSchema.parse({
  ...instance.manifest,
  capabilities: ['commands', 'panels', 'chatProviders'],
  contributes: {
   ...instance.manifest.contributes,
   chatProviders: [
    {
     id: 'chat',
     label: 'Chat',
     credentials: [{ name: 'token', label: 'Token' }],
     discoveryUrl: 'https://example.com',
     limits: { maxText: 1000, buttonsPerMessage: 0, perChatPerSecond: 1, perBotPerSecond: 1 },
     receiveModel: 'ordered'
    }
   ]
  }
 })
 await host.activate(instance)
 const controller = new AbortController(); let started!:()=>void; const ready = new Promise<void>(r=>{started=r})
 let settled=false
 const params={providerId:'chat',botHandle:'dce3f484-d031-4ec2-b7cb-17e72c814af9',credential:'{}',operation:'receiveSession',input:{}}
 // Only setTimeout is faked: worker IPC stays real while the host's call deadlines are driven here.
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']})
 const running=host.receiveSession('test',params,{signal:controller.signal,service:async()=>{started()}}).then(()=>{settled=true},()=>{settled=true})
 try {
  await ready
  vi.advanceTimersByTime(30_100)
  expect(await host.chat('test',{...params,operation:'identify'})).toEqual({id:'bot',username:'Bot'})
  expect(settled).toBe(false)
 } finally {vi.useRealTimers();controller.abort();await running}
})
it.each(['cooperative','forced','exit'] as const)('drains host chat services before %s cancellation or successor activation', async mode => {
 const {host,instance}=await fixture(`export function activate(c){c.chat.register('chat',()=>({receiveSession:async s=>{
 const accepted=s.accept({probe:true});
 ${mode === 'cooperative' ? "await Promise.race([accepted,new Promise(r=>s.signal.addEventListener('abort',r,{once:true}))])" : mode === 'exit' ? 'setTimeout(()=>process.exit(1),100);await accepted' : 'await accepted'};
 }}))}`)
 instance.manifest = extensionManifestSchema.parse({
  ...instance.manifest,
  capabilities: ['commands', 'panels', 'chatProviders'],
  contributes: {
   ...instance.manifest.contributes,
   chatProviders: [
    {
     id: 'chat',
     label: 'Chat',
     credentials: [{ name: 'token', label: 'Token' }],
     discoveryUrl: 'https://example.com',
     limits: { maxText: 1000, buttonsPerMessage: 0, perChatPerSecond: 1, perBotPerSecond: 1 },
     receiveModel: 'ordered'
    }
   ]
  }
 })
 let release!:()=>void,entered!:()=>void,settled=false,failed=false
 const work=new Promise<void>(r=>{release=r}),started=new Promise<void>(r=>{entered=r})
 await host.activate({...instance,onFailure:()=>{failed=true}})
 const controller=new AbortController()
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']})
 const running = host
  .receiveSession(
   'test',
   { providerId: 'chat', botHandle: 'dce3f484-d031-4ec2-b7cb-17e72c814af9', credential: '{}', operation: 'receiveSession', input: {} },
   {
    signal: controller.signal,
    service: async () => {
     entered()
     await work
    }
   }
  )
  .then(
   () => {
    settled = true
   },
   () => {
    settled = true
   }
  )
 try {
  await started
  if(mode !== 'exit') controller.abort()
  // Past the forced-cancel deadline; the worker's exit or drained reply is the signal, not a sleep.
  vi.advanceTimersByTime(1_000)
  const session=(host as unknown as {sessions:Map<string,{failed?:boolean;drains:Map<string,unknown>}>}).sessions.get('test')!
  await expect.poll(()=>mode === 'cooperative' ? session.drains.size === 0 : session.failed === true).toBe(true)
  expect(settled).toBe(false)
  expect(failed).toBe(false)
  if(mode !== 'cooperative') await expect(host.activate(instance)).rejects.toThrow('stopped')
 } finally {vi.useRealTimers();release();await running;await host.deactivate('test')}
})
it('exposes public receiver health through the connection read model', async()=>{
 const { host, instance } = await fixture(
  `export function activate(c){c.chat.register('chat',()=>({receiveSession:async s=>{await s.health({state:'polling'});await s.health({state:'backoff'});await new Promise(r=>s.signal.addEventListener('abort',r,{once:true}))}}))}`
 )
 instance.manifest = extensionManifestSchema.parse({
  ...instance.manifest,
  capabilities: ['commands', 'panels', 'chatProviders'],
  contributes: {
   ...instance.manifest.contributes,
   chatProviders: [
    {
     id: 'chat',
     label: 'Chat',
     credentials: [{ name: 'token', label: 'Token' }],
     discoveryUrl: 'https://example.com',
     limits: { maxText: 1000, buttonsPerMessage: 0, perChatPerSecond: 1, perBotPerSecond: 1 },
     receiveModel: 'ordered'
    }
   ]
  }
 })
 await host.activate(instance)
 const {ChatExtensionBridge}=await import('./chat-bridge.ts')
 const {randomUUID}=await import('node:crypto')
 const bridge = new ChatExtensionBridge(
  (operation, input, options) => host.receiveSession('test', { providerId: 'chat', botHandle: randomUUID(), credential: '{}', operation, input }, options),
  () => true,
  'ordered'
 )
 const seen:unknown[]=[]
 const connection = bridge.connect(
  {
   recover: async () => {},
   assertReady() {},
   prepareReceive: async () => {},
   snapshot: () => ({ epoch: randomUUID(), nextOffset: 0 }),
   duplicate: () => false,
   finish: async () => {},
   touch: async () => {},
   flush: async () => {}
  },
  {
   accept: async () => {},
   process: async () => {},
   needed: () => true,
   assertCredentials: async () => {},
   onHealth: value => {
    seen.push(value)
   }
  }
 )
 try {
  connection.start();await expect.poll(()=>seen.at(-1)).toEqual({state:'backoff'})
  expect(connection.health()).toEqual({state:'backoff'})
  expect(seen).toContainEqual({state:'polling',lastSuccessfulPollAt:expect.any(Number)})
 } finally {await connection.stop()}
})
