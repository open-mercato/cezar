import {extensionInventoryResponseSchema} from '@open-mercato/cezar-contract';
import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Hono} from 'hono';
import {expect,it,vi} from 'vitest';
import {loadChatDeliveryCatalog} from '../extensions/delivery-catalog.ts';
import {ExtensionHost} from '../extensions/host.ts';
import {ExtensionManager} from '../extensions/manager.ts';
import {RunStore} from '../runs/store.ts';
import {WebhookService} from '../webhooks/service.ts';
import {WebhookScheduler} from '../webhooks/scheduler.ts';
import type {ProjectContext} from './project-context.ts';
import {extensionRoutes,globalExtensionRoutes,closeProjectExtensions} from './extensions.ts';
const spawned=vi.hoisted(()=>vi.fn());
vi.mock('../extensions/worker-process.ts',async original=>{
 const actual=await original<typeof import('../extensions/worker-process.ts')>();
 return {...actual,spawnWorkerProcess:(...args:Parameters<typeof actual.spawnWorkerProcess>)=>{spawned();return actual.spawnWorkerProcess(...args)}};
});
it('allows only verified shipped enable/disable through the flag-off HTTP policy without a worker',async()=>{
 const root=await mkdtemp(join(tmpdir(),'chat-management-'));const dataDir=join(root,'.ai/cezar');
 execFileSync('git',['init','-q'],{cwd:root,timeout:5000});
 vi.stubEnv('CEZ_HOME',join(root,'home'));vi.stubEnv('CEZ_EXTENSIONS','0');vi.stubEnv('CEZ_WEBHOOKS','1');
 const store=RunStore.open(dataDir),project={id:'project',root,dataDir,store} as ProjectContext;
 const service=await WebhookService.open({root,dataDir,projectId:'project',mode:'local',serverPorts:()=>[],scheduler:new WebhookScheduler()});
 const app=new Hono<{Variables:{project:ProjectContext}}>().use('*',async(c,next)=>{c.set('project',project);await next()}).route('/api/v1',extensionRoutes(()=> 'flag disabled',()=>true)).route('/api/v1',globalExtensionRoutes(project,()=> 'flag disabled'));
 const post=(path:string,body:unknown={})=>app.request('/api/v1/extensions/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 try {
  const inventory=extensionInventoryResponseSchema.parse(await (await app.request('/api/v1/extensions/inventory')).json());
  expect(inventory.extensions.find(row=>row.record.manifest.id==='open-mercato.telegram')).toMatchObject({provenance:{kind:'bundled'},management:{enable:false,disable:true,update:false,uninstall:false}});
  const enabled=await post('open-mercato.telegram/enable',{integrity:inventory.extensions.find(row=>row.record.manifest.id==='open-mercato.telegram')!.record.integrity});
  expect(enabled.status,await enabled.text()).toBe(200);
  expect((await post('unknown/enable')).status).toBe(409);
  expect((await post('unknown/disable')).status).toBe(409);
  expect((await post('open-mercato.telegram/prepare-update')).status).toBe(409);
  expect((await app.request('/api/v1/extensions/open-mercato.telegram',{method:'DELETE'})).status).toBe(409);
  expect((await post('open-mercato.telegram/disable')).status).toBe(200);
  expect(spawned).not.toHaveBeenCalled();
 } finally {await service?.dispose();await closeProjectExtensions(project);store.flush();vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});}
},20000);

