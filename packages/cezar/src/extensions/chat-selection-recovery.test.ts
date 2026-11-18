import {chatManagementOwner} from './project-runtime.ts'
import {mkdtemp,mkdir,writeFile,rm,chmod,readFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {afterEach,expect,it} from 'vitest'
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
 const create=(d=data,p=root)=>{const m=new ExtensionManager(d,'project',p,{openChatOwner:chatManagementOwner({root:p,dataDir:d,projectId:'project'}),home,deliveryPackageRoot:join(root,'absent')});managers.push(m);return m}
 const manager=create(),record=await manager.install(source)
 await new ChatSelectionStore(data,home).replace('telegram',null,{kind:'installed',record,localProviderId:'telegram'})
 return {root,home,data,source,create,manager,record}
}
it('matching declaration only aliases canonical and approval stays project-local',async()=>{
 const {root,home,manager,record}=await setup();await manager.declareDeliveredChat('telegram');await manager.setEnabled(record.manifest.id,true)
 expect(projectChatExtensions(root).map(p=>p.id).sort()).toEqual(['open-mercato.telegram/other','telegram'])
 expect(await chatTransport(root,'telegram','token')!.identify()).toMatchObject({id:'1'})
 const otherData=join(root,'otherdata'),otherRoot=join(root,'other');await mkdir(otherRoot)
 await new ChatSelectionStore(otherData,home).replace('telegram',null,{kind:'installed',record,localProviderId:'telegram'})
 const other=new ExtensionManager(otherData,'other',otherRoot,{openChatOwner:chatManagementOwner({root:otherRoot,dataDir:otherData,projectId:'other'}),home});managers.push(other)
 await other.startDeliveredChat('telegram');expect((await other.list())[0]).toMatchObject({enabled:false,status:'disabled'})
})
it.each([false,true])('restore selected approval with catalog absent=%s',async absent=>{
 const {root,home,manager,record,create}=await setup();await manager.declareDeliveredChat('telegram');await manager.setEnabled(record.manifest.id,true);
 if(absent){await manager.uninstall(record.manifest.id);await manager.setEnabled(record.manifest.id,true)}
 await manager.close()
 const reopened=create();await reopened.restore()
 expect(projectChatExtensions(root).map(p=>p.id)).toContain('telegram')
 expect((await reopened.list()).find(r=>r.manifest.id===record.manifest.id)).toMatchObject({enabled:true,status:'running'})
})
it('malicious bundled branding never permits flag-off execution',async()=>{
 const {root,home,data,manager,record}=await setup();await manager.close()
 const store=new ChatSelectionStore(data,home),prior=(await store.read('telegram'))!
 const forged={...record,source:'bundled',installedAt:record.integrity!,enabled:true}
 await store.replace('telegram',prior.revision,{kind:'installed',record:forged,localProviderId:'telegram'})
 await new ExtensionStore(join(data,'extensions/registry.json')).update(()=>[forged])
 const m=new ExtensionManager(data,'p',root,{openChatOwner:chatManagementOwner({root:root,dataDir:data,projectId:'p'}),home,trustedChatInProcess:true});managers.push(m)
 await expect(m.startDeliveredChat('telegram')).rejects.toThrow('extensions are disabled')
})

it('empty restore leaves a read-only home untouched and starts no canonical provider',async()=>{
 const root=await mkdtemp(join(tmpdir(),'empty-selected-'));roots.push(root)
 const home=join(root,'home');await mkdir(home);await chmod(home,0o500)
 const data=join(root,'data'),manager=new ExtensionManager(data,'empty',root,{openChatOwner:chatManagementOwner({root:root,dataDir:data,projectId:'empty'}),home});managers.push(manager)
 try{await manager.restore();expect(projectChatExtensions(root)).toEqual([]);await expect(readFile(join(home,'extensions/registry.json'))).rejects.toMatchObject({code:'ENOENT'});await expect(readFile(join(data,'extensions/registry.json'))).rejects.toMatchObject({code:'ENOENT'})}
 finally{await chmod(home,0o700)}
})
