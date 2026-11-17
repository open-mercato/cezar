import {realpath} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {mkdtemp,rm,symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {afterEach,expect,it,vi} from 'vitest'
import {ExtensionManager} from './manager.ts'
import {retainProjectExtensions} from './project-runtime.ts'
const roots:string[]=[],releases:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const release of releases.splice(0))await release();vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
async function fixture(){const root=await mkdtemp(join(tmpdir(),'shared-extensions-'));roots.push(root);execFileSync('git',['init','-q'],{cwd:root,timeout:5000});return{root,dataDir:join(root,'.ai/cezar'),projectId:'project'}}
it('shares one manager across boot service and HTTP owners, including a symlink root',async()=>{
 const project=await fixture(),link=project.root+'-link';await symlink(project.root,link);roots.push(link)
 const service=await retainProjectExtensions(project);releases.push(service.release)
 const api=await retainProjectExtensions({...project,root:link});releases.push(api.release)
 expect(api.manager).toBe(service.manager)
 const close=vi.spyOn(service.manager,'close')
 await service.release();expect(close).not.toHaveBeenCalled()
 await api.release();expect(close).toHaveBeenCalledTimes(1)
 await api.release();expect(close).toHaveBeenCalledTimes(1)
})
it('waits for retiring ownership before constructing a replacement',async()=>{
 const project=await fixture(),first=await retainProjectExtensions(project);releases.push(first.release)
 let finish!:()=>void;const barrier=new Promise<void>(resolve=>{finish=resolve})
 const close=first.manager.close.bind(first.manager)
 vi.spyOn(first.manager,'close').mockImplementation(async()=>{await barrier;await close()})
 const retiring=first.release();let acquired=false
 const next=retainProjectExtensions(project).then(value=>{acquired=true;releases.push(value.release);return value})
 await realpath(project.root);await new Promise(setImmediate);expect(acquired).toBe(false)
 finish();await retiring;expect((await next).manager).not.toBe(first.manager)
})
it('rejects a second data directory for an already owned project root',async()=>{
 const project=await fixture(),owner=await retainProjectExtensions(project);releases.push(owner.release)
 await expect(retainProjectExtensions({...project,dataDir:join(project.root,'other')})).rejects.toThrow('data directory')
})
it('declares all default canonical artifacts before webhook storage and shares the retained manager',async()=>{
 const project=await fixture();vi.stubEnv('CEZ_HOME',join(project.root,'home'));vi.stubEnv('CEZ_WEBHOOKS','1');vi.stubEnv('CEZ_EXTENSIONS','0')
 const {WebhookService}=await import('../webhooks/service.ts'),{WebhookScheduler}=await import('../webhooks/scheduler.ts')
 const {projectChatExtensions}=await import('../chat/registry.ts'),{existsSync}=await import('node:fs')
 const owner=await retainProjectExtensions(project);releases.push(owner.release)
 const declare=owner.manager.declareDeliveredChat.bind(owner.manager),observed:string[]=[]
 vi.spyOn(owner.manager,'declareDeliveredChat').mockImplementation(async provider=>{expect(existsSync(join(project.dataDir,'webhooks'))).toBe(false);observed.push(provider);await declare(provider)})
 let service:Awaited<ReturnType<typeof WebhookService.open>>
 try{
  service=await WebhookService.open({...project,mode:'local',serverPorts:()=>[],scheduler:new WebhookScheduler()})
  expect(observed).toEqual(['telegram'])
  expect(projectChatExtensions(project.root).map(provider=>provider.id).sort()).toEqual(['telegram'])
  expect((await owner.manager.list()).every(record=>record.status!=='running')).toBe(true)
 }finally{await service?.dispose();vi.unstubAllEnvs()}
})

it('hosted chat neither declares artifacts nor starts a worker',async()=>{
 const project=await fixture();vi.stubEnv('CEZ_HOME',join(project.root,'home'));vi.stubEnv('CEZ_WEBHOOKS','1')
 const {WebhookService}=await import('../webhooks/service.ts'),{WebhookScheduler}=await import('../webhooks/scheduler.ts')
 const {projectChatExtensions}=await import('../chat/registry.ts'),{ExtensionHost}=await import('./host.ts')
 const activate=vi.spyOn(ExtensionHost.prototype,'activate')
 let service:Awaited<ReturnType<typeof WebhookService.open>>
 try{service=await WebhookService.open({...project,mode:'hosted',serverPorts:()=>[],scheduler:new WebhookScheduler()});await service!.startChat();expect(projectChatExtensions(project.root)).toEqual([]);expect(activate).not.toHaveBeenCalled()}
 finally{await service?.dispose();vi.unstubAllEnvs()}
})
it('does not admit a replacement after ownership drain fails',async()=>{
 const project=await fixture(),owner=await retainProjectExtensions(project)
 const original=owner.manager.close.bind(owner.manager)
 vi.spyOn(owner.manager,'close').mockRejectedValue(Error('drain failed'))
 await expect(owner.release()).rejects.toThrow('drain failed')
 await expect(retainProjectExtensions(project)).rejects.toThrow('drain failed')
 await original()
})

it('HTTP restoration keeps unconfigured default chat artifacts lazy',async()=>{
 const project=await fixture();vi.stubEnv('CEZ_HOME',join(project.root,'home'));vi.stubEnv('CEZ_WEBHOOKS','1');vi.stubEnv('CEZ_EXTENSIONS','1')
 const {WebhookService}=await import('../webhooks/service.ts'),{WebhookScheduler}=await import('../webhooks/scheduler.ts')
 const {ExtensionHost}=await import('./host.ts'),{RunStore}=await import('../runs/store.ts')
 const {restoreProjectExtensions,closeProjectExtensions}=await import('../server/extensions.ts')
 const store=RunStore.open(project.dataDir),context={id:project.projectId,root:project.root,dataDir:project.dataDir,store} as import('../server/project-context.ts').ProjectContext
 const activate=vi.spyOn(ExtensionHost.prototype,'activate').mockRejectedValue(Error('unconfigured artifact must not start'))
 let service:Awaited<ReturnType<typeof WebhookService.open>>
 try{
  service=await WebhookService.open({...project,mode:'local',serverPorts:()=>[],scheduler:new WebhookScheduler()})
  const {ExtensionStore}=await import('./store.ts'),{readFile}=await import('node:fs/promises')
  const manifest=JSON.parse(await readFile(new URL('../../../chat-plugins/telegram/cezar-extension.json',import.meta.url),'utf8'))
  manifest.id='example.helper'
  await new ExtensionStore(join(project.root,'home/extensions/registry.json')).update(()=>[{manifest,source:'fixture',installedAt:new Date().toISOString(),enabled:false}])
  await restoreProjectExtensions(context)
  // A list reconciles exactly as the catalog watcher would, without waiting for its tick.
  const owner=await retainProjectExtensions(project)
  try{await owner.manager.list()}finally{await owner.release()}
  expect(activate).not.toHaveBeenCalled()
 }
 finally{await service?.dispose();await closeProjectExtensions(context);store.flush();vi.unstubAllEnvs()}
})
