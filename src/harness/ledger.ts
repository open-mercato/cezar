import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  harnessLedgerSchema,
  type HarnessLedger,
  type HarnessPhase,
  type HarnessProfile,
} from './types.js';

/**
 * File I/O for the harness ledger (spec 2026-07-23-harness-orchestration):
 * one JSON file beside the run's NDJSON, written with the same atomic
 * tmp+rename discipline as `runs.json`. Pure persistence — the driver owns
 * every mutation and emits the matching `harness.*` events itself, so this
 * module needs no store import and stays trivially testable.
 */

export function ledgerPath(dataDir: string, runId: string): string {
  return join(dataDir, 'runs', `${runId}.harness.json`);
}

export function createLedger(init: {
  workflow: string;
  requestedProfile: HarnessProfile;
  subject: HarnessLedger['subject'];
}): HarnessLedger {
  return harnessLedgerSchema.parse({
    version: 1,
    workflow: init.workflow,
    requestedProfile: init.requestedProfile,
    effectiveProfile: init.requestedProfile,
    subject: init.subject,
  });
}

/** Load and validate; a missing, corrupt, or future-versioned file reads as
 *  null — callers treat that as "no ledger", never as an error. */
export function loadLedger(dataDir: string, runId: string): HarnessLedger | null {
  try {
    const raw = JSON.parse(readFileSync(ledgerPath(dataDir, runId), 'utf8'));
    const parsed = harnessLedgerSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveLedger(dataDir: string, runId: string, ledger: HarnessLedger): void {
  const path = ledgerPath(dataDir, runId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf8');
  renameSync(tmp, path);
}

/**
 * Create — or restart — a phase in place. Restarting an existing id bumps
 * `attempts` and clears the previous outcome, so a recovery re-entry and the
 * one automatic retry after a malformed phase result share one code path.
 */
export function startPhase(
  ledger: HarnessLedger,
  init: Pick<HarnessPhase, 'id' | 'name' | 'kind'> & Partial<Pick<HarnessPhase, 'skill'>>,
): HarnessPhase {
  const existing = ledger.phases.find((p) => p.id === init.id);
  if (existing) {
    existing.status = 'running';
    existing.attempts += 1;
    existing.startedAt = new Date().toISOString();
    existing.endedAt = undefined;
    existing.error = undefined;
    return existing;
  }
  const phase: HarnessPhase = {
    id: init.id,
    name: init.name,
    kind: init.kind,
    ...(init.skill ? { skill: init.skill } : {}),
    status: 'running',
    attempts: 1,
    startedAt: new Date().toISOString(),
    artifacts: {},
  };
  ledger.phases.push(phase);
  return phase;
}

export function finishPhase(
  ledger: HarnessLedger,
  phaseId: string,
  status: 'done' | 'failed' | 'skipped',
  error?: string,
): HarnessPhase | undefined {
  const phase = ledger.phases.find((p) => p.id === phaseId);
  if (!phase) return undefined;
  phase.status = status;
  phase.endedAt = new Date().toISOString();
  phase.error = error;
  return phase;
}
