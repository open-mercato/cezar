import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { remainingBudgetUsd } from '../dispatch/engine.ts';

it('retains the child reservation after preliminary zero and failure before final cost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-zero-incomplete-'));
  vi.stubEnv('CEZ_HOME', join(dir, 'home'));
  vi.stubEnv('CEZ_AUTONAME', '0');
  vi.stubEnv('CEZ_FOLLOWUPS', '0');
  const store = RunStore.open(join(dir, '.ai/cezar'));
  const bin = join(dir, 'stub.mjs');
  writeFileSync(bin, `#!/usr/bin/env node
import {createServer} from 'node:http';
let stream;
const server=createServer((req,res)=>{
req.resume();
if(req.url==='/event'){stream=res;res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();}
else if(req.url==='/session'){res.end(JSON.stringify({id:'s'}));}
else if(req.url.endsWith('/abort')){res.end('{}');}
else {
stream.write('data: '+JSON.stringify({type:'message.updated',properties:{info:{id:'a',sessionID:'s',role:'assistant',cost:0,tokens:{input:0,output:0}}}})+'\\n\\n');
stream.write('data: '+JSON.stringify({type:'message.updated',properties:{info:{id:'a',sessionID:'s',role:'assistant',tokens:{input:10000,output:500}}}})+'\\n\\n');
setTimeout(()=>{res.writeHead(500);res.end('backend failed before final cost report');},100);
}});
server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port));
`,{mode:0o700});
  vi.stubEnv('CEZ_OPENCODE_BIN', bin);
  const manager = new RunManager(store, dir, {
    semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }),
  });
  try {
    const child = manager.startRun(
      { name: 'repro', source: 'built-in', steps: [{ id: 'a', name: 'A', prompt: '{{task}}', runner: 'opencode' }] },
      { task: 'work', worktree: false, runner: 'opencode' },
    );
    store.updateRun(child.id, { dispatch: { rootRunId: 'p', parentRunId: 'p', budgetUsd: 2 } });
    await vi.waitFor(() => expect(child.status).toBe('failed'), { timeout: 10000 });
    const parent = { ...child, id: 'p', dispatch: { rootRunId: 'p', budgetUsd: 5 }, costUsd: 0 };
    expect(child.status).toBe('failed');
    expect(child.steps[0]?.tokensUsed).toBe(10500);
    expect(child.costUsd).toBe(0);
    expect(remainingBudgetUsd(parent, [child])).toBe(3);
  } finally {
    manager.dispose();
    store.flush();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
