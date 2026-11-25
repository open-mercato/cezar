import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import type { AgentRunSpec } from './agent-runner.ts';
const bin = fileURLToPath(new URL('./__fixtures__/codex/mock-restricted-server.mjs', import.meta.url));
const dirs: string[] = [];
const METACHARACTERS = '$(touch FORBIDDEN); `touch FORBIDDEN` && touch FORBIDDEN || x > FORBIDDEN < /etc/passwd | sh & * ~ $HOME';
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
  it.each([
    ['version', 'the installed Codex protocol has not been verified'],
    ['prerelease', 'the installed Codex protocol has not been verified'],
    ['flags', 'a required native tool/extension control is unavailable'],
    ['apps', 'a required native tool/extension control is unavailable'],
    ['layer', 'an unverified futureLayer configuration layer is active'],
    ['managed-layer', 'an unverified enterpriseManaged configuration layer is active'],
    ['hooks', 'hooks or MCP services could not be proven absent'],
    ['mcp', 'hooks or MCP services could not be proven absent'],
    ['requirements', 'a managed Codex requirement (allowedSandboxModes) could not be verified'],
    ['requirements-on', 'a managed Codex requirement (featureRequirements) could not be verified'],
    ['sandbox', 'the thread did not retain its sandbox and approval policy'],
    ['newer-stuck', 'native Codex features stayed enabled (future_native_tool)'],
    ['newer-garbled', 'Codex cannot report its native features'],
  ])('refuses before a model turn when %s cannot be verified', async (mode, reason) => {
    const f = setup(mode);
    await expect(f.runner.run(f.spec)).rejects.toThrow(`tool-policy enforcement unavailable — ${reason}`);
    expect(f.requests().some((r: {method: string}) => r.method === 'turn/start')).toBe(false);
    expect(existsSync(join(f.cwd, 'FORBIDDEN'))).toBe(false);
  });
  it('runs only what a brokered shell vets, as an argv pipeline with no shell (Codex managers)', async () => {
    const f = setup();
    const seen: string[] = [];
    // A stub `gh` first on PATH: the unit suite never reaches github.com or the host's gh login.
    const stubs = join(f.cwd, 'stub-bin');
    mkdirSync(stubs);
    writeFileSync(join(stubs, 'gh'), '#!/bin/sh\necho "stub gh: $*"\n', { mode: 0o755 });
    const brokeredShell = {
      describe: 'a test command.',
      env: { PATH: `${stubs}${delimiter}${process.env.PATH}` },
      verify: (command: string) => {
        seen.push(command);
        if (command === 'echo hi | wc -c') return { ok: true as const, pipeline: [['echo', 'hi'], ['wc', '-c']] };
        if (command === 'count-lines') return { ok: true as const, pipeline: [['wc', '-l']], stdin: 'a\nb\n' };
        if (command === 'literal') return { ok: true as const, pipeline: [['printf', '%s', METACHARACTERS]] };
        if (command === 'gh pr view 1') return { ok: true as const, pipeline: [['gh', 'pr', 'view', '1']] };
        if (command.includes('\0')) return { ok: true as const, pipeline: [['echo', 'a\0b'], ['wc', '-c']] };
        return { ok: false as const, reason: 'not a manager command' };
      },
    };
    const result = await f.runner.run({ ...f.spec, allowedTools: ['Read', 'Grep', 'Glob', 'Bash'], bashAllowlist: ['cez-manager'], brokeredShell });
    const responses = JSON.parse(result.text);
    const text = (id: number) => responses.find((r: {id: number}) => r.id === id).result;
    expect(text(216)).toMatchObject({ success: true });
    expect(text(216).contentItems[0].text.trim()).toBe('3');
    expect(text(217).contentItems[0].text.trim()).toBe('2');
    expect(text(221)).toEqual({ success: true, contentItems: [{ type: 'inputText', text: 'stub gh: pr view 1\n' }] });
    // No shell: every metacharacter reaches printf as one literal argument.
    expect(text(219)).toEqual({ success: true, contentItems: [{ type: 'inputText', text: METACHARACTERS }] });
    // A control character is refused before the verifier, like on the read path.
    expect(text(220).contentItems[0].text).toContain('a control character');
    expect(seen.some((command) => command.includes('\0'))).toBe(false);
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
  it.each(['build', 'newer-pre'])('checks native features live on %s (only the exact 0.169.0 build is the static baseline)', async (mode) => {
    const f = setup(mode);
    await f.runner.run(f.spec);
    const lists = f.requests().filter((r: {method: string}) => r.method === 'experimentalFeature/list');
    expect(lists).toHaveLength(2);
    expect(f.requests().find((r: {method: string}) => r.method === 'thread/start').params.config['features.future_native_tool']).toBe(false);
  });
  it('lists the exact 0.169.0 build against the static list only', async () => {
    const f = setup();
    await f.runner.run(f.spec);
    expect(f.requests().some((r: {method: string}) => r.method === 'experimentalFeature/list')).toBe(false);
  });
  it('disables a native feature reported only on the second page of the list', async () => {
    const f = setup('newer-paged');
    await f.runner.run({ ...f.spec, enforceReadOnly: true, allowedTools: ['Read'], bashAllowlist: undefined });
    const lists = f.requests().filter((r: {method: string}) => r.method === 'experimentalFeature/list');
    expect(lists.map((r: {params: {cursor?: string}}) => r.params.cursor)).toEqual([undefined, 'page-2', undefined, 'page-2']);
    expect(f.requests().find((r: {method: string}) => r.method === 'thread/start').params.config['features.future_native_tool']).toBe(false);
  });
  it('keeps a manager\'s gh off GitHub under CEZ_CODEX_NETWORK=0', async () => {
    const f = setup();
    const previous = process.env.CEZ_CODEX_NETWORK;
    process.env.CEZ_CODEX_NETWORK = '0';
    try {
      // A stub gh first on PATH: a regressed guard would run it, never the host's real gh.
      const stubs = join(f.cwd, 'stub-bin');
      mkdirSync(stubs);
      writeFileSync(join(stubs, 'gh'), '#!/bin/sh\necho "stub gh: $*"\n', { mode: 0o755 });
      const brokeredShell = { describe: 'x', env: { PATH: `${stubs}${delimiter}${process.env.PATH}` }, verify: (command: string) => command === 'gh pr view 1'
        ? { ok: true as const, pipeline: [['gh', 'pr', 'view', '1']] } : { ok: false as const, reason: 'no' } };
      const result = await f.runner.run({ ...f.spec, allowedTools: ['Read', 'Bash'], bashAllowlist: undefined, brokeredShell });
      const reply = JSON.parse(result.text).find((r: {id: number}) => r.id === 221).result;
      expect(reply.success).toBe(false);
      expect(reply.contentItems[0].text).toContain('network commands are disabled by CEZ_CODEX_NETWORK=0 (`gh` may reach the network)');
    } finally {
      if (previous === undefined) delete process.env.CEZ_CODEX_NETWORK; else process.env.CEZ_CODEX_NETWORK = previous;
    }
  });
  it('keeps a no-tools invocation empty even when the model requests supported reads', async () => {
    const f = setup();
    const output = await f.runner.run({ ...f.spec, allowedTools: [], bashAllowlist: undefined });
    expect(JSON.parse(output.text).find((r: {id: number}) => r.id === 215).result.success).toBe(false);
  });
});
