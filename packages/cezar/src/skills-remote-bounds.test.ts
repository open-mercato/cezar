import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFile, spawn, loadConfig } = vi.hoisted(() => {
  vi.resetModules();
  return { execFile: vi.fn(), spawn: vi.fn(), loadConfig: vi.fn() };
});
vi.mock('node:child_process', () => ({ execFile, spawn }));
vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(), existsSync: () => true,
}));
vi.mock('./config.ts', () => ({ loadConfig }));
vi.mock('./skills-cache-state.ts', () => ({ readJsonCache: () => null, writeJsonCache: () => {} }));

import {
  abortTeamSkillsBackgroundWork, getTeamSkillsCached, listRemoteSkills,
  refreshTeamSkills, resetTeamSkillsBackgroundWorkAbort, settleTeamSkillsBackgroundWork,
  waitForTeamSkills,
} from './skills-remote.ts';

const sha = 'a'.repeat(40);
const source = { repo: 'acme/bounds', ref: 'main' };
const cap = 16 * 1024 * 1024;

function batchChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stdin: new PassThrough(),
    kill: vi.fn(() => { queueMicrotask(() => child.emit('close')); return true; }),
  });
  return child;
}
let children: ReturnType<typeof batchChild>[];

function frame(body: string, type = 'blob', name = sha): Buffer {
  return Buffer.from(`${name} ${type} ${Buffer.byteLength(body)}\n${body}\n`);
}

beforeEach(() => {
  children = [];
  resetTeamSkillsBackgroundWorkAbort();
  loadConfig.mockResolvedValue({ skillsRepos: [source] });
  execFile.mockImplementation((_file, args: string[], _opts, callback) => {
    const stdout = args.includes('ls-tree')
      ? `100644 blob ${sha}\tdemo/SKILL.md\n100644 blob ${'b'.repeat(40)}\tpartial/SKILL.md\n`
      : `${sha}\n`;
    queueMicrotask(() => callback(null, stdout, ''));
    return { kill: vi.fn() };
  });
  spawn.mockImplementation(() => {
    const child = batchChild(); children.push(child); return child;
  });
});

afterEach(async () => {
  abortTeamSkillsBackgroundWork();
  await settleTeamSkillsBackgroundWork();
  resetTeamSkillsBackgroundWorkAbort();
  vi.clearAllMocks();
});

describe('batched skill reads', () => {
  it('kills output beyond 16 MiB and keeps only complete blobs within the budget', async () => {
    const pending = listRemoteSkills(source);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    const child = children[0]!;
    const first = frame('kept');
    child.stdout.emit('data', first);
    const incomplete = Buffer.alloc(cap - first.length, 'x');
    incomplete.write(`${'b'.repeat(40)} blob ${cap}\n`);
    child.stdout.emit('data', incomplete);
    expect(child.kill).not.toHaveBeenCalled();
    child.stdout.emit('data', Buffer.from('overflow'));
    child.emit('close');
    const skills = await pending;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(skills.map((skill) => skill.body)).toEqual(['kept']);
  });

  it('keeps complete blobs when the child closes in the middle of another body', async () => {
    const pending = listRemoteSkills(source);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.stdout.emit('data', Buffer.concat([
      frame('kept'), Buffer.from(`${'b'.repeat(40)} blob 100\npartial`),
    ]));
    children[0]!.emit('close');
    expect((await pending).map((skill) => skill.body)).toEqual(['kept']);
  });

  it('skips non-blob bodies without losing the following blob', async () => {
    execFile.mockImplementation((_file, args: string[], _opts, callback) => {
      const stdout = args.includes('ls-tree')
        ? `160000 commit ${'b'.repeat(40)}\tsubmodule/SKILL.md\n100644 blob ${sha}\tdemo/SKILL.md\n`
        : `${sha}\n`;
      queueMicrotask(() => callback(null, stdout, ''));
      return { kill: vi.fn() };
    });
    const pending = listRemoteSkills(source);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    const child = children[0]!;
    child.stdout.emit('data', Buffer.concat([frame('commit body', 'commit', 'b'.repeat(40)), frame('blob body')]));
    child.emit('close');
    expect((await pending).map((skill) => skill.name)).toEqual(['demo']);
  });

  it('aborts a cat-file child and settles its background load promptly', async () => {
    const pending = waitForTeamSkills('/bounds/abort');
    await vi.waitFor(() => expect(children).toHaveLength(1));
    abortTeamSkillsBackgroundWork();
    try {
      expect(children[0]!.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      children[0]!.emit('close');
    }
    await settleTeamSkillsBackgroundWork();
    expect(await pending).toEqual([]);
  });

  it('keeps a newer refresh cached when the superseded passive load finishes last', async () => {
    const root = '/bounds/supersede';
    const stale = waitForTeamSkills(root);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    const fresh = refreshTeamSkills(root);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1]!.stdout.emit('data', frame('fresh'));
    children[1]!.emit('close');
    expect((await fresh)[0]?.body).toBe('fresh');
    children[0]!.stdout.emit('data', frame('stale'));
    children[0]!.emit('close');
    expect((await stale)[0]?.body).toBe('stale');
    expect(getTeamSkillsCached(root)[0]?.body).toBe('fresh');
    expect((await waitForTeamSkills(root))[0]?.body).toBe('fresh');
    expect(children).toHaveLength(2);
  });
});
