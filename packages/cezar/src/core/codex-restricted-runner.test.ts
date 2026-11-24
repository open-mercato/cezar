import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { runPipeline } from './codex-restricted-tools.ts';
import type { AgentRunSpec } from './agent-runner.ts';
const bin = fileURLToPath(new URL('./__fixtures__/codex/mock-restricted-server.mjs', import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
function setup(mode = '') {
  const cwd = mkdtempSync(join(tmpdir(), 'cez-restricted-runner-')); dirs.push(cwd);
  mkdirSync(join(cwd, 'native'));
  writeFileSync(join(cwd, 'mode'), mode);
  writeFileSync(join(cwd, 'a.txt'), 'allowed read');
  const spec: AgentRunSpec = { cwd, userPrompt: 'try every escape', allowedTools: ['Read', 'Bash'], bashAllowlist: ['gh pr diff'], env: { CODEX_HOME: join(cwd, 'native'), GH_CONFIG_DIR: join(cwd, 'fake-gh'), GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '', OPENAI_API_KEY: '', CODEX_API_KEY: '' } };
  const runner = new CodexAppServerRunner({ bin, resumeLockRetryMs: [] });
  const requests = () => readFileSync(join(cwd, 'rpc.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { cwd, spec, runner, requests };
}
describe.skipIf(process.platform === 'win32')('isolated Codex execution boundary', () => {
  it.each(['new', 'resume', 'lock', 'newer', 'workspace'])('blocks native/foreign/disallowed tools and allows reads on %s', async path => {
    const f = setup(['lock', 'newer', 'workspace'].includes(path) ? path : '');
    const result = await f.runner.run({ ...f.spec, ...(path !== 'new' ? { resume: true, sessionId: 'restricted' } : {}) });
    const responses = JSON.parse(result.text);
    for (const id of [204, 214]) expect(responses.find((r: {id: number}) => r.id === id).error).toBeDefined();
    for (const id of [200, 201]) expect(responses.find((r: {id: number}) => r.id === id).result.decision).toBe('decline');
    expect(responses.find((r: {id: number}) => r.id === 202).result).toEqual({ permissions: {}, scope: 'turn' });
    expect(responses.find((r: {id: number}) => r.id === 203).result.action).toBe('decline');
    for (const id of [210, 211, 212, 213]) expect(responses.find((r: {id: number}) => r.id === id).result.success).toBe(false);
    expect(responses.find((r: {id: number}) => r.id === 215).result.contentItems[0].text).toBe('allowed read');
    expect(existsSync(join(f.cwd, 'FORBIDDEN'))).toBe(false);
    const turn = f.requests().find((r: {method: string}) => r.method === 'turn/start').params;
    expect(turn.approvalPolicy).toBe('never');
    expect(turn.environments).toEqual([]);
    const start = f.requests().find((r: {method: string}) => r.method === 'thread/start');
    if (start) expect(start.params.environments).toEqual([]);
    expect(f.requests().filter((r: {method: string}) => r.method === 'mcpServerStatus/list').at(-1).params.threadId).toBeDefined();
    expect(turn.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false });
    if (path === 'lock') expect(f.requests().some((r: {method: string}) => r.method === 'thread/fork')).toBe(true);
  });
  it('runs a read-only step on a Codex newer than 0.169.0 once every native feature is off for the thread', async () => {
    const f = setup('newer');
    const result = await f.runner.run({ ...f.spec, enforceReadOnly: true, allowedTools: ['Read', 'Grep', 'Glob'], bashAllowlist: undefined });
    expect(JSON.parse(result.text).find((r: {id: number}) => r.id === 215).result.contentItems[0].text).toBe('allowed read');
    const config = f.requests().find((r: {method: string}) => r.method === 'thread/start').params.config;
    // The unknown flag and every listed one are off; a removed flag and the exec selector are left alone.
    expect(config).toMatchObject({ 'features.future_native_tool': false, 'features.fast_mode': false, 'features.shell_tool': false });
    expect(config).not.toHaveProperty('features.old_flag');
    expect(config).not.toHaveProperty('features.unified_exec');
    const lists = f.requests().filter((r: {method: string}) => r.method === 'experimentalFeature/list');
    expect(lists.at(-1).params.threadId).toBe('restricted');
  });
  it.each(['version', 'flags', 'apps', 'layer', 'hooks', 'mcp', 'requirements', 'sandbox', 'managed-layer', 'newer-stuck', 'newer-garbled'])('refuses before a model turn when %s cannot be verified', async mode => {
    const f = setup(mode);
    await expect(f.runner.run(f.spec)).rejects.toThrow('tool-policy enforcement unavailable');
    expect(f.requests().some((r: {method: string}) => r.method === 'turn/start')).toBe(false);
    expect(existsSync(join(f.cwd, 'FORBIDDEN'))).toBe(false);
  });
  it('runs only what a brokered shell vets, as an argv pipeline with no shell (Codex managers)', async () => {
    const f = setup();
    const seen: string[] = [];
    const brokeredShell = {
      describe: 'a test command.',
      env: { PATH: process.env.PATH },
      verify: (command: string) => {
        seen.push(command);
        if (command === 'echo hi | wc -c') return { ok: true as const, pipeline: [['echo', 'hi'], ['wc', '-c']] };
        if (command === 'count-lines') return { ok: true as const, pipeline: [['wc', '-l']], stdin: 'a\nb\n' };
        return { ok: false as const, reason: 'not a manager command' };
      },
    };
    const result = await f.runner.run({ ...f.spec, allowedTools: ['Read', 'Grep', 'Glob', 'Bash'], bashAllowlist: ['cez-manager'], brokeredShell });
    const responses = JSON.parse(result.text);
    const text = (id: number) => responses.find((r: {id: number}) => r.id === id).result;
    expect(text(216)).toMatchObject({ success: true });
    expect(text(216).contentItems[0].text.trim()).toBe('3');
    expect(text(217).contentItems[0].text.trim()).toBe('2');
    for (const id of [211, 212, 218]) {
      expect(text(id).success).toBe(false);
      expect(text(id).contentItems[0].text).toContain('cezar manager policy: not a manager command');
    }
    expect(seen).toEqual(expect.arrayContaining(['touch FORBIDDEN', 'gh pr merge 1', 'echo $HOME > FORBIDDEN']));
    expect(existsSync(join(f.cwd, 'FORBIDDEN'))).toBe(false);
    // The isolation is the read-only step's: native tools still declined, sandbox read-only.
    for (const id of [200, 201]) expect(text(id).decision).toBe('decline');
    const turn = f.requests().find((r: {method: string}) => r.method === 'turn/start').params;
    expect(turn.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false });
    expect(f.requests().find((r: {method: string}) => r.method === 'thread/start').params.dynamicTools[0].description).toContain('a test command.');
  });
  it('checks native features on a 0.169.0 prerelease, which the static list was never verified against', async () => {
    const f = setup('prerelease');
    await f.runner.run(f.spec);
    expect(f.requests().filter((r: {method: string}) => r.method === 'experimentalFeature/list')).toHaveLength(2);
  });
  it('ends the writers of a brokered pipeline whose reader quits early, as a shell would', async () => {
    const started = Date.now();
    const ran = await runPipeline([['yes'], ['head', '-1']], undefined, { cwd: process.cwd(), env: { PATH: process.env.PATH }, signal: new AbortController().signal });
    expect(ran).toEqual({ ok: true, text: 'y\n' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });
  it('keeps a no-tools invocation empty even when the model requests supported reads', async () => {
    const f = setup();
    const output = await f.runner.run({ ...f.spec, allowedTools: [], bashAllowlist: undefined });
    expect(JSON.parse(output.text).find((r: {id: number}) => r.id === 215).result.success).toBe(false);
  });
});
