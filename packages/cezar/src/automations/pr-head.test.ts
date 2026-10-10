import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { CheckEnv } from '../workspace/check-env.ts';
import { launchEventCandidate } from './event-poll-cycle.ts';
import { prunePrHeadRefs, resolvePrHead, runCommand, type CommandRunner } from './pr-head.ts';
import { AutomationStore } from './store.ts';
import { AutomationLaunchOutcome, launchAutomationRun } from './task-template.ts';
import { automationDefinitionSchema, type GithubAutomationDefinition } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const REPO = 'acme/shop';
const PROJECT = 'pr-head-project';

async function gitRepo(prefix: string): Promise<{ root: string; base: string; head: string }> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'a.txt'), 'one\n');
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
  const base = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  // The PR's head: a commit on a branch the user never checked out here.
  await run('git', ['checkout', '-q', '-b', 'contributor'], { cwd: root });
  writeFileSync(join(root, 'a.txt'), 'one\nfrom the pull request\n');
  await run('git', [...GIT_ID, 'commit', '-q', '-am', 'pr change'], { cwd: root });
  const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  await run('git', ['checkout', '-q', 'main'], { cwd: root });
  await run('git', ['branch', '-q', '-D', 'contributor'], { cwd: root });
  return { root, base, head };
}

/**
 * A `gh`/`git` stand-in: `gh api` answers `pull`, `git fetch` "fetches" by pointing the
 * requested ref at `fetchSha` (or fails), and every other git command runs for real.
 */
function fakeGithub(pull: Record<string, unknown> | null, opts: { fetchSha?: string; fetchFails?: string; ghFails?: string } = {}) {
  const calls: string[][] = [];
  const runner: CommandRunner = async (command, args, cwd) => {
    calls.push([command, ...args]);
    if (command === 'gh') {
      if (opts.ghFails) return { ok: false, stdout: '', stderr: opts.ghFails };
      return { ok: true, stdout: JSON.stringify(pull), stderr: '' };
    }
    if (args[0] === 'fetch') {
      if (opts.fetchFails) return { ok: false, stdout: '', stderr: opts.fetchFails };
      const target = args.at(-1)!.split(':')[1]!;
      return runCommand('git', ['update-ref', target, opts.fetchSha!], cwd);
    }
    return runCommand(command, args, cwd);
  };
  return { runner, calls };
}

const pull = (sha: string, over: Record<string, unknown> = {}) => ({
  state: 'open',
  html_url: `https://github.com/${REPO}/pull/42`,
  head: { sha, ref: 'feature/login', repo: { full_name: REPO } },
  base: { ref: 'main' },
  ...over,
});

