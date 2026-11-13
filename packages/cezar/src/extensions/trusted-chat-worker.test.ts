import { expect, it } from 'vitest';
import { trustedChatWorker } from './trusted-chat-worker.ts';
it('rejects unverified in-process code before activation or host stdio changes', () => {
  const write = process.stdout.write, log = console.log;
  expect(() => trustedChatWorker({ provider:'telegram', extensionId:'open-mercato.telegram', entry:'/tmp/arbitrary.mjs' } as never,
    {onFrame() {throw Error('must not run')}, onExit() {throw Error('must not run')}})).toThrow('verified shipped artifact');
  expect(process.stdout.write).toBe(write); expect(console.log).toBe(log);
});

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach } from 'vitest';
import { loadChatDeliveryCatalog } from './delivery-catalog.ts';
import { artifactIntegrity } from './installer.ts';
const roots: string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(source:string) {
 const root=await mkdtemp(join(tmpdir(),'trusted-lifecycle-'));roots.push(root);
 const directory=join(root,'dist/chat-plugins'),stamps=[];
 for(const provider of ['telegram','slack','discord']) {
  const target=join(directory,provider);await mkdir(join(target,'dist'),{recursive:true});
  const manifest=JSON.parse(await readFile(new URL(`../../../chat-plugins/${provider}/cezar-extension.json`,import.meta.url),'utf8'));
  manifest.capabilities.push('taskEvents');
  await writeFile(join(target,'cezar-extension.json'),JSON.stringify(manifest));
  await writeFile(join(target,'package.json'),JSON.stringify({type:'module',version:manifest.version}));
  await writeFile(join(target,'dist/index.js'),source);
  stamps.push({provider,extensionId:manifest.id,version:manifest.version,integrity:await artifactIntegrity(target)});
 }
 await writeFile(join(directory,'catalog.json'),JSON.stringify(stamps));
 const [artifact]=await loadChatDeliveryCatalog(root);
 const frames: any[]=[],exits: Error[]=[];
 const worker=trustedChatWorker(artifact!,{onFrame:frame=>frames.push(frame),onExit:error=>{if(error)exits.push(error);}});
 worker.write({type:'request',requestId:'activate',generation:'g',method:'activate',params:{entry:artifact!.entry,manifest:artifact!.manifest,context:{}}});
 return {worker,frames,exits,artifact:artifact!};
}
it.each(['stop','kill','timedOut'] as const)('finishes all disposal attempts and notifies supervisor after %s despite errors',async method=>{
 const key=randomUUID(); const state={disposed:0,deactivated:0}; Reflect.set(globalThis,key,state);
 const {worker,frames,exits}=await fixture(`export function activate(ctx){ctx.chat.register('telegram',()=>({}));return {dispose(){globalThis['${key}'].disposed++;throw Error('dispose failed')}}} export function deactivate(){globalThis['${key}'].deactivated++;throw Error('deactivate failed')}`);
 try {
  await expect.poll(()=>frames.some(frame=>frame.ok===true)).toBe(true);
  if(method==='stop') await worker.stop(0); else worker[method]();
  await expect.poll(()=>exits.length).toBe(1);
  await worker.exited;
  expect(worker.alive).toBe(false);expect(state).toEqual({disposed:1,deactivated:1});
  expect(String(exits[0])).toMatch(/failed/);
  await worker.stop(0);expect(exits).toHaveLength(1);
 } finally {Reflect.deleteProperty(globalThis,key);}
});
it('disposes resources returned by activation after cancellation before reporting exit',async()=>{
 const key=randomUUID();let release!:()=>void;
 const state={entered:false,resource:false,hold:new Promise<void>(r=>release=r)};Reflect.set(globalThis,key,state);
 const {worker,exits}=await fixture(`export async function activate(ctx){ctx.chat.register('telegram',()=>({}));const s=globalThis['${key}'];s.entered=true;await s.hold;s.resource=true;return {dispose(){s.resource=false}}}`);
 try {
  await expect.poll(()=>state.entered).toBe(true);
  const stopped=worker.stop(0);await new Promise(setImmediate);expect(exits).toHaveLength(0);
  release();await stopped;expect(state.resource).toBe(false);expect(exits).toHaveLength(1);
 } finally {release();await worker.stop(0);Reflect.deleteProperty(globalThis,key);}
});
it('drains held event listeners before exit and does not start the next listener',async()=>{
 const key=randomUUID();let release!:()=>void;
 const state={entered:false,effects:0,next:0,hold:new Promise<void>(r=>release=r)};Reflect.set(globalThis,key,state);
 const {worker,frames,exits}=await fixture(`export function activate(ctx){ctx.chat.register('telegram',()=>({}));const s=globalThis['${key}'];ctx.taskEvents.subscribe(async()=>{s.entered=true;await s.hold;s.effects++});ctx.taskEvents.subscribe(()=>{s.next++})}`);
 try {
  await expect.poll(()=>frames.some(frame=>frame.ok===true)).toBe(true);
  worker.write({type:'event',generation:'g',event:{type:'resyncRequired'}});
  await expect.poll(()=>state.entered).toBe(true);
  const stopped=worker.stop(0);await new Promise(setImmediate);
  expect(exits).toHaveLength(0);expect(worker.alive).toBe(true);
  release();await stopped;expect(state.effects).toBe(1);expect(state.next).toBe(0);expect(exits).toHaveLength(1);
 } finally {release();await worker.stop(0);Reflect.deleteProperty(globalThis,key);}
});

it('binds activation to the verified manifest rather than a caller-supplied identity',async()=>{
 const {worker,frames,artifact}=await fixture("export function activate(ctx){ctx.chat.register('telegram',()=>({}))}");
 try {
  await expect.poll(()=>frames.some(frame=>frame.ok===true)).toBe(true);
  expect(()=>worker.write({type:'request',requestId:'forged',generation:'g',method:'activate',params:{entry:artifact.entry,manifest:{...artifact.manifest,permissions:['project.read']},context:{}}})).toThrow('Untrusted');
 } finally {await worker.stop(0);}
});
it('keeps facade host-service cancellation and successor activation fenced until effects settle',async()=>{
 const {ExtensionHost}=await import('./host.ts');
 const {worker,frames,artifact}=await fixture("export function activate(ctx){ctx.chat.register('telegram',()=>({receiveSession:async s=>{await s.accept({})}}))}");
 await expect.poll(()=>frames.some(frame=>frame.ok===true)).toBe(true);await worker.stop(0);
 const host=new ExtensionHost();const instance={id:artifact.extensionId,manifest:artifact.manifest,entry:artifact.entry,projectId:'fixture',trustedInProcess:artifact};
 await host.activate(instance);
 let release!:()=>void,entered=false,settled=false,stopped=false;
 const held=new Promise<void>(r=>release=r),controller=new AbortController();
 const running=host.receiveSession(instance.id,{providerId:'telegram',botHandle:randomUUID(),credential:'{}',operation:'receiveSession',input:{}},{signal:controller.signal,service:async()=>{entered=true;await held}}).catch(()=>{}).finally(()=>{settled=true});
 try {
  await expect.poll(()=>entered).toBe(true);controller.abort();
  const shutdown=host.deactivate(instance.id).then(()=>{stopped=true});
  await new Promise(setImmediate);expect(settled).toBe(false);expect(stopped).toBe(false);
  await expect(host.activate(instance)).rejects.toThrow('stopped');
  release();await Promise.all([running,shutdown]);expect(stopped).toBe(true);
 } finally {release();await running;await host.deactivate(instance.id);}
});
