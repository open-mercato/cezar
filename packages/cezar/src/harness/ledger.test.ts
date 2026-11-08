import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  councilDecisionDetail,
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
      skillProfile: 'open-mercato',
      subject: { kind: 'issue', id: '642', text: 'Fix issue #642' },
    });
    saveLedger(dataDir, runId, ledger);
    const loaded = loadLedger(dataDir, runId);
    expect(loaded).not.toBeNull();
    expect(loaded?.version).toBe(2);
    expect(loaded?.workflow).toBe('harness-fix-issue');
    expect(loaded?.requestedProfile).toBe('standard');
    expect(loaded?.effectiveProfile).toBe('standard');
    expect(loaded?.skillProfile).toBe('open-mercato');
    expect(loaded?.subject).toEqual({ kind: 'issue', id: '642', text: 'Fix issue #642' });
    expect(loaded?.phases).toEqual([]);
    expect(loaded?.loops).toEqual({ fixRounds: 0, maxFixRounds: 3 });
  });

  // an over-long decision finding was written fine and then read back as corrupt.
  it('refuses to write a ledger its reader would reject, leaving the previous one intact', () => {
    const ledger = createLedger({
      workflow: 'harness-implement-feature',
      requestedProfile: 'standard',
      skillProfile: 'generic',
      subject: { kind: 'brief', text: 'x' },
    });
    saveLedger(dataDir, runId, ledger);
    ledger.outcome = {
      status: 'contested',
      blockingReasons: ['x'],
      pendingDecision: { kind: 'spec', gate: 'pre-implement', round: 1, findings: ['f'.repeat(4_001)] },
    };
    expect(() => saveLedger(dataDir, runId, ledger)).toThrow(/reader would reject/);
    const read = readLedger(dataDir, runId);
    expect(read.status).toBe('valid');
    if (read.status === 'valid') expect(read.ledger.outcome.status).toBe('pending');
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

  it('reports a pre-release v1 ledger as unsupported without rewriting it', () => {
    const path = ledgerPath(dataDir, runId);
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1 }), 'utf8');

    expect(readLedger(dataDir, runId)).toMatchObject({ status: 'unsupported', version: 1 });
    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify({ version: 1 }));
  });

  it('loads a v2 ledger written before the round cursor, and round-trips one that has it', () => {
    const legacy = createLedger({
      workflow: 'harness-fix-issue',
      requestedProfile: 'standard',
      subject: { kind: 'brief', text: 'x' },
    });
    saveLedger(dataDir, runId, legacy);
    expect(readFileSync(ledgerPath(dataDir, runId), 'utf8')).not.toContain('"rounds"');
    const read = readLedger(dataDir, runId);
    expect(read.status).toBe('valid');
    if (read.status !== 'valid') throw new Error('expected valid ledger');
    expect(read.ledger.rounds).toBeUndefined();

    read.ledger.rounds = {
      implementation: {
        round: 2,
        basis: 'b'.repeat(64),
        validationRepairRounds: 1,
        repairPhases: ['fix-2'],
        findings: [{ severity: 'blocker', title: 'validation gate failed', evidence: 'exit 1' }],
        history: [],
        allowlist: { 'src/a.ts': 'implement' },
        suggestedCommit: 'fix: x',
      },
    };
    saveLedger(dataDir, runId, read.ledger);
    expect(loadLedger(dataDir, runId)?.rounds).toEqual(read.ledger.rounds);
  });

  it('keys a council decision to the subject its round reviewed', () => {
    expect(councilDecisionDetail({ council: 'implementation', round: 2, subjectSha256: 'abc' })).toBe(
      'implementation:2:abc',
    );
    expect(councilDecisionDetail({ council: 'spec', round: 1 })).toBe('spec:1');
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
    const phase = startPhase(ledger, { id: 'qualify', name: 'Qualify', kind: 'agent', skill: 'om-verify-in-repo' });
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
