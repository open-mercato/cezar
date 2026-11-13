import {fork, type ChildProcess} from 'node:child_process'
import {mkdtemp,mkdir,writeFile,rm,access} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {it,expect} from 'vitest'
import {ExtensionManager} from './manager.ts'

it.each([true,false])('reconciles update/disable/uninstall across processes (check live artifact: %s)',async checkArtifact=>{
 const root=await mkdtemp(join(tmpdir(),'extension-peer-')),home=join(root,'home'),source=join(root,'source')
 await mkdir(source)
 const manager=new ExtensionManager(join(root,'data'),'project',root,{home})
 let peer:ChildProcess|undefined
 const write=async(version:string,command:string)=>{
  await writeFile(join(source,'cezar-extension.json'),JSON.stringify({id:'test.peer',name:'Peer',version,apiVersion:'0.1',entry:'index.mjs',capabilities:['commands'],contributes:{commands:[{id:command,label:command}]}}))
  await writeFile(join(source,'index.mjs'),`import {writeFile} from 'node:fs/promises';export function activate(c){c.commands.register('${command}',()=>({message:'${version}'}));return {dispose:()=>writeFile(${JSON.stringify(join(root,'disposed-'))}+'${version}-'+process.ppid,'done')}}`)
 }
 try{
  await write('1.0.0','old')
  const old=await manager.install(source);await manager.setEnabled('test.peer',true)
  const artifact=join(home,'extensions','artifacts','test.peer','1.0.0',createHash('sha256').update(old.integrity!).digest('hex'))
  const script=join(root,'peer.mts')
  await writeFile(script,`import {ExtensionManager} from ${JSON.stringify(fileURLToPath(new URL('./manager.ts',import.meta.url)))};
   const m=new ExtensionManager(${JSON.stringify(join(root,'data'))},'project',${JSON.stringify(root)},{home:${JSON.stringify(home)}});
   await m.restore();process.send({ready:true});
   process.on('message',async command=>{try {
    if(command==='close'){await m.close();process.disconnect();return;}
    const list=await m.list();let result;try{result=await m.invoke('test.peer','new')}catch(e){result={error:e.message}}
    process.send({list,result});
   }catch(e){process.send({error:e.message})}});
  `)
  peer=fork(script,{execArgv:['--import',fileURLToPath(new URL('../../../../node_modules/tsx/dist/loader.mjs',import.meta.url))],stdio:['ignore','ignore','inherit','ipc'],env:{...process.env,CEZ_HOME:home}})
  const reply=()=>new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('peer timeout')),10000);peer!.once('message',v=>{clearTimeout(timer);resolve(v)})})
  await reply()
  peer.kill('SIGSTOP')
  await write('1.0.1','new');const installed = await manager.install(source)
  const currentArtifact = join(home,'extensions','artifacts','test.peer','1.0.1',createHash('sha256').update(installed.integrity!).digest('hex'))
  // A stopped peer still owns v1: lazy imports must remain available until retirement.
  if(checkArtifact) await expect(access(artifact)).resolves.toBeUndefined()
  peer.kill('SIGCONT')
  let response=reply();peer.send('check');const updated=await response
  expect(updated.list[0]).toMatchObject({manifest:{version:'1.0.1'},status:'running'})
  expect(updated.result).toMatchObject({ok:true,message:'1.0.1'})
  await expect(access(artifact)).rejects.toMatchObject({code:'ENOENT'})
  await manager.setEnabled('test.peer',false)
  await expect.poll(async()=>access(join(root,'disposed-1.0.1-'+peer!.pid)).then(()=>true,()=>false)).toBe(true)
  response=reply();peer.send('check');const disabled=await response
  expect(disabled.list[0]).toMatchObject({enabled:false,status:'disabled'})
  expect(disabled.result.error).toMatch(/enabled/)
  await manager.setEnabled('test.peer',true)
  response=reply();peer.send('check');expect((await response).result).toMatchObject({message:'1.0.1'})
  await rm(join(root,'disposed-1.0.1-'+peer!.pid),{force:true})
  peer.kill('SIGSTOP')
  await manager.uninstall('test.peer')
  await expect(access(currentArtifact)).resolves.toBeUndefined()
  peer.kill('SIGCONT')
  await expect.poll(async()=>access(join(root,'disposed-1.0.1-'+peer!.pid)).then(()=>true,()=>false)).toBe(true)
  response=reply();peer.send('check');expect((await response).list).toEqual([])
  await expect(access(currentArtifact)).rejects.toMatchObject({code:'ENOENT'})
 }finally{
  if(peer){peer.kill('SIGCONT');peer.send('close');await new Promise<void>(resolve=>{peer!.once('exit',()=>resolve());setTimeout(()=>{peer!.kill('SIGKILL');resolve()},3000).unref()})}
  await manager.close();await rm(root,{recursive:true,force:true})
 }
},30000)
