import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createSlackReceiver} from '../dist/adapter.js'
for(const failure of [false,true])test('idle receive renews both scoped credentials and propagates failure '+failure,async t=>{
 const controller=new AbortController(),calls=[];let now=0,rounds=0
 t.mock.method(Date,'now',()=>now)
 const a=createSlackReceiver({},async()=>{throw Error('Unexpected wire')},{},{credentials:{accessToken:async(slot,op)=>{assert.equal(op.signal,controller.signal);calls.push(slot);if(failure)throw Error('renewal unavailable');return 'fixture-token'}}})
 a.receive=async()=>{now+=24000;return []}
 const session={signal:controller.signal,assertActive:async()=>controller.signal.throwIfAborted(),accept:async()=>{throw Error('Unexpected delivery')},health:async()=>{if(++rounds===2)controller.abort()}}
 try{
  if(failure)await assert.rejects(a.receiveSession(session),/renewal unavailable/)
  else await a.receiveSession(session)
  assert.deepEqual(calls,failure?['app']:['app','bot','app','bot'])
 }finally{await a.dispose()}
})
