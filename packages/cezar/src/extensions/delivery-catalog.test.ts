import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { artifactIntegrity } from './installer.ts'
import { isVerifiedChatDelivery, loadChatDeliveryCatalog } from './delivery-catalog.ts'
import { ExtensionManager } from './manager.ts'
import { chatTransportAvailable } from '../chat/registry.ts'
const spawns = vi.hoisted(() => vi.fn())
vi.mock('./worker-process.ts', async importOriginal => {
 const actual = await importOriginal<typeof import('./worker-process.ts')>()
 return {...actual, spawnWorkerProcess: (options: Parameters<typeof actual.spawnWorkerProcess>[0]) => { spawns(); return actual.spawnWorkerProcess(options) }}
})
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true}))) })
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'delivery-catalog-'));roots.push(root)
 const directory=join(root,'dist','chat-plugins'), stamps=[]
 for(const provider of ['telegram','slack','discord']) {
  const artifact=join(directory,provider);await mkdir(join(artifact,'dist'),{recursive:true})
  const manifest=JSON.parse(await readFile(new URL(`../../../chat-plugins/${provider}/cezar-extension.json`,import.meta.url),'utf8'))
  await writeFile(join(artifact,'cezar-extension.json'),JSON.stringify(manifest))
  await writeFile(join(artifact,'package.json'),JSON.stringify({name:`@open-mercato/cezar-chat-${provider}`,version:manifest.version,type:'module'}))
  await writeFile(join(artifact,'dist','index.js'),`export default { activate(context) { context.chat.register('${provider}', () => ({})) } }`)
  stamps.push({provider,extensionId:manifest.id,version:manifest.version,integrity:await artifactIntegrity(artifact)})
 }
 await writeFile(join(directory,'catalog.json'),JSON.stringify(stamps))
 return {root,directory}
}
it('verifies a whole-catalog read once per catalog file, and a provider read every time',async()=>{
 const {root,directory}=await fixture()
 const first=await loadChatDeliveryCatalog(root)
 await writeFile(join(directory,'slack','dist','index.js'),'throw Error("modified")')
 expect(await loadChatDeliveryCatalog(root)).toEqual(first)
 await expect(loadChatDeliveryCatalog(root,'slack')).rejects.toThrow('integrity mismatch')
})
it('loads verified actual manifests with independent versions and refuses modified package bytes',async()=>{
 const {root,directory}=await fixture()
 expect((await loadChatDeliveryCatalog(root)).map(item=>item.provider)).toEqual(['telegram','slack','discord'])
 await writeFile(join(directory,'slack','dist','index.js'),'throw Error("modified")')
 await expect(loadChatDeliveryCatalog(root,'slack')).rejects.toThrow('integrity mismatch')
 await writeFile(join(directory,'catalog.json'),await readFile(join(directory,'catalog.json')))
 expect((await loadChatDeliveryCatalog(root)).map(item=>item.provider)).toEqual(['telegram','discord'])
 await expect(loadChatDeliveryCatalog(root, 'slack')).rejects.toThrow('integrity mismatch')
})
it('does not grant shipped provenance through an artifact directory symlink',async()=>{
 const {root,directory}=await fixture()
 const outside=join(root,'external-artifact')
 await rename(join(directory,'telegram'),outside)
 await symlink(outside,join(directory,'telegram'),'dir')
 expect((await loadChatDeliveryCatalog(root)).map(item=>item.provider)).toEqual(['slack','discord'])
 await expect(loadChatDeliveryCatalog(root, 'telegram')).rejects.toThrow('directory')
})
it('pins verified entry, identity and nested manifest against mutation',async()=>{
 const {root}=await fixture()
 const [artifact]=await loadChatDeliveryCatalog(root)
 expect(()=>{artifact!.entry='/arbitrary.mjs'}).toThrow()
 expect(()=>{artifact!.extensionId='untrusted'}).toThrow()
 expect(()=>{artifact!.manifest.contributes!.chatProviders![0]!.id='other'}).toThrow()
 expect(()=>{artifact!.manifest.permissions.push('project.read')}).toThrow()
})

