import {chatManagementOwner} from './project-runtime.ts'
import {extensionChatSelectionPreviewSchema} from '@open-mercato/cezar-contract'
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {afterEach,expect,it,vi} from 'vitest'
import type {ProjectContext} from '../server/project-context.ts'
import {ExtensionManager} from './manager.ts'
import {ExtensionStore} from './store.ts'
import {ChatSelectionStore} from './chat-selection-store.ts'
import {projectChatExtensions,chatTransport} from '../chat/registry.ts'
const roots:string[]=[],managers:ExtensionManager[]=[]
afterEach(async()=>{for(const m of managers.splice(0))await m.close();for(const r of roots.splice(0))await rm(r,{recursive:true,force:true})})
async function setup(){
 const root=await mkdtemp(join(tmpdir(),'selection-lifetime-'));roots.push(root);execFileSync('git',['init','-q'],{cwd:root,timeout:5000})
 const home=join(root,'home'),data=join(root,'.ai','cezar'),source=join(root,'source');await mkdir(source)
 const manifest=JSON.parse(await readFile(new URL('../../../chat-plugins/telegram/cezar-extension.json',import.meta.url),'utf8'))
 manifest.entry='index.mjs';manifest.contributes.chatProviders.push({...manifest.contributes.chatProviders[0],id:'other'})
 await writeFile(join(source,'cezar-extension.json'),JSON.stringify(manifest))
 await writeFile(join(source,'index.mjs'),`export function activate(c){c.chat.register('telegram',()=>({identify:async()=>({id:'1',username:'fixture'})}));c.chat.register('other',()=>({identify:async()=>({id:'2',username:'other'})}));}`)
 const create=(d=data,p=root)=>{const m=new ExtensionManager(d,'project',p,{openChatOwner:chatManagementOwner({root:p,dataDir:d,projectId:'project',mode:'local' as const,runtimeAllowed:true}),home,deliveryPackageRoot:join(root,'absent')});managers.push(m);return m}
 const manager=create(),record=await manager.install(source)
 await new ChatSelectionStore(data,home).replace('telegram',null,{kind:'installed',record,localProviderId:'telegram'})
 return {root,home,data,source,create,manager,record}
}

it.each(['flag','hosted'] as const)('later transport calls observe stored policy: %s',async mode=>{
 const {root,manager,record}=await setup();let policy:'worker'|'facade'|'blocked'='worker'
 const input={target:{kind:'installed' as const,extensionId:record.manifest.id,localProviderId:'telegram',integrity:record.integrity!},enabled:true}
 const preview=await manager.previewChatSelection('telegram',input)
 await manager.selectChat('telegram',{...input,revision:preview.revision},()=>policy)
 const transport=chatTransport(root,'telegram','token')!;expect(await transport.identify()).toMatchObject({id:'1'})
 policy=mode==='flag'?'facade':'blocked'
 await expect(transport.identify()).rejects.toThrow(/blocked/)
})
it('manager created flag-off accepts installed selection after flag enabled',async()=>{
 const {root,home,data,manager,record}=await setup();await manager.close()
 const reused=new ExtensionManager(data,'project',root,{openChatOwner:chatManagementOwner({root:root,dataDir:data,projectId:'project',mode:'local' as const,runtimeAllowed:true}),home,trustedChatInProcess:true});managers.push(reused)
 // A shipped preview/selection while flag-off constructs the cached manager.
 const shipped={target:{kind:'shipped' as const},enabled:false}
 const first=await reused.previewChatSelection('telegram',shipped)
 await reused.selectChat('telegram',{...shipped,revision:first.revision},()=> 'facade')
 // Same manager is reused after the live flag is turned on.
 const input={target:{kind:'installed' as const,extensionId:record.manifest.id,localProviderId:'telegram',integrity:record.integrity!},enabled:true}
 const next=await reused.previewChatSelection('telegram',input)
 await reused.selectChat('telegram',{...input,revision:next.revision},()=> 'worker')
 expect(await chatTransport(root,'telegram','token')!.identify()).toMatchObject({id:'1'})
})

