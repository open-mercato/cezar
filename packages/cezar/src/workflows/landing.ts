import { execFile, spawn } from 'node:child_process';
import { CEZAR_DATA_EXCLUDE } from '../data-gitignore.ts';
import { gitHasIdentity, unresolvedConflicts } from '../git-worktree.ts';

/**
 * Auto-land for in-place tasks (spec 2026-10-20-trunk-based-projects): commit what the task
 * left, rebase on the checkout's upstream, run the project's required checks, push. Never
 * throws; every failure names its stage so the engine can hand it back to the agent.
 */

export type LandStage = 'branch' | 'commit' | 'sync' | 'checks' | 'push';

export type LandResult =
  | { result: 'landed'; branch: string; sha: string; pushed: boolean; files: string[] }
  | { result: 'nothing' }
  | { result: 'failed'; stage: LandStage; error: string };

export interface LandOptions {
  /** Commit message for what the task left uncommitted, written from the staged change itself so
   *  every landing describes its own commit. Absent, or answering nothing: `fallbackCommitMessage`. */
  describe?: (staged: StagedChange) => Promise<string | undefined>;
  /** The project's configured base branch; the checkout must be on it. Unset = any branch. */
  baseBranch?: string;
  /** The task's starting commit — the lower bound of "files landed" when there is no upstream. */
  since?: string;
  checks: string[];
  env?: NodeJS.ProcessEnv;
  /** Runs one check; injectable for tests. */
  runCheck?: (command: string, cwd: string, env?: NodeJS.ProcessEnv) => Promise<{ ok: boolean; output: string }>;
}

// cezar's own state never lands: committing `.ai/cezar/config.json` would track it, and a tracked
// config can no longer grant auto-land.
const PATHSPEC = ['--', '.', CEZAR_DATA_EXCLUDE];
const NETWORK_TIMEOUT_MS = 60_000;
const CHECK_TIMEOUT_MS = 10 * 60_000;
const CHECK_OUTPUT_TAIL = 8_000;
// Network git never prompts: a landing runs unattended.
const NETWORK_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' };

interface GitResult { ok: boolean; stdout: string; stderr: string }

function git(cwd: string, args: string[], timeout = 0): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout, env: { ...process.env, ...NETWORK_ENV } },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

const reason = (res: GitResult, fallback: string) =>
  (res.stderr.trim() || res.stdout.trim()).split('\n').slice(0, 3).join('\n') || fallback;

