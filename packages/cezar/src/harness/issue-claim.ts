import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

const issueClaimSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  issueId: z.string().min(1),
  acquiredAt: z.string().min(1),
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
        }, null, 2)}\n`,
      );
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    try {
      const existing = issueClaimSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (existing.success && existing.data.runId === runId) {
        return { ok: true, claim: { path, held: true, issueId } };
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
    const parsed = issueClaimSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success) {
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
