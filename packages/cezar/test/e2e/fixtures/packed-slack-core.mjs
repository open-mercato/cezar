import assert from 'node:assert/strict'
import {chatSelectionCycle,grantApprovals} from './chat-selection-cycle.mjs'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import {mkdir,writeFile,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
const [root,host,plugin,mode,credentialMode,fault]=process.argv.slice(2)
const defaultRuntime=mode==='default'||mode==='default-facade'
const require=createRequire(join(host,'package.json'))
const {WebSocketServer}=require('ws')
const load=path=>import(pathToFileURL(join(host,'dist',path)).href)
const {ExtensionManager}=await load('extensions/manager.js')
const {WebhookService}=await load('webhooks/service.js')
const {WebhookScheduler}=await load('webhooks/scheduler.js')
const {RunStore}=await load('runs/store.js')
const {createChatTask}=await load('server/run-messages.js')
const sockets=[],acks=[],requests=[],started=[]
const rotating=credentialMode==='rotation'
let profiledCalls=0
const credentialSlots=[]
if(rotating){
 const {ExtensionHost}=await load('extensions/host.js')
 for(const method of ['chat','receiveSession']){
  const original=ExtensionHost.prototype[method]
  ExtensionHost.prototype[method]=function(id,params,options){
   assert.equal(params.credential,'{}','Raw credential crossed host-to-adapter boundary')
   if(params.operation!=='retire'){assert.equal(params.credentialProfile,'slack-oauth-v1');profiledCalls++}
   for(const secret of ['xoxe-original-app-refresh','xoxe-original-bot-refresh','a'.repeat(32)])assert.ok(!JSON.stringify(params).includes(secret))
   return original.call(this,id,params,{...options,service:async(method,input)=>{if(method==='accessToken')credentialSlots.push(input.slot);return options.service(method,input)}})
  }
 }
}
let sequence=0,receiptSequence=0
const server=createServer(async(req,res)=>{
 const chunks=[];for await(const chunk of req)chunks.push(chunk)
 const raw=Buffer.concat(chunks).toString()
 const body=raw.startsWith('{')?JSON.parse(raw):Object.fromEntries(new URLSearchParams(raw))
 requests.push({path:req.url,body,authorization:req.headers.authorization})
 let result
 if(req.url==='/api/oauth.v2.access'){assert.equal(body.client_secret,'a'.repeat(32));const app=body.refresh_token.includes('app');result={ok:true,token_type:app?'app_level':'bot',access_token:app?'xoxe.xapp-renewed-token':'xoxe.xoxb-renewed-token',refresh_token:app?'xoxe-renewed-app-refresh':'xoxe-renewed-bot-refresh',expires_in:43200}}
 if(req.url==='/api/auth.test')result={ok:true,team_id:'T1',user_id:'U1'}
 if(req.url==='/api/apps.connections.open')result={ok:true,url:'wss://wss-primary.slack.com/link/?ticket=1'}
 if(req.url==='/api/conversations.info')result={ok:true,channel:{id:body.channel,is_im:body.channel==='D1',is_member:true,user:'U2',name:'Packed group'}}
 if(req.url==='/api/conversations.members')result={ok:true,members:['U1','U2']}
 if(req.url==='/api/chat.update')result={ok:true,channel:body.channel}
 if(req.url==='/api/chat.postMessage'){result={ok:true,channel:body.channel,ts:`${Math.floor(Date.now()/1000)}.${String(++receiptSequence).padStart(6,'0')}`};body.receipt=result.ts}
 res.setHeader('content-type','application/json');res.statusCode=result?200:404;res.end(JSON.stringify(result??{ok:false,error:'unexpected_method'}))
})
const gateway=new WebSocketServer({server})
gateway.on('connection',socket=>{sockets.push(socket);socket.on('message',data=>{const value=JSON.parse(String(data));if(value.envelope_id)acks.push(value.envelope_id)});socket.send(JSON.stringify({type:'hello'}))})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const preload=join(root,'simulator.mjs'),port=server.address().port
await writeFile(preload,`import dns from 'node:dns/promises';import tls from 'node:tls';import net from 'node:net';import {syncBuiltinESMExports} from 'node:module';
const allowed=new Set(['slack.com','wss-primary.slack.com']);
dns.lookup=async hostname=>{if(!allowed.has(hostname))throw Error('Network denied');return [{address:'8.8.8.8',family:4}]};
tls.connect=(options,callback)=>{if(!allowed.has(options.servername)&&!allowed.has(options.host))throw Error('Network denied');const socket=net.connect({host:'127.0.0.1',port:${port}});socket.authorized=true;socket.encrypted=true;socket.on('connect',()=>{socket.emit('secureConnect');callback?.()});return socket};syncBuiltinESMExports();`)
if(rotating){
 const originalFetch=globalThis.fetch
 globalThis.fetch=(input,init)=>{assert.equal(String(input),'https://slack.com/api/oauth.v2.access','Unexpected host fetch');return originalFetch(`http://127.0.0.1:${port}/api/oauth.v2.access`,init)}
}
if(mode==='facade'||mode==='default-facade')await import(pathToFileURL(preload).href)
let defaultWorkers=0
if(defaultRuntime){
 const child=(await import('node:child_process')).default,spawn=child.spawn
 child.spawn=function(command,args,options){
  if(command===process.execPath&&args?.includes('--input-type=module')){defaultWorkers++;args=['--import',preload,...args]}
  return spawn.call(this,command,args,options)
 };(await import('node:module')).syncBuiltinESMExports()
}
const project=join(root,'project');await mkdir(project);execFileSync('git',['init','-q'],{cwd:project,timeout:5000})
const credential=JSON.stringify(rotating?{appToken:'xoxe.xapp-original-token',botToken:'xoxe.xoxb-original-token',appRefreshToken:'xoxe-original-app-refresh',botRefreshToken:'xoxe-original-bot-refresh',clientId:'123.456',clientSecret:'a'.repeat(32)}:{appToken:'xapp-1-A111-111-aaaaaaaaaaaa',botToken:'xoxb-111-222-aaaaaaaaaaaa'})
const provider=mode==='installed'?'open-mercato.slack/slack':'slack'
const wait=async(check,label,timeout=10000)=>{const end=Date.now()+timeout;while(!check()){if(Date.now()>end)throw Error(label);await new Promise(r=>setTimeout(r,20))}}
let manager,service,store,runtimeOwner
const dataDir=join(project,'.ai/cezar')
async function open(first){
 if(defaultRuntime){runtimeOwner=await (await load('extensions/project-runtime.js')).retainProjectExtensions({root:project,dataDir,projectId:'project'});manager=runtimeOwner.manager}
 else manager=new ExtensionManager(dataDir,'project',project,{home:process.env.CEZ_HOME,workerExecArgv:['--import',preload],...(mode==='facade'?{trustedChatInProcess:true}:{})})
 if(mode!=='installed'&&!defaultRuntime)await manager.declareDeliveredChat('slack')
 service=await WebhookService.open({root:project,dataDir,projectId:'project',mode:'local',serverPorts:()=>[],scheduler:new WebhookScheduler(),...(!defaultRuntime?{slackWire:()=>{throw Error('Private Slack wire invoked')},chatTransport:()=>{throw Error('Private Slack transport invoked')}}:{})})
 assert.ok(service);store=RunStore.open(dataDir)
 const context={id:'project',root:project,dataDir,store,manager:{startRun(workflow,options){started.push({workflow,options});return {id:options.chatSource.runId}}}}
 service.setChatInteractions({context:async()=>context,deliver:async()=>{throw Error('Unexpected reply')},createTask:(project,text,source,check,target)=>createChatTask(project,text,source,check,{providerActionError:async()=>null},target)})
 if(mode==='installed'){if(first){await manager.install(plugin);await manager.setEnabled('open-mercato.slack',true)}else await manager.restore()}else await service.startChat()
}
async function close(){await service?.dispose();service=undefined;if(runtimeOwner)await runtimeOwner.release();else await manager?.close();runtimeOwner=undefined;manager=undefined;store?.flush()}
const stamp=()=>{const now=Date.now();return `${Math.floor(now/1000)}.${String(now%1000).padStart(3,'0')}${String(++sequence%1000).padStart(3,'0')}`}
async function message(text,channel='D1'){
 await wait(()=>sockets.at(-1)?.readyState===1&&service.chats.get(provider).list().bots.every(bot=>bot.health.state==='polling'),'Current Slack receiver not polling')
 const timestamp=stamp(),envelope={envelope_id:'envelope-'+sequence,type:'events_api',payload:{team_id:'T1',event_id:'Ev'+sequence,authorizations:[{user_id:'U1',is_bot:true}],event:{type:'message',user:'U2',channel,channel_type:channel==='D1'?'im':'channel',ts:timestamp,text}}}
 sockets.at(-1).send(JSON.stringify(envelope));await wait(()=>acks.includes(envelope.envelope_id),'Slack core command not acknowledged');return envelope
}
const confirmations=()=>requests.filter(row=>row.path==='/api/chat.postMessage').map(row=>row.body).filter(body=>JSON.stringify(body.blocks??'').includes('Confirm'))
function tap(preview){
 const blocks=typeof preview.blocks==='string'?JSON.parse(preview.blocks):preview.blocks
 const button=blocks.flatMap(block=>block.elements??[]).find(button=>button.text?.text==='Confirm');assert.ok(button)
 return {envelope_id:'tap-'+(++sequence),type:'interactive',payload:{type:'block_actions',team:{id:'T1'},user:{id:'U2'},message:{user:'U1'},container:{channel_id:'D1',message_ts:preview.receipt},actions:[{action_id:button.action_id,value:button.value,action_ts:stamp()}]}}
}
async function startTask(text,count){
 const before=confirmations().length;await message('/task '+text)
 await wait(()=>confirmations().length>before,'Slack core Confirm preview missing')
 assert.equal(started.length,count-1)
 const event=tap(confirmations().at(-1));sockets.at(-1).send(JSON.stringify(event))
 await wait(()=>started.length===count,'Slack Confirm did not create task')
 assert.match(started.at(-1).options.task,new RegExp(text))
 assert.equal(started.at(-1).options.chatSource.provider,provider)
 return event
}
try{
 await open(true)
 const inbound=service.chats.get(provider);assert.ok(inbound)
 const begun=await inbound.beginSetup({token:credential,name:'Packed Slack',dedicatedBot:true})
 const code=new URL(begun.deepLink).searchParams.get('cezar_start');assert.ok(code)
 await wait(()=>sockets.length>0,'Slack pairing socket missing');await message('/start '+code)
 try{await wait(()=>inbound.setupStatus(begun.setupId).status==='candidate','Slack pairing candidate missing')}catch(error){console.error(JSON.stringify({status:inbound.setupStatus(begun.setupId),health:inbound.list().bots.map(bot=>bot.health),acks,requests}));throw error}
 const status=inbound.setupStatus(begun.setupId)
 await inbound.activateSetup(begun.setupId,{activate:true,expectedRevision:status.inboundRevision,candidateUserId:'U2',permissions:['respond','start']})
 assert.equal(inbound.list().grants.length,1)
 if(defaultRuntime)assert.equal(defaultWorkers>0,mode==='default','default selection must use the expected worker/facade path')
 const group=await inbound.beginSetup({token:credential,name:'Packed Slack group',dedicatedBot:true})
 const groupCode=new URL(group.deepLink).searchParams.get('cezar_start');assert.ok(groupCode)
 await message('<@U1> /start '+groupCode,'C1')
 try{await wait(()=>inbound.setupStatus(group.setupId).candidate?.chatType==='group','Slack group candidate missing')}catch(error){console.error(JSON.stringify({status:inbound.setupStatus(group.setupId),health:inbound.list().bots.map(bot=>bot.health),sockets:sockets.map(s=>s.readyState),acks,requests}));throw error}
 await message('/start '+groupCode)
 await wait(()=>!!inbound.setupStatus(group.setupId).candidate?.comparisonCode,'Slack group private verification missing')
 const verified=inbound.setupStatus(group.setupId)
 await inbound.activateSetup(group.setupId,{activate:true,expectedRevision:verified.inboundRevision,candidateUserId:'U2',permissions:['respond'],comparisonVerified:true,groupVisibilityAccepted:true})
 assert.equal(inbound.list().grants.length,2)
 const replay=await startTask('first packed Slack task',1)
 const selectionGrants=structuredClone(grantApprovals(service.chats.get(provider).list().grants))
 if(mode==='default'&&!rotating)await chatSelectionCycle({manager,plugin,provider,dataDir,fault,fresh:async stage=>{
  const before=requests.filter(row=>row.path==='/api/chat.postMessage').length
  await message('/help')
  await wait(()=>requests.filter(row=>row.path==='/api/chat.postMessage').length>before,'Fresh Slack response missing after '+stage)
  assert.deepEqual(grantApprovals(service.chats.get(provider).list().grants),selectionGrants)
  assert.equal(service.chats.has('open-mercato.slack/slack'),false)
 }})
 const socketsBefore=sockets.length;await close();await open(false)
 await wait(()=>sockets.length>socketsBefore,'Slack core restart socket missing')
 assert.deepEqual(grantApprovals(service.chats.get(provider).list().grants),selectionGrants)
 const repeated={...replay,envelope_id:'replay-'+(++sequence),payload:{...replay.payload,actions:replay.payload.actions.map(action=>({...action,action_ts:stamp()}))}}
 sockets.at(-1).send(JSON.stringify(repeated))
 await wait(()=>acks.includes(repeated.envelope_id),'Replayed Slack Confirm not acknowledged')
 await startTask('fresh packed Slack task',2)
 assert.equal(started.length,2,'Replayed Confirm created an extra task')
 if(rotating){
  assert.ok(profiledCalls>0,'No public credential-profile calls observed')
  const before=credentialSlots.length
  await wait(()=>credentialSlots.slice(before).includes('app')&&credentialSlots.slice(before).includes('bot'),'Idle session did not renew both credential slots',35000)
  const exchanges=requests.filter(row=>row.path==='/api/oauth.v2.access');assert.equal(exchanges.length,2,'Restart must reuse persisted rotating credentials')
  assert.deepEqual(new Set(exchanges.map(row=>row.body.refresh_token)),new Set(['xoxe-original-app-refresh','xoxe-original-bot-refresh']))
  const disk=await readFile(join(process.env.CEZ_HOME,'secrets/project.json'),'utf8')
  for(const secret of ['xoxe-','xoxe.','a'.repeat(32)])assert.ok(!disk.includes(secret),'Rotation secret stored in plaintext')
  for(const row of requests.filter(row=>row.path!=='/api/oauth.v2.access'))assert.ok(!JSON.stringify(row.body).includes('refresh_token')&&!JSON.stringify(row.body).includes('client_secret'),'Worker request contains renewal credentials')
  assert.ok(requests.some(row=>row.authorization==='Bearer xoxe.xapp-renewed-token'))
  assert.ok(requests.some(row=>row.authorization==='Bearer xoxe.xoxb-renewed-token'))
 }
 console.log('PACKED_SLACK_CORE_PAIR_CONFIRM_RESTART_OK')
}finally{await close();for(const socket of sockets)socket.terminate();await new Promise(resolve=>gateway.close(resolve));server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