describe('resolvePrHead (spec 2026-10-06-agentic-e2e-checks Phase 3)', () => {
  let repo: { root: string; base: string; head: string };
  beforeEach(async () => {
    repo = await gitRepo('cez-pr-head-');
  });
  afterEach(() => rmSync(repo.root, { recursive: true, force: true }));

  const resolve = (runner: CommandRunner, allowForkHeads = false) =>
    resolvePrHead({ root: repo.root, repo: REPO, number: 42, allowForkHeads, run: runner, env: {} });

  it('fetches a same-repo head into the namespaced ref and returns the fetched sha', async () => {
    const { runner, calls } = fakeGithub(pull(repo.head), { fetchSha: repo.head });
    const result = await resolve(runner);
    expect(result).toMatchObject({
      kind: 'ok',
      head: { number: 42, repo: REPO, headRepo: REPO, headRef: 'feature/login', headSha: repo.head, baseRef: 'main', ref: 'refs/cezar/pr/42', untrusted: false },
    });
    expect(calls).toContainEqual(['gh', 'api', `repos/${REPO}/pulls/42`]);
    expect(calls).toContainEqual(['git', 'fetch', '--no-tags', 'origin', '+refs/pull/42/head:refs/cezar/pr/42']);
    // A ref, never a branch: nothing new in the user's branch list.
    expect((await run('git', ['branch', '--list'], { cwd: repo.root })).stdout.trim()).toBe('* main');
  });

  it('skips a closed pull request', async () => {
    const { runner, calls } = fakeGithub(pull(repo.head, { state: 'closed' }));
    expect(await resolve(runner)).toEqual({ kind: 'skipped', reason: 'pr-not-open' });
    expect(calls.some((call) => call[1] === 'fetch')).toBe(false);
  });

  it('skips a fork head unless the automation admits forks, and marks an admitted one untrusted', async () => {
    const fork = pull(repo.head, { head: { sha: repo.head, ref: 'patch-1', repo: { full_name: 'stranger/shop' } } });
    expect(await resolve(fakeGithub(fork).runner)).toEqual({ kind: 'skipped', reason: 'fork-head' });
    const admitted = await resolve(fakeGithub(fork, { fetchSha: repo.head }).runner, true);
    expect(admitted).toMatchObject({ kind: 'ok', head: { headRepo: 'stranger/shop', untrusted: true } });
    // A deleted fork has no head repository to trust.
    const deleted = pull(repo.head, { head: { sha: repo.head, ref: 'patch-1', repo: null } });
    expect(await resolve(fakeGithub(deleted).runner)).toEqual({ kind: 'skipped', reason: 'fork-head' });
  });

  it('tests what was fetched when the pull request moved between poll and launch, and says so', async () => {
    const { runner } = fakeGithub(pull('0'.repeat(40)), { fetchSha: repo.head });
    const result = await resolve(runner);
    expect(result).toMatchObject({ kind: 'ok', head: { headSha: repo.head } });
    expect(result.kind === 'ok' && result.note).toContain('moved while launching');
  });

  it('fails as pr-head-unavailable with a redacted reason when gh or the fetch fails', async () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const gh = await resolve(fakeGithub(null, { ghFails: `HTTP 401: Bad credentials (${token})` }).runner);
    expect(gh.kind).toBe('failed');
    expect(gh.kind === 'failed' && gh.reason).toMatch(/^pr-head-unavailable: could not read the pull request/);
    expect(gh.kind === 'failed' && gh.reason).not.toContain(token);
    const fetch = await resolve(fakeGithub(pull(repo.head), { fetchFails: "fatal: couldn't find remote ref refs/pull/42/head" }).runner);
    expect(fetch.kind === 'failed' && fetch.reason).toContain('could not fetch refs/pull/42/head');
  });

  it('makes no gh or fetch call under CEZ_DRY_RUN=1 and uses a fixture pull request', async () => {
    const { runner, calls } = fakeGithub(null, { ghFails: 'must not be called' });
    const result = await resolvePrHead({ root: repo.root, repo: REPO, number: 42, allowForkHeads: false, run: runner, env: { CEZ_DRY_RUN: '1' } });
    expect(result).toMatchObject({ kind: 'ok', head: { headSha: repo.base, ref: 'refs/cezar/pr/42', untrusted: false } });
    expect(calls.some(([command, sub]) => command === 'gh' || sub === 'fetch')).toBe(false);
  });

  it('prunes the refs no run needs and keeps the rest', async () => {
    await run('git', ['update-ref', 'refs/cezar/pr/1', repo.head], { cwd: repo.root });
    await run('git', ['update-ref', 'refs/cezar/pr/2', repo.head], { cwd: repo.root });
    await prunePrHeadRefs(repo.root, new Set([2]));
    const left = (await run('git', ['for-each-ref', '--format=%(refname)', 'refs/cezar/pr/'], { cwd: repo.root })).stdout.trim();
    expect(left).toBe('refs/cezar/pr/2');
  });
});

