import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promises as fs, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackerAssociation } from '@open-mercato/cezar-contract';
import {
  classifyTracker,
  clearTrackerAssociation,
  readTrackerAssociation,
  writeTrackerAssociation,
} from './tracker-association.ts';

const jira: TrackerAssociation = {
  kind: 'jira',
  source: { id: 'cloud-1', webUrl: 'https://acme.atlassian.net' },
  externalId: '10000',
  externalName: 'Platform',
};

const linear: TrackerAssociation = {
  kind: 'linear',
  source: { id: 'org-1', webUrl: 'https://linear.app/acme' },
  externalId: 'team-1',
  externalName: 'Engineering',
};

describe('tracker association persistence', () => {
  let root: string;
  let dataDir: string;
  const path = () => join(dataDir, 'tracker.json');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-tracker-association-'));
    dataDir = join(root, '.ai/cezar');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads absent, malformed, and schema-invalid files as no association', async () => {
    expect(await readTrackerAssociation(dataDir)).toBeNull();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path(), '{ nope', 'utf8');
    expect(await readTrackerAssociation(dataDir)).toBeNull();
    writeFileSync(path(), JSON.stringify({ ...jira, kind: 'unsupported' }), 'utf8');
    expect(await readTrackerAssociation(dataDir)).toBeNull();
    expect(await classifyTracker(dataDir)).toBeUndefined();
  });

  it('preserves unknown stored fields while exposing only the known association', async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path(), JSON.stringify({ ...jira, future: { nested: true }, source: { ...jira.source, futureSource: 42 } }));
    expect(await readTrackerAssociation(dataDir)).toEqual(jira);
    expect(await writeTrackerAssociation(dataDir, { ...jira, externalName: 'Renamed' })).toBe(true);
    expect(JSON.parse(readFileSync(path(), 'utf8'))).toMatchObject({ future: { nested: true }, source: { futureSource: 42 }, externalName: 'Renamed' });
  });

  it('atomically writes and validates a non-secret association', async () => {
    expect(await writeTrackerAssociation(dataDir, jira)).toBe(true);
    expect(await readTrackerAssociation(dataDir)).toEqual(jira);
    expect(await classifyTracker(dataDir)).toBe('jira');
    expect(JSON.parse(readFileSync(path(), 'utf8'))).toEqual(jira);
    expect(readFileSync(path(), 'utf8')).not.toContain('token');
    expect(() => readFileSync(`${path()}.tmp`, 'utf8')).toThrow();
  });

  it('rejects invalid replacement data and preserves the old association', async () => {
    expect(await writeTrackerAssociation(dataDir, jira)).toBe(true);
    const invalid = { ...linear, source: { id: '', webUrl: 'not-https' } } as TrackerAssociation;
    expect(await writeTrackerAssociation(dataDir, invalid)).toBe(false);
    expect(await readTrackerAssociation(dataDir)).toEqual(jira);
  });

  it('preserves the old association when the atomic replacement cannot be written', async () => {
    expect(await writeTrackerAssociation(dataDir, jira)).toBe(true);
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Read-only filesystem'));
    try { expect(await writeTrackerAssociation(dataDir, linear)).toBe(false); }
    finally { rename.mockRestore(); }
    expect(await readTrackerAssociation(dataDir)).toEqual(jira);
    expect(readdirSync(dataDir)).toEqual(['tracker.json']);
  });

  it('does not steal an old lease from a live process', async () => {
    expect(await writeTrackerAssociation(dataDir, jira)).toBe(true);
    const lock = join(dataDir, 'tracker-association.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, String(process.pid)), '');
    utimesSync(lock, new Date(0), new Date(0));
    expect(await writeTrackerAssociation(dataDir, linear)).toBe(false);
    expect(await readTrackerAssociation(dataDir)).toEqual(jira);
  });

  it('reports inaccessible storage as a failed mutation without throwing', async () => {
    expect(await writeTrackerAssociation(dataDir, jira)).toBe(true);
    const mkdir = vi.spyOn(fs, 'mkdir').mockRejectedValue(Object.assign(new Error('read-only'), { code: 'EROFS' }));
    try {
      expect(await writeTrackerAssociation(dataDir, linear)).toBe(false);
      expect(await clearTrackerAssociation(dataDir)).toBe(false);
    } finally { mkdir.mockRestore(); }
    expect(await readTrackerAssociation(dataDir)).toEqual(jira);
  });

  it('clears idempotently and reports a real removal failure', async () => {
    expect(await clearTrackerAssociation(dataDir)).toBe(true);
    expect(await writeTrackerAssociation(dataDir, jira)).toBe(true);
    expect(await clearTrackerAssociation(dataDir)).toBe(true);
    expect(await clearTrackerAssociation(dataDir)).toBe(true);
    expect(await readTrackerAssociation(dataDir)).toBeNull();

    mkdirSync(path(), { recursive: true });
    expect(await clearTrackerAssociation(dataDir)).toBe(false);
  });

  it('serializes concurrent mutations for one project', async () => {
    const results = await Promise.all([
      writeTrackerAssociation(dataDir, jira),
      clearTrackerAssociation(dataDir),
      writeTrackerAssociation(dataDir, linear),
    ]);
    expect(results).toEqual([true, true, true]);
    expect(await readTrackerAssociation(dataDir)).toEqual(linear);
  });
});


