import { execFile } from 'node:child_process';
import { resolveTaskDiffBase } from '../git-diff-base.ts';
import type { RunRecord } from '../runs/store.ts';
import type { WebhookCompletionReason } from '@open-mercato/cezar-contract';

/** Only called while lifecycle capture is attached. Never makes completion depend on git. */
export async function completionReason(run: RunRecord | undefined): Promise<WebhookCompletionReason> {
  if (!run?.worktreePath || !run.baseBranch) return 'completed';
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const git = (args: string[]): Promise<{ ok: boolean; stdout: string }> => new Promise(resolve => {
    if (controller.signal.aborted) return resolve({ ok: false, stdout: '' });
    execFile('git', args, { cwd: run.worktreePath, encoding: 'utf8', signal: controller.signal, timeout: 5000, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve({ ok: !error, stdout }));
  });
  const determine = async (): Promise<WebhookCompletionReason> => {
    const anchor = await resolveTaskDiffBase(git, run.baseBranch!, { taskBranch: run.branch, runStartedAt: run.startedAt });
    // HEAD is the diff helper's uncommitted-only fallback when a repointed
    // checkout has no usable baseline (detached HEAD, absent reflog or start).
    // An empty diff there cannot prove the task made no committed changes.
    if (anchor.repointedHead && anchor.base === 'HEAD') return 'completed';
    const diff = await git(['diff', '--name-only', anchor.base, '--']);
    const untracked = await git(['ls-files', '--others', '--exclude-standard']);
    return diff.ok && untracked.ok && !diff.stdout.trim() && !untracked.stdout.trim() ? 'no_changes' : 'completed';
  };
  try {
    return await Promise.race([determine(), new Promise<WebhookCompletionReason>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve('completed'); }, 5000);
    })]);
  } catch { return 'completed'; }
  finally { if (timer) clearTimeout(timer); controller.abort(); }
}
