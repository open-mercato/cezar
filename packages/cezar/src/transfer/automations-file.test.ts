import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { automationsFileSchema, type AutomationsFile } from '@open-mercato/cezar-contract';
import { AutomationStore } from '../automations/store.ts';
import { exportAutomations, planAutomationImport } from './automations-file.ts';

const dirs: string[] = [];
const storeIn = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cezar-transfer-'));
  dirs.push(dir);
  return AutomationStore.open(dir);
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const poll = {
  name: 'Review new PRs',
  enabled: true,
  kind: 'github' as const,
  events: ['pull_request.opened' as const],
  intervalSeconds: 300,
  filters: { lookbackDays: 7, maxRecords: 25, anyLabels: ['bug'] },
  task: { prompt: 'Review {{github.url}}', runner: 'claude' as const, model: 'opus', dispatch: { maxSubtasks: 2, reviewChild: true } },
};
const schedule = {
  name: 'Nightly',
  enabled: false,
  kind: 'schedule' as const,
  schedule: { type: 'daily' as const, time: '04:00' },
  task: { prompt: 'Tidy up' },
};
const checks = { trackerTriggerIssue: async () => null, accountIssue: async () => null };
const local = { localHandoff: true, checks };
const fileOf = (automations: unknown[]): AutomationsFile =>
  automationsFileSchema.parse({ format: 'cezar-automations', version: 1, exportedAt: new Date().toISOString(), automations });

