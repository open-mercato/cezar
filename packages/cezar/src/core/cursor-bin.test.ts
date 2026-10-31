import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isForeignCursorAgent, resolveCursorAgentBin } from './cursor-bin.ts';

let root: string;

function executable(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\n');
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cursor-bin-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('resolveCursorAgentBin', () => {
  // Telemetry 8d304c50: a foreign `agent` earlier on PATH than Cursor's own links.
  it('prefers cursor-agent over an `agent` that comes first on PATH', () => {
    const foreign = join(root, 'foreign');
    const cursor = join(root, 'cursor');
    executable(foreign, 'agent');
    executable(cursor, 'agent');
    executable(cursor, 'cursor-agent');
    const env = { PATH: `${foreign}:${cursor}` };
    expect(resolveCursorAgentBin(undefined, env, root, 'darwin')).toBe('cursor-agent');
  });

  it('falls back to `agent` when only that name is on PATH', () => {
    executable(join(root, 'bin'), 'agent');
    expect(resolveCursorAgentBin(undefined, { PATH: join(root, 'bin') }, root, 'linux')).toBe('agent');
  });

  it('finds the installer link off PATH', () => {
    const installed = executable(join(root, '.local', 'bin'), 'cursor-agent');
    expect(resolveCursorAgentBin(undefined, { PATH: join(root, 'empty') }, root, 'darwin')).toBe(installed);
  });

  it('prefers the installer link off PATH over a foreign `agent` on PATH', () => {
    executable(join(root, 'foreign'), 'agent');
    const installed = executable(join(root, '.local', 'bin'), 'cursor-agent');
    expect(resolveCursorAgentBin(undefined, { PATH: join(root, 'foreign') }, root, 'darwin')).toBe(installed);
  });

  it('answers a bare `agent` when nothing is installed, so the spawn reports not-installed', () => {
    expect(resolveCursorAgentBin(undefined, { PATH: join(root, 'empty') }, root, 'darwin')).toBe('agent');
  });

  it('returns an explicit binary or CEZ_CURSOR_AGENT_BIN verbatim', () => {
    executable(join(root, 'bin'), 'cursor-agent');
    const env = { PATH: join(root, 'bin'), CEZ_CURSOR_AGENT_BIN: '/opt/agent' };
    expect(resolveCursorAgentBin('/x/agent', env, root, 'darwin')).toBe('/x/agent');
    expect(resolveCursorAgentBin(undefined, env, root, 'darwin')).toBe('/opt/agent');
  });

  it('keeps the bare name on Windows', () => {
    expect(resolveCursorAgentBin(undefined, { PATH: '' }, root, 'win32')).toBe('agent');
  });
});

describe('isForeignCursorAgent', () => {
  it.each([
    ['agent', '0.2.22', {}, true],
    ['agent', '2026.01.28-fd13201', {}, false],
    ['agent', '2025.9.12', {}, false],
    ['agent', null, {}, false],
    ['agent', '0.2.22', { CEZ_CURSOR_AGENT_BIN: 'agent' }, false],
    ['cursor-agent', '0.2.22', {}, false],
  ])('%s answering %s (env %j) → %s', (executable, version, env, expected) => {
    expect(isForeignCursorAgent(executable, version, env)).toBe(expected);
  });
});