it.each(['missing', 'invalid'] as const)('keeps healthy artifacts verified when Slack is %s', async fault => {
 const {root,directory}=await fixture()
 if(fault==='missing') await rm(join(directory,'slack'),{recursive:true})
 else await writeFile(join(directory,'slack','dist','index.js'),'throw Error("must never execute")')
 const artifacts=await loadChatDeliveryCatalog(root)
 expect(artifacts.map(item=>item.provider)).toEqual(['telegram','discord'])
 expect(artifacts.every(isVerifiedChatDelivery)).toBe(true)
 await expect(loadChatDeliveryCatalog(root,'slack')).rejects.toThrow()
})
it('still rejects the whole catalog with duplicate trusted identities', async()=>{
 const {root,directory}=await fixture()
 const path=join(directory,'catalog.json')
 const stamps=JSON.parse(await readFile(path,'utf8'))
 stamps[1].extensionId=stamps[0].extensionId
 await writeFile(path,JSON.stringify(stamps))
 await expect(loadChatDeliveryCatalog(root)).rejects.toThrow('Duplicate delivery identity')
 await expect(loadChatDeliveryCatalog(root,'telegram')).rejects.toThrow('Duplicate delivery identity')
})
it.each([
 {fault:'missing',facade:false}, {fault:'invalid',facade:false},
 {fault:'missing',facade:true}, {fault:'invalid',facade:true},
])('manager preserves inventory and default startup with $fault Slack, facade=$facade', async ({fault,facade})=>{
 const {root,directory}=await fixture()
 if(fault==='missing') await rm(join(directory,'slack'),{recursive:true})
 else await writeFile(join(directory,'slack','dist','index.js'),'throw Error("must never execute")')
 const manager=new ExtensionManager(join(root,'data'),'project',root,{
  home:join(root,'home'),deliveryPackageRoot:root,...(facade?{trustedChatInProcess:true}:{}),
 })
 spawns.mockClear()
 try {
  const inventory=await manager.inventory(facade?'flag-disabled':undefined)
  expect(inventory.map(item=>item.providers[0]?.id)).toEqual(['telegram','discord'])
  expect(inventory.every(item=>item.availability==='available' && item.provenance.kind==='bundled')).toBe(true)
  for(const provider of ['telegram','discord'] as const) {
   await manager.startDeliveredChat(provider)
   expect(chatTransportAvailable(root,provider)).toBe(true)
  }
  await expect(manager.startDeliveredChat('slack')).rejects.toThrow(fault==='invalid'?'integrity mismatch':/ENOENT/)
  expect(chatTransportAvailable(root,'slack')).toBe(false)
  expect(spawns).toHaveBeenCalledTimes(facade?0:2)
  expect((await manager.list()).map(item=>item.status)).toEqual(['running','running'])
 } finally { await manager.close() }
},15000)

it('isolates an identity mismatch even when the artifact digest matches the catalog', async()=>{
 const {root,directory}=await fixture()
 const manifestPath=join(directory,'slack','cezar-extension.json')
 const manifest=JSON.parse(await readFile(manifestPath,'utf8'))
 manifest.version='99.0.0'
 await writeFile(manifestPath,JSON.stringify(manifest))
 const catalogPath=join(directory,'catalog.json')
 const stamps=JSON.parse(await readFile(catalogPath,'utf8'))
 stamps[1].integrity=await artifactIntegrity(join(directory,'slack'))
 await writeFile(catalogPath,JSON.stringify(stamps))
 expect((await loadChatDeliveryCatalog(root)).map(item=>item.provider)).toEqual(['telegram','discord'])
 await expect(loadChatDeliveryCatalog(root,'slack')).rejects.toThrow('identity mismatch')
})
