import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FleetJob } from '@open-mercato/cezar-contract';
import { loadJobs, saveJobs } from './jobs-store.ts';

const job: FleetJob = {
  id: 'j1', repoUrl: 'a/b', task: 't', openPr: true, status: 'pending', attempts: 0,
  createdAt: '2026-10-21T12:00:00.000Z', updatedAt: '2026-10-21T12:00:00.000Z',
};
const tmp = () => join(mkdtempSync(join(tmpdir(), 'cez-fleet-')), 'fleet', 'jobs.json');

describe('fleet jobs store', () => {
  it('round-trips jobs through an atomic write', () => {
    const path = tmp();
    saveJobs([job], path);
    expect(loadJobs(path)).toEqual([job]);
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1);
  });

  it('starts fresh when the file is missing', () => {
    expect(loadJobs(tmp())).toEqual([]);
  });

  it('degrades a corrupt file to an empty queue with one warning', () => {
    const path = tmp();
    saveJobs([], path);
    writeFileSync(path, '{ not json');
    const warn = vi.fn();
    expect(loadJobs(path, warn)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the good rows when one entry is bad', () => {
    const path = tmp();
    saveJobs([], path);
    writeFileSync(path, JSON.stringify({ version: 1, jobs: [job, { id: 5 }] }));
    expect(loadJobs(path)).toEqual([job]);
  });
});
