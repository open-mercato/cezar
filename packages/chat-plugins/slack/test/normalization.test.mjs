import assert from 'node:assert/strict'
import {test} from 'node:test'
import {EventEmitter} from 'node:events'
import {createHash} from 'node:crypto'
import {createSlackReceiver} from '../dist/adapter.js'
const credentials={appToken:'xapp-'+'A'.repeat(20),botToken:'xoxb-'+'B'.repeat(20)}
async function fixture(run){
 let socket
 const a=createSlackReceiver(credentials,async(method,body)=>{
  if(method==='auth.test')return {team_id:'T1',user_id:'U1'}
  if(method==='apps.connections.open')return {url:'wss://slack.com/socket'}
  if(method==='conversations.info')return {channel:{id:body.channel,is_im:false,is_member:true}}
  throw Error(method)
 },{lookup:async()=>[{address:'8.8.8.8',family:4}],socket:()=>{socket=new EventEmitter();socket.readyState=1;socket.send=()=>{};socket.terminate=()=>socket.emit('close');queueMicrotask(()=>socket.emit('open'));return socket}})
 const receive=async envelope=>{const pending=a.receive(null);await new Promise(resolve=>setImmediate(resolve));socket.emit('message',Buffer.from(JSON.stringify(envelope)));return (await pending)[0]?.event}
 try{await run(receive)}finally{await a.dispose()}
}
const envelope=event=>({envelope_id:'event',type:'events_api',payload:{team_id:'T1',event_id:'Ev1',event_time:Math.floor(Date.now()/1000),authorizations:[{user_id:'U1',is_bot:true}],event:{type:'message',channel:'C1',user:'U2',ts:`${Math.floor(Date.now()/1000)}.000001`,...event}}})
test('legacy text commands normalize after mention and entity decoding',()=>fixture(async receive=>{
 assert.equal((await receive(envelope({text:'<@U1> CeZaR task fix &lt;value&gt;'}))).text,'/task fix <value>')
}))
test('slash retries retain the native trigger identity and unsupported commands remain help',()=>fixture(async receive=>{
 const slash={envelope_id:'first',type:'slash_commands',payload:{team_id:'T1',user_id:'U2',channel_id:'C1',command:'/cezar',text:'tasks',trigger_id:'trigger'}}
 const first=await receive(slash),retry=await receive({...slash,envelope_id:'retry'})
 assert.equal(first.id,'slash:'+createHash('sha256').update('T1:trigger').digest('hex'))
 assert.equal(retry.id,first.id)
 assert.equal((await receive({...slash,payload:{...slash.payload,text:'task forbidden'}})).text,'/help')
 for(const patch of [{user_id:undefined},{user_id:'bad id'},{trigger_id:undefined}])assert.equal(await receive({...slash,payload:{...slash.payload,...patch}}),undefined)
}))
test('old or undated member removal is not fresh evidence',()=>fixture(async receive=>{
 const removal=envelope({type:'member_left_channel',user:'U1'})
 assert.equal((await receive(removal)).kind,'membership')
 for(const event_time of [undefined,Math.floor(Date.now()/1000)-901,Math.floor(Date.now()/1000)+61])assert.equal(await receive({...removal,payload:{...removal.payload,event_time}}),undefined)
}))
test('unrelated event types and self-thread timestamps do not create messages or reply targets',()=>fixture(async receive=>{
 assert.equal(await receive(envelope({type:'reaction_added',text:'<@U1> hello'})),undefined)
 const row=envelope({text:'<@U1> hello'});row.payload.event.thread_ts=row.payload.event.ts
 assert.equal((await receive(row)).replyTo,undefined)
}))
test('a member removal without event_id keeps one id when it is normalized again later',t=>fixture(async receive=>{
 const removal=envelope({type:'member_left_channel',user:'U1'});delete removal.payload.event_id
 const first=await receive(removal),start=Date.now()
 t.mock.method(Date,'now',()=>start+30_000)
 assert.equal((await receive(removal)).id,first.id)
}))
