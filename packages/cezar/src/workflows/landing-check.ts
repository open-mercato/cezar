/**
 * The landing check's engine half (spec `.ai/specs/2026-09-29-landing-check.md`, PR 4): the
 * SUBJECT — what combination is being checked — and the arithmetic that decides whether a
 * candidate child belongs in it.
 *
 * A landing check answers one question no other surface answers: *is the UNION green?* Every
 * dispatched child checks its own branch; nothing checked the tree a parent is about to land.
 * The verdict is a claim about one constructed, frozen tree:
 *
 *     subject = (base = the invoking run's branch tip at request time)
 *             + (sources = the tree's eligible children, applied BY SHA, in dispatch order)
 *     identity = the resulting commit's tree sha
 *
 * Three rules are load-bearing and each exists because the obvious version is wrong:
 *
 *  - **`--is-ancestor` alone is not "landed".** An empty child — one that committed nothing —
 *    has its tip equal to its fork point, which IS an ancestor of the parent tip, so ancestry
 *    alone reports every empty child as already merged (the live false positive probed on tree
 *    `c603664e`). Landed means ancestry AND commits past the fork point; emptiness is tested
 *    FIRST, and an empty child is named `empty`, never `already-landed`.
 *  - **Order comes from the ledger, never from `createdAt`.** `childrenOf()` reads
 *    `store.listRuns()`, which is `createdAt` DESC — the reverse of dispatch order. Merge order
 *    is a semantic input, so it comes from `ledger.jsonl`, which appends chronologically.
 *  - **Sources are applied by sha, never by name.** A branch that moves while the check runs
 *    cannot change what was checked; the record's `(ref, sha)` pairs are the pin.
 *
 * This module reads git and the dispatch tree only. It executes NOTHING: the merge loop below
 * runs `git merge` (fixed argv, no shell), and every command the check eventually runs is
 * resolved and executed elsewhere (`check-commands.ts` decides WHAT may run, `check-runner.ts`
 * runs it).
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckOutcomeStatus } from './check-runner.ts';
import { isSafeGitRef } from '../git-refs.ts';
import { treeDir } from '../dispatch/tree-fs.ts';
import type { RunRecord } from '../runs/store.ts';

/** One source of the subject: the name it was found by, and the commit that is actually merged. */
export interface LandingSource {
  ref: string;
  sha: string;
}

/** Why a candidate was left out. Recorded on the subject so the omission is auditable. */
export type LandingExclusionReason =
  | 'unknown-run'
  | 'not-terminal'
  | 'review'
  | 'failed'
  | 'missing-ref'
  | 'empty'
  | 'already-landed'
  | 'duplicate';

export interface LandingExclusion {
  runId: string;
  sha?: string;
  reason: LandingExclusionReason;
}

export interface LandingCandidateSet {
  /** `explicit` when the request/CLI named the sources; `ledger` when the tree's own order did. */
  order: 'explicit' | 'ledger';
  sources: LandingSource[];
  excluded: LandingExclusion[];
  /** One line per decision worth explaining, for the check run's transcript. */
  notes: string[];
}

/** The outcome of deriving the subject's sources. A vanished EXPLICIT ref is a refusal: the
 *  caller named it, so silently checking a different combination is not an option. */
export type LandingDerivation =
  | { status: 'ok'; candidates: LandingCandidateSet }
  | { status: 'could-not-run'; reason: 'source-missing'; detail: string };

/** A caller-supplied `git` invocation, already bound to a working directory. Same shape as
 *  `git-diff-base.ts`'s runner, widened with stderr because the merge loop reports it — and with
 *  an optional env, which is how the merge loop pins the commits it creates (see
 *  `landingMergeEnv`). */
