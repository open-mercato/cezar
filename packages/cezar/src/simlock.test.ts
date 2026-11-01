import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { releaseSimlockLeases, simlockAgentEnv, simlockAgentId, simlockAvailable, type SimlockExec } from './simlock.ts';

describe('simlock discovery', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(realpathSync(tmpdir()), 'cez-simlock-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const install = () => {
    writeFileSync(join(dir, 'simlock'), '#!/bin/sh\n');
    chmodSync(join(dir, 'simlock'), 0o755);
  };

  it('adds nothing when simlock is absent, including with no PATH at all', () => {
    expect(simlockAgentEnv('r1', { PATH: dir })).toEqual({});
    expect(simlockAgentEnv('r1', {})).toEqual({});
  });

  it('gives each task its own identity once simlock is on PATH', () => {
    install();
    expect(simlockAgentEnv('r1', { PATH: dir })).toEqual({ SIMLOCK_AGENT_ID: 'cezar:r1', AGENT_DEVICE_SESSION: 'cezar-r1' });
    expect(simlockAgentEnv('r2', { PATH: dir }).SIMLOCK_AGENT_ID).not.toBe(simlockAgentEnv('r1', { PATH: dir }).SIMLOCK_AGENT_ID);
  });

  it('honours the opt-out and the dry run', () => {
    install();
    expect(simlockAvailable({ PATH: dir, CEZ_SIMLOCK: '0' })).toBe(false);
    expect(simlockAvailable({ PATH: dir, CEZ_DRY_RUN: '1' })).toBe(false);
    expect(simlockAvailable({ PATH: dir, CEZ_SIMLOCK: '1' })).toBe(true);
  });

  it('is not fooled by a non-executable file or a directory of that name', () => {
    writeFileSync(join(dir, 'simlock'), 'x');
    chmodSync(join(dir, 'simlock'), 0o644);
    expect(simlockAvailable({ PATH: dir })).toBe(false);
    rmSync(join(dir, 'simlock'));
    mkdirSync(join(dir, 'simlock'));
    expect(simlockAvailable({ PATH: dir })).toBe(false);
  });
});

describe('releaseSimlockLeases', () => {
  const fake = (answers: Record<string, string | Error>) => {
    const calls: string[] = [];
    const exec: SimlockExec = async (args) => {
      const key = args.join(' ');
      calls.push(key);
      const answer = answers[key] ?? answers[args[0]!];
      if (answer instanceof Error) throw answer;
      return answer ?? '';
    };
    return { calls, exec };
  };
  const running = JSON.stringify({ devices: [], leases: [], capacity: {} }); // shape of simlock 0.4.0
  const leases = JSON.stringify([
    { id: 'lse_mine', requesterId: simlockAgentId('r1'), deviceId: 'd1' },
    { id: 'lse_child', requesterId: simlockAgentId('r1-child') },
    { id: 'lse_human', requesterId: 'claude-code:abc' },
  ]);

  it('releases only the leases this task holds', async () => {
    const { calls, exec } = fake({ 'daemon status --json': running, 'list --leases': leases, release: '{}' });
    await expect(releaseSimlockLeases('r1', exec)).resolves.toEqual(['lse_mine']);
    expect(calls).toEqual(['daemon status --json', 'list --leases', 'release lse_mine']);
  });

  it('never starts a stopped daemon', async () => {
    const { calls, exec } = fake({ 'daemon status --json': JSON.stringify({ status: 'stopped' }) });
    await expect(releaseSimlockLeases('r1', exec)).resolves.toEqual([]);
    expect(calls).toEqual(['daemon status --json']);
  });

  it('reports only the releases that worked', async () => {
    const { exec } = fake({ 'daemon status --json': running, 'list --leases': leases, release: new Error('gone') });
    await expect(releaseSimlockLeases('r1', exec)).resolves.toEqual([]);
  });

  it.each([
    ['a failing CLI', new Error('FORBIDDEN')],
    ['unparseable output', 'not json'],
    ['an unknown shape', JSON.stringify({ leases: 'x' })],
  ])('degrades on %s', async (_name, answer) => {
    const { exec } = fake({ 'daemon status --json': running, 'list --leases': answer });
    await expect(releaseSimlockLeases('r1', exec)).resolves.toEqual([]);
  });
});