export function runShellCheck(command: string, cwd: string, env?: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], { cwd, env: env ?? process.env });
    let output = '';
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-CHECK_OUTPUT_TAIL);
    };
    const timer = setTimeout(() => child.kill('SIGTERM'), CHECK_TIMEOUT_MS);
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `failed to spawn: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: output.trim() || `(no output, exit ${code ?? 'signal'})` });
    });
  });
}

async function upstreamOf(root: string): Promise<{ ref: string; remote: string; branch: string } | undefined> {
  const res = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const ref = res.stdout.trim();
  if (!res.ok || !ref) return undefined;
  const head = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const remote = (await git(root, ['config', `branch.${head.stdout.trim()}.remote`])).stdout.trim();
  const merge = (await git(root, ['config', `branch.${head.stdout.trim()}.merge`])).stdout.trim();
  if (!remote || remote === '.' || !merge) return undefined;
  return { ref, remote, branch: merge.replace(/^refs\/heads\//, '') };
}

async function count(root: string, range: string): Promise<number> {
  const res = await git(root, ['rev-list', '--count', range]);
  return res.ok ? Number.parseInt(res.stdout.trim(), 10) || 0 : 0;
}

async function changedFiles(root: string, range: string): Promise<string[]> {
  const res = await git(root, ['diff', '--name-only', range]);
  return res.ok ? res.stdout.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 200) : [];
}

export async function landInPlace(root: string, options: LandOptions): Promise<LandResult> {
  const head = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = head.stdout.trim();
  if (!head.ok || !branch || branch === 'HEAD') {
    return { result: 'failed', stage: 'branch', error: 'the checkout is on a detached HEAD — check out the base branch' };
  }
  if (options.baseBranch && branch !== options.baseBranch) {
    return {
      result: 'failed',
      stage: 'branch',
      error: `the checkout is on ${branch}, but this project lands on ${options.baseBranch}`,
    };
  }
  // The commit AND the rebase that rewrites it need a committer; a machine with no identity gets cezar's.
  const identity = (await gitHasIdentity(root)) ? [] : ['-c', 'user.name=cezar', '-c', 'user.email=cezar@local'];
  const upstream = await upstreamOf(root);
  const dryRun = process.env.CEZ_DRY_RUN === '1';
  if (!upstream) {
    // A local-only repository: the commit on the base branch IS the landing, so the checks gate
    // the commit itself — a failed check must not leave it behind for a retry to call "nothing".
    const pending = await git(root, ['status', '--porcelain', ...PATHSPEC]);
    if (pending.ok && !pending.stdout.trim()) return { result: 'nothing' };
    const checked = await runChecks(root, options);
    if (checked) return checked;
    const committed = await commitTask(root, options.describe, identity);
    if (committed.result === 'failed') return { result: 'failed', stage: 'commit', error: committed.error };
    if (committed.result === 'nothing') return { result: 'nothing' };
    const files = options.since ? await changedFiles(root, `${options.since}..HEAD`) : [];
    return { result: 'landed', branch, sha: committed.sha, pushed: false, files };
  }
  const committed = await commitTask(root, options.describe, identity);
  if (committed.result === 'failed') return { result: 'failed', stage: 'commit', error: committed.error };
  // Nothing new against the last-fetched upstream: no network, nothing to land.
  if (committed.result === 'nothing' && (await count(root, `${upstream.ref}..HEAD`)) === 0) return { result: 'nothing' };

  // One retry: a push rejected because someone else landed in between rebases once more.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!dryRun) {
      const fetched = await git(root, ['fetch', upstream.remote, upstream.branch], NETWORK_TIMEOUT_MS);
      if (!fetched.ok) return { result: 'failed', stage: 'sync', error: `git fetch failed: ${reason(fetched, 'no answer')}` };
    }
    const rebased = await git(root, [...identity, 'rebase', '--autostash', upstream.ref]);
    if (!rebased.ok) {
      const conflicted = (await git(root, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim().split('\n').filter(Boolean);
      await git(root, ['rebase', '--abort']);
      return {
        result: 'failed',
        stage: 'sync',
        error: conflicted.length
          ? `rebasing onto ${upstream.ref} conflicts in: ${conflicted.join(', ')}. Run \`git pull --rebase\`, resolve the conflicts keeping both sides' content, and finish again.`
          : `rebasing onto ${upstream.ref} failed: ${reason(rebased, 'unknown error')}`,
      };
    }
    const checked = await runChecks(root, options);
    if (checked) return checked;
    const files = await changedFiles(root, `${upstream.ref}..HEAD`);
    const sha = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
    if (dryRun) return { result: 'landed', branch, sha, pushed: false, files };
    const pushed = await git(root, ['push', upstream.remote, `HEAD:${upstream.branch}`], NETWORK_TIMEOUT_MS);
    if (pushed.ok) return { result: 'landed', branch, sha, pushed: true, files };
    const rejected = /rejected|non-fast-forward|fetch first/i.test(pushed.stderr);
    if (!rejected || attempt === 1) {
      return { result: 'failed', stage: 'push', error: `git push failed: ${reason(pushed, 'no answer')}` };
    }
  }
  return { result: 'failed', stage: 'push', error: 'git push was rejected twice' };
}

/** What a landing commit is about to record: name-status lines and a capped patch. */
export interface StagedChange {
  files: Array<{ status: string; path: string }>;
  patch: string;
}

const STAGED_PATCH_CAP = 12_000;

/**
 * A message from the file list alone, when no model wrote one: what kind of change, how many,
 * where — `Add meeting.md`, `Update a.md and b.md`, `Remove 19 and update 4 files in vault/knowledge/`.
 */
export function fallbackCommitMessage(files: StagedChange['files']): string {
  if (files.length === 0) return 'Update files';
  const verbOf = (status: string) =>
    status.startsWith('A') ? 'add' : status.startsWith('D') ? 'remove' : status.startsWith('R') ? 'rename' : 'update';
  const counts = new Map<string, number>();
  for (const file of files) counts.set(verbOf(file.status), (counts.get(verbOf(file.status)) ?? 0) + 1);
  const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
  const names = files.map((f) => f.path.split('/').pop() ?? f.path);
  if (files.length <= 2) {
    const verb = counts.size === 1 ? capital([...counts.keys()][0] as string) : 'Update';
    return `${verb} ${names.join(' and ')}`;
  }
  const order = ['add', 'update', 'rename', 'remove'];
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([verb, n]) => `${verb} ${n}`);
  const head = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] as string);
  const dir = commonDirectory(files.map((f) => f.path));
  const message = `${capital(head)} files${dir ? ` in ${dir}` : ''}`;
  return message.length <= 72 ? message : `${capital(head)} files`;
}

/** The deepest directory every path sits in, with a trailing slash; '' when they share none. */
function commonDirectory(paths: string[]): string {
  const dirs = paths.map((p) => p.split('/').slice(0, -1));
  const first = dirs[0] ?? [];
  let depth = 0;
  while (depth < first.length && dirs.every((d) => d[depth] === first[depth])) depth += 1;
  return depth ? `${first.slice(0, depth).join('/')}/` : '';
}

