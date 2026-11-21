import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  harnessLedgerSchema,
  type HarnessLedger,
  type HarnessPhase,
  type HarnessProfile,
  type HarnessSkillProfile,
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
  skillProfile?: HarnessSkillProfile;
  subject: HarnessLedger['subject'];
}): HarnessLedger {
  return harnessLedgerSchema.parse({
    version: 2,
    workflow: init.workflow,
    requestedProfile: init.requestedProfile,
    effectiveProfile: init.requestedProfile,
    ...(init.skillProfile ? { skillProfile: init.skillProfile } : {}),
    subject: init.subject,
  });
}

/** A `council.retry`/`council.proceed` decision's detail, keyed to the subject its round
 *  reviewed so it never applies to another diff of that round. */
export function councilDecisionDetail(target: {
  council: string;
  round: number;
  subjectSha256?: string;
}): string {
  const key = `${target.council}:${target.round}`;
  return target.subjectSha256 ? `${key}:${target.subjectSha256}` : key;
}

export type HarnessLedgerRead =
  | { status: 'missing'; path: string }
  | { status: 'valid'; path: string; ledger: HarnessLedger }
  | { status: 'corrupt'; path: string; error: string }
  | { status: 'unsupported'; path: string; version: number | string | null };

/**
 * Read without mutating the ledger file. Missing state is recoverable; corrupt
 * and future state are distinct terminal conditions that callers must surface.
 */
export function readLedger(dataDir: string, runId: string): HarnessLedgerRead {
  const path = ledgerPath(dataDir, runId);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', path };
    return { status: 'corrupt', path, error: error instanceof Error ? error.message : String(error) };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { status: 'corrupt', path, error: error instanceof Error ? error.message : String(error) };
  }

  const version =
    typeof raw === 'object' && raw !== null && 'version' in raw
      ? (raw as { version?: unknown }).version
      : null;
  if (version !== 2) {
    return {
      status: 'unsupported',
      path,
      version: typeof version === 'number' || typeof version === 'string' ? version : null,
    };
  }

  const parsed = harnessLedgerSchema.safeParse(raw);
  return parsed.success
    ? { status: 'valid', path, ledger: parsed.data }
    : { status: 'corrupt', path, error: parsed.error.message };
}

/** Compatibility helper for read-only UI/API callers. Control-flow callers
 * must use `readLedger` so corrupt state cannot be confused with absence. */
export function loadLedger(dataDir: string, runId: string): HarnessLedger | null {
  const result = readLedger(dataDir, runId);
  return result.status === 'valid' ? result.ledger : null;
}

export function saveLedger(dataDir: string, runId: string, ledger: HarnessLedger): void {
  // Never write what `readLedger` would call corrupt: that strands resume, Continue and the
  // cockpit on one bad field. Failing here names the field while it is fixable.
  const valid = harnessLedgerSchema.safeParse(ledger);
  if (!valid.success) {
    throw new Error(`refusing to write a harness ledger its reader would reject: ${valid.error.message}`);
  }
  const path = ledgerPath(dataDir, runId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
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
