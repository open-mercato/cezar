import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverCommands, parseMakefileTargets, parsePackageScripts } from './commands.ts';

describe('parsePackageScripts', () => {
  it('offers each script as the command a user would type, in file order', () => {
    const text = JSON.stringify({ scripts: { dev: 'vite', 'test:unit': 'vitest run' } });
    expect(parsePackageScripts(text)).toEqual([
      { command: 'npm run dev', source: 'package.json', detail: 'vite' },
      { command: 'npm run test:unit', source: 'package.json', detail: 'vitest run' },
    ]);
  });

  it('skips a name that would not survive a shell, rather than quoting it into something else', () => {
    const text = JSON.stringify({ scripts: { 'oops; rm -rf /': 'nope', ok: 'echo ok' } });
    expect(parsePackageScripts(text).map((entry) => entry.command)).toEqual(['npm run ok']);
  });

  it('is empty for a manifest with no scripts, and for junk', () => {
    expect(parsePackageScripts(JSON.stringify({ name: 'x' }))).toEqual([]);
    expect(parsePackageScripts('not json')).toEqual([]);
    expect(parsePackageScripts('null')).toEqual([]);
  });

  it('caps a generated manifest so the picker stays a picker', () => {
    const scripts = Object.fromEntries(Array.from({ length: 200 }, (_, n) => [`s${n}`, 'x']));
    expect(parsePackageScripts(JSON.stringify({ scripts })).length).toBeLessThanOrEqual(40);
  });
});

describe('parseMakefileTargets', () => {
  it('recognises the targets a human would have run', () => {
    const make = ['dev:', '\tnpm run dev', '', 'build: dev', '\techo build'].join('\n');
    expect(parseMakefileTargets(make).map((entry) => entry.command)).toEqual(['make dev', 'make build']);
  });

  it('leaves variables, special targets and recipes alone', () => {
    const make = ['.PHONY: dev', 'CC := gcc', '%.o: %.c', '\techo recipe', 'real:', '\techo hi'].join('\n');
    expect(parseMakefileTargets(make).map((entry) => entry.command)).toEqual(['make real']);
  });

  it('lists a repeated target once', () => {
    expect(parseMakefileTargets('dev:\n\techo a\ndev:\n\techo b')).toHaveLength(1);
  });
});

describe('discoverCommands', () => {
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'cez-commands-'));
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  it('reads both sources and says where each came from', async () => {
    writeFileSync(join(worktree, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    writeFileSync(join(worktree, 'Makefile'), 'serve:\n\techo serving\n');
    expect(await discoverCommands(worktree)).toEqual([
      { command: 'npm run dev', source: 'package.json', detail: 'vite' },
      { command: 'make serve', source: 'Makefile' },
    ]);
  });

  it('offers nothing, rather than failing, for a project with neither', async () => {
    expect(await discoverCommands(worktree)).toEqual([]);
  });

  it('survives a worktree that is not there', async () => {
    expect(await discoverCommands(join(worktree, 'gone'))).toEqual([]);
  });

  it('survives a malformed manifest', async () => {
    writeFileSync(join(worktree, 'package.json'), '{ broken');
    expect(await discoverCommands(worktree)).toEqual([]);
  });
});
