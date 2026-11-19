/**
 * Assess Impact's server half (spec 2026-10-22-html-artifacts-and-impact § Serving, Q8–Q10):
 * resolve and PIN a subject before any run exists, and find the newest run per subject.
 *
 * A PR goes through the automations' `pr-head.ts` resolver — head fetched into
 * `refs/cezar/pr/<n>`, the same admission rules (closed → refused, a fork → refused) — and the
 * run forks its worktree from the fetched sha through the internal `forkRef` path, so `POST /runs`
 * never gains a fetch-from-GitHub field. A spec must be a tracked `.ai/specs/**.md` file; its blob
 * sha at HEAD is pinned. Every refusal is one human line.
 */
import { execFile } from 'node:child_process';
import type { ImpactSubjectInput, RunSubject } from '@open-mercato/cezar-contract';
import { resolvePrHead, runCommand, type CommandRunner } from '../automations/pr-head.ts';
import { resolveBaseRef } from '../git-worktree.ts';
import type { RunRecord } from '../runs/store.ts';
import { fetchPrHeadSha, resolveRepoHandle } from '../server/forge/github.ts';
import { repoIndexContains } from '../server/git-changes.ts';
import { getRepoInfo } from '../server/git.ts';
import type { StartRunInput } from '../workflows/run.ts';

export interface ImpactLaunch {
  task: string;
  subject: RunSubject;
  forkRef?: StartRunInput['forkRef'];
  /** Said on the run's log, e.g. the PR moved while it was fetched. */
  note?: string;
}

export type ImpactResolution = { ok: true; launch: ImpactLaunch } | { ok: false; status: 404 | 409; error: string };

export interface ImpactDeps {
  /** Test seam for the `gh`/`git` calls of a PR subject. */
  run?: CommandRunner;
  /** `owner/name` of the project's GitHub repository; null when `gh` cannot say. */
  repoHandle?: (root: string) => Promise<{ owner: string; name: string } | null>;
  env?: NodeJS.ProcessEnv;
}

/** `.ai/specs/` and below, a `.md` file, no `.`/`..` segment, no backslash, relative. */
const SPEC_PATH_RE = /^\.ai\/specs\/(?:[^/\\\0]+\/)*[^/\\\0]+\.md$/;

export function isSpecPath(path: string): boolean {
  return SPEC_PATH_RE.test(path) && !path.split('/').some((segment) => segment === '.' || segment === '..');
}

export const GH_UNAVAILABLE =
  'GitHub is unavailable — install the gh CLI and run `gh auth login`, and check the project has a GitHub remote';

function git(root: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, timeout: 15_000 }, (error, stdout) => resolve(error ? null : String(stdout).trim()));
  });
}

/** `git rev-parse HEAD:<path>` — the spec's blob at the checkout's HEAD, or null. */
export function specBlobSha(root: string, path: string): Promise<string | null> {
  return git(root, ['rev-parse', '--verify', '--quiet', `HEAD:${path}`]);
}

export async function resolveImpactSubject(root: string, input: ImpactSubjectInput, deps: ImpactDeps = {}): Promise<ImpactResolution> {
  if (!(await getRepoInfo(root))) {
    return { ok: false, status: 409, error: 'Assess impact needs a git repository with at least one commit' };
  }
  if (input.kind === 'spec') return resolveSpec(root, input.path);
  return resolvePr(root, input.number, deps);
}

async function resolveSpec(root: string, path: string): Promise<ImpactResolution> {
  if (!isSpecPath(path)) {
    return { ok: false, status: 409, error: `only a Markdown spec under .ai/specs/ can be assessed — not ${JSON.stringify(path.slice(0, 200))}` };
  }
  const index = await repoIndexContains(root, path);
  if (!index.ok) return { ok: false, status: 409, error: `could not read the repository index: ${index.error}` };
  if (!index.indexed) return { ok: false, status: 409, error: `${path} is not a file in this repository` };
  const blobSha = await specBlobSha(root, path);
  if (!blobSha) return { ok: false, status: 409, error: `${path} is not committed on the current branch yet — commit it, then assess it` };
  return { ok: true, launch: { task: `Assess the impact of the spec ${path}`, subject: { kind: 'spec', path, blobSha } } };
}

