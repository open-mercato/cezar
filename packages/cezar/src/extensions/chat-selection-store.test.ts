import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,chmod,symlink} from 'node:fs/promises'
import {join,relative,basename,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {afterEach,expect,it,vi} from 'vitest'
import {ExtensionInstaller} from './installer.ts'
import {ChatSelectionStore} from './chat-selection-store.ts'
import {isVouchedChatArtifact,registerSelectedChatSlot,projectChatExtensions} from '../chat/registry.ts'
const roots:string[]=[]
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'chat-selection-'));roots.push(root)
 const home=join(root,'home'),data=join(root,'project','.ai','cezar'),source=join(root,'source');await mkdir(source)
 const manifest=JSON.parse(await readFile(new URL('../../../chat-plugins/telegram/cezar-extension.json',import.meta.url),'utf8'))
 await mkdir(join(source,'dist'));await writeFile(join(source,'cezar-extension.json'),JSON.stringify(manifest));await writeFile(join(source,'package.json'),JSON.stringify({version:manifest.version}));await writeFile(join(source,'dist/index.js'),'throw Error("reads must not execute")')
 const installer=new ExtensionInstaller(home),prepared=await installer.prepareInstall(source),installed=await installer.commitInstall(prepared)
 const record={manifest:installed.manifest,source,installedAt:new Date().toISOString(),integrity:installed.integrity,enabled:true}
 return {root,home,data,installer,installed,record,store:new ChatSelectionStore(data,home)}
}
it('metadata reads are passive and absent selection means shipped default',async()=>{
 const {store,data}=await fixture();expect(await store.read('telegram')).toBeUndefined();await expect(readdir(data)).rejects.toMatchObject({code:'ENOENT'})
})
it('pins an exact installed artifact across a closed project and installer pruning',async()=>{
 const {store,home,data,installer,installed,record}=await fixture()
 const selected=await store.replace('telegram',null,{kind:'installed',record,localProviderId:'telegram'})
 expect(selected.target.kind).toBe('installed')
 await installer.pruneArtifacts(record.manifest.id)
 expect(await readFile(join(installed.path,'dist/index.js'),'utf8')).toContain('must not execute')
 expect(await new ChatSelectionStore(data,home).read('telegram')).toEqual(selected)
 const resolved=await store.resolve('telegram');expect(resolved?.root).toBe(installed.path)
})
it('compare-and-swap rejects stale decisions without rewinding selection',async()=>{
 const {store,record}=await fixture()
 const first=await store.replace('telegram',null,{kind:'installed',record,localProviderId:'telegram'})
 await expect(store.replace('telegram',null,{kind:'shipped'})).rejects.toThrow('changed')
 expect(await store.read('telegram')).toEqual(first)
 const next=await store.replace('telegram',first.revision,{kind:'shipped'});expect(next.revision).not.toBe(first.revision)
})
it('retains missing and modified selection metadata but refuses executable resolution',async()=>{
 const {store,installed,record}=await fixture()
 const selected=await store.replace('telegram',null,{kind:'installed',record,localProviderId:'telegram'})
 await writeFile(join(installed.path,'dist/index.js'),'tampered')
 await expect(store.resolve('telegram')).rejects.toThrow('integrity')
 expect(await store.read('telegram')).toEqual(selected)
 await rm(installed.path,{recursive:true});await expect(store.resolve('telegram')).rejects.toThrow();expect(await store.read('telegram')).toEqual(selected)
})
it('invalid local provider and modified candidate cannot earn a durable alias selection',async()=>{
 const {store,record,installed}=await fixture()
 await expect(store.replace('telegram',null,{kind:'installed',record,localProviderId:'missing'})).rejects.toThrow('provider')
 await writeFile(join(installed.path,'dist/index.js'),'tampered')
 await expect(store.replace('telegram',null,{kind:'installed',record,localProviderId:'telegram'})).rejects.toThrow('integrity')
 expect(await store.read('telegram')).toBeUndefined()
})
it('corrupt durable selection fails closed rather than becoming shipped default',async()=>{
 const {store,data}=await fixture();await mkdir(join(data,'extensions','chat-selections'),{recursive:true});await writeFile(join(data,'extensions','chat-selections','telegram.json'),'{')
 await expect(store.read('telegram')).rejects.toThrow();await expect(store.replace('telegram',null,{kind:'shipped'})).rejects.toThrow()
})
it('explicit return to shipped releases only this project durable artifact pin',async()=>{
 const {store,data,home,record,installer,installed}=await fixture()
 const other=new ChatSelectionStore(join(data,'other'),home)
 const first=await store.replace('telegram',null,{kind:'installed',record,localProviderId:'telegram'})
 const second=await other.replace('telegram',null,{kind:'installed',record,localProviderId:'telegram'})
 await store.replace('telegram',first.revision,{kind:'shipped'});await installer.pruneArtifacts(record.manifest.id)
 expect(await readFile(join(installed.path,'dist/index.js'),'utf8')).toContain('must not execute')
 await other.replace('telegram',second.revision,{kind:'shipped'});await installer.pruneArtifacts(record.manifest.id)
 await expect(readFile(join(installed.path,'dist/index.js'))).rejects.toMatchObject({code:'ENOENT'})
})
it('a claimed manifest cannot change the permissions of an integrity-pinned artifact',async()=>{
 const {store,record}=await fixture()
 await expect(store.replace('telegram',null,{kind:'installed',record:{...record,manifest:{...record.manifest,permissions:['project.read']}},localProviderId:'telegram'})).rejects.toThrow('manifest mismatch')
 expect(await store.read('telegram')).toBeUndefined()
})