describe('checkout schema', () => {
  const base = {
    id: 'a', revision: 1, name: 'n', enabled: false, intervalSeconds: 300, filters: {},
    createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z',
  };
  const parse = (definition: Record<string, unknown>) => automationDefinitionSchema.safeParse({ ...base, ...definition });

  it('accepts checkout on a pull_request.*-only GitHub automation', () => {
    expect(parse({ kind: 'github', events: ['pull_request.opened', 'pull_request.review_requested'], task: { prompt: 'p', checkout: 'pr-head', allowForkHeads: true } }).success).toBe(true);
    expect(parse({ kind: 'github', events: ['issue.opened'], task: { prompt: 'p' } }).success).toBe(true);
  });

  it.each([
    ['a schedule', { kind: 'schedule', schedule: { type: 'daily', hour: 9 } }],
    ['a tracker poll', { kind: 'tracker', filters: { status: 'To Do' } }],
    ['mixed issue and PR events', { kind: 'github', events: ['pull_request.opened', 'issue.opened'] }],
  ])('refuses checkout on %s, naming the field', (_label, shape) => {
    const result = parse({ ...shape, task: { prompt: 'p', checkout: 'pr-head' } });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('checkout');
  });

  it('refuses allowForkHeads without checkout: pr-head', () => {
    const result = parse({ kind: 'github', events: ['pull_request.opened'], task: { prompt: 'p', allowForkHeads: true } });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('allowForkHeads');
  });
});

