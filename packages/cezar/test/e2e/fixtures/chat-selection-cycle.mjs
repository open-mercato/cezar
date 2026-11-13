import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'

/** Exercise code selection against an already paired native provider. The
 * caller proves fresh wire traffic after each transition; no live credentials. */
export async function chatSelectionCycle({manager,plugin,provider,dataDir,fresh,fault}) {
 const manifestPath=join(plugin,'cezar-extension.json'),packagePath=join(plugin,'package.json')
 const manifestBytes=await readFile(manifestPath),packageBytes=await readFile(packagePath)
 const manifest=JSON.parse(manifestBytes),pkg=JSON.parse(packageBytes)
 const entry=join(plugin,manifest.entry),entryBytes=await readFile(entry)
 const stamp=async version=>{
  await writeFile(manifestPath,JSON.stringify({...manifest,version}))
  await writeFile(packagePath,JSON.stringify({...pkg,version}))
 }
 const select=async record=>{
  const input={target:{kind:'installed',extensionId:record.manifest.id,localProviderId:provider,integrity:record.integrity},enabled:true}
  const preview=await manager.previewChatSelection(provider,input)
  await manager.selectChat(provider,{...input,revision:preview.revision})
 }
 const selected=async()=> (await manager.inventory()).find(row=>row.record.manifest.id===manifest.id)?.selectedVersion
 const assertTarget=async(record,stage)=>{
  const file=join(dataDir,'extensions','chat-selections',provider+'.json')
  const raw=await readFile(file,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error})
  const selection=raw===null?undefined:JSON.parse(raw)
  assert.equal(selection?.target.kind,'installed','installed selection target missing after '+stage)
  assert.equal(selection.provider,provider)
  assert.equal(selection.target.localProviderId,provider)
  assert.equal(selection.target.record.manifest.id,record.manifest.id)
  assert.equal(selection.target.record.integrity,record.integrity,'selected artifact digest changed after '+stage)
 }

 try {
  const original=await manager.install(plugin)
  if(fault!=='skip-adoption')await select(original);await fresh('adoption');await assertTarget(original,'adoption')
  await stamp('0.1.901')
  const candidate=await manager.install(plugin)
  assert.equal(await selected(),original.manifest.version,'install must preserve the existing selection')
  await fresh('candidate installation');await assertTarget(original,'candidate installation')
  if(fault!=='skip-select-update')await select(candidate);await fresh('selected update');await assertTarget(candidate,'selected update')
  assert.equal(await selected(),'0.1.901','selected update version was not activated')
  await stamp('0.1.902')
  await writeFile(entry,"throw new Error('Fixture selection activation failure')\n")
  const broken=await manager.install(plugin)
  await assert.rejects(select(broken),/Fixture selection activation failure/)
  await fresh('failed selection rollback');await assertTarget(candidate,'failed selection rollback')
  assert.equal(await selected(),'0.1.901','rollback must preserve the last working code selection')
 } finally {
  await writeFile(manifestPath,manifestBytes);await writeFile(packagePath,packageBytes);await writeFile(entry,entryBytes)
 }
}

// Explicit re-enable rotates enableGeneration to fence stale work. The grant's
// own generation, identity, permissions and original approval must survive.
export const grantApprovals=grants=>grants.map(({enableGeneration,...approval})=>approval)