it('only a frozen verified durable selection can declare a canonical slot',async()=>{
 const {store,root,record}=await fixture()
 await store.replace('telegram',null,{kind:'installed',record,localProviderId:'telegram'})
 const artifact=(await store.resolve('telegram'))!;expect(isVouchedChatArtifact('selection',artifact)).toBe(true)
 await expect(registerSelectedChatSlot(root,{...artifact})).rejects.toThrow('Unverified')
 expect(projectChatExtensions(root)).toEqual([])
 expect(()=>{artifact.manifest.permissions.push('project.read')}).toThrow()
 const slot=await registerSelectedChatSlot(root,artifact)
 try{expect(projectChatExtensions(root).map(provider=>provider.id)).toEqual(['telegram'])}finally{await slot.dispose()}
})

const faults=vi.hoisted(()=>({failSelection:false,failRelease:false}))
vi.mock('node:fs/promises',async(importOriginal)=>{
 const original=await importOriginal<typeof import('node:fs/promises')>()
 return {...original,rm:async(path:Parameters<typeof original.rm>[0],options:Parameters<typeof original.rm>[1])=>{
  if(faults.failRelease&&/^selection-[a-f0-9]{64}$/.test(basename(String(path)))&&basename(dirname(dirname(dirname(String(path)))))==='leases'){faults.failRelease=false;throw Error('injected release failure')}
  return original.rm(path,options)
 }}
})
vi.mock('../worktree-lifecycle/store.ts',async(importOriginal)=>{
 const original=await importOriginal<typeof import('../worktree-lifecycle/store.ts')>()
 return {...original,atomicLifecycleWrite:async(path:string,value:unknown)=>{
  if(faults.failSelection&&path.endsWith('/chat-selections/telegram.json')){
   faults.failSelection=false;throw Error('injected selection commit failure')
  }
  return original.atomicLifecycleWrite(path,value)
 }}
})
it('review: shipped selection works with read-only global home',async()=>{
 const root=await mkdtemp(join(tmpdir(),'readonly-selection-'));roots.push(root)
 const home=join(root,'home'),data=join(root,'project');await mkdir(home);await chmod(home,0o500)
 try {
  const store=new ChatSelectionStore(data,home)
  expect(await store.read('telegram')).toBeUndefined()
  await expect(store.replace('telegram',null,{kind:'shipped'})).resolves.toMatchObject({target:{kind:'shipped'}})
 } finally {await chmod(home,0o700)}
})
it('review: failed first selection then explicit shipped does not retain an abandoned pin',async()=>{
 const {store,record,installed,installer}=await fixture()
 faults.failSelection=true
 await expect(store.replace('telegram',null,{kind:'installed',record,localProviderId:'telegram'})).rejects.toThrow('injected')
 expect(await store.read('telegram')).toBeUndefined()
 await store.replace('telegram',null,{kind:'shipped'})
 await installer.pruneArtifacts(record.manifest.id)
 await expect(readFile(join(installed.path,'dist/index.js'))).rejects.toMatchObject({code:'ENOENT'})
})
it('review: equivalent project paths release the same owner pin',async()=>{
 const {store,record,data,home,installed,installer}=await fixture()
 const selected=await store.replace('telegram',null,{kind:'installed',record,localProviderId:'telegram'})
 const reopened=new ChatSelectionStore(data+'/',home)
 await reopened.replace('telegram',selected.revision,{kind:'shipped'})
 await installer.pruneArtifacts(record.manifest.id)
 await expect(readFile(join(installed.path,'dist/index.js'))).rejects.toMatchObject({code:'ENOENT'})
})

