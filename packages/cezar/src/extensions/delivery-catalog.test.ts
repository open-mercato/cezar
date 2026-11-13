import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { artifactIntegrity } from './installer.ts'
import { loadChatDeliveryCatalog } from './delivery-catalog.ts'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true}))) })
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'delivery-catalog-'));roots.push(root)
 const directory=join(root,'dist','chat-plugins'), stamps=[]
 for(const provider of ['telegram']) {
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
 await writeFile(join(directory,'telegram','dist','index.js'),'throw Error("modified")')
 expect(await loadChatDeliveryCatalog(root)).toEqual(first)
 await expect(loadChatDeliveryCatalog(root,'telegram')).rejects.toThrow('integrity mismatch')
})
it('loads verified actual manifests with independent versions and refuses modified package bytes',async()=>{
 const {root,directory}=await fixture()
 expect((await loadChatDeliveryCatalog(root)).map(item=>item.provider)).toEqual(['telegram'])
 await writeFile(join(directory,'telegram','dist','index.js'),'throw Error("modified")')
 await expect(loadChatDeliveryCatalog(root,'telegram')).rejects.toThrow('integrity mismatch')
 await writeFile(join(directory,'catalog.json'),await readFile(join(directory,'catalog.json')))
 expect((await loadChatDeliveryCatalog(root)).map(item=>item.provider)).toEqual([])
 await expect(loadChatDeliveryCatalog(root, 'telegram')).rejects.toThrow('integrity mismatch')
})
it('does not grant shipped provenance through an artifact directory symlink',async()=>{
 const {root,directory}=await fixture()
 const outside=join(root,'external-artifact')
 await rename(join(directory,'telegram'),outside)
 await symlink(outside,join(directory,'telegram'),'dir')
 expect((await loadChatDeliveryCatalog(root)).map(item=>item.provider)).toEqual([])
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

it('isolates an identity mismatch even when the artifact digest matches the catalog', async()=>{
 const {root,directory}=await fixture()
 const manifestPath=join(directory,'telegram','cezar-extension.json')
 const manifest=JSON.parse(await readFile(manifestPath,'utf8'))
 manifest.version='99.0.0'
 await writeFile(manifestPath,JSON.stringify(manifest))
 const catalogPath=join(directory,'catalog.json')
 const stamps=JSON.parse(await readFile(catalogPath,'utf8'))
 stamps[0].integrity=await artifactIntegrity(join(directory,'telegram'))
 await writeFile(catalogPath,JSON.stringify(stamps))
 expect((await loadChatDeliveryCatalog(root)).map(item=>item.provider)).toEqual([])
 await expect(loadChatDeliveryCatalog(root,'telegram')).rejects.toThrow('identity mismatch')
})
