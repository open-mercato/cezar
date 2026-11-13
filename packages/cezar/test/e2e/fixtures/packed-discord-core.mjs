import assert from 'node:assert/strict'
import {chatSelectionCycle,grantApprovals} from './chat-selection-cycle.mjs'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import {mkdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
const [root,host,plugin,mode,fault]=process.argv.slice(2)
const defaultRuntime=mode==='default'||mode==='default-facade'
const require=createRequire(join(host,'package.json'))
const {WebSocketServer}=require('ws')
const load=path=>import(pathToFileURL(join(host,'dist',path)).href)
const {ExtensionManager}=await load('extensions/manager.js')
const {WebhookService}=await load('webhooks/service.js')
const {WebhookScheduler}=await load('webhooks/scheduler.js')
const {RunStore}=await load('runs/store.js')
const {createChatTask}=await load('server/run-messages.js')
const BOT='222222222222222222',DM='333333333333333333',USER='444444444444444444',MSG='555555555555555555'
const GROUP='666666666666666666',GUILD='777777777777777777',OUTSIDER='888888888888888888'
const sockets=[],ready=[],requests=[],started=[],gatewayEvents=[]
let sequence=1,receipt=0,forcingResume=false,lastDispatchSequence=1,expectedResume
const snowflake=()=>String(((BigInt(Date.now())-1420070400000n)<<22n)+BigInt(++sequence))
const server=createServer(async(req,res)=>{
 const chunks=[];for await(const chunk of req)chunks.push(chunk)
 const raw=Buffer.concat(chunks).toString()
 const body=(raw.startsWith('{')||raw.startsWith('['))?JSON.parse(raw):Object.fromEntries(new URLSearchParams(raw))
 const recorded={method:req.method,path:req.url,body,authorization:req.headers.authorization,status:0};requests.push(recorded)
 let result
 if(req.url==='/api/v10/users/@me')result={id:BOT,username:'cezar',bot:true}
 if(req.url==='/api/v10/gateway/bot')result={url:'wss://gateway.discord.gg/',shards:1,session_start_limit:{remaining:1000,reset_after:1000}}
 if(req.url===`/api/v10/channels/${DM}`)result={id:DM,type:1,recipients:[{id:USER}]}
 if(req.url===`/api/v10/channels/${GROUP}`)result={id:GROUP,type:0,guild_id:GUILD,permission_overwrites:[]}
 if(req.url===`/api/v10/guilds/${GUILD}`)result={id:GUILD,owner_id:USER}
 if(req.url===`/api/v10/guilds/${GUILD}/roles`)result=[{id:GUILD,permissions:'1024'}]
 if(req.url.startsWith(`/api/v10/guilds/${GUILD}/members/`))result={user:{id:req.url.split('/').at(-1)},roles:[]}
 for(const channel of [DM,GROUP]){
  if(req.url===`/api/v10/channels/${channel}/messages`){result={id:snowflake(),channel_id:channel};body.receipt=result.id}
  if(req.url.startsWith(`/api/v10/channels/${channel}/messages/`))result={id:req.url.split('/').at(-1),channel_id:channel}
 }
 if(req.url.startsWith('/api/v10/webhooks/'))result={id:MSG,channel_id:DM}
 if(req.url===`/api/v10/applications/${BOT}/commands`)result=[]
 if(req.url.startsWith('/api/v10/interactions/'))result={}
 if(fault==='skip-replay-ack'&&req.url.includes('/replayed-confirm-token/callback'))result=undefined
 recorded.status=result?200:404
 res.setHeader('content-type','application/json');res.statusCode=recorded.status;res.end(JSON.stringify(result??{ok:false,error:'unexpected_method'}))
})
const gateway=new WebSocketServer({server})
gateway.on('connection',socket=>{
 sockets.push(socket)
 const socketId=sockets.length;gatewayEvents.push({event:'connect',socketId})
 socket.on('close',(code)=>gatewayEvents.push({event:'close',socketId,code}))
 socket.on('message',data=>{const frame=JSON.parse(String(data));if(frame.op===6){gatewayEvents.push({event:'resume',socketId,sequence:frame.d.seq});if(expectedResume){assert.equal(frame.d.seq,expectedResume.sequence,'RESUME must use the last dispatch sequence');assert.notEqual(socketId,expectedResume.socketId,'RESUME must open a new socket');expectedResume=undefined}assert.equal(frame.d.session_id,'session');assert.ok(Number.isSafeInteger(frame.d.seq)&&frame.d.seq>=1);if(!(forcingResume&&fault==='skip-forced-resume')){ready.push(socket);socket.send(JSON.stringify({op:0,s:frame.d.seq,t:'RESUMED',d:{}}))}}if(frame.op===2){gatewayEvents.push({event:'identify',socketId});ready.push(socket);socket.send(JSON.stringify({op:0,s:1,t:'READY',d:{session_id:'session',resume_gateway_url:'wss://gateway.discord.gg/',user:{id:BOT,username:'cezar',bot:true}}}))}if(frame.op===1)socket.send(JSON.stringify({op:11}))})
 socket.send(JSON.stringify({op:10,d:{heartbeat_interval:45000}}))
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const preload=join(root,'simulator.mjs'),port=server.address().port
await writeFile(preload,`import dns from 'node:dns/promises';import tls from 'node:tls';import net from 'node:net';import {syncBuiltinESMExports} from 'node:module';
const allowed=new Set(['discord.com','gateway.discord.gg']);
dns.lookup=async hostname=>{if(!allowed.has(hostname))throw Error('Network denied');return [{address:'8.8.8.8',family:4}]};
tls.connect=(options,callback)=>{if(!allowed.has(options.servername)&&!allowed.has(options.host))throw Error('Network denied');const socket=net.connect({host:'127.0.0.1',port:${port}});socket.authorized=true;socket.encrypted=true;socket.on('connect',()=>{socket.emit('secureConnect');callback?.()});return socket};syncBuiltinESMExports();`)
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
const token='A'.repeat(24)+'.'+'B'.repeat(6)+'.'+'C'.repeat(27)
const credential=mode==='installed'?JSON.stringify({token}):token
const provider=mode==='installed'?'open-mercato.discord/discord':'discord'
const wait=async(check,label)=>{const end=Date.now()+10000;while(!check()){if(Date.now()>end)throw Error(label+' '+JSON.stringify({sockets:sockets.map((socket,index)=>({id:index+1,state:socket.readyState,identified:ready.includes(socket)})),gateway:gatewayEvents.slice(-20),bots:service?.chats.get(provider)?.list().bots.map(bot=>({id:bot.id,health:bot.health})),requests:requests.slice(-12).map(row=>({method:row.method,path:row.path,status:row.status}))}));await new Promise(r=>setTimeout(r,20))}}
let manager,service,store,runtimeOwner
const dataDir=join(project,'.ai/cezar')
async function open(first){
 if(defaultRuntime){runtimeOwner=await (await load('extensions/project-runtime.js')).retainProjectExtensions({root:project,dataDir,projectId:'project'});manager=runtimeOwner.manager}
 else manager=new ExtensionManager(dataDir,'project',project,{home:process.env.CEZ_HOME,workerExecArgv:['--import',preload],...(mode==='facade'?{trustedChatInProcess:true}:{})})
 if(mode!=='installed'&&!defaultRuntime)await manager.declareDeliveredChat('discord')
 service=await WebhookService.open({root:project,dataDir,projectId:'project',mode:'local',serverPorts:()=>[],scheduler:new WebhookScheduler(),...(!defaultRuntime?{chatTransport:()=>{throw Error('Private Discord transport invoked')}}:{})})
 assert.ok(service);store=RunStore.open(dataDir)
 const context={id:'project',root:project,dataDir,store,manager:{startRun(workflow,options){started.push({workflow,options});return store.createRun({id:options.chatSource.runId,title:options.task,task:options.task,workflow:'quick-task',steps:[],chatSource:options.chatSource})}}}
 service.setChatInteractions({context:async()=>context,deliver:async()=>{throw Error('Unexpected reply')},createTask:(project,text,source,check,target)=>createChatTask(project,text,source,check,{providerActionError:async()=>null},target)})
 if(mode==='installed'){if(first){await manager.install(plugin);await manager.setEnabled('open-mercato.discord',true)}else await manager.restore()}else await service.startChat()
}
async function close(){await service?.dispose();service=undefined;if(runtimeOwner)await runtimeOwner.release();else await manager?.close();runtimeOwner=undefined;manager=undefined;store?.flush()}
async function send(type,data){
 await wait(()=>ready.at(-1)?.readyState===1&&service.chats.get(provider).list().bots.every(bot=>bot.health.state==='polling'),'Discord core receiver not ready')
 const frame={op:0,s:++sequence,t:type,d:data};lastDispatchSequence=frame.s;ready.at(-1).send(JSON.stringify(frame));return frame
}
const message=(content,channel=DM)=>send('MESSAGE_CREATE',{id:snowflake(),channel_id:channel,...(channel===GROUP?{guild_id:GUILD}:{}),author:{id:USER,username:'Person'},content,timestamp:new Date().toISOString()})
const previews=()=>requests.filter(row=>row.method==='POST'&&row.path===`/api/v10/channels/${DM}/messages`&&JSON.stringify(row.body.components??'').includes('Confirm'))
function tap(preview){
 const button=preview.body.components.flatMap(row=>row.components).find(button=>button.label==='Confirm');assert.ok(button)
 return {id:snowflake(),application_id:BOT,type:3,token:'confirm-token',channel_id:DM,user:{id:USER,username:'Person'},message:{id:preview.body.receipt,channel_id:DM,author:{id:BOT,bot:true}},data:{custom_id:button.custom_id}}
}
async function startTask(text,count){
 const before=previews().length;await message('/task '+text)
 await wait(()=>previews().length>before,'Discord core Confirm preview missing');assert.equal(started.length,count-1)
 const event=tap(previews().at(-1));await send('INTERACTION_CREATE',event)
 await wait(()=>started.length===count,'Discord Confirm did not create task')
 assert.match(started.at(-1).options.task,new RegExp(text));assert.equal(started.at(-1).options.chatSource.provider,provider)
 return event
}
const code=setup=>new URL(setup.deepLink).searchParams.get('cezar_start')??new URL(setup.deepLink).hash.split('=')[1]
async function autocomplete(user){
 const id=snowflake();await send('INTERACTION_CREATE',{id,application_id:BOT,type:4,token:'query-token',channel_id:DM,user:{id:user,username:'Person'},data:{name:'tasks',options:[{name:'task',focused:true,value:''}]}})
 await wait(()=>requests.some(row=>row.path===`/api/v10/interactions/${id}/query-token/callback`),'Core autocomplete reply missing')
 return requests.find(row=>row.path===`/api/v10/interactions/${id}/query-token/callback`).body
}
try{
 await open(true)
 const inbound=service.chats.get(provider);assert.ok(inbound)
 const begun=await inbound.beginSetup({token:credential,name:'Packed Discord',dedicatedBot:true});assert.ok(code(begun))
 await message('/start '+code(begun));await wait(()=>inbound.setupStatus(begun.setupId).status==='candidate','Discord private candidate missing')
 const status=inbound.setupStatus(begun.setupId)
 await inbound.activateSetup(begun.setupId,{activate:true,expectedRevision:status.inboundRevision,candidateUserId:USER,permissions:['respond','start']})
 assert.equal(inbound.list().grants.length,1)
 if(defaultRuntime)assert.equal(defaultWorkers>0,mode==='default','default selection must use the expected worker/facade path')
 const group=await inbound.beginSetup({token:credential,name:'Packed Discord group',dedicatedBot:true})
 await message(`<@${BOT}> /start ${code(group)}`,GROUP);await wait(()=>inbound.setupStatus(group.setupId).candidate?.chatType==='group','Discord group candidate missing')
 await message('/start '+code(group));await wait(()=>!!inbound.setupStatus(group.setupId).candidate?.comparisonCode,'Discord group private verification missing')
 const verified=inbound.setupStatus(group.setupId)
 await inbound.activateSetup(group.setupId,{activate:true,expectedRevision:verified.inboundRevision,candidateUserId:USER,permissions:['respond'],comparisonVerified:true,groupVisibilityAccepted:true})
 assert.equal(inbound.list().grants.length,2)
 const replay=await startTask('first packed Discord task',1)
 const selectionGrants=structuredClone(grantApprovals(service.chats.get(provider).list().grants))
 const beforeResume=ready.length,resumeEventStart=gatewayEvents.length,checkpoint={sequence:lastDispatchSequence,socketId:sockets.indexOf(ready.at(-1))+1};expectedResume=checkpoint;forcingResume=true;ready.at(-1).send(JSON.stringify({op:7,d:null}))
 await wait(()=>ready.length>beforeResume&&ready.at(-1).readyState===1,'Discord gateway RESUME did not complete')
 assert.ok(gatewayEvents.slice(resumeEventStart).some(event=>event.event==='resume'&&event.socketId!==checkpoint.socketId&&event.sequence===checkpoint.sequence),'forced reconnect must resume this checkpoint')
 const choices=await autocomplete(USER);assert.equal(choices.type,8);assert.ok(choices.data.choices.some(choice=>choice.value===started[0].options.chatSource.runId),'Authorized core task absent')
 assert.deepEqual(await autocomplete(OUTSIDER),{type:8,data:{choices:[]}},'Unpaired user saw tasks')
 const registration=requests.find(row=>row.path===`/api/v10/applications/${BOT}/commands`)
 assert.equal(registration.method,'PUT');assert.deepEqual(registration.body,[{name:'tasks',description:'List this project’s tasks',type:1,options:[{name:'task',description:'Open a task or show its status',type:3,required:false,autocomplete:true}]}])
 const messagesBefore=requests.filter(row=>row.method==='POST'&&row.path===`/api/v10/channels/${DM}/messages`).length
 const native=snowflake();await send('INTERACTION_CREATE',{id:native,application_id:BOT,type:2,token:'slash-token',channel_id:DM,user:{id:USER,username:'Person'},data:{name:'tasks'}})
 try{await wait(()=>requests.some(row=>row.path.includes('/webhooks/')&&row.path.includes('slash-token')),'Native tasks command did not execute')}catch(error){console.error(JSON.stringify({mode,native,health:inbound.list().bots.map(bot=>bot.health),requests:requests.slice(-25)}));throw error}
 await wait(()=>requests.filter(row=>row.method==='POST'&&row.path===`/api/v10/channels/${DM}/messages`).slice(messagesBefore).some(row=>row.body.content.includes(started[0].options.chatSource.runId.slice(0,8))),'Native tasks command did not list core task')
 if(mode==='default')await chatSelectionCycle({manager,plugin,provider,dataDir,fault,fresh:async stage=>{
  const replies=()=>requests.filter(row=>row.method==='POST'&&row.path===`/api/v10/channels/${DM}/messages`)
  const before=replies().length
  await message('/help')
  await wait(()=>replies().length>before,'Fresh Discord response missing after '+stage)
  assert.deepEqual(grantApprovals(service.chats.get(provider).list().grants),selectionGrants)
  assert.equal(service.chats.has('open-mercato.discord/discord'),false)
 }})
 const before=ready.length;await close();await open(false);await wait(()=>ready.length>before,'Discord core restart missing')
 assert.deepEqual(grantApprovals(service.chats.get(provider).list().grants),selectionGrants)
 const repeated={...replay,id:snowflake(),token:'replayed-confirm-token'}
 if(fault!=='skip-replay')await send('INTERACTION_CREATE',repeated)
 await wait(()=>requests.some(row=>row.path===`/api/v10/interactions/${repeated.id}/${repeated.token}/callback`&&row.body.type===6&&row.status===200),'Replayed Discord Confirm not acknowledged')
 // After a type-6 defer @original is the preview itself; the outcome is an ephemeral follow-up to the tapper.
 await wait(()=>requests.some(row=>row.method==='POST'&&row.path===`/api/v10/webhooks/${BOT}/${repeated.token}`&&row.body.flags===64&&/no longer available/.test(row.body.content)),'Replayed Discord Confirm outcome missing')
 assert.equal(started.length,1,'Consumed Confirm started another task')
 await startTask('fresh packed Discord task',2);assert.equal(started.length,2)
 console.log('PACKED_DISCORD_CORE_PAIR_CONFIRM_RESTART_OK')
}finally{await close();for(const socket of sockets)socket.terminate();await new Promise(resolve=>gateway.close(resolve));server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
