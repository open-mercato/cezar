import { chmodSync, copyFileSync, statSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DISCLAIM_EXEC_FLAG, disclaimedCommand } from './disclaim-spawn.ts';

const dir = mkdtempSync(join(tmpdir(), 'cez-disclaim-'));
const exe = (name: string, body: string | Buffer = '#!/bin/sh\n') => {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
};
const trampoline = exe('Cezar');
const claude = exe('claude');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const cloneDir = join(dir, 'clones');
const darwin = { platform: 'darwin' as const, hostEnv: { CEZ_DISCLAIM_EXEC: trampoline }, cloneDir };

describe('disclaimedCommand', () => {
  it('routes an agent through the desktop trampoline, resolved on the child PATH', () => {
    expect(disclaimedCommand('claude', ['-p', 'x'], { PATH: `/nowhere:${dir}` }, darwin))
      .toEqual([trampoline, [DISCLAIM_EXEC_FLAG, claude, '-p', 'x']]);
    expect(disclaimedCommand(claude, [], {}, darwin)).toEqual([trampoline, [DISCLAIM_EXEC_FLAG, claude]]);
  });

  it('leaves the command alone outside the desktop app and off macOS', () => {
    expect(disclaimedCommand('claude', ['-p'], { PATH: dir }, { platform: 'darwin', hostEnv: {} })).toEqual(['claude', ['-p']]);
    expect(disclaimedCommand('claude', ['-p'], { PATH: dir }, { ...darwin, platform: 'linux' })).toEqual(['claude', ['-p']]);
    expect(disclaimedCommand('claude', [], { PATH: dir }, { platform: 'darwin', hostEnv: { CEZ_DISCLAIM_EXEC: join(dir, 'gone') } }))
      .toEqual(['claude', []]);
  });

  it('keeps a missing program a plain spawn, so ENOENT and its install hint survive', () => {
    expect(disclaimedCommand('codex', ['app-server'], { PATH: dir }, darwin)).toEqual(['codex', ['app-server']]);
    expect(disclaimedCommand('./claude', [], { PATH: dir }, darwin)).toEqual(['./claude', []]);
  });

  // `cp -c` is macOS-only, so the tests clone with a plain copy; the TCC grant itself is not testable here.
  const clone = (from: string, to: string) => copyFileSync(from, to);
  const machO = (body: number) => Buffer.from([0xcf, 0xfa, 0xed, 0xfe, body]);
  const spawnPath = (bin: string) => disclaimedCommand('claude', ['-p'], { PATH: bin }, { ...darwin, clone });

  it('runs a version-named Mach-O from a clone at a path stable across agent updates (#1696)', () => {
    const root = mkdtempSync(join(dir, 'upd-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const v1 = join(root, '2.1.295');
    writeFileSync(v1, machO(1));
    chmodSync(v1, 0o755);
    symlinkSync(v1, join(bin, 'claude'));
    const [file, argv] = spawnPath(bin);
    expect(file).toBe(trampoline);
    expect(argv[1]).toBe(join(cloneDir, 'claude', 'claude'));
    expect(readFileSync(argv[1]!)).toEqual(machO(1));
    expect(argv.slice(2)).toEqual(['-p']);
    const ino = statSync(argv[1]!).ino;
    // Same agent file: the clone is reused, not rewritten.
    expect(spawnPath(bin)[1][1]).toBe(argv[1]);
    expect(statSync(argv[1]!).ino).toBe(ino);

    // The agent updates: a new file, size and mtime. The path must not move, the content must.
    const v2 = join(root, '2.1.300');
    writeFileSync(v2, Buffer.concat([machO(2), Buffer.from('more')]));
    chmodSync(v2, 0o755);
    rmSync(join(bin, 'claude'));
    symlinkSync(v2, join(bin, 'claude'));
    const after = spawnPath(bin)[1][1];
    expect(after).toBe(argv[1]);
    expect(readFileSync(after!)).toEqual(Buffer.concat([machO(2), Buffer.from('more')]));
    // Refreshed by rename, so a process still running the old clone keeps its inode.
    expect(statSync(after!).ino).not.toBe(ino);
    expect(readdirSync(join(cloneDir, 'claude')).filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps one clone directory per agent, so one Allow does not cover another agent', () => {
    const root = mkdtempSync(join(dir, 'two-'));
    for (const n of ['2.1.1', '3.0.0']) writeFileSync(join(root, n), machO(9)), chmodSync(join(root, n), 0o755);
    symlinkSync(join(root, '2.1.1'), join(root, 'claude'));
    symlinkSync(join(root, '3.0.0'), join(root, 'codex'));
    const opts = { ...darwin, clone };
    const a = disclaimedCommand('claude', [], { PATH: root }, opts)[1][1];
    const b = disclaimedCommand('codex', [], { PATH: root }, opts)[1][1];
    expect(a).toBe(join(cloneDir, 'claude', 'claude'));
    expect(b).toBe(join(cloneDir, 'codex', 'codex'));
  });

  it('removes the legacy per-version slots once and falls back when the clone fails', () => {
    const legacy = join(cloneDir, 'claude-0123456789abcdef');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'claude'), 'old');
    const root = mkdtempSync(join(dir, 'leg-'));
    writeFileSync(join(root, '1.0.0'), machO(5));
    chmodSync(join(root, '1.0.0'), 0o755);
    symlinkSync(join(root, '1.0.0'), join(root, 'claude'));
    spawnPath(root);
    expect(existsSync(legacy)).toBe(false);
    const broken = disclaimedCommand('claude', [], { PATH: root }, { ...darwin, cloneDir: join(dir, 'broken'), clone: () => { throw new Error('no clonefile'); } });
    expect(broken[1][1]).toBe(join(root, 'claude'));
  });

  it('never moves a script, which may find its siblings by its own path', () => {
    mkdirSync(join(dir, 'pkg'));
    const script = exe('pkg/index.sh');
    mkdirSync(join(dir, 'sbin'));
    symlinkSync(script, join(dir, 'sbin', 'cursor-agent'));
    const link = join(dir, 'sbin', 'cursor-agent');
    expect(disclaimedCommand('cursor-agent', [], { PATH: join(dir, 'sbin') }, darwin)).toEqual([trampoline, [DISCLAIM_EXEC_FLAG, link]]);
    expect(existsSync(cloneDir) && readdirSync(cloneDir).some((e) => e.startsWith('cursor-agent'))).toBe(false);
  });

  it('runs a Node script on its node, so the prompt does not say "node"', () => {
    mkdirSync(join(dir, 'npm'));
    const node = exe('npm/node', Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
    const pi = exe('npm/pi', '#!/usr/bin/env node\nconsole.log(1)\n');
    const flagged = exe('npm/flagged', `#!/usr/bin/env -S node --no-warnings\n`);
    const [, argv] = disclaimedCommand('pi', ['--mode', 'rpc'], { PATH: join(dir, 'npm') }, darwin);
    expect(argv.slice(2)).toEqual([pi, '--mode', 'rpc']);
    if (process.platform === 'darwin') expect(argv[1]).toMatch(/\/clones\/pi-[0-9a-f]{16}\/pi$/);
    else expect(argv[1]).toBe(node);
    expect(disclaimedCommand(flagged, [], { PATH: join(dir, 'npm') }, darwin)[1].slice(2)).toEqual(['--no-warnings', flagged]);
  });

  it('never renames a node that is really a Volta or mise shim', () => {
    mkdirSync(join(dir, 'volta'));
    const shim = exe('volta/volta-shim', Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
    symlinkSync(shim, join(dir, 'volta', 'node'));
    const tool = exe('volta/tool', '#!/usr/bin/env node\n');
    expect(disclaimedCommand(tool, ['-p'], { PATH: join(dir, 'volta') }, darwin)).toEqual([trampoline, [DISCLAIM_EXEC_FLAG, tool, '-p']]);
  });

  it('leaves a script whose node cannot be found, and a bash launcher, as they are', () => {
    mkdirSync(join(dir, 'lone'));
    const lone = exe('lone/tool', '#!/usr/bin/env node\n');
    expect(disclaimedCommand(lone, [], { PATH: join(dir, 'lone') }, darwin)).toEqual([trampoline, [DISCLAIM_EXEC_FLAG, lone]]);
    const bash = exe('lone/launcher', '#!/usr/bin/env bash\nexec node x\n');
    expect(disclaimedCommand(bash, [], { PATH: join(dir, 'npm') }, darwin)).toEqual([trampoline, [DISCLAIM_EXEC_FLAG, bash]]);
  });
});
