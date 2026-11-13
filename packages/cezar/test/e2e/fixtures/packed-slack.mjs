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
const sockets=[],acks=[],requests=[]
const server=createServer(async(req,res)=>{
 const chunks=[];for await(const chunk of req)chunks.push(chunk)
 const raw=Buffer.concat(chunks).toString()
 const body=raw.startsWith('{')?JSON.parse(raw):Object.fromEntries(new URLSearchParams(raw))
 requests.push({path:req.url,body,authorization:req.headers.authorization})
 let result
 if(req.url==='/api/auth.test')result={ok:true,team_id:'T1',user_id:'U1'}
 if(req.url==='/api/apps.connections.open')result={ok:true,url:'wss://wss-primary.slack.com/link/?ticket=1'}
 if(req.url==='/api/conversations.info')result={ok:true,channel:{id:'D1',is_im:true,user:'U2'}}
 if(req.url==='/api/chat.postMessage')result={ok:true,channel:'D1',ts:'1800000000.000009'}
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
if(mode==='facade')await import(pathToFileURL(preload).href)
const project=join(root,'project');await mkdir(project)
const credential=JSON.stringify({appToken:'xapp-1-A111-111-aaaaaaaaaaaa',botToken:'xoxb-111-222-aaaaaaaaaaaa'})
const provider=mode==='installed'?'open-mercato.slack/slack':'slack'
const wait=async(check,label)=>{const end=Date.now()+10000;while(!check()){if(Date.now()>end)throw Error(label);await new Promise(r=>setTimeout(r,20))}}
let manager,connection
const accepted=[],health=[],binding={id:randomUUID(),revision:'1'},epoch=randomUUID()
async function open(first){
 manager=new ExtensionManager(join(project,'.ai/cezar'),'project',project,{home:process.env.CEZ_HOME,workerExecArgv:['--import',preload],...(mode==='facade'?{trustedChatInProcess:true}:{})})
 if(mode==='installed'){if(first){await manager.install(plugin);await manager.setEnabled('open-mercato.slack',true)}else await manager.restore()}
 else await manager.startDeliveredChat('slack')
 const transport=chatTransport(project,provider,credential,()=>true,binding);assert.ok(transport)
 assert.equal((await transport.identify()).id,'T1:U1')
 connection=transport.connect({recover:async()=>{},flush:async()=>{},snapshot:()=>({epoch,nextOffset:null})}, {accept:async event=>{accepted.push(event)},process:async()=>{throw Error('Unexpected ordered event')},needed:()=>true,assertCredentials:async()=>{},onHealth:value=>health.push(value)})
 connection.start()
 return transport
}
const envelope=n=>({envelope_id:'envelope-'+n,type:'events_api',payload:{team_id:'T1',event_id:'Ev'+n,authorizations:[{user_id:'U1',is_bot:true}],event:{type:'message',user:'U2',channel:'D1',channel_type:'im',ts:`${Math.floor(Date.now()/1000)}.${String(n).padStart(6,'0')}`,text:'hello '+n}}})
try{
 for(let generation=1;generation<=2;generation++){
  const before=sockets.length,transport=await open(generation===1)
  await wait(()=>sockets.length>before,'fresh Slack receive session missing')
  const socket=sockets.at(-1);socket.send(JSON.stringify(envelope(generation)))
  try{await wait(()=>accepted.length===generation,'Slack event not admitted')}catch(error){console.error(JSON.stringify({generation,accepted,acks,health,requests}));throw error}
  await wait(()=>acks.includes('envelope-'+generation),'Slack envelope not acknowledged')
  assert.equal(accepted.at(-1).text,'hello '+generation)
  assert.deepEqual(await transport.send('private:T1:U1:D1',{text:mode==='installed'?'safe <&> @everyone':'safe &lt;&amp;&gt; @everyone'}),{chatId:'private:T1:U1:D1',messageId:'1800000000.000009'})
  const posted=requests.filter(row=>row.path==='/api/chat.postMessage').at(-1).body
  assert.equal(posted.text,'safe &lt;&amp;&gt; @everyone')
  assert.equal(String(posted.link_names),'false');assert.equal(posted.parse,'none')
  await connection.stop();connection=undefined;await manager.close();manager=undefined
 }
 assert.ok(requests.filter(row=>row.path==='/api/auth.test').every(row=>row.authorization==='Bearer xoxb-111-222-aaaaaaaaaaaa'))
 console.log('PACKED_SLACK_RECEIVE_RESTART_OK')
}finally{await connection?.stop();await manager?.close();for(const socket of sockets)socket.terminate();await new Promise(resolve=>gateway.close(resolve));server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