it('shipped-only changes never create an absent global home',async()=>{
 const {root,data}=await fixture(),home=join(root,'absent-home'),store=new ChatSelectionStore(data,home)
 const first=await store.replace('telegram',null,{kind:'shipped'})
 await store.replace('telegram',first.revision,{kind:'shipped'})
 await expect(readdir(home)).rejects.toMatchObject({code:'ENOENT'})
})
it('reconciles interrupted pin creation without touching another project selection',async()=>{
 const {store,data,home,record,installer,installed}=await fixture()
 const target={kind:'installed' as const,record,localProviderId:'telegram'}
 const selected=await store.replace('telegram',null,target)
 const other=new ChatSelectionStore(join(data,'other'),home)
 const otherSelection=await other.replace('telegram',null,target)
 // Crash after pin creation but before the first selection commit.
 await writeFile(join(data,'extensions/chat-selections/telegram.json.pending'),JSON.stringify([target]))
 await rm(join(data,'extensions/chat-selections/telegram.json'))
 await new ChatSelectionStore(data,home).reconcile('telegram')
 await installer.pruneArtifacts(record.manifest.id)
 expect(await readFile(join(installed.path,'dist/index.js'),'utf8')).toContain('must not execute')
 await other.replace('telegram',otherSelection.revision,{kind:'shipped'})
 await installer.pruneArtifacts(record.manifest.id)
 await expect(readFile(join(installed.path,'dist/index.js'))).rejects.toMatchObject({code:'ENOENT'})
 expect(selected.target.kind).toBe('installed')
})
it('reconciles crash after selection commit and preserves a same-artifact replacement',async()=>{
 const {store,data,home,record,installer,installed}=await fixture(),target={kind:'installed' as const,record,localProviderId:'telegram'}
 const first=await store.replace('telegram',null,target)
 const next=await store.replace('telegram',first.revision,target)
 const journal=join(data,'extensions/chat-selections/telegram.json.pending')
 await writeFile(journal,JSON.stringify([target,target]))
 await new ChatSelectionStore(data,home).reconcile('telegram')
 await installer.pruneArtifacts(record.manifest.id)
 expect(await readFile(join(installed.path,'dist/index.js'),'utf8')).toContain('must not execute')
 // The durable selection has advanced, but its old pin release was interrupted.
 await writeFile(journal,JSON.stringify([target]))
 await writeFile(join(data,'extensions/chat-selections/telegram.json'),JSON.stringify({...next,target:{kind:'shipped'}}))
 await new ChatSelectionStore(data,home).reconcile('telegram')
 await installer.pruneArtifacts(record.manifest.id)
 await expect(readFile(join(installed.path,'dist/index.js'))).rejects.toMatchObject({code:'ENOENT'})
})
it('canonical project ownership survives a symlink alias without releasing another owner',async()=>{
 const {store,data,home,root,record,installer,installed}=await fixture(),target={kind:'installed' as const,record,localProviderId:'telegram'}
 const first=await store.replace('telegram',null,target)
 const other=new ChatSelectionStore(join(root,'other'),home),second=await other.replace('telegram',null,target)
 const alias=join(root,'project-alias');await symlink(data,alias)
 await new ChatSelectionStore(alias,home).replace('telegram',first.revision,{kind:'shipped'})
 await installer.pruneArtifacts(record.manifest.id)
 expect(await readFile(join(installed.path,'dist/index.js'),'utf8')).toContain('must not execute')
 await other.replace('telegram',second.revision,{kind:'shipped'})
 await installer.pruneArtifacts(record.manifest.id)
 await expect(readFile(join(installed.path,'dist/index.js'))).rejects.toMatchObject({code:'ENOENT'})
})

