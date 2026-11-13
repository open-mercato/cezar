import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createSlackAdapter} from '../dist/adapter.js'
const credentials={appToken:'xapp-'+'A'.repeat(20),botToken:'xoxb-'+'B'.repeat(20)}
const group='group:T1:U1:C1',dm='private:T1:U1:D1'
function adapter(info,members=()=>({members:['U1','U2']})){
 return createSlackAdapter(credentials,async(method,body)=>{
  if(method==='auth.test')return {team_id:'T1',user_id:'U1'}
  if(method==='conversations.info')return {channel:{id:body.channel,...info}}
  if(method==='conversations.members')return members(body)
  throw Error(method)
 })
}
for(const info of [{is_im:false,is_member:false},{is_im:false,is_member:true,is_archived:true}])test('explicit channel denial overrides positive membership '+JSON.stringify(info),async()=>{
 const a=adapter(info);try{assert.equal(await a.isMember(group,'U2'),false)}finally{await a.dispose()}
})
for(const info of [{is_im:false,is_mpim:true},{is_member:true}])test('absent channel evidence remains unknown '+JSON.stringify(info),async()=>{
 const a=adapter(info);try{assert.equal(await a.isMember(group,'U2'),undefined)}finally{await a.dispose()}
})
test('private membership uses the authenticated bot and explicit peer without group enumeration',async()=>{
 const a=adapter({is_im:true,user:'U2'},()=>{throw Error('DM must not enumerate members')})
 try{assert.equal(await a.isMember(dm,'T1:U1'),true);assert.equal(await a.isMember(dm,'U2'),true);assert.equal(await a.isMember(dm,'U3'),false)}finally{await a.dispose()}
 const missing=adapter({is_im:true});try{assert.equal(await missing.isMember(dm,'U2'),undefined)}finally{await missing.dispose()}
})
for(const members of [()=>({members:null}),()=>({members:[],response_metadata:{next_cursor:'more'}}),()=>{throw Error('network')}])test('incomplete membership evidence remains unknown',async()=>{
 const a=adapter({is_im:false,is_member:true},members);try{assert.equal(await a.isMember(group,'U2'),undefined)}finally{await a.dispose()}
})
test('private/group namespace mismatch denies membership',async()=>{
 const a=adapter({is_im:false,is_member:true});try{assert.equal(await a.isMember(dm,'U2'),false)}finally{await a.dispose()}
})
