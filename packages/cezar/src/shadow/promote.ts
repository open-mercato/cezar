import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ShadowIntent } from '@open-mercato/cezar-contract';
import { classifyGh, ghFileReferences } from './gh-policy.ts';
import { defaultGit, type GitResult } from './git-redirect.ts';
import { LEDGER_VERSION, appendDecision, shadowDir, type ForgeIntentLine, type PushIntentLine } from './ledger.ts';
import { findExecutable } from './setup.ts';
import { loadShadowIntents, type LoadedIntent, type ShadowViewContext } from './view.ts';

/**
 * Carrying out a recorded intent (spec `2026-10-06-shadow-runs` § Promotion): the one door out of
 * a shadow run, opened only by a human, one intent at a time.
 *
 * Rules that hold whatever the ledger says, because the ledger is the agent's:
 *  - only a `click` intent runs, and its class is re-derived here from the raw argv/ref;
 *  - a push is a plain `git push <remote> <sha>:<ref>` - never `--force`, never a deletion;
 *  - `gh` is resolved on the SERVER's own PATH, never read from the run's `shadow.json`, which sits
 *    in a directory the agent can write;
 *  - argv goes to `execFile` as an array: no shell, ever;
 *  - a captured body file must still sit exactly where the recorded argv says it does, or the
 *    intent is refused rather than reassembled;
 *  - `gh pr create` waits for the run's pending branch push, so a PR is never opened against a
 *    branch the remote does not have;
 *  - `gh` runs in the run's own working directory, never in a checkout whose branch it would
 *    mistake for the run's.
 */

export type DecisionOutcome =
  | { ok: true; intent: ShadowIntent }
  | { ok: false; status: 404 | 409; error: string; manual?: string };

export interface PromoteContext extends ShadowViewContext {
  /** Where the run's agent worked - its worktree, or the checkout for an in-place run - and so the
   *  directory gh resolves its repository and branch from. Absent or gone, gh is not run. */
  workdir?: string;
  /** Runs the promoted command. Injected by tests; the default is `execFile` without a shell. */
  exec?: (bin: string, args: string[], cwd: string) => Promise<GitResult>;
  /** Where `gh` is. Defaults to the server's own PATH. */
  findGh?: () => string | null;
  now?: () => Date;
}

const PROMOTE_TIMEOUT_MS = 120_000;

const defaultExec = (bin: string, args: string[], cwd: string): Promise<GitResult> =>
  new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
        timeout: PROMOTE_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });

const defaultFindGh = () => findExecutable('gh', process.env.PATH ?? '', process.platform);

/** One decision at a time per run: two clicks on Promote must not run the command twice. */
const runLocks = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = runLocks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  runLocks.set(key, next);
  next
    .finally(() => {
      if (runLocks.get(key) === next) runLocks.delete(key);
    })
    .catch(() => undefined);
  return next;
}

const firstLine = (text: string) => text.trim().split('\n')[0] ?? '';

/** Real paths where they exist: macOS `/var` vs `/private/var`, Windows 8.3 short names. */
const canonical = (path: string) => {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
};