describe('a pr-head automation launch', () => {
  let repo: { root: string; base: string; head: string };
  let store: RunStore;
  let manager: RunManager;
  let checkEnv: CheckEnv;

  beforeEach(async () => {
    repo = await gitRepo('cez-pr-launch-');
    store = RunStore.open(join(repo.root, '.ai/cezar'));
    checkEnv = new CheckEnv();
    manager = new RunManager(store, repo.root, { projectId: PROJECT, checkEnv });
  });
  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(repo.root, { recursive: true, force: true });
  });

  /** A checks-only verification workflow: no agent step, as a PR verifier would be. */
  const definition = (task: Partial<GithubAutomationDefinition['task']> = {}): GithubAutomationDefinition => ({
    id: 'verify-prs', revision: 1, name: 'Verify PRs', enabled: true, kind: 'github', events: ['pull_request.opened'],
    intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 },
    task: {
      prompt: 'Verify #{{github.number}}',
      steps: [{
        id: 'verify',
        name: 'Verify',
        command: 'git rev-parse HEAD > ../verified-head.txt; echo "sha=$CEZ_PR_HEAD_SHA ref=$CEZ_PR_HEAD_REF base=$CEZ_PR_BASE_REF n=$CEZ_GITHUB_NUMBER key=$E2E_KEY" > ../verified-env.txt',
      }],
      checkout: 'pr-head',
      ...task,
    },
    createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z',
  });
  const candidate = {
    eventId: 'e42', event: 'pull_request.opened' as const, timestamp: '2026-10-06T01:00:00.000Z', tieBreaker: 'P',
    repo: REPO, nodeId: 'PR_42', number: 42, title: 'Login fix', url: `https://github.com/${REPO}/pull/42`,
    author: 'alice', assignees: [], labels: [],
  };
  const settle = async (id: string): Promise<void> => {
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 25_000;
    while (!terminal.has(store.getRun(id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  it('forks the worktree from the PR head, records it, references the PR and refuses to publish', async () => {
    await checkEnv.set(PROJECT, repo.root, 'E2E_KEY', 'trusted-key');
    const { runner } = fakeGithub(pull(repo.head), { fetchSha: repo.head });
    const { runId } = await launchAutomationRun({ root: repo.root, manager, store, definition: definition(), candidate, receiptId: 'r1', runCommand: runner });
    await settle(runId);

    const finished = store.getRun(runId)!;
    // A checks-only workflow settles like any other run.
    expect(finished.status).toBe('done');
    expect(finished.baseBranch).toBe(repo.head);
    expect(readFileSync(join(finished.worktreePath!, '..', 'verified-head.txt'), 'utf8').trim()).toBe(repo.head);
    expect(readFileSync(join(finished.worktreePath!, '..', 'verified-env.txt'), 'utf8').trim())
      .toBe(`sha=${repo.head} ref=feature/login base=main n=42 key=trusted-key`);
    expect(finished.prHead).toMatchObject({ number: 42, headSha: repo.head, ref: 'refs/cezar/pr/42' });
    expect(finished.untrustedHead).toBeUndefined();
    expect(finished.prRefs?.map((ref) => ref.number)).toContain(42);
  }, 40_000);

  it('runs an admitted fork head without the project\'s check credentials', async () => {
    await checkEnv.set(PROJECT, repo.root, 'E2E_KEY', 'trusted-key');
    const fork = pull(repo.head, { head: { sha: repo.head, ref: 'patch-1', repo: { full_name: 'stranger/shop' } } });
    const { runner } = fakeGithub(fork, { fetchSha: repo.head });
    const { runId } = await launchAutomationRun({
      root: repo.root, manager, store, definition: definition({ allowForkHeads: true }), candidate, receiptId: 'r2', runCommand: runner,
    });
    await settle(runId);
    const finished = store.getRun(runId)!;
    expect(finished.untrustedHead).toBe(true);
    expect(readFileSync(join(finished.worktreePath!, '..', 'verified-env.txt'), 'utf8')).toContain('key=\n');
  }, 40_000);

  it('notes a PR that moved between poll and launch on the run', async () => {
    const { runner } = fakeGithub(pull('0'.repeat(40)), { fetchSha: repo.head });
    const { runId } = await launchAutomationRun({ root: repo.root, manager, store, definition: definition(), candidate, receiptId: 'r3', runCommand: runner });
    await settle(runId);
    const notes = readFileSync(join(repo.root, '.ai/cezar/runs', `${runId}.ndjson`), 'utf8');
    expect(notes).toContain('moved while launching');
  }, 40_000);

  it('starts no run for a closed PR or an unreachable head', async () => {
    const before = store.listRuns().length;
    await expect(launchAutomationRun({
      root: repo.root, manager, store, definition: definition(), candidate, receiptId: 'r4',
      runCommand: fakeGithub(pull(repo.head, { state: 'merged' })).runner,
    })).rejects.toMatchObject({ result: 'skipped', reason: 'pr-not-open' });
    await expect(launchAutomationRun({
      root: repo.root, manager, store, definition: definition(), candidate, receiptId: 'r5',
      runCommand: fakeGithub(pull(repo.head), { fetchFails: 'fatal: unable to access' }).runner,
    })).rejects.toBeInstanceOf(AutomationLaunchOutcome);
    expect(store.listRuns()).toHaveLength(before);
  });

  it('without checkout an existing pull_request.opened automation still forks from the base', async () => {
    const { runner, calls } = fakeGithub(pull(repo.head), { fetchSha: repo.head });
    const plain = definition();
    delete plain.task.checkout;
    const { runId } = await launchAutomationRun({ root: repo.root, manager, store, definition: plain, candidate, receiptId: 'r6', runCommand: runner });
    await settle(runId);
    expect(calls).toEqual([]);
    expect(store.getRun(runId)?.baseBranch).not.toBe(repo.head);
    expect(store.getRun(runId)?.prHead).toBeUndefined();
  }, 40_000);
});

describe('launch outcomes in the execution log', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-pr-outcome-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each([
    ['skipped', 'fork-head', 'skipped'],
    ['failed', 'pr-head-unavailable: could not fetch refs/pull/42/head', 'launch-error'],
  ] as const)('records a %s launch as a receipt and a log row, without failing the poll', async (result, reason, receiptStatus) => {
    const store = AutomationStore.open(join(root, '.ai/cezar'));
    const definition = { id: 'verify-prs', revision: 1 } as GithubAutomationDefinition;
    await launchEventCandidate({
      store, definition,
      receipt: { eventId: `e-${result}` },
      log: { event: 'pull_request.opened', githubNumber: 42 },
      launch: async () => { throw new AutomationLaunchOutcome(result, reason); },
    });
    const receipt = [...store.latestReceipts().values()].find((row) => row.eventId === `e-${result}`);
    expect(receipt?.status).toBe(receiptStatus);
    const log = store.logs().find((row) => row.receiptId === receipt?.receiptId);
    expect(log).toMatchObject({ result, reason });
    // The same event never fires twice.
    await launchEventCandidate({
      store, definition, receipt: { eventId: `e-${result}` }, log: {},
      launch: async () => { throw new Error('must not launch again'); },
    });
  });
});
