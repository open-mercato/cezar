import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnCalls: Array<[string, string[]]> = [];
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (file: string, argv: string[]) => (spawnCalls.push([file, argv]), {}) };
});

const { spawnJunieAcp } = await import('./junie-acp-transport.ts');

// a330744e: npm installs junie as `junie.cmd`, which Node refuses to spawn without a shell.
describe('spawnJunieAcp on Windows', () => {
  const platform = process.platform;
  afterEach(() => Object.defineProperty(process, 'platform', { value: platform }));

  it('runs a junie.cmd shim as node <script>', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-junie-shim-'));
    try {
      const script = join(dir, 'node_modules', '@jetbrains', 'junie', 'bin', 'junie.js');
      mkdirSync(join(script, '..'), { recursive: true });
      writeFileSync(script, '');
      writeFileSync(join(dir, 'junie.cmd'), '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@jetbrains\\junie\\bin\\junie.js" %*');
      Object.defineProperty(process, 'platform', { value: 'win32' });
      spawnJunieAcp(join(dir, 'junie.cmd'), dir);
      expect(spawnCalls.at(-1)).toEqual([process.execPath, [script, '--acp=true', '-p', dir]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