function isInside(dir: string, path: string): boolean {
  const rel = relative(canonical(dir), canonical(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

type Execution = { ok: boolean; detail: string } | { refused: string };

async function promotePush(context: PromoteContext, line: PushIntentLine): Promise<Execution> {
  const git = context.git ?? defaultGit;
  const remotes = await git(context.repoRoot, ['remote']);
  const configured = remotes.stdout.split('\n').map((name) => name.trim()).filter(Boolean);
  if (line.remote.startsWith('-') || !configured.includes(line.remote)) {
    return { refused: `remote "${line.remote}" is not configured in this repository` };
  }
  const format = await git(context.repoRoot, ['check-ref-format', line.ref]);
  if (!format.ok || !line.ref.startsWith('refs/heads/')) return { refused: `"${line.ref}" is not a branch ref` };
  const pushed = await (context.exec ?? defaultExec)('git', ['push', '--porcelain', line.remote, `${line.sha}:${line.ref}`], context.repoRoot);
  return { ok: pushed.ok, detail: (pushed.ok ? pushed.stdout : pushed.stderr || pushed.stdout).trim() };
}

async function promoteForge(context: PromoteContext, line: ForgeIntentLine, entries: readonly LoadedIntent[]): Promise<Execution> {
  if (classifyGh(line.argv).command === 'pr create') {
    const waiting = entries.find(
      (entry) => entry.view.kind === 'push' && entry.view.promotable === 'click' && (entry.view.state === 'pending' || entry.view.state === 'failed'),
    );
    if (waiting) return { refused: `promote "${waiting.view.summary}" first: the pull request needs its branch on the remote` };
  }
  // Which argv tokens carry a body file is re-derived from the argv itself; the ledger's own
  // `index`/`flag` are the agent's and only ever have to AGREE with it, one for one.
  const references = ghFileReferences(line.argv);
  const agrees =
    references.length === line.files.length &&
    references.every((reference) =>
      line.files.some(
        (file) =>
          file.index === reference.index &&
          file.flag === reference.flag &&
          file.inline === reference.inline &&
          file.name === reference.value,
      ),
    );
  if (!agrees) return { refused: 'the recorded command and its captured files disagree' };
  // gh reads the repository AND the current branch from its cwd: run anywhere else, a `pr create`
  // without `--head` would open a PR from whatever branch that checkout has out.
  const workdir = context.workdir && existsSync(context.workdir) ? context.workdir : null;
  if (!workdir) return { refused: "the run's working directory is gone, and gh would resolve another branch anywhere else" };
  if (!isInside(workdir, line.cwd)) return { refused: `it ran in ${line.cwd}, outside the run's working directory` };
  const gh = (context.findGh ?? defaultFindGh)();
  if (!gh) return { refused: 'gh is not installed on the machine cezar runs on' };

  const argv = [...line.argv];
  let scratch: string | undefined;
  try {
    if (line.files.length > 0) {
      scratch = mkdtempSync(join(tmpdir(), 'cez-shadow-promote-'));
      line.files.forEach((file, index) => {
        const path = join(scratch as string, `body-${index}.txt`);
        writeFileSync(path, file.content, 'utf8');
        argv[file.index] = file.inline ? `${file.flag}=${path}` : path;
      });
    }
    const ran = await (context.exec ?? defaultExec)(gh, argv, workdir);
    return { ok: ran.ok, detail: (ran.ok ? ran.stdout : ran.stderr || ran.stdout).trim() };
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

async function findIntent(context: PromoteContext, intentId: string): Promise<{ entry?: LoadedIntent; entries: LoadedIntent[] }> {
  const { entries } = await loadShadowIntents(context);
  return { entry: entries.find((candidate) => candidate.view.id === intentId), entries };
}

async function refreshed(context: PromoteContext, intentId: string, fallback: ShadowIntent): Promise<ShadowIntent> {
  return (await findIntent(context, intentId)).entry?.view ?? fallback;
}

export function promoteShadowIntent(context: PromoteContext, intentId: string): Promise<DecisionOutcome> {
  return serialized(`${context.dataDir}\0${context.runId}`, async (): Promise<DecisionOutcome> => {
    const { entry, entries } = await findIntent(context, intentId);
    if (!entry) return { ok: false, status: 404, error: 'no such intent' };
    const { view, line } = entry;
    if (view.state === 'promoted' || view.state === 'discarded') {
      return { ok: false, status: 409, error: `this intent was already ${view.state}` };
    }
    if (view.promotable !== 'click') {
      return {
        ok: false,
        status: 409,
        error: `cezar does not run this intent: ${view.reason}`,
        ...(view.promotable === 'manual' ? { manual: view.command } : {}),
      };
    }
    const result = line.kind === 'push' ? await promotePush(context, line) : await promoteForge(context, line, entries);
    if ('refused' in result) return { ok: false, status: 409, error: result.refused, manual: view.command };

    appendDecision(shadowDir(context.dataDir, context.runId), {
      v: LEDGER_VERSION,
      type: 'decision',
      intentId,
      at: (context.now?.() ?? new Date()).toISOString(),
      decision: result.ok ? 'promoted' : 'failed',
      detail: result.detail.slice(0, 4_000),
    });
    if (!result.ok) {
      return { ok: false, status: 409, error: `promotion failed: ${firstLine(result.detail) || 'no output'}`, manual: view.command };
    }
    return { ok: true, intent: await refreshed(context, intentId, view) };
  });
}

export function discardShadowIntent(context: PromoteContext, intentId: string): Promise<DecisionOutcome> {
  return serialized(`${context.dataDir}\0${context.runId}`, async (): Promise<DecisionOutcome> => {
    const { entry } = await findIntent(context, intentId);
    if (!entry) return { ok: false, status: 404, error: 'no such intent' };
    if (entry.view.state === 'promoted' || entry.view.state === 'discarded') {
      return { ok: false, status: 409, error: `this intent was already ${entry.view.state}` };
    }
    appendDecision(shadowDir(context.dataDir, context.runId), {
      v: LEDGER_VERSION,
      type: 'decision',
      intentId,
      at: (context.now?.() ?? new Date()).toISOString(),
      decision: 'discarded',
    });
    return { ok: true, intent: await refreshed(context, intentId, entry.view) };
  });
}