export type LandingGit = (
  args: string[],
  env?: Record<string, string>,
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/** A `git` runner bound to `cwd`. Never throws — every caller branches on `ok`. */
export function gitIn(cwd: string): LandingGit {
  return (args, env) =>
    new Promise((resolve) => {
      execFile(
        'git',
        args,
        {
          cwd,
          maxBuffer: 32 * 1024 * 1024,
          encoding: 'utf8',
          // Spread, never replace: git needs PATH, HOME and its own GIT_* vars from the host.
          ...(env ? { env: { ...process.env, ...env } } : {}),
        },
        (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
      );
    });
}

// ---- the ledger reader ---------------------------------------------------------------------

/** One `dispatch` line of `ledger.jsonl` — the tree's chronological record of what was dispatched. */
export interface LedgerDispatch {
  runId: string;
  parentRunId: string;
  /** ISO instant the engine wrote the line. */
  at?: string;
}

/**
 * The tree's dispatch order, read from `ledger.jsonl` (`dispatch/tree-fs.ts:163`).
 *
 * A ledger line is best-effort data written by a best-effort writer, so this reader is total: a
 * missing file is an empty list, a malformed line is skipped, and a line that is not a dispatch
 * is not an order. Only `parentRunId` matchers are returned — grandchildren belong to their own
 * parent's subject, not to this one.
 */
export function readLedgerDispatches(dataDir: string, rootRunId: string, parentId: string): LedgerDispatch[] {
  let text: string;
  try {
    text = readFileSync(join(treeDir(dataDir, rootRunId), 'ledger.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const dispatches: LedgerDispatch[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // a half-written line is a line with no history, not a broken tree
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== 'dispatch') continue;
    if (typeof record.runId !== 'string' || typeof record.parentRunId !== 'string') continue;
    if (record.parentRunId !== parentId) continue;
    dispatches.push({
      runId: record.runId,
      parentRunId: record.parentRunId,
      ...(typeof record.at === 'string' ? { at: record.at } : {}),
    });
  }
  return dispatches;
}

// ---- candidate derivation --------------------------------------------------------------------

/** A full ISO-8601 instant, as `startedAt` records it — what a reflog revision can be read at. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Where this child's branch actually forked: the parent branch as the CHILD's own run found it —
 * `<baseBranch>@{<startedAt>}`, the reflog revision `git-diff-base.ts` already reads for exactly
 * this question. A dispatched child forks its worktree off the parent's branch at `execute` time,
 * which is the instant `startedAt` records, so the lookup returns the commit the child built on.
 *
 * This is what makes `empty` and `already-landed` two different facts instead of one: for a
 * MERGED child, `merge-base(<parent>, <child>)` is the child's own tip, so a commit count from
 * the merge-base can only ever say "nothing new" — it cannot tell a child whose work is in the
 * base from a child that committed nothing. From the FORK point it can: the merged child is 1
 * commit ahead of its fork, the empty one is 0.
 *
 * Undefined when the reflog cannot answer (no `startedAt`, no recorded `baseBranch`, reflogs
 * disabled, a deleted parent branch). The caller then falls back to the merge-base, which is the
 * fork point for every child that has NOT been merged — the conservative half of the answer.
 */
async function childForkPoint(git: LandingGit, record: RunRecord): Promise<string | undefined> {
  const base = record.baseBranch;
  const startedAt = record.startedAt;
  if (!base || !startedAt || !ISO_INSTANT.test(startedAt) || !isSafeGitRef(base)) return undefined;
  const at = await git(['rev-parse', '--verify', '--quiet', `${base}@{${startedAt}}^{commit}`]);
  return at.ok && at.stdout.trim() ? at.stdout.trim() : undefined;
}

/**
 * Is this candidate eligible — and if not, why? The design's own rule
 * (`units/652cd408/notes.md` §(b)): a child is LANDED when it is an ancestor of the frozen base
 * AND it is ahead of its fork point. The second half is not optional — an empty child's tip IS
 * its fork point, which is an ancestor of the parent tip whenever the parent has moved past it,
 * so ancestry alone answers LANDED for a child that committed nothing.
 *
 * Emptiness is therefore tested BEFORE ancestry, so an empty child is never recorded as landed.
 */
async function ineligibility(
  git: LandingGit,
  parentSha: string,
  sha: string,
  forkPoint?: string,
): Promise<'empty' | 'already-landed' | null> {
  const fork = forkPoint ?? (await git(['merge-base', parentSha, sha])).stdout.trim();
  if (fork) {
    const ahead = await git(['rev-list', '--count', `${fork}..${sha}`]);
    if (ahead.ok && Number.parseInt(ahead.stdout.trim(), 10) === 0) return 'empty';
  }
  // Unrelated histories (merge-base exits 1 with no output) fall through to ancestry: the merge
  // itself will decide, and `could-not-run` is the honest verdict for a history git refuses.
  const ancestor = await git(['merge-base', '--is-ancestor', sha, parentSha]);
  return ancestor.ok ? 'already-landed' : null;
}

/** Order the ledger's children when the ledger itself is missing: `createdAt` ASCENDING, which is
 *  the dispatch order `listRuns()` reverses. The fallback is named in a note — never silent. */
function storeOrderFallback(runs: readonly RunRecord[], parentId: string): RunRecord[] {
  return runs
    .filter((run) => run.dispatch?.parentRunId === parentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export interface DeriveLandingCandidatesOptions {
  dataDir: string;
  /** The tree's root run id — where `ledger.jsonl` lives. */
  rootRunId: string;
  /** The run whose branch tip is the subject's base. */
  parentId: string;
  /** That base, frozen: ancestry and emptiness are both measured against THIS commit. */
  parentSha: string;
  /** The request/CLI list. Present = it replaces the ledger order entirely. */
  explicit?: readonly string[];
  runs: readonly RunRecord[];
  /** Injectable for tests; defaults to a real `git` in the repository root. */
  repoRoot?: string;
  git?: LandingGit;
}

/**
 * The subject's sources, in the order they will be merged.
 *
 * Explicit list first (shape-validated upstream, bounded, resolved here — a vanished ref is a
 * refusal); otherwise the tree's own ledger order, filtered to children that are terminal `done`,
 * not `kind: 'review'`, neither empty nor already in the parent, and deduped by sha. Every
 * exclusion is recorded with its reason.
 */
export async function deriveLandingCandidates(options: DeriveLandingCandidatesOptions): Promise<LandingDerivation> {
  const git = options.git ?? gitIn(options.repoRoot ?? process.cwd());
  const excluded: LandingExclusion[] = [];
  const notes: string[] = [];

  if (options.explicit?.length) {
    const sources: LandingSource[] = [];
    for (const entry of options.explicit) {
      const resolved = await git(['rev-parse', '--verify', '--quiet', `${entry}^{commit}`]);
      if (!resolved.ok) {
        return { status: 'could-not-run', reason: 'source-missing', detail: `source "${entry}" does not resolve to a commit` };
      }
      sources.push({ ref: entry, sha: resolved.stdout.trim() });
    }
    return { status: 'ok', candidates: { order: 'explicit', sources: dedupe(sources, excluded), excluded, notes } };
  }

  const ledger = readLedgerDispatches(options.dataDir, options.rootRunId, options.parentId);
  const ordered: Array<{ runId: string; record?: RunRecord }> = ledger.length
    ? ledger.map((entry) => ({ runId: entry.runId, record: options.runs.find((run) => run.id === entry.runId) }))
    : storeOrderFallback(options.runs, options.parentId).map((record) => ({ runId: record.id, record }));
  if (!ledger.length && ordered.length) {
    notes.push('no dispatch ledger for this parent — falling back to store order (createdAt ascending), which is the closest available approximation of dispatch order');
  }

  const sources: LandingSource[] = [];
  const seen = new Set<string>();
  for (const candidate of ordered) {
    const { runId } = candidate;
    const record = candidate.record;
    if (!record) {
      excluded.push({ runId, reason: 'unknown-run' });
      continue;
    }
    if (record.status !== 'done') {
      excluded.push({ runId, reason: record.status === 'review' || record.status === 'failed' || record.status === 'cancelled' ? (record.status === 'review' ? 'review' : 'failed') : 'not-terminal' });
      continue;
    }
    if (record.dispatch?.kind === 'review') {
      excluded.push({ runId, reason: 'review' });
      continue;
    }
    const ref = record.branch;
    if (!ref) {
      excluded.push({ runId, reason: 'missing-ref' });
      continue;
    }
    const resolved = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (!resolved.ok) {
      excluded.push({ runId, reason: 'missing-ref' });
      continue;
    }
    const sha = resolved.stdout.trim();
    const why = await ineligibility(git, options.parentSha, sha, await childForkPoint(git, record));
    if (why) {
      excluded.push({ runId, sha, reason: why });
      continue;
    }
    if (seen.has(sha)) {
      excluded.push({ runId, sha, reason: 'duplicate' });
      continue;
    }
    seen.add(sha);
    sources.push({ ref, sha });
  }
  if (excluded.length) {
    notes.push(`excluded ${excluded.length} candidate${excluded.length === 1 ? '' : 's'}: ${excluded.map((item) => `${item.runId.slice(0, 8)} (${item.reason})`).join(', ')}`);
  }
  return { status: 'ok', candidates: { order: 'ledger', sources, excluded, notes } };
}

/** Drop repeated shas, keeping the FIRST occurrence; later ones are recorded as `duplicate`. */
function dedupe(sources: LandingSource[], excluded: LandingExclusion[]): LandingSource[] {
  const seen = new Set<string>();
  const out: LandingSource[] = [];
  for (const source of sources) {
    if (seen.has(source.sha)) {
      excluded.push({ runId: source.ref, sha: source.sha, reason: 'duplicate' });
      continue;
    }
    seen.add(source.sha);
    out.push(source);
  }
  return out;
}

// ---- materialization ---------------------------------------------------------------------------

/** The merge loop's non-green reasons, as the record spells them. */
export type LandingMaterializeReason = 'dirty-worktree' | 'merge-failed' | 'tree-moved' | 'abort-failed';

export type LandingMaterializeResult =
  | { status: 'materialized'; headSha: string; treeSha: string; merged: string[] }
  | { status: 'conflict'; failedSha: string; files: string[]; merged: string[]; detail: string }
  | { status: 'could-not-run'; reason: LandingMaterializeReason | 'source-missing' | 'stale-head'; detail: string; merged: string[] };

export interface MaterializeLandingSubjectOptions {
  /** The check run's OWN scratch worktree — never the parent's, never a shared `node_modules`. */
  worktreePath: string;
  /** The frozen base commit; the worktree must be AT it (a retry is reset to it). */
  baseSha: string;
  sources: readonly LandingSource[];
  git?: LandingGit;
}

/**
 * The identity and date every merge commit of ONE materialization is stamped with, read from the
 * frozen BASE commit: its author and committer identities, and its committer date.
 *
 * `git merge --no-ff` would otherwise stamp each commit with the operator's current identity and
 * the current time, so the same subject would materialize to a different commit on every run —
 * and the acknowledgement digest binds the materialized head, so a foreign preview's digest could
 * never match the run that acks it. Pinning the stamp makes the subject a pure function of
 * (base, sources, order): same content, same tree, same head, same digest.
 *
 * `undefined` when the base cannot be read — the merge loop then runs as git would by default,
 * and a base that cannot be read fails on its own.
 */
const MERGE_STAMP_FORMAT = '%an%x09%ae%x09%cn%x09%ce%x09%cI';

async function landingMergeEnv(git: LandingGit, baseSha: string): Promise<Record<string, string> | undefined> {
  const read = await git(['log', '-1', `--format=${MERGE_STAMP_FORMAT}`, baseSha]);
  if (!read.ok) return undefined;
  const [authorName = '', authorEmail = '', committerName = '', committerEmail = '', date = ''] = read.stdout
    .trim()
    .split('\t');
  if (!date) return undefined;
  return {
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: committerName || authorName,
    GIT_COMMITTER_EMAIL: committerEmail || authorEmail,
    GIT_COMMITTER_DATE: date,
  };
}

/**
 * Materialize the subject: `git merge --no-ff <sha>` for each source, in order, in the check
 * run's own worktree.
 *
 * The commits it creates are REPRODUCIBLE — identity, date and no-signing are pinned to the
 * frozen base (`landingMergeEnv`) — so the same subject yields the same head on a later run, which
 * is what the acknowledgement digest binds.
 *
 * Three guards, each closing a measured way for the check to lie about what it checked:
 *  - a CLEAN PRECONDITION (a dirty, non-overlapping tracked file merges silently — the verdict
 *    would then be about a tree nobody can reconstruct);
 *  - a post-merge check that git really finished (`MERGE_HEAD` gone, no `ls-files -u`, worktree
 *    clean) — a merge left half-applied is not a merge;
 *  - a conflict stops the loop: the conflicting paths are recorded, `git merge --abort` restores
 *    the tree, and NO command runs. An agent-resolved conflict is out of v1.
 */
export async function materializeLandingSubject(options: MaterializeLandingSubjectOptions): Promise<LandingMaterializeResult> {
  const git = options.git ?? gitIn(options.worktreePath);
  const merged: string[] = [];

  const status = await git(['status', '--porcelain']);
  if (!status.ok) {
    return { status: 'could-not-run', reason: 'dirty-worktree', detail: `git status failed: ${status.stderr.trim()}`, merged };
  }
  if (status.stdout.trim() !== '') {
    return { status: 'could-not-run', reason: 'dirty-worktree', detail: 'the check worktree is not clean', merged };
  }

  const head = await git(['rev-parse', 'HEAD']);
  if (!head.ok) {
    return { status: 'could-not-run', reason: 'merge-failed', detail: `git rev-parse HEAD failed: ${head.stderr.trim()}`, merged };
  }
  if (head.stdout.trim() !== options.baseSha) {
    // Reachable only on a retry of a check run (the run's own worktree is scratch and unbranched
    // by anyone else): re-anchor it on the frozen base rather than merging onto a stale partial.
    const reset = await git(['reset', '--hard', options.baseSha]);
    if (!reset.ok) {
      return { status: 'could-not-run', reason: 'stale-head', detail: `the check worktree is not at the frozen base and could not be reset: ${reset.stderr.trim()}`, merged };
    }
  }

  const mergeEnv = await landingMergeEnv(git, options.baseSha);
  for (const source of options.sources) {
    const merge = await git(
      [
        // A GPG signature embeds a signing time, so a signed commit could never be reproduced:
        // the same subject is the same commit only while these synthetic merges are unsigned.
        '-c',
        'commit.gpgsign=false',
        'merge',
        '--no-ff',
        '--no-edit',
        '-m',
        `Landing check: merge ${source.ref} (${source.sha.slice(0, 8)})`,
        source.sha,
      ],
      mergeEnv,
    );
    if (!merge.ok) {
      const conflicts = await git(['diff', '--name-only', '--diff-filter=U']);
      const files = conflicts.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      const detail = (merge.stderr.trim() || merge.stdout.trim() || 'merge failed').split('\n')[0] ?? 'merge failed';
      if (files.length === 0) {
        return { status: 'could-not-run', reason: 'merge-failed', detail: `merging ${source.sha.slice(0, 8)} failed: ${detail}`, merged };
      }
      const abort = await git(['merge', '--abort']);
      if (!abort.ok) {
        return { status: 'could-not-run', reason: 'abort-failed', detail: `a conflict on ${source.sha.slice(0, 8)} could not be aborted: ${abort.stderr.trim()}`, merged };
      }
      return { status: 'conflict', failedSha: source.sha, files, merged, detail };
    }
    // A merge that "succeeded" but left the index unmerged or the tree dirty did not succeed.
    const mergeHead = await git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
    const unmerged = await git(['ls-files', '-u']);
    const after = await git(['status', '--porcelain']);
    if (mergeHead.ok || (unmerged.ok && unmerged.stdout.trim() !== '') || after.stdout.trim() !== '') {
      const files = unmerged.stdout.split('\n').map((line) => line.trim().split('\t').pop() ?? '').filter(Boolean);
      const abort = await git(['merge', '--abort']);
      if (!abort.ok) {
        return { status: 'could-not-run', reason: 'abort-failed', detail: `an incomplete merge of ${source.sha.slice(0, 8)} could not be aborted: ${abort.stderr.trim()}`, merged };
      }
      return {
        status: 'conflict',
        failedSha: source.sha,
        files,
        merged,
        detail: `merging ${source.sha.slice(0, 8)} left the worktree dirty`,
      };
    }
    merged.push(source.sha);
  }

  const final = await git(['status', '--porcelain']);
  if (final.stdout.trim() !== '') {
    return { status: 'could-not-run', reason: 'tree-moved', detail: 'the worktree changed while the subject was being materialized', merged };
  }
  const headAfter = await git(['rev-parse', 'HEAD']);
  const tree = await git(['rev-parse', 'HEAD^{tree}']);
  if (!headAfter.ok || !tree.ok) {
    return { status: 'could-not-run', reason: 'tree-moved', detail: `could not read the resulting tree: ${tree.stderr.trim()}`, merged };
  }
  return { status: 'materialized', headSha: headAfter.stdout.trim(), treeSha: tree.stdout.trim(), merged };
}

// ---- the verdict ------------------------------------------------------------------------------

export type LandingVerdict = 'passed' | 'failed' | 'conflict' | 'nothing-to-check' | 'could-not-run';

/** One executed (or deliberately not executed) command, as the record keeps it. */
export interface LandingResultEntry {
  command: string;
  exitCode: number | null;
  outcome: 'passed' | 'failed' | 'not-run' | 'could-not-run';
  startedAt: string;
  finishedAt?: string;
}

/** The seam's six statuses as the record's four, with the reason that keeps the difference. The
 *  status alone carries it: the exit code and the timestamps are recorded by the caller, and this
 *  mapping never read them. */
export function landingResultOf(status: CheckOutcomeStatus): Pick<LandingResultEntry, 'outcome'> & { reason?: string } {
  switch (status) {
    case 'passed':
      return { outcome: 'passed' };
    case 'failed':
      return { outcome: 'failed' };
    case 'timed-out':
      return { outcome: 'could-not-run', reason: 'timeout' };
    case 'skipped':
      return { outcome: 'could-not-run', reason: 'dry-run' };
    case 'cancelled':
      return { outcome: 'could-not-run', reason: 'cancelled' };
    case 'could-not-run':
      return { outcome: 'could-not-run', reason: 'unsupported-platform' };
    default:
      return { outcome: 'could-not-run' };
  }
}

/**
 * The verdict a list of results earns. Only an unbroken run of `passed` is green; everything else
 * is visibly not, and the first non-green outcome names the reason.
 */
export function verdictFromResults(results: readonly LandingResultEntry[]): { verdict: LandingVerdict; reason?: string } {
  if (results.length > 0 && results.every((entry) => entry.outcome === 'passed')) return { verdict: 'passed' };
  const failed = results.find((entry) => entry.outcome === 'failed');
  if (failed) return { verdict: 'failed', reason: 'command-failed' };
  return { verdict: 'could-not-run' };
}

// ---- the trust model: foreign subjects and the acknowledgement digest -------------------------

/**
 * Is this subject the operator's OWN work? The check runs repository-authored shell with the
 * operator's identity, and the spec's brake is that a foreign subject — any commit a source
 * introduces whose author or committer is not the local user — stops before execution.
 *
 * The LOCAL identity set is deliberately two things, and the second half is what keeps the rule
 * zero-config:
 *
 *  - the repository's configured `user.email` (`git config --get user.email`, so local, global
 *    and system config all count), when set; PLUS
 *  - the author and committer emails of the subject's OWN base commit — the invoking run's branch
 *    tip, which by construction is the operator's own work.
 *
 * Without the second half, a fixture repository (or a container) that never ran
 * `git config user.email` would read every commit made with `-c user.email=test@local` as
 * foreign, and the check's zero-config path would be preview-only. With it, a colleague's
 * fetched branch — whose commits carry an identity neither source knows — is foreign, which is
 * the case the brake exists for.
 *
 * Fail-closed on an unreadable history: a scan that cannot name identities cannot prove the
 * subject is local, and guessing "local" would run foreign code. Detection reads git only; it
 * executes NOTHING.
 */
export interface LandingForeignReport {
  foreign: boolean;
  /** The foreign identities as `Name <email>`, deduped and sorted (stable across runs). */
  authors: string[];
  /** The source tip the FIRST foreign commit arrived with — the head a preview is about. */
  headSha?: string;
  /** True when a source's history could not be read at all; the report is foreign either way. */
  unreadable?: boolean;
}

/** The commit-identity format the scan parses: author name/email, committer name/email. */
const IDENTITY_FORMAT = '%an%x09%ae%x09%cn%x09%ce';

export async function detectForeignSubject(options: {
  git: LandingGit;
  baseSha: string;
  sources: readonly LandingSource[];
}): Promise<LandingForeignReport> {
  const local = new Set<string>();
  const configured = await options.git(['config', '--get', 'user.email']);
  const configuredEmail = configured.ok ? configured.stdout.trim().toLowerCase() : '';
  if (configuredEmail) local.add(configuredEmail);

  const base = await options.git(['log', '-1', '--format=%ae%n%ce', options.baseSha]);
  const lastSource = options.sources.length ? options.sources[options.sources.length - 1] : undefined;
  if (!base.ok) {
    return { foreign: true, authors: [], ...(lastSource ? { headSha: lastSource.sha } : {}), unreadable: true };
  }
  for (const line of base.stdout.split('\n')) {
    const email = line.trim().toLowerCase();
    if (email) local.add(email);
  }

  const authors = new Set<string>();
  let headSha: string | undefined;
  let unreadable = false;
  for (const source of options.sources) {
    // "Any commit a source introduces": everything in `<base>..<source>`, author AND committer.
    const log = await options.git(['log', `--format=${IDENTITY_FORMAT}`, `${options.baseSha}..${source.sha}`]);
    if (!log.ok) {
      unreadable = true;
      headSha ??= source.sha;
      continue;
    }
    for (const line of log.stdout.split('\n')) {
      if (!line.trim()) continue;
      const [authorName = '', authorEmail = '', committerName = '', committerEmail = ''] = line
        .split('\t')
        .map((cell) => cell.trim());
      const foreign: string[] = [];
      if (authorEmail && !local.has(authorEmail.toLowerCase())) foreign.push(`${authorName} <${authorEmail}>`);
      if (committerEmail && !local.has(committerEmail.toLowerCase())) foreign.push(`${committerName} <${committerEmail}>`);
      if (!foreign.length) continue;
      for (const identity of foreign) authors.add(identity);
      headSha ??= source.sha;
    }
  }

  return {
    foreign: authors.size > 0 || unreadable,
    authors: [...authors].sort(),
    ...(headSha ? { headSha } : {}),
    ...(unreadable ? { unreadable: true } : {}),
  };
}

/** The canonical digest's version. Bump it when the shape below changes: an old preview's digest
 *  must never match a digest computed under a new shape, or a stale ack would unlock a run.
 *  2 — `headSha` joined the canonical form (PR 4.2). */
export const LANDING_SUBJECT_DIGEST_VERSION = 2;

export interface LandingSubjectDigestInput {
  baseRef: string;
  baseSha: string;
  sources: readonly LandingSource[];
  /** The materialized subject's tree — the verdict's identity, and the digest's anchor. */
  treeSha: string;
  /** The commit that tree was checked out from. Stable across materializations because the merge
   *  loop pins its metadata to the frozen base; see `materializeLandingSubject`. */
  headSha: string;
  /** The resolved plan's digest (`check-commands.ts`), so a moved PLAN re-previews too. */
  commandsDigest: string;
  /** `npm ci` / `npm install`, when the frozen base declares a manifest. */
  installArgv?: readonly string[];
}

/**
 * The acknowledgement digest: a sha256 over a VERSIONED, explicitly-ordered canonical JSON of the
 * frozen subject. Two properties are the whole point, and both are properties of this function:
 *
 *  - Stable — the same subject digests identically on a later run. The key order is fixed here
 *    (JSON.stringify preserves insertion order), and every semantic input — the pinned sources,
 *    the materialized tree AND head, the resolved plan, the install argv — is inside. The head is
 *    in the digest only because it is stable: `materializeLandingSubject` pins the merge commits'
 *    identity and date to the frozen base, so a later materialization of the same (base, sources)
 *    produces the same commit — without that pinning, this field would make every preview's digest
 *    unmatchable by the run that acks it.
 *  - Moving with the subject — a new commit on a source, a new base, a different tree or a changed
 *    plan all produce a different digest, so an old acknowledgement previews again instead of
 *    running.
 */
export function landingSubjectDigest(input: LandingSubjectDigestInput): { version: number; canonical: string; digest: string } {
  const canonical = JSON.stringify({
    version: LANDING_SUBJECT_DIGEST_VERSION,
    baseRef: input.baseRef,
    baseSha: input.baseSha,
    sources: input.sources.map((source) => ({ ref: source.ref, sha: source.sha })),
    treeSha: input.treeSha,
    headSha: input.headSha,
    commandsDigest: input.commandsDigest,
    installArgv: [...(input.installArgv ?? [])],
  });
  return {
    version: LANDING_SUBJECT_DIGEST_VERSION,
    canonical,
    digest: createHash('sha256').update(canonical).digest('hex'),
  };
}

// ---- staleness ---------------------------------------------------------------------------------

function refMatches(recorded: string, resolved: string | undefined): boolean {
  // Only a ref that RESOLVES can have moved. A deleted branch is not evidence that the content
  // changed, and the worktree being reclaimed by retention must not read as stale either.
  return resolved === undefined || resolved === recorded;
}

/**
 * Has the subject moved since the check ran? Recomputed at READ time from the recorded
 * `(ref, sha)` pins — the stored verdict text is never rewritten, and the comparison is
 * ref-vs-recorded-sha, because the shas themselves cannot move.
 *
 * `undefined` when there is nothing to be stale about (no check, or a check that never
 * materialized).
 */
export async function landingCheckStale(options: {
  landingCheck: { subject: { baseRef: string; baseSha: string; sources: readonly LandingSource[]; treeSha?: string } } | undefined;
  git: LandingGit;
}): Promise<boolean | undefined> {
  const subject = options.landingCheck?.subject;
  if (!subject?.treeSha) return undefined;
  const base = await options.git(['rev-parse', '--verify', '--quiet', `${subject.baseRef}^{commit}`]);
  if (!refMatches(subject.baseSha, base.ok ? base.stdout.trim() : undefined)) return true;
  for (const source of subject.sources) {
    // A sha recorded as its own ref (the explicit path may name a commit) can never move.
    if (source.ref === source.sha) continue;
    const resolved = await options.git(['rev-parse', '--verify', '--quiet', `${source.ref}^{commit}`]);
    if (!refMatches(source.sha, resolved.ok ? resolved.stdout.trim() : undefined)) return true;
  }
  return false;
}
