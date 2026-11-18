import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
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
  it.each(['new', 'resume', 'lock'])('blocks native/foreign/disallowed tools and allows reads on %s', async path => {
    const f = setup(path === 'lock' ? 'lock' : '');
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
  it.each(['version', 'flags', 'layer', 'hooks', 'mcp', 'requirements', 'sandbox'])('refuses before a model turn when %s cannot be verified', async mode => {
    const f = setup(mode);
    await expect(f.runner.run(f.spec)).rejects.toThrow('tool-policy enforcement unavailable');
    expect(f.requests().some((r: {method: string}) => r.method === 'turn/start')).toBe(false);
    expect(existsSync(join(f.cwd, 'FORBIDDEN'))).toBe(false);
  });
  it('keeps a no-tools invocation empty even when the model requests supported reads', async () => {
    const f = setup();
    const output = await f.runner.run({ ...f.spec, allowedTools: [], bashAllowlist: undefined });
    expect(JSON.parse(output.text).find((r: {id: number}) => r.id === 215).result.success).toBe(false);
  });
});
