import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lifecycleListResponseSchema, lifecycleOperationResponseSchema, lifecyclePreviewResponseSchema, type ScriptEntry } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { WorktreeLifecycleCoordinator } from '../worktree-lifecycle/coordinator.ts';
import { writeLifecycleConfig } from '../worktree-lifecycle/config.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { createWorktree } from '../git-worktree.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

describe('worktree lifecycle API', () => {
  let root: string;
  let store: RunStore;
  let coordinator: WorktreeLifecycleCoordinator;
  let app: ReturnType<typeof createApp>;
  let runId: string;
  let path: string;
  const script = (command: string): ScriptEntry => ({id: randomUUID(),command});
  beforeEach(async () => {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-lifecycle-api-')));
    execFileSync('git',['init','-q','-b','main'],{cwd:root});
    writeFileSync(join(root,'.gitignore'),'.ai/cezar/\n');
    execFileSync('git',['add','.gitignore'],{cwd:root});
    execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],{cwd:root});
    store = RunStore.open(join(root,'.ai/cezar'));
    runId = store.createRun({title:'fixture',workflow:'quick-task',task:'fixture task',steps:[]}).id;
    const wt = await createWorktree(root,runId,'main'); path=wt.path;
    store.updateRun(runId,{status:'done',worktreePath:path,branch:wt.branch});
    coordinator = new WorktreeLifecycleCoordinator(root,store,{semaphore:new WorkspaceSemaphore({initial:{maxParallel:1}}),busySlots:()=>0,isActive:()=>false,cancelAndWait:async()=>true,resume:async()=>{}});
    const manager = {lifecycle:coordinator,isActive:()=>false,cancelAndWait:async()=>true} as unknown as RunManager;
    app=createApp({repoRoot:root,store,manager,version:'test',bootProjectId:'lifecycle-test'});
  });
  afterEach(() => { coordinator.dispose();store.flush();rmSync(root,{recursive:true,force:true});vi.unstubAllEnvs(); });
  const request = (route:string,body?:unknown,method=body===undefined?'GET':'POST') => apiRequest(app,`/api/v1${route}`,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
  async function failedRemoval() {
    await writeLifecycleConfig(root,{afterCreate:[],beforeRemove:[script('printf fixture-output; exit 2')]},null);
    const res=await request('/worktree-lifecycle/operations',{requestId:randomUUID(),runId,intent:'remove-worktree'});
    expect(res.status).toBe(202);
    const {operation}=lifecycleOperationResponseSchema.parse(await res.json());
    await vi.waitFor(async()=>expect((await coordinator.operation(operation.id)).state).toBe('needs_attention'));
    return coordinator.operation(operation.id);
  }
  it('keeps hook-free legacy deletion and its original response',async()=>{
    const res=await request(`/runs/${runId}/remove-worktree`,{});
    expect(res.status).toBe(200); expect(await res.json()).toEqual({removed:true});expect(existsSync(path)).toBe(false);
  });
  it('refuses legacy deletion before any directory or record mutation when hooks exist',async()=>{
    await writeLifecycleConfig(root,{afterCreate:[],beforeRemove:[script('exit 0')]},null);
    for(const [route,method] of [[`/runs/${runId}/remove-worktree`,'POST'],[`/runs/${runId}`,'DELETE']]) {
      const res=await request(route!,{},method);expect(res.status).toBe(409);expect(await res.json()).toMatchObject({error:expect.stringContaining('/worktree-lifecycle/operations')});
    }
    expect(existsSync(path)).toBe(true);expect(store.getRun(runId)?.worktreePath).toBe(path);
  });
  it('previews safely without execution and validates bodies/params/queries',async()=>{
    const res=await request('/worktree-lifecycle/preview',{command:'printf %s {{ root_path }}/test'});
    expect(res.status).toBe(200);expect(lifecyclePreviewResponseSchema.parse(await res.json())).toMatchObject({illustrative:true,cwd:'/example/project/.ai/cezar/worktrees/example-task'});
    expect((await request('/worktree-lifecycle/preview',{command:'echo "{{ root_path }}"'})).status).toBe(400);
    expect((await request('/worktree-lifecycle/preview',{command:'echo {{ unknown }}'})).status).toBe(400);
    expect((await request('/worktree-lifecycle/../../outside')).status).toBe(404);
    expect((await request('/worktree-lifecycle?limit=101')).status).toBe(400);
    expect((await request('/worktree-lifecycle/operations',{requestId:randomUUID(),runId,intent:'orphan',path:'/tmp'})).status).toBe(400);
    expect((await request(`/worktree-lifecycle/operations/${randomUUID()}`)).status).toBe(404);
    expect((await request(`/worktree-lifecycle/operations/${randomUUID()}/output`)).status).toBe(404);
  });
  it('lists attention through both aliases, pages output, rejects stale recovery and keeps the directory',async()=>{
    const operation=await failedRemoval();
    for(const prefix of ['', '/p/default', '/p/lifecycle-test']) {
      const res=await apiRequest(app,`/api/v1${prefix}/worktree-lifecycle?attentionOnly=true&limit=1`);
      expect(res.status).toBe(200);expect(lifecycleListResponseSchema.parse(await res.json()).worktrees[0]?.operation?.id).toBe(operation.id);
    }
    const output=await request(`/worktree-lifecycle/operations/${operation.id}/output?afterSeq=0&limit=1`);
    expect(output.status).toBe(200);expect(await output.json()).toMatchObject({items:[{text:expect.stringContaining('fixture-output')}],nextSeq:expect.any(Number)});
    expect((await request(`/worktree-lifecycle/operations/${operation.id}/actions`,{requestId:randomUUID(),expectedRevision:operation.revision-1,action:'force-delete'})).status).toBe(409);
    const res=await request(`/worktree-lifecycle/operations/${operation.id}/actions`,{requestId:randomUUID(),expectedRevision:operation.revision,action:'keep-worktree'});
    expect(res.status).toBe(202);expect(await res.json()).toMatchObject({operation:{state:'kept'}});expect(existsSync(path)).toBe(true);
  });
  it('makes duplicate removal requests idempotent and rejects a different intent with the same ID',async()=>{
    await writeLifecycleConfig(root,{afterCreate:[],beforeRemove:[script('exit 2')]},null);
    const input={requestId:randomUUID(),runId,intent:'reclaim'};
    const first=await request('/worktree-lifecycle/operations',input);
    const {operation}=lifecycleOperationResponseSchema.parse(await first.json());
    await vi.waitFor(async()=>expect((await coordinator.operation(operation.id)).state).toBe('needs_attention'));
    const duplicate=await request('/worktree-lifecycle/operations',input);
    expect(duplicate.status).toBe(202);expect(await duplicate.json()).toMatchObject({operation:{id:operation.id}});
    expect((await request('/worktree-lifecycle/operations',{...input,intent:'delete-task'})).status).toBe(409);
    expect(existsSync(path)).toBe(true);
  });
  it('refuses git mutation while cleanup awaits recovery',async()=>{
    await failedRemoval();
    const res=await request(`/runs/${runId}/git/commit`,{message:'must not commit'});
    expect(res.status).toBe(409);expect(await res.json()).toMatchObject({error:expect.stringContaining('lifecycle')});
  });
  it('saves lists atomically with revision checking and preserves unrelated raw keys',async()=>{
    writeFileSync(join(root,'.ai/cezar/config.json'),JSON.stringify({custom:{keep:true}}));
    const config={afterCreate:[script('echo {{ root_path }}')],beforeRemove:[]};
    const first=await request('/config',{worktreeLifecycle:config,worktreeLifecycleRevision:null,worktreeRetention:4},'PUT');
    expect(first.status).toBe(200);const saved=await first.json() as {worktreeLifecycleRevision:string};
    const raw=()=>JSON.parse(readFileSync(join(root,'.ai/cezar/config.json'),'utf8'));
    expect(raw()).toMatchObject({custom:{keep:true},worktreeRetention:4,worktreeLifecycle:config});
    expect((await request('/config',{worktreeLifecycle:null,worktreeLifecycleRevision:null,worktreeRetention:9},'PUT')).status).toBe(409);
    expect(raw().worktreeRetention).toBe(4);
    expect((await request('/config',{worktreeLifecycle:{afterCreate:[script('echo "{{ root_path }}"')],beforeRemove:[]},worktreeLifecycleRevision:saved.worktreeLifecycleRevision},'PUT')).status).toBe(400);
    expect(raw().worktreeLifecycle).toEqual(config);
  });
  it('does not erase malformed config through unrelated settings writes',async()=>{
    const configPath=join(root,'.ai/cezar/config.json');writeFileSync(configPath,'{broken');
    expect((await request('/config',{worktreeRetention:9},'PUT')).status).toBe(409);expect(readFileSync(configPath,'utf8')).toBe('{broken');
    expect((await request(`/runs/${runId}/remove-worktree`,{})).status).toBe(409);expect(existsSync(path)).toBe(true);
  });
  it('rejects cross-origin mutation using the existing global guard',async()=>{
    const res=await apiRequest(app,'/api/v1/worktree-lifecycle/preview',{method:'POST',headers:{origin:'https://outside.example','content-type':'application/json'},body:JSON.stringify({command:'echo hello'})});
    expect(res.status).toBe(403);
  });
});
