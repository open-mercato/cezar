import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ManagerChange } from '@open-mercato/cezar-contract';
import { changeLogPath, ManagerChangeLog } from './change-log.ts';

const entry = (n: number, overrides: Partial<ManagerChange> = {}): ManagerChange => ({
  id: `c${n}`, at: `2026-11-20T00:00:${String(n).padStart(2, '0')}.000Z`, managerId: 'm1', managerName: 'Scout',
  type: 'merge-pr', kind: 'proposal', summary: `Merge of alpha#${n}`, outcome: 'done', by: 'user', ...overrides,
});

describe('the manager change log (spec 2026-11-20-manager-admin-actions § 3.3)', () => {
  let home: string;
  const saved = { CEZ_HOME: process.env.CEZ_HOME, SECRET: process.env.CHANGE_LOG_TEST_API_KEY };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-change-log-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => {
    process.env.CEZ_HOME = saved.CEZ_HOME;
    if (saved.SECRET === undefined) delete process.env.CHANGE_LOG_TEST_API_KEY;
    rmSync(home, { recursive: true, force: true });
  });

  it('lives in ~/.cezar and lists newest first, filtered by manager', () => {
    const log = new ManagerChangeLog();
    log.append(entry(1));
    log.append(entry(2, { managerId: 'm2' }));
    log.append(entry(3));
    expect(changeLogPath()).toBe(join(home, 'admin-audit.ndjson'));
    expect(log.list().map((change) => change.id)).toEqual(['c3', 'c2', 'c1']);
    expect(log.list({ managerId: 'm1' }).map((change) => change.id)).toEqual(['c3', 'c1']);
    expect(log.list({ limit: 1 }).map((change) => change.id)).toEqual(['c3']);
    log.append(entry(4, { projectId: 'beta', category: 'automations' }));
    expect(log.list({ projectId: 'beta' }).map((change) => change.id)).toEqual(['c4']);
    expect(log.list({ category: 'automations' }).map((change) => change.id)).toEqual(['c4']);
  });

  it('is empty when the file is missing, and skips a bad line instead of failing', () => {
    const log = new ManagerChangeLog();
    expect(log.list()).toEqual([]);
    log.append(entry(1));
    appendFileSync(changeLogPath(), 'not json\n{"id":"half"}\n');
    log.append(entry(2));
    expect(log.list().map((change) => change.id)).toEqual(['c2', 'c1']);
  });

  it('rotates by size and still reads the rotated half', () => {
    const log = new ManagerChangeLog(() => undefined, 1);
    for (let n = 1; n <= 4; n += 1) log.append(entry(n));
    expect(existsSync(join(home, 'admin-audit.1.ndjson'))).toBe(true);
    // Each line outgrows the 1-byte cap, so the current file holds one entry and the rotated one the previous.
    expect(log.list().map((change) => change.id)).toEqual(['c4', 'c3']);
  });

  it('keeps logging when the rotated half cannot be written', () => {
    mkdirSync(join(home, 'admin-audit.1.ndjson'));
    const warnings: string[] = [];
    const log = new ManagerChangeLog((message) => warnings.push(message), 1);
    for (let n = 1; n <= 3; n += 1) log.append(entry(n));
    expect(warnings).toHaveLength(1);
    expect(log.list().map((change) => change.id)).toEqual(['c3', 'c2', 'c1']);
  });

  it('never writes a secret value from the environment', () => {
    process.env.CHANGE_LOG_TEST_API_KEY = 'sk-test-0123456789abcdef';
    const log = new ManagerChangeLog();
    log.append(entry(1, { reason: 'use sk-test-0123456789abcdef please' }));
    expect(readFileSync(changeLogPath(), 'utf8')).not.toContain('sk-test-0123456789abcdef');
  });

  it('never throws when it cannot write: the change it records still happens', () => {
    writeFileSync(join(home, 'blocker'), '');
    process.env.CEZ_HOME = join(home, 'blocker');
    const warnings: string[] = [];
    const log = new ManagerChangeLog((message) => warnings.push(message));
    expect(() => log.append(entry(1))).not.toThrow();
    expect(() => log.append(entry(2))).not.toThrow();
    expect(warnings).toHaveLength(1);
  });
});
