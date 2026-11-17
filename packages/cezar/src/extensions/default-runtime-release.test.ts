import {execFileSync} from 'node:child_process'
import {mkdtemp,rm,symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {afterEach,expect,it,vi} from 'vitest'
import {ExtensionManager} from './manager.ts'
import {retainProjectExtensions} from './project-runtime.ts'
import {WebhookService} from '../webhooks/service.ts'
import {WebhookScheduler} from '../webhooks/scheduler.ts'
const roots:string[]=[]
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
async function fixture(){const root=await mkdtemp(join(tmpdir(),'review-default-'));roots.push(root);execFileSync('git',['init','-q'],{cwd:root,timeout:5000});vi.stubEnv('CEZ_HOME',join(root,'home'));vi.stubEnv('CEZ_WEBHOOKS','1');vi.stubEnv('CEZ_EXTENSIONS','1');return {root,dataDir:join(root,'.ai/cezar'),projectId:'project',mode:'local' as const,runtimeAllowed:true}}
it.each([false,true])('last webhook owner drains manager after ownership-release retry=%s',async fault=>{
 const project=await fixture(),owner=await retainProjectExtensions(project)
 const service=await WebhookService.open({...project,mode:'local',serverPorts:()=>[],scheduler:new WebhookScheduler()})
 const close=vi.spyOn(owner.manager,'close');await owner.release()
 const ownership=(service as unknown as {ownership:{release():Promise<void>}}).ownership
 try {
  if(fault){vi.spyOn(ownership,'release').mockRejectedValueOnce(Error('EACCES'));await expect(service!.dispose()).rejects.toThrow('EACCES')}
  await service!.dispose()
  expect(close).toHaveBeenCalledTimes(1)
 }finally{await service?.dispose();await owner.manager.close()}
})
it('canonical project aliases with equivalent data-directory aliases share owner',async()=>{
 const project=await fixture(),link=project.root+'-link';await symlink(project.root,link);roots.push(link)
 const first=await retainProjectExtensions(project)
 try {const second=await retainProjectExtensions({...project,root:link,dataDir:join(link,'.ai/cezar')});try{expect(second.manager).toBe(first.manager)}finally{await second.release()}}
 finally {await first.release()}
})
it('HTTP close during pending acquisition releases exactly once and allows a fresh owner',async()=>{
 const project=await fixture();const {RunStore}=await import('../runs/store.ts');const {restoreProjectExtensions,closeProjectExtensions}=await import('../server/extensions.ts')
 const store=RunStore.open(project.dataDir),context={root:project.root,dataDir:project.dataDir,id:project.projectId,store} as unknown as import('../server/project-context.ts').ProjectContext
 const close=vi.spyOn(ExtensionManager.prototype,'close')
 try{const opening=restoreProjectExtensions(context);await closeProjectExtensions(context);await opening;expect(close).toHaveBeenCalledTimes(1);await restoreProjectExtensions(context);await closeProjectExtensions(context);expect(close).toHaveBeenCalledTimes(2)}finally{await closeProjectExtensions(context);store.flush()}
})
it('concurrent shutdown callers await the same final runtime release',async()=>{
 const project=await fixture(),owner=await retainProjectExtensions(project)
 const service=await WebhookService.open({...project,mode:'local',serverPorts:()=>[],scheduler:new WebhookScheduler()})
 await owner.release()
 const original=owner.manager.close.bind(owner.manager)
 let finish!:()=>void
 const gate=new Promise<void>(resolve=>{finish=resolve})
 const close=vi.spyOn(owner.manager,'close').mockImplementation(async()=>{await gate;await original()})
 try {
  const first=service!.dispose();let settled=false
  const second=service!.dispose().then(()=>{settled=true})
  await vi.waitFor(()=>expect(close).toHaveBeenCalledOnce())
  expect(settled).toBe(false)
  finish();await Promise.all([first,second]);await service!.dispose()
  expect(close).toHaveBeenCalledOnce()
 }finally{finish();await service?.dispose()}
})
