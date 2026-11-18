import {extensionChatSelectionPreviewSchema} from '@open-mercato/cezar-contract'
import {mkdtemp,rm} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Hono} from 'hono'
import {expect,it,vi} from 'vitest'
import {extensionRoutes,closeProjectExtensions} from './extensions.ts'
import type {ProjectContext} from './project-context.ts'
import {RunStore} from '../runs/store.ts'
import {ExtensionHost} from '../extensions/host.ts'
import {watchChatAdapterSelection,projectChatExtensions} from '../chat/registry.ts'

it('validates project selection previews and commits the reviewed paused source without starting code',async()=>{
 const root=await mkdtemp(join(tmpdir(),'selection-http-')),dataDir=join(root,'data')
 vi.stubEnv('CEZ_HOME',join(root,'home'));vi.stubEnv('CEZ_EXTENSIONS','1')
 const store=RunStore.open(dataDir),project={id:'project',root,dataDir,store} as ProjectContext
 const spawned=vi.spyOn(ExtensionHost.prototype,'activate').mockRejectedValue(Error('must not execute'))
 const changes:boolean[]=[],unwatch=watchChatAdapterSelection(root,async(_id,enabled)=>{changes.push(enabled)})
 const app=new Hono<{Variables:{project:ProjectContext}}>().use('*',async(c,next)=>{c.set('project',project);await next()}).route('/api/v1/p/:projectId',extensionRoutes())
 const post=(suffix:string,body:unknown)=>app.request('/api/v1/p/project/extensions/chat-selections/'+suffix,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
 try {
  const input={target:{kind:'shipped'},enabled:false}
  const response=await post('telegram/preview',input);expect(response.status,await response.clone().text()).toBe(200)
  const preview=extensionChatSelectionPreviewSchema.parse(await response.json())
  expect(preview.provider).toBe('telegram');expect(preview.candidate.source).toBe('bundled')
  expect(existsSync(join(dataDir,'extensions'))).toBe(false);expect(existsSync(join(root,'home'))).toBe(false)
  expect(projectChatExtensions(root)).toEqual([])
  expect((await post('telegram/preview',{...input,unexpected:true})).status).toBe(400)
  expect((await post('invalid/preview',input)).status).toBe(400)
  expect((await post('telegram/select',{...input,revision:preview.revision})).status).toBe(200)
  expect((await post('telegram/select',{...input,revision:preview.revision})).status).toBe(400)
  expect(projectChatExtensions(root).map(item=>item.id)).toEqual(['telegram'])
  expect(changes).toEqual([false,false]);expect(spawned).not.toHaveBeenCalled()
  expect(existsSync(join(root,'home'))).toBe(false)
 }finally{await closeProjectExtensions(project);store.flush();unwatch();spawned.mockRestore();vi.unstubAllEnvs();await rm(root,{recursive:true,force:true})}
})
it('hosted selection requests are refused before reading project metadata',async()=>{
 const app=new Hono().route('/api/v1',extensionRoutes(()=> 'hosted',()=>false))
 for(const suffix of ['preview','select']){
  const response=await app.request('/api/v1/extensions/chat-selections/telegram/'+suffix,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({target:{kind:'shipped'},enabled:false,...(suffix==='select'?{revision:'a'.repeat(64)}:{})})})
  expect(response.status).toBe(409)
 }
})
