import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareRestrictedCodexHome } from './codex-restricted-home.ts';
import { compileCodexRestrictedPolicy, CODEX_READ_PREFIXES } from './codex-restricted-policy.ts';
import { CodexReadBroker } from './codex-restricted-tools.ts';
const dirs: string[] = [];
const brokers: CodexReadBroker[] = [];
afterEach(() => { for (const b of brokers.splice(0)) b.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(tools = ['Read', 'Grep', 'Glob', 'Bash']) {
  const root = mkdtempSync(join(tmpdir(), 'cez-read-broker-')); dirs.push(root);
  const cwd = join(root, 'repo'); mkdirSync(cwd);
  const native = join(root, 'native'); mkdirSync(native);
  writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\n');
  const home = prepareRestrictedCodexHome({ cwd }, { HOME: root, CEZ_HOME: join(root, 'cezar'), CODEX_HOME: native });
  const broker = new CodexReadBroker(compileCodexRestrictedPolicy({ allowedTools: tools, bashAllowlist: [...CODEX_READ_PREFIXES] })!, { cwd }, home.toolEnv);
  brokers.push(broker);
  const call = (arguments_: unknown, tool = 'cezar_read') => broker.call({ tool, arguments: arguments_ });
  return { root, cwd, home, broker, call };
}
describe.skipIf(process.platform === 'win32')('cezar executes restricted reads', () => {
  it('reads regular files and refuses symlink escapes, devices and write-shaped payloads', async () => {
    const f = setup();
    expect((await f.call({ tool: 'Read', path: 'a.txt', offset: 2, limit: 1 })).contentItems[0]?.text).toBe('two');
    writeFileSync(join(f.root, 'outside'), 'secret'); symlinkSync(join(f.root, 'outside'), join(f.cwd, 'link'));
    for (const payload of [{ tool: 'Read', path: 'link' }, { tool: 'Read', path: '../outside' }, { tool: 'Read', path: '.' }, { tool: 'Write', path: 'a.txt', content: 'bad' }, { tool: 'Read', path: 'a.txt', command: 'touch x' }]) expect((await f.call(payload)).success).toBe(false);
    expect(readFileSync(join(f.cwd, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
    execFileSync('mkfifo', [join(f.cwd, 'pipe')], { timeout: 5_000 });
    expect((await f.call({ tool: 'Read', path: 'pipe' })).success).toBe(false);
  });
  it('executes approved GitHub reads as argv and never invokes the binary for a mutation', async () => {
    const f = setup();
    const bin = join(f.root, 'bin'); mkdirSync(bin);
    const log = join(f.root, 'calls');
    const executable = join(bin, 'gh');
    writeFileSync(executable, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.PROBE_LOG, JSON.stringify(process.argv.slice(2))+'\\n');\nprocess.stdout.write('read-only diff');\n`);
    chmodSync(executable, 0o755);
    const broker = new CodexReadBroker(compileCodexRestrictedPolicy({ allowedTools: ['Read', 'Bash'], bashAllowlist: ['gh pr diff', 'gh repo view'] })!, { cwd: f.cwd }, { ...f.home.toolEnv, PATH: `${bin}:${f.home.toolEnv.PATH}`, PROBE_LOG: log });
    brokers.push(broker);
    execFileSync('git', ['init', '-q'], { cwd: f.cwd, timeout: 5_000 });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], { cwd: f.cwd, timeout: 5_000 });
    expect((await broker.call({ tool: 'cezar_read', arguments: { tool: 'Bash', command: 'gh pr diff 3' } })).contentItems[0]?.text).toBe('read-only diff');
    for (const command of ['gh pr merge 3', 'gh pr diff 3; gh pr merge 3', 'gh pr diff 3 --web', 'gh api repos/o/r -X DELETE', 'gh pr diff https://evil.example/o/r/pull/3', 'gh pr diff 3 -R evil.example/o/r', 'gh repo view evil.example/o/r', 'gh repo view -- evil.example/o/r']) expect((await broker.call({ tool: 'cezar_read', arguments: { tool: 'Bash', command } })).success).toBe(false);
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://evil.example/o/r.git'], { cwd: f.cwd, timeout: 5_000 });
    expect((await broker.call({ tool: 'cezar_read', arguments: { tool: 'Bash', command: 'gh pr diff 3' } })).success).toBe(false);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['["pr","diff","3"]']);
  });
  it('truncates an oversized read result instead of failing it', async () => {
    const f = setup();
    const bin = join(f.root, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!${process.execPath}\nprocess.stdout.write('x'.repeat(400_000));\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    const broker = new CodexReadBroker(compileCodexRestrictedPolicy({ allowedTools: ['Read', 'Bash'], bashAllowlist: ['gh pr diff'] })!, { cwd: f.cwd }, { ...f.home.toolEnv, PATH: `${bin}:${f.home.toolEnv.PATH}` });
    brokers.push(broker);
    execFileSync('git', ['init', '-q'], { cwd: f.cwd, timeout: 5_000 });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], { cwd: f.cwd, timeout: 5_000 });
    const res = await broker.call({ tool: 'cezar_read', arguments: { tool: 'Bash', command: 'gh pr diff 3' } });
    expect(res.success).toBe(true);
    expect(res.contentItems[0]?.text).toMatch(/^x{64000}\n\[cezar: output truncated/);
  });
  it('fails a GitHub read when the remote list overflows instead of validating a truncated list', async () => {
    const f = setup();
    const bin = join(f.root, 'bin'); mkdirSync(bin);
    const log = join(f.root, 'calls');
    writeFileSync(join(bin, 'gh'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.PROBE_LOG, 'called');\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    const broker = new CodexReadBroker(compileCodexRestrictedPolicy({ allowedTools: ['Read', 'Bash'], bashAllowlist: ['gh pr diff'] })!, { cwd: f.cwd }, { ...f.home.toolEnv, PATH: `${bin}:${f.home.toolEnv.PATH}`, PROBE_LOG: log });
    brokers.push(broker);
    execFileSync('git', ['init', '-q'], { cwd: f.cwd, timeout: 5_000 });
    const remotes = Array.from({ length: 3_000 }, (_, i) => `[remote "r${i}"]\n\turl = https://github.com/o/repository-with-a-long-name-${i}.git\n`).join('');
    writeFileSync(join(f.cwd, '.git/config'), readFileSync(join(f.cwd, '.git/config'), 'utf8') + remotes + '[remote "zz"]\n\turl = https://evil.example/o/r.git\n');
    const res = await broker.call({ tool: 'cezar_read', arguments: { tool: 'Bash', command: 'gh pr diff 3' } });
    expect(res.success).toBe(false);
    expect(res.contentItems[0]?.text).toMatch(/maxBuffer/);
    expect(existsSync(log)).toBe(false);
  });
  it('honors the existing network-off setting for brokered GitHub reads', async () => {
    const f = setup();
    const broker = new CodexReadBroker(compileCodexRestrictedPolicy({ allowedTools: ['Read', 'Bash'], bashAllowlist: ['gh pr diff'] })!, { cwd: f.cwd }, f.home.toolEnv, false);
    brokers.push(broker);
    expect((await broker.call({ tool: 'cezar_read', arguments: { tool: 'Bash', command: 'gh pr diff 3' } })).contentItems[0]?.text).toContain('CEZ_CODEX_NETWORK=0');
  });
  it('keeps real git status read-only and prevents a configured fsmonitor from executing', async () => {
    const f = setup();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.cwd, stdio: 'pipe', timeout: 10_000 });
    git('init', '-q'); git('add', 'a.txt');
    const marker = join(f.root, 'executed');
    const hook = join(f.root, 'evil'); writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(hook, 0o755);
    git('config', 'core.fsmonitor', hook);
    const before = statSync(join(f.cwd, '.git/index')).mtimeMs;
    expect((await f.call({ tool: 'Bash', command: 'git status --short' })).success).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(statSync(join(f.cwd, '.git/index')).mtimeMs).toBe(before);
  });
  it('never launches an executor for forbidden commands, MCP, or missing grants', async () => {
    const f = setup(); const marker = join(f.cwd, 'FORBIDDEN');
    for (const command of ['touch FORBIDDEN', 'git push', 'gh pr merge 3', 'gh pr comment 3 --body x', 'git status; touch FORBIDDEN', 'sh -c "touch FORBIDDEN"', 'gh pr view 3 --web']) expect((await f.call({ tool: 'Bash', command })).success).toBe(false);
    expect((await f.call({ tool: 'Read', path: 'a.txt' }, 'mcp__publish')).success).toBe(false);
    const read = setup(['Read']); expect((await read.call({ tool: 'Bash', command: 'git status' })).success).toBe(false);
    expect(existsSync(marker)).toBe(false);
    f.broker.close(); expect((await f.call({ tool: 'Read', path: 'a.txt' })).success).toBe(false);
  });
});