async function commitTask(
  root: string,
  describe: LandOptions['describe'],
  identity: string[],
): Promise<{ result: 'committed'; sha: string } | { result: 'nothing' } | { result: 'failed'; error: string }> {
  const status = await git(root, ['status', '--porcelain', ...PATHSPEC]);
  if (!status.ok) return { result: 'failed', error: reason(status, 'git status failed') };
  if (!status.stdout.trim()) return { result: 'nothing' };
  const unresolved = await unresolvedConflicts(root, status.stdout);
  if (unresolved) return { result: 'failed', error: `refusing to commit: ${unresolved}` };
  const add = await git(root, ['add', '-A', ...PATHSPEC]);
  if (!add.ok) return { result: 'failed', error: reason(add, 'git add failed') };
  const nameStatus = await git(root, ['diff', '--cached', '--name-status']);
  const files = nameStatus.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      return { status: parts[0] ?? 'M', path: parts[parts.length - 1] ?? '' };
    });
  const patch = (await git(root, ['diff', '--cached', '--no-color'])).stdout.slice(0, STAGED_PATCH_CAP);
  const described = describe ? await describe({ files, patch }).catch(() => undefined) : undefined;
  const message = described?.trim() || fallbackCommitMessage(files);
  const commit = await git(root, [...identity, 'commit', '--no-verify', '-m', message]);
  if (!commit.ok) return { result: 'failed', error: reason(commit, 'git commit failed') };
  return { result: 'committed', sha: (await git(root, ['rev-parse', 'HEAD'])).stdout.trim() };
}

/** Uncommitted changes, or commits the last-fetched upstream lacks. Offline. */
export async function hasUnlanded(root: string): Promise<boolean> {
  const status = await git(root, ['status', '--porcelain', ...PATHSPEC]);
  if (status.ok && status.stdout.trim()) return true;
  const upstream = await upstreamOf(root);
  return upstream ? (await count(root, `${upstream.ref}..HEAD`)) > 0 : false;
}

/**
 * The checkout's git status for an in-place task's git step (spec 2026-10-20-trunk-based-projects):
 * uncommitted files outside `.ai/cezar/`, and commits against the last-fetched upstream. Offline.
 * `null` counts mean there is no upstream.
 */
export async function checkoutGitStatus(
  root: string,
): Promise<{ ok: true; uncommitted: number; unpushed: number | null; behind: number | null; ahead: number | null } | { ok: false; error: string }> {
  const status = await git(root, ['status', '--porcelain', ...PATHSPEC]);
  if (!status.ok) return { ok: false, error: reason(status, 'git status failed') };
  const uncommitted = status.stdout.split('\n').filter((line) => line.trim()).length;
  const upstream = await upstreamOf(root);
  if (!upstream) return { ok: true, uncommitted, unpushed: null, behind: null, ahead: null };
  const unpushed = await count(root, `${upstream.ref}..HEAD`);
  return { ok: true, uncommitted, unpushed, behind: await count(root, `HEAD..${upstream.ref}`), ahead: unpushed };
}

async function runChecks(root: string, options: LandOptions): Promise<LandResult | undefined> {
  const run = options.runCheck ?? runShellCheck;
  for (const command of options.checks) {
    const res = await run(command, root, options.env);
    if (!res.ok) {
      return { result: 'failed', stage: 'checks', error: `required check \`${command}\` failed:\n${res.output}` };
    }
  }
  return undefined;
}

/** What the agent is told when the owner enabled auto-land — the Guard's written permission. An
 *  interactive run lands only after the user reviews it; an autonomous one lands on CEZ:DONE. */
export function landingPromptPart(baseBranch: string | undefined, checks: string[], autonomous: boolean): string {
  const target = baseBranch ?? 'the checked-out base branch';
  const checkLine = checks.length ? ` runs the required checks (${checks.map((c) => `\`${c}\``).join(', ')})` : '';
  return [
    `Landing: the project owner enabled AUTO-LAND for this project. You work directly in the repository checkout on ${target}.`,
    autonomous
      ? `When you end a turn with CEZ:DONE, cezar commits your changes, rebases onto the remote,${checkLine} and pushes to ${target} itself.`
      : `When you end a turn with CEZ:DONE, the user reviews your changes and may ask for corrections; when they approve, cezar commits, rebases onto the remote,${checkLine} and pushes to ${target} itself.`,
    'Pushing to the base branch is therefore authorized for this project, but leave it to cezar: do not commit, create branches, open pull requests, or push yourself.',
    'If landing fails, cezar sends you the error (a rebase conflict or a failing check): fix it and end with CEZ:DONE again.',
  ].join('\n');
}

export const READ_ONLY_PROMPT =
  'This is a READ-ONLY task: answer from the files in the repository. Do not create, edit, move or delete any file, and do not commit, branch or push. If the request needs a change, say so in your answer instead.';

export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
