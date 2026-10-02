import { autosaveCommit } from '../../git-worktree.ts';
import { execTool } from './cli.ts';
import type { DraftPrInput } from './types.ts';

/**
 * The forge-neutral prelude of "publish this task as a draft PR/MR" (spec
 * 2026-08-10-forge-provider-adapters, Step 4.1): final autosave-commit → dry-run short-circuit →
 * `git remote get-url origin` → `git push -u origin <branch>` → base branch + body. Extracted from
 * `createDraftPr` (forge/github.ts) unchanged in wording, timeouts and ordering, so the GitHub
 * (`gh pr create`) and GitLab (`glab mr create`) drivers only differ in the create call itself.
 * Never throws.
 */

export const PUSH_TIMEOUT_MS = 60_000;
const PROGRESS_LINES_MAX = 10;

export type PublishPrelude =
  | { kind: 'error'; error: string }
  /** CEZ_DRY_RUN=1: the autosave ran, nothing was pushed — the caller fakes its forge's URL. */
  | { kind: 'dryRun' }
  | {
      kind: 'ready';
      worktree: string;
      branch: string;
      /** The branch to target, or null to let the forge CLI pick the repo default. */
      base: string | null;
      title: string;
      body: string;
    };

export async function preparePublish(input: DraftPrInput): Promise<PublishPrelude> {
  const { run } = input;
  const worktree = run.worktreePath;
  const branch = run.branch;
  if (!worktree || !branch) {
    return { kind: 'error', error: 'this task has no worktree/branch to publish' };
  }

  // Final autosave: the branch must hold everything before it leaves the box.
  // This is the LAST flush — unlike the turn-end and run-finalize ones there is
  // no later autosave to pick the work up, so a refusal (conflicted tree) or a
  // failed commit has to stop the publish instead of silently opening a PR from
  // a branch that is missing the run's final state.
  const saved = await autosaveCommit(worktree, 'pre-PR');
  if (saved === 'refused') {
    return {
      kind: 'error',
      error: 'worktree has unresolved merge conflicts — resolve them, then publish again',
    };
  }
  if (saved === 'failed') {
    return { kind: 'error', error: 'could not commit the final changes — check git status in the worktree' };
  }

  // DRY-RUN (CEZ_DRY_RUN=1): no push, no forge CLI — the caller simulates success
  // with a fake URL so the whole review → PR flow is testable without a forge.
  if (process.env.CEZ_DRY_RUN === '1') return { kind: 'dryRun' };

  const remote = await execTool(['remote', 'get-url', 'origin'], worktree, 'git');
  if (!remote.ok || !remote.stdout.trim()) {
    return { kind: 'error', error: 'no git remote — add one (git remote add origin <url>) or merge the branch locally' };
  }

  const push = await execTool(['push', '-u', 'origin', branch], worktree, 'git', PUSH_TIMEOUT_MS);
  if (!push.ok) {
    return { kind: 'error', error: `git push failed — ${tail(push.stderr) || 'unknown error'}` };
  }

  // Target the branch the worktree forked from (config `baseBranch`) — without
  // an explicit base, the forge CLI aims at the repo default (main) even when
  // work started on develop. `origin/x` normalizes to `x`; a raw sha
  // (detached-HEAD fork point) can't be a PR base, so it falls back to the
  // default branch.
  const prBase = run.baseBranch?.replace(/^origin\//, '');
  const base = prBase && !/^[0-9a-f]{7,40}$/i.test(prBase) ? prBase : null;
  return { kind: 'ready', worktree, branch, base, title: run.title, body: buildPrBody(input.handoffText, run.task) };
}

/**
 * PR body from the handoff journal: the "## Goal" section (task text as
 * fallback) + the first ~10 lines of "## Progress log" (newest first) +
 * the cezar footer.
 */
export function buildPrBody(handoffText: string, task: string): string {
  const goal = section(handoffText, '## Goal') || task.trim();
  const progress = section(handoffText, '## Progress log')
    .split('\n')
    .filter((l) => l.trim())
    .slice(0, PROGRESS_LINES_MAX)
    .join('\n');
  const parts = ['## Goal', '', goal];
  if (progress) parts.push('', '## Progress log', '', progress);
  parts.push('', '---', '', '🤖 made with cezar');
  return parts.join('\n');
}

/** Text of one `## Header` section, up to the next `## ` header. */
function section(text: string, header: string): string {
  const start = text.indexOf(`${header}\n`);
  if (start < 0) return '';
  const rest = text.slice(start + header.length + 1);
  const next = rest.indexOf('\n## ');
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

/** Last 3 stderr lines, pipe-joined — enough context, toast-sized. */
export function tail(stderr: string): string {
  return stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
}
