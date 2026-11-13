import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { NanobotRunner } from './nanobot-runner.ts';
import { NanobotEventMapper } from './nanobot-ui-mapper.ts';
import type { AgentEvent } from './agent-runner.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fixture(body: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'nanobot-runner-')); dirs.push(cwd);
  const bin = join(cwd, 'bridge.mjs');
  writeFileSync(bin, `#!/usr/bin/env node\nimport readline from 'node:readline';\nconst emit = x => console.log(JSON.stringify(x));\n${body}`);
  chmodSync(bin, 0o700);
  return { bin, cwd };
}
const bridge = `let session; for await (const line of readline.createInterface({input:process.stdin})) {
 const v=JSON.parse(line);
 if(v.type==='init') { session=v.sessionId; emit({type:'ready', sessionId:session}); }
 if(v.type==='prompt') {emit({type:'turn-start'});emit({type:'model',model:'actual-model'});emit({type:'text',text:v.text});emit({type:'usage',tokens:12,input:8,output:4});emit({type:'turn-end'});}
 if(v.type==='end') break;
}`;

describe('Nanobot native bridge seam', () => {
  it('preserves session identity, model metadata and follow-up turns', async () => {
    const {bin,cwd}=fixture(bridge); const events:AgentEvent[]=[]; const ui: unknown[]=[];
    let turns=0;
    const runner=new NanobotRunner({bin});
    const session=runner.startSession({cwd,userPrompt:'first',sessionId:'stable',resume:true}, e => {
      events.push(e);
      if(e.type==='turn-end') { if(++turns===1) session.sendMessage([{type:'text',text:'second'}]); else session.end(); }
    }, {onUiEvent:e=>ui.push(e)});
    const result=await session.result;
    expect(result).toMatchObject({sessionId:'stable',text:'first\nsecond',tokensUsed:12});
    expect(ui).toContainEqual({type:'session.started',sessionId:'stable',backend:'nanobot',model:'actual-model',modelSource:'runtime-selection'});
    expect(events.filter(e=>e.type==='turn-end')).toHaveLength(2);
    expect(session.open).toBe(false);
    expect(session.sendMessage([{type:'text',text:'late'}])).toBe(false);
  });
  it('auto-ends a single turn and rejects missing binaries without hanging', async () => {
    const {bin,cwd}=fixture(bridge);
    await expect(new NanobotRunner({bin}).run({cwd,userPrompt:'hello'})).resolves.toMatchObject({text:'hello'});
    await expect(new NanobotRunner({bin:join(cwd,'missing')}).run({cwd,userPrompt:'hello'})).rejects.toThrow();
  });
  it('rejects premature clean exits and failed graceful cleanup', async () => {
    const early=fixture('process.exit(0);');
    await expect(new NanobotRunner({bin:early.bin}).run({cwd:early.cwd,userPrompt:'x'})).rejects.toThrow('before completing');
    const cleanup=fixture(bridge.replace("if(v.type==='end') break;", "if(v.type==='end') process.exit(7);"));
    await expect(new NanobotRunner({bin:cleanup.bin}).run({cwd:cleanup.cwd,userPrompt:'x'})).rejects.toThrow('code 7');
  });
  it('bounds ignored cancellation and timeouts with a process kill', async () => {
    const {bin,cwd}=fixture(`process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`);
    await expect(new NanobotRunner({bin,timeoutMs:100,killGraceMs:20}).run({cwd,userPrompt:'hello'})).rejects.toThrow('timed out');
  });
  it('rejects unsupported effort and read-only guarantees before launching', () => {
    const runner=new NanobotRunner({bin:'must-not-launch'});
    expect(()=>runner.startSession({cwd:'.',userPrompt:'x',reasoningEffort:'high'})).toThrow('reasoning effort');
    expect(()=>runner.startSession({cwd:'.',userPrompt:'x',enforceReadOnly:true})).toThrow('read-only');
  });
  it('fails closed on malformed bridge frames without exposing raw output', async () => {
    const {bin,cwd}=fixture(`console.log('private invalid content'); setInterval(()=>{},1000);`);
    await expect(new NanobotRunner({bin,killGraceMs:20}).run({cwd,userPrompt:'x'})).rejects.toThrow('invalid JSON');
  });
});

describe('Nanobot event mapping',()=>{
  it('degrades safely for malformed/unknown events and preserves native tool results',()=>{
    const mapper=new NanobotEventMapper();
    for(const v of [null,[],42,{type:'text',text:7},{type:'future'}]) expect(mapper.map(v)).toEqual({agent:[],ui:[]});
    mapper.map({type:'tool-call',id:'t1',tool:'exec',input:{command:'pwd'}});
    const result=mapper.map({type:'tool-result',id:'t1',result:'/workspace',isError:false});
    expect(result.agent).toEqual([{type:'tool-result',toolCallId:'t1',result:'/workspace',isError:false}]);
    expect(result.ui[0]).toMatchObject({type:'item.completed',item:{id:'t1',name:'exec',status:'completed',output:'/workspace'}});
    expect(mapper.map({type:'usage',tokens:NaN})).toEqual({agent:[],ui:[]});
  });
});