it('HTTP cached flag-off manager accepts installed selection after re-enable',async()=>{
 const {root,home,data,manager,record}=await setup();await manager.close()
 const {Hono}=await import('hono'),{RunStore}=await import('../runs/store.ts')
 const {extensionRoutes,closeProjectExtensions,localExtensionHost}=await import('../server/extensions.ts')
 vi.stubEnv('CEZ_HOME',home);vi.stubEnv('CEZ_EXTENSIONS','0')
 const store=RunStore.open(data),project={id:'p',root,dataDir:data,store} as ProjectContext
 const app=new Hono().use('*',async(c,next)=>{c.set('project' as never,project);await next()}).route('/api/v1',extensionRoutes(()=>process.env.CEZ_EXTENSIONS==='0'?'disabled':undefined,localExtensionHost))
 const post=(op:string,body:unknown)=>app.request('/api/v1/extensions/chat-selections/telegram/'+op,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
 try{
  const shipped={target:{kind:'shipped'},enabled:false}
  expect((await post('preview',shipped)).status).toBe(200)
  vi.stubEnv('CEZ_EXTENSIONS','1')
  const input={target:{kind:'installed',extensionId:record.manifest.id,localProviderId:'telegram',integrity:record.integrity},enabled:true}
  const preview=extensionChatSelectionPreviewSchema.parse(await (await post('preview',input)).json())
  const result=await post('select',{...input,revision:preview.revision})
  expect(result.status,await result.clone().text()).toBe(200)
  expect(await chatTransport(root,'telegram','token')!.identify()).toMatchObject({id:'1'})
 }finally{await closeProjectExtensions(project);store.flush();vi.unstubAllEnvs()}
})

it.each([false,true])('missing selected bytes=%s do not prevent restoring an unrelated enabled extension',async missing=>{
 const {root,home,data,source,manager,record,create}=await setup()
 await manager.declareDeliveredChat('telegram');await manager.setEnabled(record.manifest.id,true)
 const other=join(root,'other-source');await mkdir(other)
 const manifest=JSON.parse(await readFile(join(source,'cezar-extension.json'),'utf8'))
 manifest.id='fixture.unrelated'
 await writeFile(join(other,'cezar-extension.json'),JSON.stringify(manifest))
 await writeFile(join(other,'index.mjs'),await readFile(join(source,'index.mjs')))
 const independent=await manager.install(other);await manager.setEnabled(independent.manifest.id,true)
 const artifact=await new ChatSelectionStore(data,home).resolve('telegram')
 await manager.close();if(missing)await rm(artifact!.root,{recursive:true})
 const reopened=create();await reopened.restore()
 const rows=await reopened.inventory()
 expect(rows.find(row=>row.record.manifest.id===independent.manifest.id)?.record.status).toBe('running')
 if(missing){expect(rows.find(row=>row.record.manifest.id===record.manifest.id)).toMatchObject({availability:'missing',selectedVersion:record.manifest.version});expect(chatTransport(root,'telegram','token')).toBeUndefined()}
})

it('does not activate a globally approved candidate in place of missing selected bytes',async()=>{
 const {root,home,data,source,manager,record,create}=await setup()
 await manager.declareDeliveredChat('telegram');await manager.setEnabled(record.manifest.id,true)
 const artifact=(await new ChatSelectionStore(data,home).resolve('telegram'))!
 const manifest=JSON.parse(await readFile(join(source,'cezar-extension.json'),'utf8'));manifest.version='0.1.901'
 await writeFile(join(source,'cezar-extension.json'),JSON.stringify(manifest))
 const candidate=await manager.install(source)
 await manager.close();await rm(artifact.root,{recursive:true})
 // A separately approved catalog candidate is not the durable project selection.
 await new ExtensionStore(join(data,'extensions/registry.json')).update(()=>[{...candidate,enabled:true}])
 const reopened=create();await reopened.restore();await reopened.list()
 expect(chatTransport(root,'telegram','token')).toBeUndefined()
 expect(chatTransport(root,'open-mercato.telegram/telegram','token')).toBeUndefined()
 expect((await reopened.list()).find(item=>item.manifest.id===record.manifest.id)).toMatchObject({manifest:{version:record.manifest.version},status:'failed'})
 expect((await reopened.inventory()).find(item=>item.record.manifest.id===record.manifest.id)).toMatchObject({availability:'missing',selectedVersion:record.manifest.version,installedCandidate:{selectedVersion:'0.1.901'}})
})

it('HTTP restore does not stop an already running default sibling when selected Telegram bytes are missing',async()=>{
 const {root,home,data,manager}=await setup();const artifact=await new ChatSelectionStore(data,home).resolve('telegram');await manager.close();await rm(artifact!.root,{recursive:true})
 vi.stubEnv('CEZ_HOME',home);vi.stubEnv('CEZ_WEBHOOKS','1');vi.stubEnv('CEZ_EXTENSIONS','1')
 const {WebhookService}=await import('../webhooks/service.ts'),{WebhookScheduler}=await import('../webhooks/scheduler.ts'),{retainProjectExtensions}=await import('./project-runtime.ts'),{RunStore}=await import('../runs/store.ts'),{restoreProjectExtensions,closeProjectExtensions}=await import('../server/extensions.ts'),{chatTransportAvailable}=await import('../chat/registry.ts')
 const service=await WebhookService.open({root,dataDir:data,projectId:'project',mode:'local',serverPorts:()=>[],scheduler:new WebhookScheduler()}),owner=await retainProjectExtensions({root,dataDir:data,projectId:'project',mode:'local' as const,runtimeAllowed:true})
 const store=RunStore.open(data),project={id:'project',root,dataDir:data,store} as ProjectContext
 try{await owner.manager.startDeliveredChat('slack');expect(chatTransportAvailable(root,'slack')).toBe(true);await restoreProjectExtensions(project);expect(chatTransportAvailable(root,'slack')).toBe(true)}
 finally{await service?.dispose();await closeProjectExtensions(project);await owner.release();store.flush();vi.unstubAllEnvs()}
})
