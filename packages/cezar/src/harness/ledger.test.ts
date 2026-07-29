import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLedger,
  ledgerPath,
  loadLedger,
  readLedger,
  saveLedger,
  startPhase,
  finishPhase,
} from './ledger.js';

/**
 * The harness ledger (spec 2026-07-23-harness-orchestration, Data Model): the
 * conductor's durable memory. File-backed like everything else in `.ai/cezar/`
 * — atomic tmp+rename writes, corrupt files degrade to null (never throw), and
 * the schema is versioned so a future cezar can migrate instead of guessing.
 */
describe('harness ledger', () => {
  let dataDir: string;
  const runId = 'run-1234';

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-ledger-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('round-trips a freshly created ledger', () => {
    const ledger = createLedger({
      workflow: 'harness-fix-issue',
      requestedProfile: 'standard',
      subject: { kind: 'issue', id: '642', text: 'Fix issue #642' },
    });
    saveLedger(dataDir, runId, ledger);
    const loaded = loadLedger(dataDir, runId);
    expect(loaded).not.toBeNull();
    expect(loaded?.version).toBe(2);
    expect(loaded?.workflow).toBe('harness-fix-issue');
    expect(loaded?.requestedProfile).toBe('standard');
    expect(loaded?.effectiveProfile).toBe('standard');
    expect(loaded?.subject).toEqual({ kind: 'issue', id: '642', text: 'Fix issue #642' });
    expect(loaded?.phases).toEqual([]);
    expect(loaded?.loops).toEqual({ fixRounds: 0, maxFixRounds: 3 });
  });

  it('returns null for a missing ledger', () => {
    expect(loadLedger(dataDir, 'nope')).toBeNull();
  });

  it('distinguishes a corrupt ledger from an absent ledger without changing its bytes', () => {
    saveLedger(dataDir, runId, createLedger({
      workflow: 'harness-fix-issue',
      requestedProfile: 'standard',
      subject: { kind: 'brief', text: 'x' },
    }));
    writeFileSync(ledgerPath(dataDir, runId), '{ not json', 'utf8');
    expect(loadLedger(dataDir, runId)).toBeNull();
    const read = readLedger(dataDir, runId);
    expect(read.status).toBe('corrupt');
    expect(readFileSync(ledgerPath(dataDir, runId), 'utf8')).toBe('{ not json');
  });

  it('refuses a future ledger version instead of treating it as a missing ledger', () => {
    const path = ledgerPath(dataDir, runId);
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 999, workflow: 'harness-fix-issue' }), 'utf8');

    const read = readLedger(dataDir, runId);

    expect(read).toMatchObject({ status: 'unsupported', version: 999 });
    expect(readFileSync(path, 'utf8')).toContain('"version":999');
  });

  it('migrates a valid v1 ledger in memory without rewriting it on read', () => {
    const path = ledgerPath(dataDir, runId);
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    const v1 = {
      version: 1,
      workflow: 'harness-fix-issue',
      requestedProfile: 'standard',
      effectiveProfile: 'standard',
      subject: { kind: 'brief', text: 'x' },
      phases: [],
      models: [],
      councils: [],
      packets: [],
      validation: [],
      loops: { fixRounds: 0, maxFixRounds: 3 },
      stage: { status: 'pending' },
      decisions: [],
    };
    writeFileSync(path, JSON.stringify(v1), 'utf8');

    const read = readLedger(dataDir, runId);

    expect(read.status).toBe('valid');
    if (read.status !== 'valid') throw new Error('expected valid ledger');
    expect(read.migrated).toBe(true);
    expect(read.ledger.version).toBe(2);
    expect(read.ledger.invocations).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(v1));
  });

  it('writes atomically — no .tmp file remains after save', () => {
    const ledger = createLedger({
      workflow: 'harness-fix-issue',
      requestedProfile: 'standard',
      subject: { kind: 'brief', text: 'x' },
    });
    saveLedger(dataDir, runId, ledger);
    expect(() => readFileSync(`${ledgerPath(dataDir, runId)}.tmp`, 'utf8')).toThrow();
  });

  it('startPhase creates or restarts a phase; finishPhase records the outcome', () => {
    const ledger = createLedger({
      workflow: 'harness-fix-issue',
      requestedProfile: 'standard',
      subject: { kind: 'brief', text: 'x' },
    });
    const phase = startPhase(ledger, { id: 'qualify', name: 'Qualify', kind: 'agent', skill: 'cez-verify-in-repo' });
    expect(phase.status).toBe('running');
    expect(phase.attempts).toBe(1);
    expect(ledger.phases).toHaveLength(1);

    finishPhase(ledger, 'qualify', 'done');
    expect(ledger.phases[0]?.status).toBe('done');
    expect(ledger.phases[0]?.endedAt).toBeTruthy();

    const again = startPhase(ledger, { id: 'qualify', name: 'Qualify', kind: 'agent' });
    expect(again.attempts).toBe(2);
    expect(again.status).toBe('running');
    expect(again.endedAt).toBeUndefined();
    expect(ledger.phases).toHaveLength(1);
  });

  it('finishPhase records an error message on failure', () => {
    const ledger = createLedger({
      workflow: 'harness-fix-issue',
      requestedProfile: 'standard',
      subject: { kind: 'brief', text: 'x' },
    });
    startPhase(ledger, { id: 'stage', name: 'Stage', kind: 'op' });
    finishPhase(ledger, 'stage', 'failed', 'refs moved');
    expect(ledger.phases[0]?.status).toBe('failed');
    expect(ledger.phases[0]?.error).toBe('refs moved');
  });
});