describe('tracker association across processes', () => {
  let directory: string;
  const children: ChildProcess[] = [];
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'cez-association-process-')); });
  afterEach(() => {
    for (const child of children.splice(0)) child.kill();
    rmSync(directory, { recursive: true, force: true });
  });
  function worker(operation: string, id: string) {
    const child = fork(fileURLToPath(new URL('./test-fixtures/tracker-association-worker.mjs', import.meta.url)),
      [directory, operation, id], { execArgv: ['--import', 'tsx'], silent: true });
    children.push(child);
    const messages: unknown[] = [];
    let notify: (() => void) | undefined;
    child.on('message', message => { messages.push(message); notify?.(); });
    return {
      child,
      async next(): Promise<unknown> {
        if (!messages.length) await new Promise<void>(resolve => { notify = resolve; });
        notify = undefined;
        return messages.shift();
      },
    };
  }
  it('serializes read/merge/write so successful subprocesses preserve each other’s fields', async () => {
    const a = worker('write', 'A');
    expect(await a.next()).toBe('rename');
    const b = worker('write', 'B');
    const progress = await b.next();
    a.child.send('resume');
    expect(await a.next()).toEqual({ result: true });
    if (progress === 'waiting') expect(await b.next()).toBe('rename');
    b.child.send('resume');
    expect(await b.next()).toEqual({ result: true });
    expect(JSON.parse(readFileSync(join(directory, 'tracker.json'), 'utf8'))).toMatchObject({ externalId: 'B', A: true, B: true });
  });
  it('recovers a lease after its subprocess owner dies', async () => {
    const a = worker('write', 'A');
    expect(await a.next()).toBe('rename');
    const exited = new Promise(resolve => a.child.once('exit', resolve));
    a.child.kill('SIGKILL');
    await exited;
    expect(await writeTrackerAssociation(directory, linear)).toBe(true);
    expect(await readTrackerAssociation(directory)).toEqual(linear);
  });
  it('serializes a subprocess clear after an in-flight write', async () => {
    const a = worker('write', 'A');
    expect(await a.next()).toBe('rename');
    const b = worker('clear', 'B');
    const progress = await b.next();
    a.child.send('resume');
    expect(await a.next()).toEqual({ result: true });
    expect(progress === 'waiting' ? await b.next() : progress).toEqual({ result: true });
    expect(await readTrackerAssociation(directory)).toBeNull();
  });
});