describe('automations file', () => {
  it('round-trips: export from A, import on an empty B creates every row paused with new ids and no runtime state', async () => {
    const a = storeIn();
    const first = a.create(poll);
    a.create(schedule);
    a.setState(first.id, () => ({ cursor: { timestamp: new Date().toISOString() }, baselineAt: new Date().toISOString() }));
    const file = exportAutomations(a.list(), { cezarVersion: '1.2.3' });
    const wire = JSON.parse(JSON.stringify(file));
    expect(automationsFileSchema.safeParse(wire).success).toBe(true);
    expect(JSON.stringify(wire)).not.toMatch(/"(id|revision|createdAt|updatedAt|enabled|cursor|baselineAt)"/);

    const b = storeIn();
    const plan = await planAutomationImport(automationsFileSchema.parse(wire), undefined, b.list(), local);
    expect(plan.rows.map((row) => row.action)).toEqual(['create', 'create']);
    const result = b.importMany({ creates: plan.creates, replaces: plan.replaces });
    const imported = b.list();
    expect(imported).toHaveLength(2);
    expect(imported.every((row) => row.enabled === false)).toBe(true);
    expect(imported.map((row) => row.id)).not.toContain(first.id);
    expect(result.created.every((row) => b.state(row.id) === undefined)).toBe(true);
    const review = imported.find((row) => row.name === poll.name)!;
    expect(review.task).toMatchObject(poll.task);
    expect(review.filters).toMatchObject(poll.filters);
  });

  it('exports only the selected ids and never a composer start', () => {
    const a = storeIn();
    const one = a.create(poll);
    a.create(schedule);
    expect(exportAutomations(a.list(), { ids: [one.id] }).automations.map((row) => row.name)).toEqual([poll.name]);
  });

  it('defaults a name collision to skip and honors rename and replace', async () => {
    const b = storeIn();
    const existing = b.create(poll);
    const file = fileOf([{ ...poll, enabled: undefined }].map(({ enabled: _e, ...row }) => row));
    const skipped = await planAutomationImport(file, undefined, b.list(), local);
    expect(skipped.rows[0]).toMatchObject({ action: 'skip', collision: { id: existing.id }, issues: [] });
    expect(skipped.creates).toHaveLength(0);

    const renamed = await planAutomationImport(file, { 0: { action: 'rename' } }, b.list(), local);
    expect(renamed.rows[0]).toMatchObject({ action: 'rename', newName: 'Review new PRs (imported)' });

    const replaced = await planAutomationImport(file, { 0: { action: 'replace' } }, b.list(), local);
    expect(replaced.rows[0]).toMatchObject({ action: 'replace', target: existing.id });
    b.setState(existing.id, () => ({ baselineAt: new Date().toISOString() }));
    b.importMany({ creates: replaced.creates, replaces: replaced.replaces });
    const after = b.get(existing.id)!;
    expect(after).toMatchObject({ enabled: false, revision: existing.revision + 1 });
    expect(b.state(existing.id)).toEqual({ revision: after.revision });
  });

  it('detects duplicate names inside one file and re-checks a rename', async () => {
    const b = storeIn();
    b.create({ ...schedule, name: 'Nightly (imported)' });
    const { enabled: _e, ...row } = schedule;
    const file = fileOf([row, row]);
    const plan = await planAutomationImport(file, undefined, b.list(), local);
    expect(plan.rows.map((r) => r.action)).toEqual(['create', 'skip']);
    const renamed = await planAutomationImport(file, { 1: { action: 'rename' } }, b.list(), local);
    expect(renamed.rows[1]).toMatchObject({ action: 'rename', newName: 'Nightly (imported 2)', issues: [] });
    const taken = await planAutomationImport(file, { 1: { action: 'rename', newName: 'nightly (IMPORTED)' } }, b.list(), local);
    expect(taken.rows[1]!.issues[0]).toMatch(/already taken/);
    const forced = await planAutomationImport(file, { 1: { action: 'create' } }, b.list(), local);
    expect(forced.rows[1]).toMatchObject({ action: 'create', issues: [expect.stringMatching(/already taken/)] });
  });

  it('refuses command rows without acknowledgement, and always on a hosted cockpit', async () => {
    const { enabled: _e, ...row } = schedule;
    const file = fileOf([{ ...row, task: { prompt: 'x', steps: [{ id: 'lint', command: 'npm test' }] } }]);
    const unacked = await planAutomationImport(file, undefined, [], local);
    expect(unacked.rows[0]).toMatchObject({ runsCommands: true, issues: [expect.stringMatching(/acknowledge/)] });
    const acked = await planAutomationImport(file, { 0: { action: 'create', acceptCommands: true } }, [], local);
    expect(acked.rows[0]).toMatchObject({ action: 'create', issues: [] });
    const hosted = await planAutomationImport(file, { 0: { action: 'rename', newName: 'n', acceptCommands: true } }, [], { ...local, localHandoff: false });
    expect(hosted.rows[0]!.issues[0]).toMatch(/local cockpit/);
  });

  it('reports a row the target cannot validate, and clears an unknown account on request', async () => {
    const { enabled: _e, ...row } = schedule;
    const file = fileOf([{ ...row, task: { prompt: 'x', agentProfile: 'work' } }]);
    const strict = { localHandoff: true, checks: { ...checks, accountIssue: async (task: { agentProfile?: string }) => (task.agentProfile ? 'unknown account' : null) } };
    expect((await planAutomationImport(file, undefined, [], strict)).rows[0]!.issues).toEqual(['unknown account']);
    const fixed = await planAutomationImport(file, { 0: { action: 'create', useDefaultAccount: true } }, [], strict);
    expect(fixed.rows[0]!.issues).toEqual([]);
    expect((fixed.creates[0]!.task as { agentProfile?: string }).agentProfile).toBeUndefined();
  });

  it('flags a past one-time schedule as a warning, not an issue', async () => {
    const file = fileOf([{ name: 'Once', kind: 'schedule', schedule: { type: 'once', date: '2020-01-01', time: '09:00' }, task: { prompt: 'x' } }]);
    const plan = await planAutomationImport(file, undefined, [], local);
    expect(plan.rows[0]).toMatchObject({ action: 'create', issues: [], warnings: [expect.stringMatching(/past/)] });
  });

  it('changes the digest when the target changes', async () => {
    const b = storeIn();
    const { enabled: _e, ...row } = schedule;
    const file = fileOf([row]);
    const before = await planAutomationImport(file, undefined, b.list(), local);
    b.create(poll);
    const after = await planAutomationImport(file, undefined, b.list(), local);
    expect(after.planDigest).not.toBe(before.planDigest);
    expect((await planAutomationImport(file, undefined, b.list(), local)).planDigest).toBe(after.planDigest);
  });

  it('rejects a newer version, another format and unknown keys', () => {
    const base = { format: 'cezar-automations', version: 1, exportedAt: 'x', automations: [] };
    const newer = automationsFileSchema.safeParse({ ...base, version: 2 });
    expect(newer.success).toBe(false);
    expect(newer.error!.issues[0]!.message).toMatch(/newer cezar \(version 2\)/);
    expect(automationsFileSchema.safeParse({ ...base, format: 'other' }).error!.issues[0]!.message).toMatch(/not a cezar automations file/);
    expect(automationsFileSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(automationsFileSchema.safeParse({ ...base, automations: [{ name: 'x', task: { prompt: 'p' }, id: 'leaked' }] }).success).toBe(false);
    expect(automationsFileSchema.safeParse({ ...base, automations: [{ name: 'x', task: { prompt: 'p' }, enabled: true }] }).success).toBe(false);
    // A manager link is local wiring, never part of the v1 file (spec 2026-10-31-managers § Automation reports).
    expect(automationsFileSchema.safeParse({ ...base, automations: [{ name: 'x', task: { prompt: 'p' }, report: { managerId: 'm1', mode: 'post-result' } }] }).success).toBe(false);
  });
});

describe('AutomationStore.importMany', () => {
  it('writes nothing when any row is invalid', () => {
    const b = storeIn();
    b.create(poll);
    const before = readFileSync(join(b.dataDir, 'automations.json'), 'utf8');
    expect(() => b.importMany({
      creates: [{ ...schedule }, { ...schedule, kind: 'schedule', schedule: undefined } as never],
      replaces: [],
    })).toThrow();
    expect(readFileSync(join(b.dataDir, 'automations.json'), 'utf8')).toBe(before);
  });

  it('never reuses a tombstoned id and lands every row paused', () => {
    const b = storeIn();
    const gone = b.create(poll);
    b.delete(gone.id);
    const raw = JSON.parse(readFileSync(join(b.dataDir, 'automations.json'), 'utf8'));
    expect(raw.tombstones[gone.id]).toBeTruthy();
    writeFileSync(join(b.dataDir, 'automations.json'), JSON.stringify(raw));
    const { created } = b.importMany({ creates: [{ ...poll, enabled: true }], replaces: [] });
    expect(created[0]!.id).not.toBe(gone.id);
    expect(created[0]!.enabled).toBe(false);
  });

  it('refuses a replace against a stale revision', () => {
    const b = storeIn();
    const row = b.create(poll);
    expect(() => b.importMany({ creates: [], replaces: [{ id: row.id, expectedRevision: 9, input: poll }] })).toThrow(/revision/);
  });
});