it('retries a failed old-pin release from the durable journal on reopen',async()=>{
 const {store,data,home,record,installer,installed}=await fixture()
 const first=await store.replace('telegram',null,{kind:'installed',record,localProviderId:'telegram'})
 faults.failRelease=true
 const next=await store.replace('telegram',first.revision,{kind:'shipped'})
 expect(await store.read('telegram')).toEqual(next)
 await expect(readFile(join(data,'extensions/chat-selections/telegram.json.pending'))).resolves.toBeDefined()
 await new ChatSelectionStore(relative(process.cwd(),data),home).reconcile('telegram')
 await installer.pruneArtifacts(record.manifest.id)
 await expect(readFile(join(installed.path,'dist/index.js'))).rejects.toMatchObject({code:'ENOENT'})
 await expect(readFile(join(data,'extensions/chat-selections/telegram.json.pending'))).rejects.toMatchObject({code:'ENOENT'})
})

it('manager declares the pinned canonical provider without loading the distribution or starting code',async()=>{
 const {store,data,home,record,root}=await fixture()
 await store.replace('telegram',null,{kind:'installed',record,localProviderId:'telegram'})
 const {ExtensionManager}=await import('./manager.ts')
 const manager=new ExtensionManager(data,'project',root,{home,deliveryPackageRoot:join(root,'missing-distribution')})
 try {
  await manager.declareDeliveredChat('telegram')
  expect(projectChatExtensions(root).map(item=>item.id)).toEqual(['telegram'])
  expect((await manager.list()).find(item=>item.manifest.id===record.manifest.id)).toMatchObject({integrity:record.integrity,enabled:false})
 } finally {await manager.close()}
})

it('manager keeps a canonical installed selection pinned across catalog changes and uninstall',async()=>{
 const {store,data,home,record,root}=await fixture()
 await store.replace('telegram',null,{kind:'installed',record,localProviderId:'telegram'})
 const {ExtensionManager}=await import('./manager.ts'),{ExtensionStore}=await import('./store.ts')
 const catalog=new ExtensionStore(join(home,'extensions/registry.json'))
 await catalog.update(()=>[{...record,manifest:{...record.manifest,version:'9.0.0'},integrity:'sha512-new'}])
 const manager=new ExtensionManager(data,'project',root,{home,deliveryPackageRoot:join(root,'absent')})
 try {
  await manager.declareDeliveredChat('telegram')
  expect((await manager.list()).find(item=>item.manifest.id===record.manifest.id)?.integrity).toBe(record.integrity)
  await manager.uninstall(record.manifest.id)
  expect((await store.read('telegram'))?.target.kind).toBe('installed')
  expect((await manager.list()).find(item=>item.manifest.id===record.manifest.id)).toMatchObject({integrity:record.integrity,enabled:false})
  expect(projectChatExtensions(root).map(item=>item.id)).toEqual(['telegram'])
 } finally {await manager.close()}
})
it('flag-off facade refuses an approved installed canonical selection without substituting shipped code',async()=>{
 const {store,data,home,record,root}=await fixture()
 await store.replace('telegram',null,{kind:'installed',record,localProviderId:'telegram'})
 const {ExtensionManager}=await import('./manager.ts'),{ExtensionStore}=await import('./store.ts')
 await new ExtensionStore(join(data,'extensions/registry.json')).update(()=>[record])
 const manager=new ExtensionManager(data,'project',root,{home,trustedChatInProcess:true,deliveryPackageRoot:join(root,'absent')})
 try {
  await expect(manager.startDeliveredChat('telegram')).rejects.toThrow('extensions are disabled')
  expect((await store.read('telegram'))?.target.kind).toBe('installed')
  expect(projectChatExtensions(root).map(item=>item.id)).toEqual(['telegram'])
 } finally {await manager.close()}
})
it('manager refuses missing pinned bytes rather than declaring another canonical source',async()=>{
 const {store,data,home,record,root,installed}=await fixture()
 await store.replace('telegram',null,{kind:'installed',record,localProviderId:'telegram'})
 await rm(installed.path,{recursive:true})
 const {ExtensionManager}=await import('./manager.ts')
 const manager=new ExtensionManager(data,'project',root,{home})
 try {
  await expect(manager.declareDeliveredChat('telegram')).rejects.toThrow()
  expect(projectChatExtensions(root)).toEqual([])
  expect((await store.read('telegram'))?.target.kind).toBe('installed')
 } finally {await manager.close()}
})

