import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { CardStageStatus } from '@open-mercato/cezar-contract';

const run = promisify(execFile);

/**
 * A framework's own state (D7) and the in-cockpit SDD approval (D9).
 *
 * `sdd.mjs status --json` (open-mercato/sdd @ 04ba2cc) prints
 * `{ id, ui, stages: { <stage>: { status, … } }, next, blockers }`. The parser also accepts the
 * stages as an array of `{ stage | name, status }`, so a reshaped future release degrades to
 * "read" rather than "unknown".
 */

export const SDD_APPROVAL_ENV = 'SDD_NONINTERACTIVE_APPROVAL';

/** What no framework command, check node or cezar terminal inherits from the server (D9). */
export const SCRUBBED_CHILD_ENV: readonly string[] = ['CEZ_TRACKER_CAPABILITY', SDD_APPROVAL_ENV];

/**
 * `source` without `names`, matched case-insensitively (Windows spells env names any case).
 * Advisory against an agent that sets the variable itself on purpose: the stage prompt's
 * "never run approve" rule is that guard (spec D9).
 */
export function scrubbedEnv(source: NodeJS.ProcessEnv = process.env, names: readonly string[] = SCRUBBED_CHILD_ENV): NodeJS.ProcessEnv {
  const drop = new Set(names.map((n) => n.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) if (!drop.has(name.toUpperCase())) env[name] = value;
  return env;
}

const stageEntry = z.object({ status: z.string() }).passthrough();
const sddStatusSchema = z
  .object({
    id: z.string().optional(),
    stages: z.union([
      z.record(z.string(), stageEntry),
      z.array(z.object({ stage: z.string().optional(), name: z.string().optional(), status: z.string() }).passthrough()),
    ]),
  })
  .passthrough();

export interface FrameworkStatus {
  /** The framework's change id (`<date>-<slug>` for SDD), when it reports one. */
  changeId?: string;
  /** Raw per-stage status, keyed by the framework's stage name. */
  raw: Record<string, string>;
}

export function parseFrameworkStatus(input: unknown): FrameworkStatus | null {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  // A bare array is the stage list itself.
  const parsed = sddStatusSchema.safeParse(Array.isArray(value) ? { stages: value } : value);
  if (!parsed.success) return null;
  const raw: Record<string, string> = {};
  const { stages } = parsed.data;
  if (Array.isArray(stages)) {
    for (const s of stages) {
      const key = s.stage ?? s.name;
      if (key) raw[key] = s.status;
    }
  } else {
    for (const [key, s] of Object.entries(stages)) raw[key] = s.status;
  }
  return { ...(parsed.data.id ? { changeId: parsed.data.id } : {}), raw };
}

/** SDD statuses → the card strip. Unknown words read as `pending`, never as done. */
export function mapFrameworkStageStatus(status: string): CardStageStatus {
  switch (status) {
    case 'done':
    case 'approved':
      return 'done';
    case 'skipped':
      return 'skipped';
    case 'stale':
      return 'stale';
    case 'failed':
      return 'failed';
    case 'in_progress':
      return 'running';
    case 'in_review':
      return 'waiting';
    default:
      return 'pending';
  }
}

/** Whether a framework gate may advance: approved/done (or skipped), never stale/pending (D7). */
export function isStageApproved(status: string | undefined): boolean {
  return status === 'approved' || status === 'done' || status === 'skipped';
}

export type FrameworkStateResult =
  | { ok: true; status: FrameworkStatus; stages: Record<string, CardStageStatus> }
  | { ok: false; error: string };

/**
 * Run a framework's `state.command` in the card's worktree and map it onto `stageIds`. Takes the
 * card's snapshot (`card.frameworkStateDef`, `card.stageOrder`), never the framework file (D3).
 * Never throws.
 */
export async function readFrameworkState(
  state: { command: string },
  stageIds: readonly string[],
  worktree: string,
  timeoutMs = 30_000,
): Promise<FrameworkStateResult> {
  let stdout: string;
  try {
    ({ stdout } = await run(state.command, [], { cwd: worktree, shell: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: scrubbedEnv() }));
  } catch (err) {
    return { ok: false, error: commandError(err) };
  }
  const status = parseFrameworkStatus(stdout);
  if (!status) return { ok: false, error: `${state.command} did not print a status this version of cezar can read` };
  const stages: Record<string, CardStageStatus> = {};
  for (const id of stageIds) {
    const raw = status.raw[id];
    if (raw !== undefined) stages[id] = mapFrameworkStageStatus(raw);
  }
  return { ok: true, status, stages };
}

export type ApproveResult = { ok: true; output: string } | { ok: false; error: string };

/**
 * D9: `node .ai/sdd/sdd.mjs approve <stage> <changeId> --by <by>` in the card's worktree with
 * `SDD_NONINTERACTIVE_APPROVAL=<changeId>` on THIS spawn's env only, then commit the change.json
 * it wrote ("an approval is also a commit"). Never throws; the script's refusal is the error.
 */
export async function approveSdd(worktree: string, stage: string, changeId: string, by: string): Promise<ApproveResult> {
  if (!/^[a-z][a-z0-9-]*$/.test(stage)) return { ok: false, error: `not a framework stage: ${stage}` };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(changeId)) return { ok: false, error: `not a change id: ${changeId}` };
  const name = by.trim() || 'cezar user';
  let output: string;
  try {
    const res = await run('node', ['.ai/sdd/sdd.mjs', 'approve', stage, changeId, '--by', name], {
      cwd: worktree,
      timeout: 60_000,
      // The one spawn the variable is ever set on; any other spelling of it is scrubbed first.
      env: { ...scrubbedEnv(), [SDD_APPROVAL_ENV]: changeId },
    });
    output = res.stdout.trim();
  } catch (err) {
    return { ok: false, error: commandError(err) };
  }
  try {
    // git hooks run on these: they get the scrubbed env, never the approval.
    const git = { cwd: worktree, timeout: 30_000, env: scrubbedEnv() };
    const { stdout } = await run('git', ['status', '--porcelain', '-z', '--untracked-files=all', '--', `:(glob)**/${changeId}/change.json`], git);
    const paths = stdout.split('\0').filter(Boolean).map((line) => line.slice(3));
    if (!paths.length) return { ok: false, error: `approve ${stage} reported success but changed no change.json` };
    await run('git', ['add', '--', ...paths], git);
    await run('git', ['commit', '-m', `sdd: approve ${stage} for ${changeId} (by ${name}, in cezar)`, '--', ...paths], git);
  } catch (err) {
    return { ok: false, error: `approved, but committing change.json failed: ${commandError(err)}` };
  }
  return { ok: true, output };
}

function commandError(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string; killed?: boolean };
  if (e.killed) return 'timed out';
  const text = (e.stderr?.trim() || e.stdout?.trim() || e.message || String(err)).trim();
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
}
