import {extensionChatSelectionPreviewSchema} from '@open-mercato/cezar-contract'
import {mkdtemp,mkdir,writeFile,rm,chmod,readFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {afterEach,expect,it,vi} from 'vitest'
import {ExtensionHost} from './host.ts'
import type {ProjectContext} from '../server/project-context.ts'
import {ExtensionManager} from './manager.ts'
import {ExtensionStore} from './store.ts'
import {ChatSelectionStore} from './chat-selection-store.ts'
import {projectChatExtensions,chatTransport} from '../chat/registry.ts'
const roots:string[]=[],managers:ExtensionManager[]=[]
afterEach(async()=>{for(const m of managers.splice(0))await m.close();for(const r of roots.splice(0))await rm(r,{recursive:true,force:true})})
async function setup(){
 const root=await mkdtemp(join(tmpdir(),'review-selected-'));roots.push(root);execFileSync('git',['init','-q'],{cwd:root,timeout:5000})
 const home=join(root,'home'),data=join(root,'.ai','cezar'),source=join(root,'source');await mkdir(source)
 const manifest=JSON.parse(await readFile(new URL('../../../chat-plugins/telegram/cezar-extension.json',import.meta.url),'utf8'))
 manifest.entry='index.mjs';manifest.contributes.chatProviders.push({...manifest.contributes.chatProviders[0],id:'other'})
 await writeFile(join(source,'cezar-extension.json'),JSON.stringify(manifest))
 await writeFile(join(source,'index.mjs'),`export function activate(c){c.chat.register('telegram',()=>({identify:async()=>({id:'1',username:'fixture'})}));c.chat.register('other',()=>({identify:async()=>({id:'2',username:'other'})}));}`)
 const create=(d=data,p=root)=>{const m=new ExtensionManager(d,'project',p,{home,deliveryPackageRoot:join(root,'absent')});managers.push(m);return m}
 const manager=create(),record=await manager.install(source)
 await new ChatSelectionStore(data,home).replace('telegram',null,{kind:'installed',record,localProviderId:'telegram'})
 return {root,home,data,source,create,manager,record}
}
it.each(['flag','hosted'] as const)('selection policy is rechecked after drain: %s',async mode=>{
 const {root,home,data,manager,record}=await setup();await manager.close()
 const {vi}=await import('vitest'),{Hono}=await import('hono'),{RunStore}=await import('../runs/store.ts')
 const {extensionRoutes,closeProjectExtensions}=await import('../server/extensions.ts')
 const {watchChatAdapterSelection,watchChatExtensions}=await import('../chat/registry.ts')
 vi.stubEnv('CEZ_HOME',home);vi.stubEnv('CEZ_EXTENSIONS','1')
 let local=true;const store=RunStore.open(data),project={id:'p',root,dataDir:data,store} as ProjectContext
 const app=new Hono().use('*',async(c,next)=>{c.set('project' as never,project);await next()}).route('/api/v1',extensionRoutes(()=> !local?'hosted':process.env.CEZ_EXTENSIONS==='0'?'disabled':undefined,()=>local))
 const post=(op:string,body:unknown)=>app.request('/api/v1/extensions/chat-selections/telegram/'+op,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
 const unwatch=watchChatAdapterSelection(root,async(_id,enabled)=>{if(!enabled){if(mode==='flag')vi.stubEnv('CEZ_EXTENSIONS','0');else local=false}})
 try{
  const input={target:{kind:'installed',extensionId:record.manifest.id,localProviderId:'telegram',integrity:record.integrity},enabled:true}
  const p=await post('preview',input);expect(p.status,await p.clone().text()).toBe(200);const preview=extensionChatSelectionPreviewSchema.parse(await p.json())
  const response=await post('select',{...input,revision:preview.revision})
  const approvals=await new ExtensionStore(join(data,'extensions/registry.json')).list()
  expect(approvals.find(r=>r.manifest.id===record.manifest.id)?.enabled).not.toBe(true)
  expect(chatTransport(root,'telegram','token')).toBeUndefined()
  expect(response.status).toBe(409)
 }finally{await closeProjectExtensions(project);store.flush();unwatch();vi.unstubAllEnvs()}
})

it.each(['flag','hosted'].flatMap(mode=>['drain','consent','activation','publication'].map(stage=>({mode,stage}))))('revoked $mode policy prevents rollback restart after $stage',async({mode,stage})=>{
 const {root,home,data,manager,record}=await setup();await manager.close()
 const {vi}=await import('vitest'),{Hono}=await import('hono'),{RunStore}=await import('../runs/store.ts')
 const {extensionRoutes,closeProjectExtensions}=await import('../server/extensions.ts')
 const {watchChatAdapterSelection,watchChatExtensions}=await import('../chat/registry.ts')
 vi.stubEnv('CEZ_HOME',home);vi.stubEnv('CEZ_EXTENSIONS','1')
 let local=true,armed=false;const revoke=()=>{if(mode==='flag')vi.stubEnv('CEZ_EXTENSIONS','0');else local=false};const store=RunStore.open(data),project={id:'p',root,dataDir:data,store} as ProjectContext
 const app=new Hono().use('*',async(c,next)=>{c.set('project' as never,project);await next()}).route('/api/v1',extensionRoutes(()=> !local?'hosted':process.env.CEZ_EXTENSIONS==='0'?'disabled':undefined,()=>local))
 const post=(op:string,body:unknown)=>app.request('/api/v1/extensions/chat-selections/telegram/'+op,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
 const unwatch=watchChatAdapterSelection(root,async(_id,enabled)=>{if(armed&&((stage==='drain'&&!enabled)||(stage==='consent'&&enabled)))revoke()})
 const unpublish=watchChatExtensions(root,async()=>{if(armed&&stage==='publication'&&chatTransport(root,'telegram','token'))revoke()})
 const activate=ExtensionHost.prototype.activate,spy=vi.spyOn(ExtensionHost.prototype,'activate').mockImplementation(async function(this:ExtensionHost,...args){await activate.apply(this,args);if(armed&&stage==='activation')revoke()})
 try{
  const input={target:{kind:'installed',extensionId:record.manifest.id,localProviderId:'telegram',integrity:record.integrity},enabled:true}
  const p=await post('preview',input);expect(p.status,await p.clone().text()).toBe(200);const preview=extensionChatSelectionPreviewSchema.parse(await p.json())
  expect((await post('select',{...input,revision:preview.revision})).status).toBe(200)
  expect(await chatTransport(root,'telegram','token')!.identify()).toMatchObject({id:'1'})
  const next=extensionChatSelectionPreviewSchema.parse(await (await post('preview',input)).json());armed=true
  const response=await post('select',{...input,revision:next.revision})
  const approvals=await new ExtensionStore(join(data,'extensions/registry.json')).list()
  expect(approvals.find(r=>r.manifest.id===record.manifest.id)?.enabled).toBe(true)
  expect(chatTransport(root,'telegram','token')).toBeUndefined()
  expect(response.status).toBe(409)
 }finally{unpublish();spy.mockRestore();await closeProjectExtensions(project);store.flush();unwatch();vi.unstubAllEnvs()}
})

it('switches an explicitly selected shipped artifact to the facade when the flag changes during drain',async()=>{
 const mode='flag'
 const {root,home,data,manager,record}=await setup();await manager.close()
 const {vi}=await import('vitest'),{Hono}=await import('hono'),{RunStore}=await import('../runs/store.ts')
 const {extensionRoutes,closeProjectExtensions}=await import('../server/extensions.ts')
 const {watchChatAdapterSelection,watchChatExtensions}=await import('../chat/registry.ts')
 vi.stubEnv('CEZ_HOME',home);vi.stubEnv('CEZ_EXTENSIONS','1')
 let local=true;const store=RunStore.open(data),project={id:'p',root,dataDir:data,store} as ProjectContext
 const app=new Hono().use('*',async(c,next)=>{c.set('project' as never,project);await next()}).route('/api/v1',extensionRoutes(()=> !local?'hosted':process.env.CEZ_EXTENSIONS==='0'?'disabled':undefined,()=>local))
 const post=(op:string,body:unknown)=>app.request('/api/v1/extensions/chat-selections/telegram/'+op,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
 const activate=vi.spyOn(ExtensionHost.prototype,'activate')
 const unwatch=watchChatAdapterSelection(root,async(_id,enabled)=>{if(!enabled){if(mode==='flag')vi.stubEnv('CEZ_EXTENSIONS','0');else local=false}})
 try{
  const input={target:{kind:'shipped'},enabled:true}
  const p=await post('preview',input);expect(p.status,await p.clone().text()).toBe(200);const preview=extensionChatSelectionPreviewSchema.parse(await p.json())
  const response=await post('select',{...input,revision:preview.revision})
  const approvals=await new ExtensionStore(join(data,'extensions/registry.json')).list()
  expect(approvals.find(r=>r.manifest.id===record.manifest.id)?.enabled).toBe(true)
  expect(chatTransport(root,'telegram','token')).toBeDefined()
  expect(activate.mock.calls.at(-1)?.[0].trustedInProcess).toBeDefined()
  expect(response.status,await response.clone().text()).toBe(200)
 }finally{activate.mockRestore();await closeProjectExtensions(project);store.flush();unwatch();vi.unstubAllEnvs()}
})