it('candidate updates preserve pinned approval even before the project declares its runtime',async()=>{
 const {store,data,home,record,root}=await fixture()
 await store.replace('telegram',null,{kind:'installed',record,localProviderId:'telegram'})
 const {ExtensionManager}=await import('./manager.ts'),{ExtensionStore}=await import('./store.ts')
 const approvals=new ExtensionStore(join(data,'extensions/registry.json'))
 await approvals.update(()=>[record])
 await writeFile(join(record.source,'cezar-extension.json'),JSON.stringify({...record.manifest,version:'0.2.0'}))
 await writeFile(join(record.source,'package.json'),JSON.stringify({version:'0.2.0'}))
 const manager=new ExtensionManager(data,'project',root,{home})
 try {
  await manager.install(record.source)
  expect((await approvals.list()).find(item=>item.manifest.id===record.manifest.id)).toEqual(record)
  expect((await store.resolve('telegram'))?.version).toBe(record.manifest.version)
 } finally {await manager.close()}
})

it('selection permission preview is passive and binds exact installed bytes',async()=>{
 const {data,home,record,root}=await fixture()
 const {ExtensionManager}=await import('./manager.ts'),{ExtensionStore}=await import('./store.ts')
 await new ExtensionStore(join(home,'extensions/registry.json')).update(()=>[record])
 const manager=new ExtensionManager(data,'project',root,{home,deliveryPackageRoot:join(root,'absent')})
 const input={target:{kind:'installed' as const,extensionId:record.manifest.id,localProviderId:'telegram',integrity:record.integrity!},enabled:true}
 try {
  const preview=await manager.previewChatSelection('telegram',input)
  expect(preview).toMatchObject({provider:'telegram',current:null,candidate:record,enabled:true,selectionRevision:null,addedPermissions:record.manifest.permissions})
  expect(preview.revision).toMatch(/^[a-f0-9]{64}$/)
  expect(projectChatExtensions(root)).toEqual([])
  await expect(readdir(data)).rejects.toMatchObject({code:'ENOENT'})
  await expect(manager.previewChatSelection('telegram',{...input,target:{...input.target,integrity:'sha512-bWlzc2luZw=='}})).rejects.toThrow('changed')
 } finally {await manager.close()}
})

