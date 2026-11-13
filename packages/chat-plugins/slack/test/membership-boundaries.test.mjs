import assert from 'node:assert/strict'
import { test } from 'node:test'
import {createSlackAdapter} from '../dist/adapter.js'
import {ExtensionChatError} from '@open-mercato/cezar-extension-sdk/chat'
const creds={appToken:'xapp-'+'A'.repeat(20),botToken:'xoxb-'+'B'.repeat(20)}
function fixture(pages,info={is_im:false,is_member:true}) {let calls=0; const a=createSlackAdapter(creds,async(m,b,op)=>{if(m==='auth.test')return {team_id:'T1',user_id:'U1'};if(m==='conversations.info')return {channel:{id:b.channel,...info}};if(m==='conversations.members')return pages(++calls,b,op);throw Error(m)});return {a,count:()=>calls}}
for(const target of [21,100])test('finds member on page '+target,async()=>{const f=fixture(n=>({members:n===target?['U2']:[],response_metadata:{next_cursor:'p'+n}}));try{assert.equal(await f.a.isMember('group:T1:U1:C1','U2'),true);assert.equal(f.count(),target)}finally{await f.a.dispose()}})
test('exact100 cap returns unknown',async()=>{const f=fixture(()=>({members:[],response_metadata:{next_cursor:'more'}}));try{assert.equal(await f.a.isMember('group:T1:U1:C1','U2'),undefined);assert.equal(f.count(),100)}finally{await f.a.dispose()}})
for(const kind of ['gone','auth','blocked','transient','rate_limited'])test('later page '+kind,async()=>{const f=fixture(n=>{if(n===1)return {members:[],response_metadata:{next_cursor:'more'}};throw new ExtensionChatError({kind})});try{assert.equal(await f.a.isMember('group:T1:U1:C1','U2'),kind==='gone'?false:undefined)}finally{await f.a.dispose()}})
test('abort rejection escapes unknown catch',async()=>{const c=new AbortController(),error=new Error('cancelled');const f=fixture(()=>{c.abort();throw error});try{await assert.rejects(f.a.isMember('group:T1:U1:C1','U2',{signal:c.signal,assertActive:async()=>{}}),e=>e===error)}finally{await f.a.dispose()}})
for(const metadata of [null,{next_cursor:1}])test('malformed cursor stays unknown '+JSON.stringify(metadata),async()=>{const f=fixture(()=>({members:[],response_metadata:metadata}));try{assert.equal(await f.a.isMember('group:T1:U1:C1','U2'),undefined)}finally{await f.a.dispose()}})