it.each([true,false])('preserves a foreign tombstone after cached declaration (enabled=%s)',async enabled=>{
 const root=await mkdtemp(join(tmpdir(),'cached-selection-')),dataDir=join(root,'data');
 const manager=new ExtensionManager(dataDir,'project',root,{home:join(root,'home'),trustedChatInProcess:true});
 try {
  const row=(await manager.inventory()).find(row=>row.record.manifest.id==='open-mercato.telegram')!;
  await manager.declareDeliveredChat('telegram');
  const path=join(dataDir,'extensions/registry.json');
  const bytes=JSON.stringify([{...row.record,origin:undefined,source:'/foreign/telegram',installedAt:'2026-11-10',enabled:false}]);
  await writeFile(path,bytes);
  await expect(manager.setEnabled(row.record.manifest.id,enabled,row.record.integrity)).rejects.toThrow(/selection/);
  expect(await readFile(path,'utf8')).toBe(bytes);
 }finally{await manager.close();await rm(root,{recursive:true,force:true});}
});
it.each([true,false])('revalidates flag-off shipped authorization under the mutation lock (enabled=%s)',async enabled=>{
 const root=await mkdtemp(join(tmpdir(),'selection-race-')),dataDir=join(root,'data'),home=join(root,'home');
 vi.stubEnv('CEZ_HOME',home);vi.stubEnv('CEZ_EXTENSIONS','0');
 const store=RunStore.open(dataDir),project={id:'project',root,dataDir,store} as ProjectContext;
 const app=new Hono<{Variables:{project:ProjectContext}}>().use('*',async(c,next)=>{c.set('project',project);await next()}).route('/api/v1',extensionRoutes(()=>'flag disabled'));
 const activation=vi.spyOn(ExtensionHost.prototype,'activate');
 const deactivation=vi.spyOn(ExtensionHost.prototype,'deactivate');
 const original=ExtensionManager.prototype.canManageDelivered;
 let bytes='';
 const spy=vi.spyOn(ExtensionManager.prototype,'canManageDelivered').mockImplementation(async function(this:ExtensionManager,id:string){
  const allowed=await original.call(this,id);
  if(allowed){
   const row=(await this.inventory()).find(row=>row.record.manifest.id===id)!;
   bytes=JSON.stringify([{...row.record,origin:undefined,source:'/foreign/telegram',installedAt:'2026-11-10',enabled:!enabled}]);
   for(const dir of [home,dataDir]){await mkdir(join(dir,'extensions'),{recursive:true});await writeFile(join(dir,'extensions/registry.json'),bytes);}
  }
  return allowed;
 });
 try {
  const inventory=extensionInventoryResponseSchema.parse(await (await app.request('/api/v1/extensions/inventory')).json());
  const integrity=inventory.extensions.find(row=>row.record.manifest.id==='open-mercato.telegram')!.record.integrity;
  spawned.mockClear();
  const response=await app.request('/api/v1/extensions/open-mercato.telegram/'+(enabled?'enable':'disable'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({integrity})});
  expect(response.status).toBe(400);
  expect(await readFile(join(dataDir,'extensions/registry.json'),'utf8')).toBe(bytes);
  expect(await readFile(join(home,'extensions/registry.json'),'utf8')).toBe(bytes);
  expect(activation).not.toHaveBeenCalled();expect(deactivation).not.toHaveBeenCalled();
  expect(spawned).not.toHaveBeenCalled();
 }finally{spy.mockRestore();activation.mockRestore();deactivation.mockRestore();await closeProjectExtensions(project);store.flush();vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});}
});
it.each(['0','1'].flatMap(extensions=>[undefined,'0'].map(webhooks=>({extensions,webhooks}))))('persists pre-disable without a live host ($extensions/$webhooks)',async({extensions,webhooks})=>{
 const root=await mkdtemp(join(tmpdir(),'offline-selection-')),dataDir=join(root,'.ai/cezar');
 execFileSync('git',['init','-q'],{cwd:root,timeout:5000});
 vi.stubEnv('CEZ_HOME',join(root,'home'));vi.stubEnv('CEZ_EXTENSIONS',extensions);vi.stubEnv('CEZ_WEBHOOKS',webhooks);
 const store=RunStore.open(dataDir),project={id:'project',root,dataDir,store} as ProjectContext;
 const app=new Hono<{Variables:{project:ProjectContext}}>().use('*',async(c,next)=>{c.set('project',project);await next()}).route('/api/v1',extensionRoutes(()=>extensions==='0'?'flag disabled':undefined));
 let service:WebhookService|undefined;
 try{
  spawned.mockClear();
  const response=await app.request('/api/v1/extensions/open-mercato.telegram/disable',{method:'POST'});
  expect(response.status,await response.text()).toBe(200);
  await closeProjectExtensions(project);
  vi.stubEnv('CEZ_WEBHOOKS','1');
  service=await WebhookService.open({root,dataDir,projectId:'project',mode:'local',serverPorts:()=>[],scheduler:new WebhookScheduler()});
  await service!.startChat();
  const inventory=extensionInventoryResponseSchema.parse(await(await app.request('/api/v1/extensions/inventory')).json());
  expect(inventory.extensions.find(row=>row.record.manifest.id==='open-mercato.telegram')!.record.enabled).toBe(false);
  expect(spawned).not.toHaveBeenCalled();
 }finally{await service?.dispose();await closeProjectExtensions(project);store.flush();vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});}
});

it.each([true,false])('refuses candidate install over a newer foreign selection (enabled=%s)',async enabled=>{
 const root=await mkdtemp(join(tmpdir(),'candidate-selection-')),dataDir=join(root,'data');
 const manager=new ExtensionManager(dataDir,'project',root,{home:join(root,'home'),trustedChatInProcess:true});
 const activation=vi.spyOn(ExtensionHost.prototype,'activate'),deactivation=vi.spyOn(ExtensionHost.prototype,'deactivate');
 try{
  const artifact=(await loadChatDeliveryCatalog()).find(item=>item.provider==='telegram')!;
  const row=(await manager.inventory()).find(row=>row.record.manifest.id===artifact.extensionId)!;
  await manager.declareDeliveredChat('telegram');
  const path=join(dataDir,'extensions/registry.json');
  const bytes=JSON.stringify([{...row.record,origin:undefined,source:'/foreign/telegram',installedAt:'2026-11-10',enabled}]);
  await writeFile(path,bytes);
  await expect(manager.install(artifact.root)).rejects.toThrow(/selection/);
  expect(await readFile(path,'utf8')).toBe(bytes);
  expect(await manager.installed()).toEqual([]);
  expect(existsSync(join(root,'home/extensions/artifacts',artifact.extensionId))).toBe(false);
  expect(activation).not.toHaveBeenCalled();expect(deactivation).not.toHaveBeenCalled();
 }finally{activation.mockRestore();deactivation.mockRestore();await manager.close();await rm(root,{recursive:true,force:true});}
});