it('explicit selection commits paused code with a stable canonical declaration',async()=>{
 const {store,data,home,record,root}=await fixture()
 await store.replace('telegram',null,{kind:'installed',record,localProviderId:'telegram'})
 const {ExtensionManager}=await import('./manager.ts'),{ExtensionStore}=await import('./store.ts')
 const {watchChatAdapterSelection,watchChatExtensions}=await import('../chat/registry.ts')
 await new ExtensionStore(join(home,'extensions/registry.json')).update(()=>[record])
 const manager=new ExtensionManager(data,'project',root,{home}),unwatch=watchChatAdapterSelection(root,async()=>{})
 let watch=()=>{}
 const input={target:{kind:'installed' as const,extensionId:record.manifest.id,localProviderId:'telegram',integrity:record.integrity!},enabled:false}
 try {
  await manager.declareDeliveredChat('telegram')
  const seen:string[][]=[];watch=watchChatExtensions(root,async()=>{seen.push(projectChatExtensions(root).map(item=>item.id))})
  const preview=await manager.previewChatSelection('telegram',input)
  const selected=await manager.selectChat('telegram',{...input,revision:preview.revision})
  expect(selected.selectionRevision).not.toBe(preview.selectionRevision)
  expect((await manager.list()).find(item=>item.manifest.id===record.manifest.id)?.enabled).toBe(false)
  expect(seen.every(ids=>ids.includes('telegram'))).toBe(true)
  await expect(manager.selectChat('telegram',{...input,revision:preview.revision})).rejects.toThrow('preview changed')
 }finally{watch();await manager.close();unwatch()}
})
it('failed activation rolls back selection and approval without replacing the canonical slot',async()=>{
 const {store,data,home,record,root}=await fixture()
 const initial=await store.replace('telegram',null,{kind:'installed',record,localProviderId:'telegram'})
 const {ExtensionManager}=await import('./manager.ts'),{ExtensionStore}=await import('./store.ts')
 const {watchChatAdapterSelection,watchChatExtensions}=await import('../chat/registry.ts')
 await new ExtensionStore(join(home,'extensions/registry.json')).update(()=>[record])
 const approvals=new ExtensionStore(join(data,'extensions/registry.json'));await approvals.update(()=>[{...record,enabled:false}])
 const manager=new ExtensionManager(data,'project',root,{home}),unwatch=watchChatAdapterSelection(root,async()=>{})
 let watch=()=>{}
 const input={target:{kind:'installed' as const,extensionId:record.manifest.id,localProviderId:'telegram',integrity:record.integrity!},enabled:true}
 try {
  await manager.declareDeliveredChat('telegram')
  const seen:string[][]=[];watch=watchChatExtensions(root,async()=>{seen.push(projectChatExtensions(root).map(item=>item.id))})
  const preview=await manager.previewChatSelection('telegram',input)
  await expect(manager.selectChat('telegram',{...input,revision:preview.revision})).rejects.toThrow('reads must not execute')
  expect((await store.read('telegram'))?.target).toEqual(initial.target)
  expect((await approvals.list())[0]?.enabled).toBe(false)
  expect(projectChatExtensions(root).map(item=>item.id)).toEqual(['telegram'])
  expect(seen.every(ids=>ids.includes('telegram'))).toBe(true)
 }finally{watch();await manager.close();unwatch()}
})

it('rollback accepts only an authentic frozen snapshot and retains missing-source metadata',async()=>{
 const {store,record,installed}=await fixture()
 await store.replace('telegram',null,{kind:'installed',record,localProviderId:'telegram'})
 const old=(await store.read('telegram'))!
 const changed=await store.replace('telegram',old.revision,{kind:'shipped'})
 await expect(store.restore('telegram',changed.revision,{...old})).rejects.toThrow('Unverified')
 expect(()=>{old.target={kind:'shipped'}}).toThrow()
 await rm(installed.path,{recursive:true})
 const restored=await store.restore('telegram',changed.revision,old)
 expect(restored.target).toEqual(old.target)
 await expect(store.resolve('telegram')).rejects.toThrow()
 await expect(store.restore('telegram',changed.revision,old)).rejects.toThrow('changed')
})

it('a failed first adoption restores the shipped canonical worker when no slot existed yet',async()=>{
 const {data,home,record,root,store}=await fixture()
 const {ExtensionManager}=await import('./manager.ts'),{ExtensionStore}=await import('./store.ts')
 const {watchChatAdapterSelection}=await import('../chat/registry.ts')
 await new ExtensionStore(join(home,'extensions/registry.json')).update(()=>[record])
 const manager=new ExtensionManager(data,'project',root,{home}),unwatch=watchChatAdapterSelection(root,async()=>{})
 const input={target:{kind:'installed' as const,extensionId:record.manifest.id,localProviderId:'telegram',integrity:record.integrity!},enabled:true}
 try {
  const preview=await manager.previewChatSelection('telegram',input)
  expect(preview.current?.source).toBe('bundled')
  await expect(manager.selectChat('telegram',{...input,revision:preview.revision})).rejects.toThrow('reads must not execute')
  expect((await store.read('telegram'))?.target).toEqual({kind:'shipped'})
  expect(projectChatExtensions(root).map(item=>item.id)).toEqual(['telegram'])
  expect((await manager.list()).find(item=>item.manifest.id===record.manifest.id)).toMatchObject({source:'bundled',status:'running'})
 }finally{await manager.close();unwatch()}
})
