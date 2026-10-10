import { execFile } from 'node:child_process';
import { z } from 'zod';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';

/**
 * Pull-request head checkouts for automations (spec 2026-10-06-agentic-e2e-checks Phase 3).
 *
 * A `checkout: 'pr-head'` automation verifies the PR it matched, not the base branch: before the
 * run starts, the PR is read from GitHub, its head is fetched into a NAMESPACED ref
 * (`refs/cezar/pr/<n>` — never a branch, so nothing appears in the user's branch list), and the
 * run forks its worktree from the fetched sha. Every outcome ends somewhere: a closed PR and an
 * unadmitted fork are skipped, an unreachable head fails the launch, and only a resolved head
 * starts a run.
 */

export interface PrHead {
  number: number;
  /** The base repository, `owner/name` — the one the automation polls. */
  repo: string;
  /** Where the head lives; differs from `repo` for a fork. */
  headRepo: string;
  headRef: string;
  /** The FETCHED sha — what is tested and recorded, even if the API said otherwise. */
  headSha: string;
  baseRef: string;
  /** `refs/cezar/pr/<n>`. */
  ref: string;
  /** The PR's web page, for the run's PR reference. */
  url: string;
  untrusted: boolean;
}

export type PrHeadResolution =
  | { kind: 'ok'; head: PrHead; note?: string }
  | { kind: 'skipped'; reason: 'pr-not-open' | 'fork-head' }
  | { kind: 'failed'; reason: string };

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (command: 'gh' | 'git', args: string[], cwd: string) => Promise<CommandResult>;

const pullSchema = z.object({
  state: z.string(),
  html_url: z.string().url(),
  head: z.object({
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    ref: z.string().min(1),
    // `null` when the fork was deleted: there is no head repository to trust.
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  base: z.object({ ref: z.string().min(1) }),
});

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The one ref a PR head is fetched into. */
export function prHeadRef(number: number): string {
  return `refs/cezar/pr/${number}`;
}

export const runCommand: CommandRunner = (command, args, cwd) =>
  new Promise((resolve) => {
    execFile(command, args, { cwd, maxBuffer: 4 * 1024 * 1024, timeout: 120_000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr || (error ? error.message : '')) });
    });
  });

/** A failure reason safe for the execution log: secrets and token shapes removed, bounded. */
function unavailable(what: string, stderr: string): PrHeadResolution {
  const detail = redactSecrets(stderr.trim(), collectSecretValues()).slice(0, 1_000);
  return { kind: 'failed', reason: `pr-head-unavailable: ${what}${detail ? ` — ${detail}` : ''}` };
}

export async function resolvePrHead(options: {
  root: string;
  repo: string;
  number: number;
  allowForkHeads: boolean;
  run?: CommandRunner;
  env?: NodeJS.ProcessEnv;
}): Promise<PrHeadResolution> {
  const { root, repo, number } = options;
  const exec = options.run ?? runCommand;
  if (!REPO_RE.test(repo) || !Number.isSafeInteger(number) || number <= 0) {
    return { kind: 'failed', reason: `pr-head-unavailable: invalid pull request ${repo}#${number}` };
  }
  const ref = prHeadRef(number);

  // `CEZ_DRY_RUN=1`: no `gh`, no fetch. The fixture PR is open, same-repo, and its head is the
  // repository's current HEAD, pinned into the same namespaced ref a real fetch would write.
  if ((options.env ?? process.env).CEZ_DRY_RUN === '1') {
    const head = await exec('git', ['rev-parse', 'HEAD'], root);
    if (!head.ok) return unavailable('could not read the fixture head', head.stderr);
    const sha = head.stdout.trim();
    const pinned = await exec('git', ['update-ref', ref, sha], root);
    if (!pinned.ok) return unavailable(`could not write ${ref}`, pinned.stderr);
    return {
      kind: 'ok',
      head: {
        number, repo, headRepo: repo, headRef: `fixture-pr-${number}`, headSha: sha, baseRef: 'main', ref,
        url: `https://github.com/${repo}/pull/${number}`, untrusted: false,
      },
    };
  }

  const api = await exec('gh', ['api', `repos/${repo}/pulls/${number}`], root);
  if (!api.ok) return unavailable('could not read the pull request', api.stderr);
  let parsed: z.infer<typeof pullSchema>;
  try {
    parsed = pullSchema.parse(JSON.parse(api.stdout));
  } catch {
    return unavailable('unexpected pull request payload', '');
  }
  if (parsed.state !== 'open') return { kind: 'skipped', reason: 'pr-not-open' };
  const headRepo = parsed.head.repo?.full_name ?? '(deleted fork)';
  const untrusted = headRepo.toLowerCase() !== repo.toLowerCase();
  if (untrusted && !options.allowForkHeads) return { kind: 'skipped', reason: 'fork-head' };

  const fetched = await exec('git', ['fetch', '--no-tags', 'origin', `+refs/pull/${number}/head:${ref}`], root);
  if (!fetched.ok) return unavailable(`could not fetch refs/pull/${number}/head`, fetched.stderr);
  const resolved = await exec('git', ['rev-parse', '--verify', `${ref}^{commit}`], root);
  if (!resolved.ok) return unavailable(`could not resolve ${ref}`, resolved.stderr);
  const headSha = resolved.stdout.trim();

  return {
    kind: 'ok',
    head: {
      number, repo, headRepo, headRef: parsed.head.ref, headSha, baseRef: parsed.base.ref, ref,
      url: parsed.html_url, untrusted,
    },
    // The PR moved between the API read and the fetch: test what was fetched, and say so.
    ...(headSha !== parsed.head.sha
      ? { note: `pull request #${number} moved while launching — testing the fetched head ${headSha.slice(0, 12)} (the API reported ${parsed.head.sha.slice(0, 12)})` }
      : {}),
  };
}

/**
 * Delete every `refs/cezar/pr/<n>` no remaining run still needs. Idempotent, never throws: a
 * stale ref is harmless, leaking one per PR forever is not, so every worktree removal path
 * sweeps rather than tracking which removal was the last.
 */
export async function prunePrHeadRefs(
  root: string,
  stillNeeded: ReadonlySet<number>,
  run: CommandRunner = runCommand,
): Promise<void> {
  const listed = await run('git', ['for-each-ref', '--format=%(refname)', 'refs/cezar/pr/'], root);
  if (!listed.ok) return;
  for (const name of listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
    const match = /^refs\/cezar\/pr\/([1-9][0-9]*)$/.exec(name);
    if (!match || stillNeeded.has(Number(match[1]))) continue;
    await run('git', ['update-ref', '-d', name], root);
  }
}
