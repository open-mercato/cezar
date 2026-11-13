import {chatManagementOwner} from './project-runtime.ts'
import dns from 'node:dns/promises'
import tls from 'node:tls'
import {syncBuiltinESMExports} from 'node:module'
import {pathToFileURL} from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, readFile, rm, cp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { WebhookService } from '../webhooks/service.ts'
import { WebhookScheduler } from '../webhooks/scheduler.ts'
import { artifactIntegrity } from './installer.ts'
import { ExtensionManager } from './manager.ts'
import { chatTransport, projectChatExtensions } from '../chat/registry.ts'

const repositoryRoot = resolve(import.meta.dirname, '../../../..')

const workerSpawns=vi.hoisted(()=>vi.fn())
vi.mock('./worker-process.ts',async importOriginal=>{
 const actual=await importOriginal<typeof import('./worker-process.ts')>()
 return {...actual,spawnWorkerProcess:(options:Parameters<typeof actual.spawnWorkerProcess>[0])=>{workerSpawns();return actual.spawnWorkerProcess(options)}}
})

it.each([
 'installed',
 'selected',
 'selected-host',
 'delivered',
 'delivered-host',
 'facade',
 'lazy-host',
 'inventory-enable'
] as const)('executes the %s public Telegram entry in the ordinary worker against a loopback simulator', async mode => {
 workerSpawns.mockClear()
 const root = await mkdtemp(join(tmpdir(),'public-chat-worker-'))
 const queue: unknown[] = [
  { update_id: 40, edited_message: { ignored: true } },
  {
   update_id: 41,
   message: {
    message_id: 5,
    date: Math.floor(Date.now() / 1000),
    chat: { id: -30, type: 'group', title: 'Group' },
    from: { id: 40, is_bot: false, first_name: 'Human' },
    text: '/tasks@cezar_bot',
    entities: [{ type: 'bot_command', offset: 0, length: 16 }]
   }
  }
 ]
 const requests: {method:string;body:Record<string,unknown>}[]=[]
 const server=createServer(async (request,response)=>{
  const chunks:Buffer[]=[]; for await(const chunk of request) chunks.push(Buffer.from(chunk))
  const body=JSON.parse(Buffer.concat(chunks).toString()) as Record<string,unknown>
  const method=request.url!.split('/').at(-1)!;requests.push({method,body})
  const result =
   method === 'getWebhookInfo'
    ? { url: '' }
    : method === 'getChat'
      ? { id: Number(body.chat_id), type: Number(body.chat_id) < 0 ? 'supergroup' : 'private' }
      : method === 'getChatMember'
        ? { status: 'member', user: { id: Number(body.user_id) } }
        : method === 'getMe'
          ? { id: 700001, username: 'cezar_bot' }
          : method === 'getUpdates'
            ? queue.splice(0)
            : method === 'sendMessage'
              ? { message_id: 9, chat: { id: Number(body.chat_id) } }
              : true
  setTimeout(()=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({ok:true,result}))},10)
 })
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
 const port=(server.address() as {port:number}).port
 const preload=join(root,'simulator.mjs')
 await writeFile(preload,`import dns from 'node:dns/promises';import tls from 'node:tls';import net from 'node:net';import {syncBuiltinESMExports} from 'node:module';
 dns.lookup=async hostname=>{if(hostname!=='api.telegram.org')throw Error('Network denied');return [{address:'8.8.8.8',family:4}]};
 tls.connect=(options,callback)=>{if(options.servername!=='api.telegram.org'&&options.host!=='api.telegram.org')throw Error('Network denied');const socket=net.connect({host:'127.0.0.1',port:${port}});socket.authorized=true;socket.encrypted=true;socket.on('connect',()=>{socket.emit('secureConnect');callback?.()});return socket};syncBuiltinESMExports();`)
 const source=join(root,'telegram'); await mkdir(join(source,'dist'),{recursive:true})
 for (const file of ['cezar-extension.json', 'package.json', 'README.md'])
  await cp(resolve(repositoryRoot, 'packages/chat-plugins/telegram', file), join(source, file))
 await build({
  entryPoints: [resolve(repositoryRoot, 'packages/chat-plugins/telegram/src/index.ts')],
  outfile: join(source, 'dist/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  external: ['bufferutil', 'utf-8-validate']
 })
 const webhookSend = vi.fn(async () => { throw new Error('Outbound webhook send must not run in these chat scenarios') })
 let service: WebhookService | undefined
 if(mode==='selected'){await promisify(execFile)('git',['init','-q'],{cwd:root,timeout:5000});vi.stubEnv('CEZ_HOME',join(root,'home'))}
 if(mode === 'selected-host' || mode === 'delivered-host' || mode === 'facade' || mode === 'lazy-host') {
  await promisify(execFile)('git',['init','-q'],{cwd:root,timeout:5000})
  vi.stubEnv('CEZ_HOME',join(root,'home'));vi.stubEnv('CEZ_WEBHOOKS','1');vi.stubEnv('CEZ_CHAT_INBOUND','1')
  if(mode==='facade') vi.stubEnv('CEZ_EXTENSIONS','0')
  service = await WebhookService.open({
   root,
   dataDir: join(root, '.ai', 'cezar'),
   projectId: 'project',
   mode: 'local',
   serverPorts: () => [],
   scheduler: new WebhookScheduler(),
   send: webhookSend
  })
  expect(service).toBeDefined()
 }
 const originalNative=service?.telegram
 const originalLookup=dns.lookup, originalConnect=tls.connect
 if(mode==='facade') await import(pathToFileURL(preload).href)
 let manager = new ExtensionManager(join(root, '.ai', 'cezar'), 'project', root, {
  openChatOwner: chatManagementOwner({ root: root, dataDir: join(root, '.ai', 'cezar'), projectId: 'project' }),
  home: join(root, 'home'),
  deliveryPackageRoot: join(root, 'distribution'),
  workerExecArgv: ['--import', preload],
  ...(mode === 'facade' ? { trustedChatInProcess: true } : {})
 })
 let connection: ReturnType<NonNullable<ReturnType<typeof chatTransport>>['connect']>|undefined
 try {
  if(mode === 'installed' || mode === 'selected' || mode === 'selected-host') {
   const { stdout } = await promisify(execFile)('npm', ['pack', source, '--ignore-scripts', '--json', '--pack-destination', root], {
    timeout: 30000,
    env: { ...process.env, npm_config_userconfig: '/dev/null' }
   })
   const packed=JSON.parse(stdout) as {filename:string}[]
   // The installer accepts folders; exercise the exact npm-packed files.
   const unpacked=join(root,'unpacked');await mkdir(unpacked)
   await promisify(execFile)('tar',['-xzf',join(root,packed[0]!.filename),'-C',unpacked],{timeout:10000})
   const installed=await manager.install(join(unpacked,'package'))
   if(mode==='selected'||mode==='selected-host'){
    const {ChatSelectionStore}=await import('./chat-selection-store.ts')
    await new ChatSelectionStore(join(root, '.ai', 'cezar'), join(root, 'home')).replace('telegram', null, {
     kind: 'installed',
     record: installed,
     localProviderId: 'telegram'
    })
    await manager.declareDeliveredChat('telegram')
   }
   await manager.setEnabled('open-mercato.telegram',true)
  }
  else {
   const directory=join(root,'distribution','dist','chat-plugins'),stamps=[]
   for(const provider of ['telegram']) {
    const target=join(directory,provider);await mkdir(target,{recursive:true})
    await cp(source,target,{recursive:true})
    const manifest=JSON.parse(await readFile(join(target,'cezar-extension.json'),'utf8'))
    stamps.push({provider,extensionId:manifest.id,version:manifest.version,integrity:await artifactIntegrity(target)})
   }
   await writeFile(join(root,'distribution','package.json'),JSON.stringify({version:'0.20.0-test'}))
   await writeFile(join(directory,'catalog.json'),JSON.stringify(stamps))
   const inventory=await manager.inventory()
   expect(inventory).toHaveLength(1)
   expect(inventory.find(row => row.record.manifest.id === 'open-mercato.telegram')).toMatchObject({
    provenance: { kind: 'bundled', hostVersion: '0.20.0-test' },
    availability: 'available',
    selectedVersion: '0.1.0',
    providers: [{ id: 'telegram', label: 'Telegram' }]
   })
   expect((await manager.inventory('flag-disabled')).every(row=>row.availability==='available')).toBe(true)
   expect(inventory.every(row=>!row.management.update&&!row.management.uninstall&&row.management.disable)).toBe(true)
   expect(projectChatExtensions(root)).toEqual([])
   expect(workerSpawns).not.toHaveBeenCalled()
   expect(existsSync(join(root,'home'))).toBe(false)
   if(mode==='delivered') {
    const shipped=inventory.find(row=>row.record.manifest.id==='open-mercato.telegram')!.record
    const foreign = {
     ...shipped,
     manifest: { ...shipped.manifest, name: 'Third-party same ID' },
     integrity: 'sha512-' + Buffer.from('untrusted').toString('base64'),
     origin: undefined,
     installedAt: '2026-11-10',
     enabled: false
    }
    await mkdir(join(root,'home','extensions'),{recursive:true})
    await writeFile(join(root,'home','extensions','registry.json'),JSON.stringify([foreign]))
    expect(await manager.canManageDelivered('open-mercato.telegram')).toBe(false)
    expect((await manager.inventory()).find(row => row.record.manifest.id === 'open-mercato.telegram')).toMatchObject({
     provenance: { kind: 'npm', source: 'bundled' },
     providers: [{ id: 'open-mercato.telegram/telegram', label: 'Telegram' }]
    })
    await rm(join(root,'home'),{recursive:true,force:true})
    await mkdir(join(root,'.ai/cezar/extensions'),{recursive:true})
    await writeFile(join(root,'.ai/cezar/extensions/registry.json'),JSON.stringify([foreign]))
    expect(await manager.canManageDelivered('open-mercato.telegram')).toBe(false)
    expect(await manager.setEnabled('open-mercato.telegram',true)).toBeUndefined()
    await rm(join(root,'.ai/cezar/extensions/registry.json'))
    await rm(join(root,'home'),{recursive:true,force:true})
   }
   if(mode==='inventory-enable') {
    expect(await manager.setEnabled('open-mercato.telegram',true)).toMatchObject({source:'bundled',enabled:true})
   } else {
   await manager.declareDeliveredChat('telegram')
   expect(projectChatExtensions(root).map(row=>row.id)).toContain('telegram')
   expect(chatTransport(root,'telegram','unused')).toBeUndefined()
   expect(workerSpawns).not.toHaveBeenCalled()
   expect((await manager.list()).find(row=>row.manifest.id==='open-mercato.telegram')?.source).toBe('bundled')
   expect(workerSpawns).not.toHaveBeenCalled()
   if(service) await service.chat.start()
   expect(workerSpawns).not.toHaveBeenCalled()
   if(mode !== 'lazy-host') await manager.startDeliveredChat('telegram')
   }
   if(service) { expect(service.telegram).toBe(originalNative);expect(service.chats.get('telegram')).toBe(originalNative) }
   expect(chatTransport(root,'open-mercato.telegram/telegram','{}')).toBeUndefined()
  }
  const token='700001:'+ 'A'.repeat(32)
  if(mode !== 'lazy-host') {
  const transport = chatTransport(
   root,
   mode === 'installed' ? 'open-mercato.telegram/telegram' : 'telegram',
   mode === 'installed' ? JSON.stringify({ token }) : token
  )!
  expect(await transport.identify()).toMatchObject({id:'700001',username:'cezar_bot'})
  if(mode==='delivered') {
   await expect(manager.uninstall('open-mercato.telegram')).rejects.toThrow('Shipped adapters')
   expect(await transport.identify()).toMatchObject({id:'700001'})
  }
  let nextOffset:number|null=40; const epoch=randomUUID(); const seen:unknown[]=[]
  connection = transport.connect(
   {
    recover: async () => {},
    assertReady() {},
    prepareReceive: async () => {},
    snapshot: () => ({ epoch, nextOffset }),
    duplicate: (_e, s) => nextOffset !== null && s < nextOffset,
    finish: async (_e, s) => {
     nextOffset = s + 1
    },
    touch: async () => {},
    flush: async () => {}
   },
   {
    accept: async () => {
     throw Error('ordered event reached opaque inbox')
    },
    process: async update => {
     seen.push(update)
    },
    needed: () => true,
    assertCredentials: async () => {},
    onHealth: () => {}
   }
  )
  connection.start();await expect.poll(()=>nextOffset).toBe(42)
  expect(seen).toEqual([
   expect.objectContaining({
    sequence: 41,
    message: expect.objectContaining({ chat: { id: '-30', kind: 'group', title: 'Group' }, command: { kind: 'command', name: 'tasks', args: '' } })
   })
  ])
  expect(
   await transport.send('-30', {
    text: mode !== 'installed' ? 'Confirm &lt;safe&gt;' : 'Confirm <safe>',
    buttons: [[{ text: 'Confirm', data: 'confirm:fixture' }]]
   })
  ).toEqual({ chatId: '-30', messageId: '9' })
  expect(requests.find(row => row.method === 'sendMessage')?.body).toMatchObject({
   text: mode !== 'installed' ? 'Confirm &lt;safe&gt;' : 'Confirm <safe>',
   ...(mode !== 'installed' ? { parse_mode: 'HTML' } : {}),
   reply_markup: { inline_keyboard: [[{ text: 'Confirm', callback_data: 'confirm:fixture' }]] }
  })
  expect(requests.find(row=>row.method==='getUpdates')?.body.offset).toBe(40)
  if(mode === 'delivered') expect(existsSync(join(root,'home'))).toBe(false)
  if(mode === 'facade') expect(workerSpawns).not.toHaveBeenCalled()
  if(mode === 'installed') {
   // A separate manager writes the shared approval, as another cockpit would.
   // Stop the periodic reconciler: authorization itself must retire stale work.
   clearInterval((manager as unknown as {reconcileTimer:ReturnType<typeof setInterval>}).reconcileTimer)
   const other = new ExtensionManager(join(root, '.ai', 'cezar'), 'project', root, {
    openChatOwner: chatManagementOwner({ root: root, dataDir: join(root, '.ai', 'cezar'), projectId: 'project' }),
    home: join(root, 'home')
   })
   try {
    await other.setEnabled('open-mercato.telegram',false)
    await expect(transport.identify()).rejects.toMatchObject({failure:{kind:'blocked'}})
    await expect.poll(()=>chatTransport(root,'open-mercato.telegram/telegram',JSON.stringify({token})) === undefined).toBe(true)
    expect(connection.health().state).not.toBe('blocked')
    const count=requests.length
    await expect(transport.send('-30',{text:'revoked'})).rejects.toMatchObject({failure:{kind:'blocked'}})
    expect(requests).toHaveLength(count)
   } finally {await other.close()}
  }
  }
  if(service) {
   await connection?.stop();connection=undefined
   if(mode==='lazy-host') queue.length=0
   const begun=await service.telegram.beginSetup({token,name:'Canonical Telegram',dedicatedBot:true})
   const code=new URL(begun.deepLink!).searchParams.get('start');expect(code).toBeTruthy()
   queue.push({
    update_id: 42,
    message: {
     message_id: 6,
     date: Math.ceil(Date.now() / 1000),
     chat: { id: 40, type: 'private' },
     from: { id: 40, is_bot: false, first_name: 'Human' },
     text: '/start ' + code,
     entities: [{ type: 'bot_command', offset: 0, length: 6 }]
    }
   })
   await expect.poll(()=>service!.telegram.setupStatus(begun.setupId).status).toBe('candidate')
   const status=service.telegram.setupStatus(begun.setupId)
   await service.telegram.activateSetup(begun.setupId,{activate:true,expectedRevision:status.inboundRevision!,candidateUserId:'40',permissions:['respond']})
   expect(service.telegram.list().grants).toHaveLength(1)
   expect(service.chats.has('open-mercato.telegram/telegram')).toBe(false)
   expect(webhookSend).not.toHaveBeenCalled()
   if(mode==='selected-host') {
    const record=(await manager.installed()).find(item=>item.manifest.id==='open-mercato.telegram')!
    const input={target:{kind:'installed' as const,extensionId:record.manifest.id,localProviderId:'telegram',integrity:record.integrity!},enabled:true}
    const preview=await manager.previewChatSelection('telegram',input)
    await manager.selectChat('telegram',{...input,revision:preview.revision})
    const before=requests.filter(row=>row.method==='sendMessage').length
    queue.push({
     update_id: 43,
     message: {
      message_id: 7,
      date: Math.ceil(Date.now() / 1000),
      chat: { id: 40, type: 'private' },
      from: { id: 40, is_bot: false, first_name: 'Human' },
      text: '/help',
      entities: [{ type: 'bot_command', offset: 0, length: 5 }]
     }
    })
    await expect.poll(()=>requests.filter(row=>row.method==='sendMessage').length).toBeGreaterThan(before)
    await expect.poll(()=>requests.some(row=>row.method==='getUpdates'&&row.body.offset===44)).toBe(true)
    const oldManifest=JSON.parse(await readFile(join(source,'cezar-extension.json'),'utf8'))
    const oldPackage=JSON.parse(await readFile(join(source,'package.json'),'utf8'))
    await writeFile(join(source,'cezar-extension.json'),JSON.stringify({...oldManifest,version:'0.2.0'}))
    await writeFile(join(source,'package.json'),JSON.stringify({...oldPackage,version:'0.2.0'}))
    await writeFile(join(source,'dist/index.js'),"throw Error('candidate activation failed')")
    const broken=await manager.install(source)
    const replacement={...input,target:{...input.target,integrity:broken.integrity!}}
    const brokenPreview=await manager.previewChatSelection('telegram',replacement)
    await expect(manager.selectChat('telegram',{...replacement,revision:brokenPreview.revision})).rejects.toThrow('candidate activation failed')
    const afterRollback=requests.filter(row=>row.method==='sendMessage').length
    queue.push({
     update_id: 44,
     message: {
      message_id: 8,
      date: Math.ceil(Date.now() / 1000),
      chat: { id: 40, type: 'private' },
      from: { id: 40, is_bot: false, first_name: 'Human' },
      text: '/help',
      entities: [{ type: 'bot_command', offset: 0, length: 5 }]
     }
    })
    await expect.poll(()=>requests.filter(row=>row.method==='sendMessage').length).toBeGreaterThan(afterRollback)
    expect((await manager.inventory()).find(row=>row.record.manifest.id===record.manifest.id)?.selectedVersion).toBe(record.manifest.version)
    expect(service.telegram.list().grants).toHaveLength(1)
    expect(webhookSend).not.toHaveBeenCalled()
   }
   if(mode==='delivered-host') {
    await manager.install(source)
    expect((await manager.uninstallImpact('open-mercato.telegram')).projects).toEqual([])
    const selected=(await manager.inventory('flag-disabled')).find(row=>row.record.manifest.id==='open-mercato.telegram')!
    expect(selected).toMatchObject({
     provenance: { kind: 'bundled' },
     providers: [{ id: 'telegram' }],
     management: { disable: true, uninstall: false },
     installedCandidate: {
      record: { enabled: false, status: 'disabled' },
      availability: 'flag-disabled',
      provenance: { kind: 'folder' },
      management: { enable: false, disable: false, update: false, uninstall: false }
     }
    })
    expect(await manager.canManageDelivered('open-mercato.telegram')).toBe(true)
    await manager.setEnabled('open-mercato.telegram',false,undefined,{shippedOnly:true})
    expect(service.telegram.list().receivers[0]?.state).toBe('disabled')
    await manager.setEnabled('open-mercato.telegram',true,selected.record.integrity,{shippedOnly:true})
    const both=(await manager.inventory()).find(row=>row.record.manifest.id==='open-mercato.telegram')!
    expect(both.installedCandidate).toMatchObject({management:{enable:false,disable:false,update:true,uninstall:true}})


    expect(service.telegram.list().receivers[0]?.state).toBe('active')
    expect(await chatTransport(root,'telegram',token)!.identify()).toMatchObject({id:'700001'})
   }
   if(mode==='lazy-host'||mode==='delivered-host') {
    await service.dispose();await manager.close();workerSpawns.mockClear()
    manager = new ExtensionManager(join(root, '.ai', 'cezar'), 'project', root, {
     openChatOwner: chatManagementOwner({ root: root, dataDir: join(root, '.ai', 'cezar'), projectId: 'project' }),
     home: join(root, 'home'),
     deliveryPackageRoot: join(root, 'distribution'),
     workerExecArgv: ['--import', preload]
    })
    await manager.declareDeliveredChat('telegram')
    service = await WebhookService.open({
     root,
     dataDir: join(root, '.ai', 'cezar'),
     projectId: 'project',
     mode: 'local',
     serverPorts: () => [],
     scheduler: new WebhookScheduler(),
     send: webhookSend
    })
    if(!service) throw Error('Reopened webhook service unavailable')
    expect(service.telegram.list().grants).toHaveLength(1)
    expect(workerSpawns).not.toHaveBeenCalled()
    const before=requests.length
    await service!.startChat()
    await expect.poll(()=>requests.slice(before).some(row=>row.method==='getUpdates')).toBe(true)
    expect(workerSpawns).toHaveBeenCalledTimes(1)
    expect(webhookSend).not.toHaveBeenCalled()
   }
   if(mode==='delivered-host') {
    expect(await manager.uninstall('open-mercato.telegram')).toBe(true)
    expect(service.telegram.list().receivers[0]?.state).toBe('active')
    expect(await chatTransport(root,'telegram',token)!.identify()).toMatchObject({id:'700001'})
   }
   if(mode==='delivered-host') {
    await service.dispose();service=undefined
    vi.stubEnv('CEZ_WEBHOOKS','0')
    const count=requests.length
    await manager.setEnabled('open-mercato.telegram',false)
    expect(requests).toHaveLength(count)
    vi.stubEnv('CEZ_WEBHOOKS','1')
    service = await WebhookService.open({
     root,
     dataDir: join(root, '.ai', 'cezar'),
     projectId: 'project',
     mode: 'local',
     serverPorts: () => [],
     scheduler: new WebhookScheduler(),
     send: webhookSend
    })
    if(!service) throw Error('Reopened webhook service unavailable')
   } else await manager.setEnabled('open-mercato.telegram',false)
   expect(service.telegram.list().receivers.every(row=>row.state==='disabled')).toBe(true)
   expect((await manager.inventory()).find(row => row.record.manifest.id === 'open-mercato.telegram')).toMatchObject({
    availability: 'disabled',
    providers: [{ id: 'telegram', label: 'Telegram' }]
   })
   expect(service.endpoints.live().filter(row=>row.format==='telegram.v1').every(row=>row.state==='paused')).toBe(true)
   expect(service.telegram.list().grants).toHaveLength(1)
   await manager.setEnabled('open-mercato.telegram',true)
   await expect.poll(()=>service!.telegram.list().receivers[0]?.state).toBe('active')
   expect(service.endpoints.live().filter(row=>row.format==='telegram.v1').every(row=>row.state==='active')).toBe(true)
   if(mode==='facade') expect(workerSpawns).not.toHaveBeenCalled()
  }

 } finally {
  await connection?.stop();await service?.dispose();await manager.close();
  dns.lookup=originalLookup;tls.connect=originalConnect;syncBuiltinESMExports();
  vi.unstubAllEnvs();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true})
 }
},30000)
