import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSlackAdapter,slackRequest} from '../dist/adapter.js';
const creds={appToken:'xapp-'+ 'A'.repeat(20),botToken:'xoxb-'+ 'B'.repeat(20)};
const chat='group:T1:U1:C1';
const actions={send:(a,op,d=chat)=>a.send(d,{text:'<&>',buttons:[[{text:'Go',data:'go'}]]},op),clearButtons:(a,op,d=chat)=>a.clearButtons({chatId:d,messageId:'1800000000.000001'},op),isMember:(a,op,d=chat)=>a.isMember(d,'U2',op)};
for(const [name,action] of Object.entries(actions)){
 test('fresh '+name+' lazily identifies and caches identity',async()=>{
  const calls=[];const op={signal:new AbortController().signal,assertActive:async()=>{}};
  const a=createSlackAdapter(creds,async(method,body,ctx)=>{assert.equal(ctx,op);calls.push(method);if(method==='auth.test')return {team_id:'T1',user_id:'U1'};if(method==='conversations.info')return {channel:{id:'C1',is_im:false,is_member:true}};if(method==='conversations.history')return {messages:[{ts:'1800000000.000001',user:'U1',text:'Earlier'}]};if(method==='conversations.members')return {members:['U2']};return {channel:'C1',ts:'1800000000.000001'}});
  try{await action(a,op);await action(a,op);assert.equal(calls[0],'auth.test');assert.equal(calls.filter(x=>x==='auth.test').length,1);assert.ok(calls.includes(name==='send'?'chat.postMessage':name==='clearButtons'?'chat.update':'conversations.members'));}finally{await a.dispose()}
 });
 test('fresh '+name+' refuses mismatched bot/team before side effects',async()=>{
  for(const destination of ['group:T9:U1:C1','group:T1:U9:C1']){const calls=[];const a=createSlackAdapter(creds,async method=>{calls.push(method);return {team_id:'T1',user_id:'U1'}});try{await name==='isMember'?assert.equal(await action(a,{signal:new AbortController().signal,assertActive:async()=>{}},destination),undefined):await assert.rejects(action(a,{signal:new AbortController().signal,assertActive:async()=>{}},destination),/blocked/);assert.deepEqual(calls,['auth.test']);}finally{await a.dispose()}}
 });
 test('fresh '+name+' cancellation during identification cannot send',async()=>{
  const c=new AbortController();let lookupStarted;const entered=new Promise(r=>lookupStarted=r);let dialed=0;
  const req=slackRequest(creds,{lookup:async()=>{lookupStarted();return new Promise(()=>{})},request:async()=>{dialed++;throw Error('unexpected wire')}});
  const a=createSlackAdapter(creds,req);try{const pending=action(a,{signal:c.signal,assertActive:async()=>{c.signal.throwIfAborted()}});await entered;c.abort();await assert.rejects(pending,/blocked/);assert.equal(dialed,0)}finally{await a.dispose()}
 });
}

test('group bot membership resolves only the authenticated composite identity',async()=>{
 const calls=[];
 const a=createSlackAdapter(creds,async method=>{calls.push(method);if(method==='auth.test')return {team_id:'T1',user_id:'U1'};if(method==='conversations.info')return {channel:{id:'C1',is_im:false,is_member:true}};if(method==='conversations.members')return {members:['U1','U2']};throw Error(method)});
 try{
  assert.equal(await a.isMember(chat,'T1:U1'),true);
  assert.equal(await a.isMember(chat,'U2'),true);
  const before=calls.length;
  for(const identity of ['T9:U1','T1:U9','T1:U2'])assert.equal(await a.isMember(chat,identity),false);
  assert.equal(calls.length,before,'Foreign composite identity must not query membership');
 }finally{await a.dispose()}
});