async function resolvePr(root: string, number: number, deps: ImpactDeps): Promise<ImpactResolution> {
  const env = deps.env ?? process.env;
  const dry = env.CEZ_DRY_RUN === '1';
  // A dry run fetches nothing: `resolvePrHead` pins the fixture head to the current HEAD.
  const handle = dry ? { owner: 'dry-run', name: 'repo' } : await (deps.repoHandle ?? resolveRepoHandle)(root);
  if (!handle) return { ok: false, status: 409, error: GH_UNAVAILABLE };
  const resolution = await resolvePrHead({
    root,
    repo: `${handle.owner}/${handle.name}`,
    number,
    // Assessing runs an agent with Bash over the head's code and text: a fork is never admitted.
    allowForkHeads: false,
    run: deps.run ?? runCommand,
    env,
  });
  if (resolution.kind === 'skipped') {
    return {
      ok: false,
      status: 409,
      error: resolution.reason === 'pr-not-open'
        ? `pull request #${number} is not open — only an open pull request can be assessed`
        : `pull request #${number} comes from a fork — fork heads are not checked out for assessment`,
    };
  }
  if (resolution.kind === 'failed') {
    if (resolution.notFound) return { ok: false, status: 404, error: `pull request #${number} not found in ${handle.owner}/${handle.name}` };
    if (/ENOENT/.test(resolution.reason)) return { ok: false, status: 409, error: GH_UNAVAILABLE };
    return { ok: false, status: 409, error: resolution.reason.split('\n')[0]!.slice(0, 500) };
  }
  const { head } = resolution;
  // `cez impact evidence --pr` pins GitHub's base tip, which the head fetch does not bring and
  // the forkRef path never refreshes; best effort, a failed fetch leaves the evidence to say so.
  if (!dry) await resolveBaseRef(root, head.baseRef).catch(() => null);
  const title = head.title?.replace(/\s+/g, ' ').trim();
  return {
    ok: true,
    launch: {
      // Both the URL and the worded `pull request #N` are what `runs/task-refs.ts` attributes.
      task: `Assess the impact of GitHub pull request #${number}${title ? `: ${title}` : ''}\n\n${head.url}`,
      subject: { kind: 'pr', number, headSha: head.headSha },
      forkRef: {
        sha: head.headSha,
        label: `pr/${head.number}`,
        pr: {
          number: head.number, repo: head.repo, headRepo: head.headRepo, headRef: head.headRef,
          headSha: head.headSha, baseRef: head.baseRef, ref: head.ref,
        },
        prUrl: head.url,
        untrusted: head.untrusted,
      },
      ...(resolution.note ? { note: resolution.note } : {}),
    },
  };
}

/** `pr:<n>` | `spec:<path>` (already shape-checked by the query schema). */
export function parseSubjectQuery(subject: string): ImpactSubjectInput {
  return subject.startsWith('pr:') ? { kind: 'pr', number: Number(subject.slice(3)) } : { kind: 'spec', path: subject.slice(5) };
}

/** The newest run whose pinned subject is `input` — a deleted run falls through to the previous. */
export function newestSubjectRun(runs: readonly RunRecord[], input: ImpactSubjectInput): RunRecord | undefined {
  let newest: RunRecord | undefined;
  for (const run of runs) {
    const subject = run.subject;
    if (!subject || subject.kind !== input.kind) continue;
    if (subject.kind === 'pr' ? subject.number !== (input as { number: number }).number : subject.path !== (input as { path: string }).path) continue;
    if (!newest || run.createdAt > newest.createdAt) newest = run;
  }
  return newest;
}

/**
 * Has the subject moved since the run pinned it? PR: the head GitHub reports now (the merge
 * box's cache, else one memoized `gh pr view`); spec: its blob at HEAD. `null` = cannot tell.
 */
export async function subjectStale(
  root: string,
  subject: RunSubject,
  deps: { prHeadSha?: (root: string, number: number) => Promise<string | null>; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean | null> {
  if (subject.kind === 'spec') {
    const now = await specBlobSha(root, subject.path);
    return now === null ? null : now !== subject.blobSha;
  }
  // A dry run's fixture head is the checkout's HEAD (`resolvePrHead`).
  const now = (deps.env ?? process.env).CEZ_DRY_RUN === '1'
    ? await git(root, ['rev-parse', 'HEAD'])
    : await (deps.prHeadSha ?? fetchPrHeadSha)(root, subject.number);
  return now === null ? null : now.toLowerCase() !== subject.headSha.toLowerCase();
}
