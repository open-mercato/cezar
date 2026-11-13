import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
const [root,host,plugin,fault,mode,barrier]=process.argv.slice(2)
const defaultRuntime=mode==='default'||mode==='default-facade'
// Every runtime import is from the newly installed tarball, outside the monorepo.
const load=path=>import(pathToFileURL(join(host,'dist',path)).href)
const {ExtensionManager}=await load('extensions/manager.js')
const {WebhookService}=await load('webhooks/service.js')
const {WebhookScheduler}=await load('webhooks/scheduler.js')
const {RunStore}=await load('runs/store.js')
const {createChatTask}=await load('server/run-messages.js')
const project=join(root,'project');await mkdir(project);execFileSync('git',['init','-q'],{cwd:project,timeout:5000})
const queue=[],sent=[],offsets=[],started=[]
let nextMessage=1
const server=createServer(async(req,res)=>{
 const chunks=[];for await(const chunk of req) chunks.push(chunk)
 const body=JSON.parse(Buffer.concat(chunks).toString()),method=req.url.split('/').at(-1)
 let result=true
 if(method==='getMe') result={id:700001,username:'cezar_bot',first_name:'Cezar'}
 if(method==='getChat') result={id:Number(body.chat_id),type:Number(body.chat_id)<0?'supergroup':'private',title:'Fixture'}
 if(method==='getChatMember') result={status:'member',user:{id:Number(body.user_id)}}
 if(method==='getWebhookInfo') result={url:''}
 if(method==='getUpdates') {offsets.push(body.offset);result=queue.splice(0).filter(row=>body.offset==null||row.update_id>=body.offset)}
 if(method==='sendMessage') {result={message_id:nextMessage++,chat:{id:Number(body.chat_id)}};sent.push({...body,receipt:result})}
 setTimeout(()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,result}))},10)
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const port=server.address().port,preload=join(root,'simulator.mjs')
await writeFile(preload,`import dns from 'node:dns/promises';import tls from 'node:tls';import net from 'node:net';import {syncBuiltinESMExports} from 'node:module';
dns.lookup=async hostname=>{if(hostname!=='api.telegram.org')throw Error('Network denied');return [{address:'8.8.8.8',family:4}]};
tls.connect=(options,callback)=>{if(options.servername!=='api.telegram.org'&&options.host!=='api.telegram.org')throw Error('Network denied');const socket=net.connect({host:'127.0.0.1',port:${port}});socket.authorized=true;socket.encrypted=true;socket.on('connect',()=>{socket.emit('secureConnect');callback?.()});return socket};syncBuiltinESMExports();`)
if(mode==='facade'||mode==='default-facade') await import(pathToFileURL(preload).href)
let defaultWorkers=0
if(defaultRuntime){
 const child=(await import('node:child_process')).default,spawn=child.spawn
 child.spawn=function(command,args,options){
  if(command===process.execPath&&args?.includes('--input-type=module')){defaultWorkers++;args=['--import',preload,...args]}
  return spawn.call(this,command,args,options)
 };(await import('node:module')).syncBuiltinESMExports()
}
const credential=mode!=='installed'?'700001:'+'A'.repeat(32):JSON.stringify({token:'700001:'+'A'.repeat(32)})
const dataDir=join(project,'.ai/cezar'),provider=mode!=='installed'?'telegram':'open-mercato.telegram/telegram'
let manager,service,runtimeOwner
const wait=async(predicate,label='Simulator condition timed out',timeout=10000)=>{const until=Date.now()+timeout;while(!predicate()){if(Date.now()>until)throw Error(label);await new Promise(r=>setTimeout(r,20))}}
async function open() {
 if(defaultRuntime){runtimeOwner=await (await load('extensions/project-runtime.js')).retainProjectExtensions({root:project,dataDir,projectId:'project'});manager=runtimeOwner.manager}
 else manager=new ExtensionManager(dataDir,'project',project,{openChatOwner:(await load('extensions/project-runtime.js')).chatManagementOwner({root:project,dataDir,projectId:'project'}),home:process.env.CEZ_HOME,workerExecArgv:['--import',preload],...(mode==='facade'?{trustedChatInProcess:true}:{})})
 if(mode!=='installed'&&!defaultRuntime) await manager.declareDeliveredChat('telegram')
 service=await WebhookService.open({root:project,dataDir,projectId:'project',mode:'local',serverPorts:()=>[],scheduler:new WebhookScheduler(),...(!defaultRuntime?{send:async()=>{throw Error('Unexpected private send')}}:{}),...(mode!=='installed'&&!defaultRuntime?{send:async()=>{throw Error('Unexpected private send')},telegramCall:()=>async()=>{throw Error('Unexpected private Telegram call')}}:{})})
 assert.ok(service)
 const store=await RunStore.open(dataDir)
 // Stop at the engine boundary: exercise the packed core authorization/Confirm
 // path without invoking an agent, spending money, or using live credentials.
 const context={id:'project',root:project,dataDir,store,manager:{startRun(workflow,options){started.push({workflow,options});return {id:options.chatSource.runId}}}}
 service.setChatInteractions({context:async()=>context,deliver:async()=>{throw Error('Unexpected reply')},
  createTask:(project,text,source,check,target)=>createChatTask(project,text,source,check,{providerActionError:async()=>null},target)})
}
async function close() {await service?.dispose();if(runtimeOwner)await runtimeOwner.release();else await manager?.close();runtimeOwner=undefined;service=undefined;manager=undefined}
try {
 await open();
 if(mode!=='installed') await service.startChat()
 else {await manager.install(plugin);await manager.setEnabled('open-mercato.telegram',true)}
 const inbound=service.chats.get(provider);assert.ok(inbound)
 const begun=await inbound.beginSetup({token:credential,name:'Packed Telegram',dedicatedBot:true})
 const code=new URL(begun.deepLink).searchParams.get('start');assert.ok(code)
 queue.push({update_id:100,message:{message_id:1,date:Math.ceil(Date.now()/1000),chat:{id:41,type:'private'},from:{id:41,is_bot:false,first_name:'Person'},text:'/start '+code,entities:[{type:'bot_command',offset:0,length:6}]}})
 try {await wait(()=>inbound.setupStatus(begun.setupId).status==='candidate')} catch(error) {console.error(JSON.stringify({offsets:offsets.slice(-5),queue:queue.length,health:inbound.list().bots.map(bot=>bot.health),status:inbound.setupStatus(begun.setupId)}));throw error}
 const status=inbound.setupStatus(begun.setupId)
 await inbound.activateSetup(begun.setupId,{activate:true,expectedRevision:status.inboundRevision,candidateUserId:'41',permissions:['respond','start']})
 assert.equal(inbound.list().grants.length,1)
 if(defaultRuntime)assert.equal(defaultWorkers>0,mode==='default','default selection must use the expected worker/facade path')
 await wait(()=>sent.length>0)
 const group=await inbound.beginSetup({token:credential,name:'Packed group',dedicatedBot:true})
 const groupCode=new URL(group.deepLink).searchParams.get('start');assert.ok(groupCode)
 queue.push({update_id:101,message:{message_id:2,date:Math.ceil(Date.now()/1000),chat:{id:-42,type:'supergroup',title:'Packed group'},from:{id:41,is_bot:false,first_name:'Person'},text:'/start@cezar_bot '+groupCode,entities:[{type:'bot_command',offset:0,length:16}]}})
 await wait(()=>inbound.setupStatus(group.setupId).candidate?.chatType==='group')
 assert.equal(inbound.setupStatus(group.setupId).candidate.comparisonCode,undefined)
 queue.push({update_id:102,message:{message_id:3,date:Math.ceil(Date.now()/1000),chat:{id:41,type:'private'},from:{id:41,is_bot:false,first_name:'Person'},text:'/start '+groupCode,entities:[{type:'bot_command',offset:0,length:6}]}})
 await wait(()=>!!inbound.setupStatus(group.setupId).candidate?.comparisonCode)
 const groupStatus=inbound.setupStatus(group.setupId)
 const granted=await inbound.activateSetup(group.setupId,{activate:true,expectedRevision:groupStatus.inboundRevision,candidateUserId:'41',permissions:['respond'],comparisonVerified:true,groupVisibilityAccepted:true})
 assert.equal(granted.grant.chatId,'-42')
 assert.equal(inbound.list().grants.length,2)
 queue.push({update_id:103,message:{message_id:4,date:Math.ceil(Date.now()/1000),chat:{id:41,type:'private'},from:{id:41,is_bot:false},text:'/task investigate packed runtime',entities:[{type:'bot_command',offset:0,length:5}]}})
 await wait(()=>sent.some(row=>row.reply_markup?.inline_keyboard?.flat().some(button=>button.text==='Confirm')))
 assert.equal(started.length,0,'a preview must never start an agent')
 const preview=sent.find(row=>row.reply_markup?.inline_keyboard?.flat().some(button=>button.text==='Confirm'))
 const button=preview.reply_markup.inline_keyboard.flat().find(button=>button.text==='Confirm')
 const tap=id=>({update_id:id,callback_query:{id:'tap-'+id,data:button.callback_data,from:{id:41,is_bot:false},message:{message_id:preview.receipt.message_id,chat:{id:41,type:'private'}}}})
 queue.push(tap(104));await wait(()=>started.length===1)
 queue.push(tap(105));await wait(()=>offsets.includes(106))
 assert.equal(started.length,1,'repeated Confirm must not create a second task')
 assert.match(started[0].options.task,/investigate packed runtime/)
 assert.equal(started[0].options.chatSource.provider,provider)
 if(mode==='installed') {
 // Exercise replacement with the exact packed implementation, changing only
 // release metadata, then inject a startup fault into a candidate for rollback.
 const manifestPath=join(plugin,'cezar-extension.json'),packagePath=join(plugin,'package.json')
 const manifest=JSON.parse(await readFile(manifestPath,'utf8')),pkg=JSON.parse(await readFile(packagePath,'utf8'))
 const stamp=async version=>{await writeFile(manifestPath,JSON.stringify({...manifest,version}));await writeFile(packagePath,JSON.stringify({...pkg,version}))}
 await stamp('0.1.901')
 offsets.length=0
 const updated=await manager.install(plugin)
 assert.equal(updated.manifest.version,'0.1.901');assert.equal(updated.enabled,true)
 await wait(()=>offsets.includes(106))
 assert.equal(service.chats.get(provider).list().grants.length,2)
 queue.push({update_id:106,edited_message:{ignored:true}})
 await wait(()=>offsets.includes(107))
 const entry=join(plugin,updated.manifest.entry),entryBytes=await readFile(entry)
 await stamp('0.1.902');await writeFile(entry,"throw new Error('Fixture candidate activation failure')\n")
 offsets.length=0
 await assert.rejects(manager.install(plugin),/Fixture candidate activation failure/)
 await writeFile(entry,entryBytes)
 await wait(()=>offsets.includes(107))
 assert.ok(offsets.every(offset=>offset>=107),'failed candidate rollback must not rewind the cursor')
 const rollback=(await manager.list()).find(row=>row.manifest.id==='open-mercato.telegram')
 assert.equal(rollback.manifest.version,'0.1.901');assert.equal(rollback.enabled,true)
 assert.equal(service.chats.get(provider).list().grants.length,2)
 }
 if(mode==='selected') {
  // Adopt the installed artifact into the existing native identity. Candidate
  // installation alone must leave that selection and its live state untouched.
  const select=async record=>{
   const input={target:{kind:'installed',extensionId:record.manifest.id,localProviderId:'telegram',integrity:record.integrity},enabled:true}
   const preview=await manager.previewChatSelection('telegram',input)
   return manager.selectChat('telegram',{...input,revision:preview.revision})
  }
  const fresh=async update=>{
   const before=sent.length;offsets.length=0
   queue.push({update_id:update,message:{message_id:update,date:Math.ceil(Date.now()/1000),chat:{id:41,type:'private'},from:{id:41,is_bot:false},text:'/help',entities:[{type:'bot_command',offset:0,length:5}]}})
   await wait(()=>sent.length>before,'selected artifact did not answer fresh input')
   await wait(()=>offsets.includes(update+1),'selected artifact did not advance checkpoint')
   assert.ok(offsets.every(offset=>offset>=update),'selection must not rewind cursor')
   assert.equal(service.telegram.list().grants.length,2)
   assert.equal(service.chats.has('open-mercato.telegram/telegram'),false)
  }
  const installed=await manager.install(plugin)
  await select(installed);await fresh(106)
  const manifestPath=join(plugin,'cezar-extension.json'),packagePath=join(plugin,'package.json')
  const manifest=JSON.parse(await readFile(manifestPath,'utf8')),pkg=JSON.parse(await readFile(packagePath,'utf8'))
  const stamp=async version=>{await writeFile(manifestPath,JSON.stringify({...manifest,version}));await writeFile(packagePath,JSON.stringify({...pkg,version}))}
  await stamp('0.1.901')
  const updated=await manager.install(plugin)
  assert.equal((await manager.inventory()).find(row=>row.record.manifest.id===installed.manifest.id).selectedVersion,installed.manifest.version)
  await fresh(107)
  if(fault!=='skip-select-update')await select(updated);await fresh(108)
  assert.equal((await manager.inventory()).find(row=>row.record.manifest.id===installed.manifest.id).selectedVersion,'0.1.901','selected update version was not activated')
  const entry=join(plugin,updated.manifest.entry),entryBytes=await readFile(entry)
  await stamp('0.1.902');await writeFile(entry,"throw new Error('Fixture selected candidate activation failure')\n")
  const broken=await manager.install(plugin)
  await assert.rejects(select(broken),/Fixture selected candidate activation failure/)
  await writeFile(entry,entryBytes)
  await fresh(109)
  assert.equal((await manager.inventory()).find(row=>row.record.manifest.id===installed.manifest.id).selectedVersion,'0.1.901')
 }
 if(mode==='delivered') {
  const candidate=await manager.install(plugin)
  assert.notEqual(candidate.source,'bundled')
  assert.equal(service.chats.get(provider).list().grants.length,2)
 }
 let resumedOffset=mode==='selected'?110:mode!=='installed'?106:107
 await close();offsets.length=0;await open()
 if(fault!=='skip-restore') {if(mode!=='installed') await service.startChat();else await manager.restore()}
 await wait(()=>offsets.includes(resumedOffset),'restart receive did not resume',fault==='skip-restore'?500:10000)
 assert.ok(offsets.every(offset=>offset>=resumedOffset),'restart must not rewind the cursor')
 const restored=service.chats.get(provider);assert.ok(restored)
 assert.equal(restored.list().grants.length,2)
 queue.push(tap(resumedOffset))
 await wait(()=>offsets.includes(resumedOffset+1),'restart delivery did not advance')
 assert.equal(started.length,1)
 const restartSent=sent.length
 queue.push({update_id:resumedOffset+1,message:{message_id:30,date:Math.ceil(Date.now()/1000),chat:{id:41,type:'private'},from:{id:41,is_bot:false},text:'/task fresh after restart',entities:[{type:'bot_command',offset:0,length:5}]}})
 await wait(()=>sent.slice(restartSent).some(row=>row.reply_markup?.inline_keyboard?.flat().some(button=>button.text==='Confirm')))
 const rp=sent.slice(restartSent).find(row=>row.reply_markup?.inline_keyboard?.flat().some(button=>button.text==='Confirm'))
 const rb=rp.reply_markup.inline_keyboard.flat().find(button=>button.text==='Confirm')
 assert.equal(started.length,1)
 const rt=id=>({update_id:id,callback_query:{id:'restart-'+id,data:rb.callback_data,from:{id:41,is_bot:false},message:{message_id:rp.receipt.message_id,chat:{id:41,type:'private'}}}})
 queue.push(rt(resumedOffset+2));await wait(()=>started.length===2)
 queue.push(rt(resumedOffset+3));await wait(()=>offsets.includes(resumedOffset+4))
 assert.equal(started.length,2);assert.match(started[1].options.task,/fresh after restart/)
 resumedOffset+=3
 if(mode!=='installed') {
  const receiver=service.endpoints.privateReceiver(service.list().receivers.find(row=>row.chatId==='41').id)
  const text='<b>Packed notification</b> &amp; safe'
  const outcome=await service.chat.send(receiver,{body:JSON.stringify({chat_id:'41',text}),policy:{mode:'local'},eventId:'packed-notification',secrets:[],url:receiver.url})
  assert.deepEqual(outcome,{kind:'http',status:200})
  assert.ok(sent.some(row=>row.text===text&&row.parse_mode==='HTML'))
 }
 if(mode==='delivered') {
  assert.equal(await manager.uninstall('open-mercato.telegram'),true)
  assert.equal(service.chats.get(provider).list().grants.length,2)
  assert.ok(service.chats.get(provider).list().receivers.every(row=>row.state==='active'))
 }
 // Keep the durable disable visible while its writer settles, forcing a
 // receive/service call to observe the lifecycle boundary.
 const approve=manager.approve.bind(manager)
 if(barrier!=='none') manager.approve=async record=>{await approve(record);if(!record.enabled)await new Promise(resolve=>setTimeout(resolve,300))}
 await manager.setEnabled('open-mercato.telegram',false)
 manager.approve=approve
 if(mode==='installed') assert.equal(service.chats.has(provider),false)
 assert.equal((await manager.list()).find(row=>row.manifest.id==='open-mercato.telegram').enabled,false)
 if(mode!=='installed') {
  assert.ok(service.telegram.list().receivers.every(row=>row.state==='disabled'))
  assert.ok(service.endpoints.live().filter(row=>row.format==='telegram.v1').every(row=>row.state==='paused'))
  await close();offsets.length=0;await open();await service.startChat()
  assert.equal((await manager.list()).find(row=>row.manifest.id==='open-mercato.telegram').enabled,false)
  assert.equal(service.telegram.list().grants.length,2)
  assert.ok(service.telegram.list().receivers.every(row=>row.state==='disabled'))
  assert.ok(service.endpoints.live().filter(row=>row.format==='telegram.v1').every(row=>row.state==='paused'))
  await assert.rejects(wait(()=>offsets.length>0,'disabled delivery stayed stopped',500),/disabled delivery stayed stopped/)
 }
 offsets.length=0
 if(fault!=='skip-enable') await manager.setEnabled('open-mercato.telegram',true)
 await wait(()=>offsets.includes(resumedOffset+1),'re-enable receive did not resume',fault==='skip-enable'?500:10000)
 assert.ok(offsets.every(offset=>offset>=resumedOffset+1),'re-enable must not rewind the cursor')
 assert.equal(service.chats.get(provider).list().grants.length,2)
 if(mode!=='installed') assert.ok(service.endpoints.live().filter(row=>row.format==='telegram.v1').every(row=>row.state==='active'))
 queue.push(tap(resumedOffset+1))
 await wait(()=>offsets.includes(resumedOffset+2),'re-enable delivery did not advance')
 assert.equal(started.length,2)
 const sentBefore=sent.length
 queue.push({update_id:resumedOffset+2,message:{message_id:20,date:Math.ceil(Date.now()/1000),chat:{id:41,type:'private'},from:{id:41,is_bot:false},text:'/task investigate after re-enable',entities:[{type:'bot_command',offset:0,length:5}]}})
 await wait(()=>sent.slice(sentBefore).some(row=>row.reply_markup?.inline_keyboard?.flat().some(button=>button.text==='Confirm')),'fresh task preview missing after re-enable')
 const fresh=sent.slice(sentBefore).find(row=>row.reply_markup?.inline_keyboard?.flat().some(button=>button.text==='Confirm'))
 const confirm=fresh.reply_markup.inline_keyboard.flat().find(button=>button.text==='Confirm')
 assert.equal(started.length,2,'fresh task still requires confirmation')
 const freshTap=id=>({update_id:id,callback_query:{id:'fresh-'+id,data:confirm.callback_data,from:{id:41,is_bot:false},message:{message_id:fresh.receipt.message_id,chat:{id:41,type:'private'}}}})
 queue.push(freshTap(resumedOffset+3));await wait(()=>started.length===3,'fresh Confirm did not create a task')
 queue.push(freshTap(resumedOffset+4));await wait(()=>offsets.includes(resumedOffset+5))
 assert.equal(started.length,3,'fresh Confirm replay must remain deduplicated')
 assert.match(started[2].options.task,/investigate after re-enable/)
 console.log('PACKED_TELEGRAM_PAIR_RESTART_OK')
} finally {await close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
