import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import {mkdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
const [root,host,plugin,mode]=process.argv.slice(2)
const require=createRequire(join(host,'package.json'))
const {WebSocketServer}=require('ws')
const load=path=>import(pathToFileURL(join(host,'dist',path)).href)
const {ExtensionManager}=await load('extensions/manager.js')
const {chatTransport}=await load('chat/registry.js')
const BOT='222222222222222222',DM='333333333333333333',USER='444444444444444444',MSG='555555555555555555'
const sockets=[],ready=[],requests=[],queries=[]
const server=createServer(async(req,res)=>{
 const chunks=[];for await(const chunk of req)chunks.push(chunk)
 const raw=Buffer.concat(chunks).toString()
 const body=raw.startsWith('{')?JSON.parse(raw):Object.fromEntries(new URLSearchParams(raw))
 requests.push({path:req.url,body,authorization:req.headers.authorization})
 let result
 if(req.url==='/api/v10/users/@me')result={id:BOT,username:'cezar',bot:true}
 if(req.url==='/api/v10/gateway/bot')result={url:'wss://gateway.discord.gg/',shards:1,session_start_limit:{remaining:1000,reset_after:1000}}
 if(req.url===`/api/v10/channels/${DM}`)result={id:DM,type:1,recipients:[{id:USER}]}
 if(req.url===`/api/v10/channels/${DM}/messages`)result={id:MSG,channel_id:DM}
 if(req.url===`/api/v10/applications/${BOT}/commands`)result=[]
 if(req.url.startsWith('/api/v10/interactions/'))result={}
 res.setHeader('content-type','application/json');res.statusCode=result?200:404;res.end(JSON.stringify(result??{ok:false,error:'unexpected_method'}))
})
const gateway=new WebSocketServer({server})
gateway.on('connection',socket=>{
 sockets.push(socket)
 socket.on('message',data=>{const frame=JSON.parse(String(data));if(frame.op===2){ready.push(socket);socket.send(JSON.stringify({op:0,s:1,t:'READY',d:{session_id:'session',resume_gateway_url:'wss://gateway.discord.gg/',user:{id:BOT,username:'cezar',bot:true}}}))}if(frame.op===1)socket.send(JSON.stringify({op:11}))})
 socket.send(JSON.stringify({op:10,d:{heartbeat_interval:45000}}))
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const preload=join(root,'simulator.mjs'),port=server.address().port
await writeFile(preload,`import dns from 'node:dns/promises';import tls from 'node:tls';import net from 'node:net';import {syncBuiltinESMExports} from 'node:module';
const allowed=new Set(['discord.com','gateway.discord.gg']);
dns.lookup=async hostname=>{if(!allowed.has(hostname))throw Error('Network denied');return [{address:'8.8.8.8',family:4}]};
tls.connect=(options,callback)=>{if(!allowed.has(options.servername)&&!allowed.has(options.host))throw Error('Network denied');const socket=net.connect({host:'127.0.0.1',port:${port}});socket.authorized=true;socket.encrypted=true;socket.on('connect',()=>{socket.emit('secureConnect');callback?.()});return socket};syncBuiltinESMExports();`)
if(mode==='facade')await import(pathToFileURL(preload).href)
const project=join(root,'project');await mkdir(project)
const token='A'.repeat(24)+'.'+'B'.repeat(6)+'.'+'C'.repeat(27)
const credential=mode==='installed'?JSON.stringify({token}):token
const provider=mode==='installed'?'open-mercato.discord/discord':'discord'
const wait=async(check,label)=>{const end=Date.now()+10000;while(!check()){if(Date.now()>end)throw Error(label);await new Promise(r=>setTimeout(r,20))}}
let manager,connection,releaseChoice
const accepted=[],health=[],binding={id:randomUUID(),revision:'1'},epoch=randomUUID()
async function open(first){
 manager=new ExtensionManager(join(project,'.ai/cezar'),'project',project,{home:process.env.CEZ_HOME,workerExecArgv:['--import',preload],...(mode==='facade'?{trustedChatInProcess:true}:{})})
 if(mode==='installed'){if(first){await manager.install(plugin);await manager.setEnabled('open-mercato.discord',true)}else await manager.restore()}
 else await manager.startDeliveredChat('discord')
 const transport=chatTransport(project,provider,credential,()=>true,binding);assert.ok(transport)
 assert.equal((await transport.identify()).id,BOT)
 connection=transport.connect({recover:async()=>{},flush:async()=>{},snapshot:()=>({epoch,nextOffset:null})}, {accept:async event=>{accepted.push(event)},process:async()=>{throw Error('Unexpected ordered event')},needed:()=>true,assertCredentials:async()=>{},onHealth:value=>health.push(value),nativeCommands:{tasks:async(...args)=>{queries.push(args);if(args[0]==='hold')await new Promise(resolve=>{releaseChoice=resolve});return [{name:'Fixture task',value:'run-fixture'}]}}})
 connection.start()
 return transport
}
const snowflake=()=>String((BigInt(Date.now())-1420070400000n)<<22n)
const envelope=n=>({op:0,s:2,t:'MESSAGE_CREATE',d:{id:snowflake(),channel_id:DM,author:{id:USER,username:'Person'},content:'hello '+n,timestamp:new Date().toISOString()}})

try{
 for(let generation=1;generation<=2;generation++){
  const before=ready.length,transport=await open(generation===1)
  await wait(()=>ready.length>before,'fresh Discord receive session missing')
  const socket=ready.at(-1);socket.send(JSON.stringify(envelope(generation)))
  try{await wait(()=>accepted.length===generation,'Discord event not admitted')}catch(error){console.error(JSON.stringify({generation,accepted,health,requests}));throw error}
  socket.send(JSON.stringify({op:0,s:3,t:'INTERACTION_CREATE',d:{id:snowflake(),application_id:BOT,type:4,token:'fixture-token',channel_id:DM,user:{id:USER,username:'Person'},data:{name:'tasks',options:[{name:'task',focused:true,value:'Fixture'}]}}}))
  await wait(()=>requests.filter(row=>row.path.startsWith('/api/v10/interactions/')).length===generation,'Discord autocomplete reply missing')
  assert.deepEqual(queries.at(-1),['Fixture',`discord:dm:${DM}`,USER])
  assert.deepEqual(requests.filter(row=>row.path.startsWith('/api/v10/interactions/')).at(-1).body,{type:8,data:{choices:[{name:'Fixture task',value:'run-fixture'}]}})
  assert.equal(requests.filter(row=>row.path===`/api/v10/applications/${BOT}/commands`).length,generation)

  assert.equal(accepted.at(-1).text,'hello '+generation)
  assert.deepEqual(await transport.send(`discord:dm:${DM}`,{text:'safe <&> @everyone'}),{chatId:`discord:dm:${DM}`,messageId:MSG})
  const posted=requests.filter(row=>row.path===`/api/v10/channels/${DM}/messages`).at(-1).body
  assert.deepEqual(posted.allowed_mentions,{parse:[],replied_user:false});assert.equal(posted.content,'safe <&> @everyone')
  releaseChoice=undefined
  socket.send(JSON.stringify({op:0,s:4,t:'INTERACTION_CREATE',d:{id:snowflake(),application_id:BOT,type:4,token:'held-fixture-token',channel_id:DM,user:{id:USER,username:'Person'},data:{name:'tasks',options:[{name:'task',focused:true,value:'hold'}]}}}))
  await wait(()=>!!releaseChoice,'Held host task query did not begin')
  const stopping=connection.stop();releaseChoice();await stopping;connection=undefined
  assert.equal(requests.filter(row=>row.path.startsWith('/api/v10/interactions/')).length,generation,'Retired session sent a stale autocomplete response')
  await manager.close();manager=undefined
 }
 console.log('PACKED_DISCORD_RECEIVE_NATIVE_RESTART_OK')
}finally{releaseChoice?.();await connection?.stop();await manager?.close();for(const socket of sockets)socket.terminate();await new Promise(resolve=>gateway.close(resolve));server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
