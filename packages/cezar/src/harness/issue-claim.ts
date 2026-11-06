import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { readHarnessFsEntry } from '../fs-read.js';
import { readLedger, saveLedger } from './ledger.js';
import type { HarnessLedger } from './types.js';

const issueClaimSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  issueId: z.string().min(1),
  acquiredAt: z.string().min(1),
  /** The project whose ledger records this claim; absent on claims written before it existed. */
  dataDir: z.string().optional(),
});

export interface IssueClaim {
  path: string;
  held: true;
  issueId: string;
}

function claimsDir(cwd: string): string {
  const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
  const common = isAbsolute(raw) ? raw : resolve(cwd, raw);
  return join(common, 'cez-harness', 'issue-claims');
}

function claimPath(cwd: string, issueId: string): string {
  const token = createHash('sha256').update(issueId).digest('hex');
  return join(claimsDir(cwd), `${token}.json`);
}

export function acquireIssueClaim(
  cwd: string,
  runId: string,
  issueId: string,
  /** Takes over a claim this project's ledgers no longer know: its run was deleted, or
   *  `.ai/cezar/` was, and nothing else could ever release it. */
  owner?: { dataDir: string; runExists: (runId: string) => boolean },
): { ok: true; claim: IssueClaim } | { ok: false; error: string } {
  let path: string;
  try {
    path = claimPath(cwd, issueId);
    mkdirSync(dirname(path), { recursive: true });
  } catch (error) {
    return {
      ok: false,
      error:
        `could not establish an issue claim in this git repository: ` +
        (error instanceof Error ? error.message : String(error)),
    };
  }
  try {
    const descriptor = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(
        descriptor,
        `${JSON.stringify({
          version: 1,
          runId,
          issueId,
          acquiredAt: new Date().toISOString(),
          ...(owner ? { dataDir: owner.dataDir } : {}),
        }, null, 2)}\n`,
      );
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    try {
      // No-follow and bounded: the claims directory sits in the repo's shared git dir.
      const entry = readHarnessFsEntry(path, 64 * 1024);
      if (entry.kind !== 'file' || entry.content === null) throw new Error('not a claim file');
      const existing = issueClaimSchema.safeParse(JSON.parse(entry.content.toString('utf8')));
      if (existing.success && existing.data.runId === runId) {
        return { ok: true, claim: { path, held: true, issueId } };
      }
      if (
        existing.success &&
        owner &&
        (existing.data.dataDir ?? owner.dataDir) === owner.dataDir &&
        !owner.runExists(existing.data.runId)
      ) {
        unlinkSync(path);
        // Once: a claim that reappears in between belongs to a live racer.
        return acquireIssueClaim(cwd, runId, issueId, { ...owner, runExists: () => true });
      }
      if (existing.success) {
        return {
          ok: false,
          error:
            `issue ${issueId} is already claimed by harness run ${existing.data.runId}; ` +
            `resume/cancel that run or release its claim explicitly`,
        };
      }
    } catch {
    }
    return {
      ok: false,
      error: `issue ${issueId} has an unreadable harness claim at ${path}; inspect and release it explicitly`,
    };
  }
  return { ok: true, claim: { path, held: true, issueId } };
}

export function releaseIssueClaim(path: string, runId: string): { ok: true } | { ok: false; error: string } {
  try {
    const entry = readHarnessFsEntry(path, 64 * 1024);
    const parsed =
      entry.kind === 'file' && entry.content !== null
        ? issueClaimSchema.safeParse(JSON.parse(entry.content.toString('utf8')))
        : null;
    if (!parsed?.success) {
      return { ok: false, error: `claim at ${path} is unreadable and was not removed` };
    }
    if (parsed.data.runId !== runId) {
      return {
        ok: false,
        error: `claim at ${path} belongs to run ${parsed.data.runId}, not ${runId}`,
      };
    }
    unlinkSync(path);
    return { ok: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT'
      ? { ok: true }
      : { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** A run parked on its staged handoff or on a decision resumes under the same lease, so it keeps
 *  its claim; any other ending gives it up. */
export function issueClaimStaysHeld(ledger: Pick<HarnessLedger, 'stage' | 'outcome'>): boolean {
  return ledger.stage.status === 'staged' || Boolean(ledger.outcome.pendingDecision);
}

/** The release rule every ending without the driver shares: a queued or starting cancel. */
export function releaseLedgerIssueClaimUnlessParked(dataDir: string, runId: string): void {
  const read = readLedger(dataDir, runId);
  if (read.status !== 'valid' || issueClaimStaysHeld(read.ledger)) return;
  releaseLedgerIssueClaim(dataDir, runId);
}

/** Release the claim a run's ledger records. Every path that deletes a harness run calls this
 *  first: the ledger is the only record of the claim's path. */
export function releaseLedgerIssueClaim(dataDir: string, runId: string): void {
  const read = readLedger(dataDir, runId);
  if (read.status !== 'valid' || !read.ledger.claim?.held || !read.ledger.claim.path) return;
  if (!releaseIssueClaim(read.ledger.claim.path, runId).ok) return;
  read.ledger.claim.held = false;
  saveLedger(dataDir, runId, read.ledger);
}
