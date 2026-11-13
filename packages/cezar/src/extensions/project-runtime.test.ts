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
it('does not admit a replacement after ownership drain fails',async()=>{
 const project=await fixture(),owner=await retainProjectExtensions(project)
 const original=owner.manager.close.bind(owner.manager)
 vi.spyOn(owner.manager,'close').mockRejectedValue(Error('drain failed'))
 await expect(owner.release()).rejects.toThrow('drain failed')
 await expect(retainProjectExtensions(project)).rejects.toThrow('drain failed')
 await original()
})

