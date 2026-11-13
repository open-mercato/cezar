import assert from 'node:assert/strict';
import { execFile as callback } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, cp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
const execFile = promisify(callback);
const service = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const packages = resolve(service, '..');
test('packed Telegram host/worker pairs, confirms, restarts, updates and rolls back through folder intake', {timeout:300_000}, async()=>{
 // A scenario may use whatever the test cap leaves (less cleanup), so load slows it instead of killing it.
 const deadline=Date.now()+290_000;
 const npm = process.env.npm_execpath; assert.ok(npm,'run via npm run test:package');
 const root=await mkdtemp(join(tmpdir(),'cezar-packed-chat-'));
 const env: NodeJS.ProcessEnv={...process.env,npm_config_userconfig:'/dev/null',CEZ_HOME:join(root,'home'),CEZ_WEBHOOKS:'1',CEZ_CHAT_INBOUND:'1',CEZ_EXTENSIONS:'1'};
 delete env.CEZ_DRY_RUN;
 const run=(args:string[],cwd:string)=>execFile(process.execPath,[npm,...args],{cwd,env,timeout:60_000,maxBuffer:10*1024*1024});
 try {
  const consumer=join(root,'consumer');await mkdir(consumer);
  const dependencies:Record<string,string>={};
  for(const source of [service,join(packages,'extension-sdk'),join(packages,'chat-plugins','telegram')]) {
   const {stdout}=await run(['pack','--ignore-scripts','--json','--pack-destination',root],source);
   const [packed]=JSON.parse(stdout) as {name:string;filename:string}[];
   assert.ok(packed);dependencies[packed.name]=join(root,packed.filename);
  }
  await writeFile(join(consumer,'package.json'),JSON.stringify({private:true,type:'module',dependencies}));
  await run(['install','--install-strategy=nested','--ignore-scripts','--no-audit','--no-fund','--no-package-lock'],consumer);
  const host=join(consumer,'node_modules/@open-mercato/cezar');
  const plugin=join(consumer,'node_modules/@open-mercato/cezar-chat-telegram');
  // Keep the packed plugin's declared dependencies local when the host copies it.
  await run(['install','--omit=dev','--ignore-scripts','--no-audit','--no-fund','--no-package-lock',dependencies['@open-mercato/cezar-extension-sdk']!],plugin);
  // Negative controls omit the actual lifecycle action. Each must fail at the
  // new receive assertion, not pass using observations from an earlier worker.
  assert.deepEqual(await readFile(join(host,'dist/chat-plugins/telegram/dist/index.js')),await readFile(join(plugin,'dist/index.js')),'shipped and installed entries must be the same bytes');
  for (const scenarioName of ['normal','skip-restore','skip-enable','delivered','normal-unbarrier-1','normal-unbarrier-2','facade','selected','skip-select-update','default','default-facade']) {
   const mode=scenarioName.startsWith('default')?scenarioName:(scenarioName==='selected'||scenarioName==='skip-select-update')?'selected':scenarioName==='facade'?'facade':scenarioName==='delivered'?'delivered':'installed';
   const fault=scenarioName.startsWith('skip-')?scenarioName:'';
   const scenario=join(root,scenarioName);await mkdir(scenario);
   const candidate=join(scenario,'plugin');await cp(plugin,candidate,{recursive:true});
   const execution=execFile(process.execPath,[join(service,'test/e2e/fixtures/packed-telegram.mjs'),scenario,host,candidate,fault,mode,scenarioName.includes('unbarrier')?'none':'barrier'],{
    cwd:consumer,env:{...env,CEZ_HOME:join(scenario,'home'),CEZ_EXTENSIONS:mode==='facade'||mode==='default-facade'?'0':'1'},timeout:Math.max(1,deadline-Date.now()),maxBuffer:1024*1024});
   if(fault) await assert.rejects(execution,new RegExp(fault==='skip-select-update'?'selected update version was not activated':fault==='skip-restore'?'restart receive did not resume':'re-enable receive did not resume'));
   else assert.match((await execution).stdout,/PACKED_TELEGRAM_PAIR_RESTART_OK/);
  }
 } finally {await rm(root,{recursive:true,force:true})}
});
