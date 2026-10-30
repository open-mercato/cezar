import { chmodSync, copyFileSync, existsSync, statSync, utimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  it.skipIf(process.platform !== 'darwin')('runs a version-named Mach-O from a clone named after the agent', () => {
    mkdirSync(join(dir, 'versions'));
    mkdirSync(join(dir, 'bin'));
    const real = exe('versions/2.1.295', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]));
    symlinkSync(real, join(dir, 'bin', 'claude'));
    const [file, argv] = disclaimedCommand('claude', ['-p'], { PATH: join(dir, 'bin') }, darwin);
    expect(file).toBe(trampoline);
    expect(argv[1]).toMatch(/\/clones\/claude-[0-9a-f]{12}\/claude$/);
    expect(readFileSync(argv[1]!)).toEqual(readFileSync(real));
    expect(argv.slice(2)).toEqual(['-p']);
    // Stable across spawns: the second call reuses the first clone.
    expect(disclaimedCommand('claude', ['-p'], { PATH: join(dir, 'bin') }, darwin)[1][1]).toBe(argv[1]);
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
    if (process.platform === 'darwin') expect(argv[1]).toMatch(/\/clones\/pi-[0-9a-f]{12}\/pi$/);
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

  describe('clone slot across agent updates (#1696)', () => {
    const macho = (tag: string) => Buffer.from([0xcf, 0xfa, 0xed, 0xfe, ...Buffer.from(tag)]);
    const clones = join(dir, 'upd-clones');
    const env = (bin: string) => ({ PATH: bin });
    const opts = { ...darwin, cloneDir: clones, cloneFile: copyFileSync };
    const install = (bin: string, version: string, tag: string) => {
      mkdirSync(join(bin, '..', 'versions'), { recursive: true });
      mkdirSync(bin, { recursive: true });
      const real = exe(`${bin.slice(dir.length + 1)}/../versions/${version}`, macho(tag));
      rmSync(join(bin, 'claude'), { force: true });
      symlinkSync(real, join(bin, 'claude'));
      return real;
    };
    const spawnPath = (bin: string) => disclaimedCommand('claude', [], env(bin), opts)[1][1]!;

    it('keeps the same path when the agent moves to a new version, and refreshes the content', () => {
      const bin = join(dir, 'upd1', 'bin');
      install(bin, '2.1.1', 'old');
      const before = spawnPath(bin);
      expect(before).toContain('upd-clones');
      const oldInode = statSync(before).ino;
      expect(readFileSync(before).toString()).toContain('old');
      install(bin, '2.1.2', 'new');
      const after = spawnPath(bin);
      expect(after).toBe(before);
      expect(readFileSync(after).toString()).toContain('new');
      // Replaced by rename, not rewritten: a running agent keeps the old inode.
      expect(statSync(after).ino).not.toBe(oldInode);
    });

    it('reuses an up-to-date clone without cloning again', () => {
      const bin = join(dir, 'upd2', 'bin');
      install(bin, '2.1.1', 'x');
      let clonesMade = 0;
      const counting = { ...opts, cloneFile: (a: string, b: string) => { clonesMade++; copyFileSync(a, b); } };
      disclaimedCommand('claude', [], env(bin), counting);
      disclaimedCommand('claude', [], env(bin), counting);
      expect(clonesMade).toBe(1);
    });

    it('refreshes when only the mtime of the same-named build changes', () => {
      const bin = join(dir, 'upd3', 'bin');
      const real = install(bin, '2.1.1', 'same');
      const first = spawnPath(bin);
      utimesSync(real, new Date(), new Date(Date.now() + 5000));
      let clonesMade = 0;
      disclaimedCommand('claude', [], env(bin), { ...opts, cloneFile: (a, b) => { clonesMade++; copyFileSync(a, b); } });
      expect(clonesMade).toBe(1);
      expect(spawnPath(bin)).toBe(first);
    });

    it('gives different installs of the same agent name different slots', () => {
      const a = install(join(dir, 'upd4a', 'bin'), '1.0.0', 'a');
      const b = install(join(dir, 'upd4b', 'bin'), '1.0.0', 'b');
      const pa = spawnPath(join(dir, 'upd4a', 'bin'));
      const pb = spawnPath(join(dir, 'upd4b', 'bin'));
      expect(pa).not.toBe(pb);
      expect(readFileSync(pa).toString()).toContain('a');
      expect(readFileSync(pb).toString()).toContain('b');
      expect([a, b]).toHaveLength(2);
    });

    it('removes legacy per-version slots once, and leaves other agents alone', () => {
      const bin = join(dir, 'upd5', 'bin');
      install(bin, '2.1.1', 'q');
      mkdirSync(join(clones, 'claude-0123456789abcdef'), { recursive: true });
      mkdirSync(join(clones, 'codex-0123456789abcdef'), { recursive: true });
      spawnPath(bin);
      expect(existsSync(join(clones, 'claude-0123456789abcdef'))).toBe(false);
      expect(existsSync(join(clones, 'codex-0123456789abcdef'))).toBe(true);
    });

    it('falls back to the resolved path when cloning fails, and leaves no half-made target', () => {
      const bin = join(dir, 'upd6', 'bin');
      install(bin, '2.1.1', 'z');
      const failing = { ...opts, cloneDir: join(dir, 'fail-clones'), cloneFile: () => { throw new Error('EXDEV'); } };
      expect(disclaimedCommand('claude', [], env(bin), failing)[1][1]).toBe(join(bin, 'claude'));
    });
  });
});
