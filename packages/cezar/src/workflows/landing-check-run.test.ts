import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendLedger } from '../dispatch/tree-fs.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';

/**
 * The landing check through the RUN machinery (spec `.ai/specs/2026-09-29-landing-check.md`,
 * PR 4): `RunManager.startLandingCheck` freezes the subject and creates the check run, and the
 * check run's own `execute` materializes that subject in a worktree of its own, resolves the gate
 * from the FROZEN BASE, runs the install step first and records a verdict.
 *
 * The engine arithmetic lives in `landing-check.test.ts`; this file is about the wiring — the
 * assertions a reviewer would check by hand: the check is an ordinary run, it queues like one, the
 * subject is persisted before any merge, and a check that could not run is NEVER green.
 */
const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
/** An identity no fixture in this file ever configures — the colleague's fetched branch. */
const GIT_FOREIGN = ['-c', 'user.name=Outsider', '-c', 'user.email=other@example.com'];
const posix = describe.skipIf(process.platform === 'win32');

let repoRoot: string;
let dataDir: string;
let store: RunStore;
let manager: RunManager;
let currentId: string | undefined;
const savedEnv: Record<string, string | undefined> = {};

const TERMINAL = new Set(['done', 'review', 'failed', 'cancelled']);

const waitFor = async (id: string, predicate: (record: RunRecord | undefined) => boolean, ms = 60_000) => {
  const deadline = Date.now() + ms;
  while (!predicate(store.getRun(id))) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
};
const settle = (id: string): Promise<void> => waitFor(id, (record) => TERMINAL.has(record?.status ?? ''));

/** Run `body` with `patch` applied to `process.env`, restoring every key afterwards. */
async function withEnv(patch: Record<string, string | undefined>, body: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(patch)) {
    saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const events = (id: string): Array<Record<string, unknown>> =>
  readFileSync(join(dataDir, 'runs', `${id}.ndjson`), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd });
  return stdout.trim();
}

async function commit(file: string, text: string, message: string, identity: string[] = GIT_ID): Promise<string> {
  const target = join(repoRoot, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  await git(repoRoot, 'add', '-A');
  await git(repoRoot, ...identity, 'commit', '-q', '-m', message);
  return git(repoRoot, 'rev-parse', 'HEAD');
}

function mkRun(options: {
  title: string;
  branch?: string;
  status?: RunRecord['status'];
  parentId?: string;
  baseBranch?: string;
  startedAt?: string;
}): RunRecord {
  const record = store.createRun({ title: options.title, workflow: 'task', task: options.title, steps: [] });
  store.updateRun(record.id, {
    status: options.status ?? 'done',
    ...(options.branch ? { branch: options.branch } : {}),
    ...(options.baseBranch ? { baseBranch: options.baseBranch } : {}),
    ...(options.startedAt ? { startedAt: options.startedAt } : {}),
    ...(options.parentId
      ? { dispatch: { rootRunId: options.parentId, parentRunId: options.parentId } }
      : {}),
  });
  return store.getRun(record.id) as RunRecord;
}

/** base A (gate declared) → parent branch with its own commit B → child branch with commit C. */
async function parentAndChild(
  options: { child?: (parentSha: string) => Promise<string>; childIdentity?: string[] } = {},
): Promise<{
  parent: RunRecord;
  parentSha: string;
  child: RunRecord;
  childSha: string;
}> {
  await commit('.ai/agentic.config.json', `${JSON.stringify({ version: 1, validation: { commands: ['echo gate-ok'] } }, null, 2)}\n`, 'base');
  await git(repoRoot, 'checkout', '-q', '-b', 'cez/parent');
  const parentSha = await commit('b.txt', 'parent\n', 'parent work');
  const startedAt = new Date().toISOString();
  await git(repoRoot, 'checkout', '-q', '-b', 'cez/child', parentSha);
  const childSha = options.child ? await options.child(parentSha) : await commit('c.txt', 'child\n', 'child work', options.childIdentity ?? GIT_ID);
  await git(repoRoot, 'checkout', '-q', 'cez/parent');

  // The invoking run is STILL RUNNING — the normal case, never a 409 (review finding C1).
  const parent = mkRun({ title: 'parent', branch: 'cez/parent', status: 'running' });
  const child = mkRun({ title: 'child', branch: 'cez/child', parentId: parent.id, baseBranch: 'cez/parent', startedAt });
  appendLedger(dataDir, parent.id, { type: 'dispatch', runId: child.id, parentRunId: parent.id });
  return { parent, parentSha, child, childSha };
}

beforeEach(async () => {
  repoRoot = mkdtempSync(join(tmpdir(), 'cez-landing-run-'));
  dataDir = join(repoRoot, '.ai/cezar');
  mkdirSync(dataDir, { recursive: true });
  savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
  delete process.env.CEZ_DRY_RUN;
  await git(repoRoot, 'init', '-q', '-b', 'main');
  // The fixture ignores cezar's own state directory before any run exists, exactly as a real
  // repository does. Without this the tests' later `git checkout`s would DELETE the run state
  // (a `git add -A` in a fixture with no ignore file tracks `.ai/cezar/runs/…`, and switching
  // branches then removes it from the working tree).
  writeFileSync(join(repoRoot, '.gitignore'), '.ai/cezar/\n');
  await git(repoRoot, 'add', '-A');
  await git(repoRoot, ...GIT_ID, 'commit', '-q', '-m', 'chore: ignore cezar state');
  store = RunStore.open(dataDir);
  manager = new RunManager(store, repoRoot);
  currentId = undefined;
});

afterEach(() => {
  if (currentId) manager.cancel(currentId);
  manager.dispose();
  if (savedEnv.CEZ_DRY_RUN === undefined) delete process.env.CEZ_DRY_RUN;
  else process.env.CEZ_DRY_RUN = savedEnv.CEZ_DRY_RUN;
  store.flush();
  rmSync(repoRoot, { recursive: true, force: true });
});

posix('startLandingCheck', () => {
  it('freezes the subject before any merge, runs the gate on the COMBINATION, and passes', async () => {
    const { parent, parentSha, childSha } = await parentAndChild();
    const started = await manager.startLandingCheck(parent.id, {});
    expect('runId' in started).toBe(true);
    if (!('runId' in started)) return;
    currentId = started.runId;

    // Frozen and persisted BEFORE the run's first merge: the record already names the base (the
    // invoking run's own tip — including its own commits) and the source, by sha.
    const frozen = store.getRun(started.runId);
    expect(frozen?.landingCheck?.ofRunId).toBe(parent.id);
    expect(frozen?.landingCheck?.subject.baseSha).toBe(parentSha);
    expect(frozen?.landingCheck?.subject.sources).toEqual([{ ref: 'cez/child', sha: childSha }]);
    expect(frozen?.landingCheck?.subject.order).toBe('ledger');
    expect(frozen?.landingCheck?.verdict).toBeUndefined();
    expect(frozen?.baseBranch).toBe(parentSha); // the check worktree is created AT the base
    expect(frozen?.title).toContain('Landing check');

    await settle(started.runId);
    const final = store.getRun(started.runId);
    expect(final?.status).toBe('done');
    expect(final?.landingCheck?.verdict).toBe('passed');
    expect(final?.landingCheck?.subject.treeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(final?.landingCheck?.results?.map((entry) => entry.outcome)).toEqual(['passed']);
    // A local subject: no preview, no ack — the brake simply does not apply.
    expect(final?.landingCheck?.preview).toBeUndefined();
    expect(final?.landingCheck?.ack).toBeUndefined();
    expect(final?.landingCheck?.install).toBeUndefined(); // no manifest in the frozen base
    expect(final?.landingCheck?.envNames).toBeDefined();
    expect(final?.landingCheck?.user).toBeTruthy();

    // The materialized subject IS the combination: the parent's own commit and the child's.
    const worktree = final?.worktreePath as string;
    expect(readFileSync(join(worktree, 'b.txt'), 'utf8')).toContain('parent');
    expect(readFileSync(join(worktree, 'c.txt'), 'utf8')).toContain('child');
    expect(await git(worktree, 'rev-parse', 'HEAD^{tree}')).toBe(final?.landingCheck?.subject.treeSha);
    // The check is its own run with its own branch — nothing is merged into the parent.
    expect(final?.branch).not.toBe('cez/parent');
    expect(await git(repoRoot, 'rev-parse', 'cez/parent')).toBe(parentSha);
    const output = events(started.runId).find((event) => event.type === 'check-output');
    expect(output?.status).toBe('passed');
    expect(String(output?.text)).toContain('gate-ok');
  }, 60_000);

  it('evaluates the base ALONE when nothing is eligible (sources: []), and still runs the gate', async () => {
    await commit('.ai/agentic.config.json', `${JSON.stringify({ version: 1, validation: { commands: ['echo base-only'] } })}\n`, 'base');
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/parent');
    await commit('b.txt', 'parent\n', 'parent work');
    await git(repoRoot, 'checkout', '-q', 'main');
    const parent = mkRun({ title: 'parent', branch: 'cez/parent', status: 'running' });

    const started = await manager.startLandingCheck(parent.id, {});
    if (!('runId' in started)) throw new Error(started.refused);
    currentId = started.runId;
    expect(store.getRun(started.runId)?.landingCheck?.subject.sources).toEqual([]);
    await settle(started.runId);

    const final = store.getRun(started.runId);
    expect(final?.landingCheck?.verdict).toBe('passed');
    expect(final?.landingCheck?.reason).toBeUndefined();
    expect(final?.landingCheck?.results?.map((entry) => entry.command)).toEqual(['echo base-only']);
  }, 60_000);

  it('refuses a second landing check while one is in flight, and 404s an unknown run', async () => {
    const { parent } = await parentAndChild();
    const first = await manager.startLandingCheck(parent.id, {});
    if (!('runId' in first)) throw new Error(first.refused);
    currentId = first.runId;

    const second = await manager.startLandingCheck(parent.id, {});
    expect('refused' in second).toBe(true);
    if ('refused' in second) {
      expect(second.notFound).toBe(false);
      expect(second.refused).toContain('already in flight');
    }
    const missing = await manager.startLandingCheck('no-such-run', {});
    expect(missing).toEqual({ refused: 'no such run: no-such-run', notFound: true });
    await settle(first.runId);
  }, 60_000);
});

posix('the verdicts that are not green', () => {
  it('a conflict stops the check: the U-files are recorded, no command runs, and the verdict says so', async () => {
    await commit('.ai/agentic.config.json', `${JSON.stringify({ version: 1, validation: { commands: ['echo gate-ok > gate-ran.txt'] } })}\n`, 'base');
    await commit('shared.txt', 'base\n', 'shared base');
    const shared = await git(repoRoot, 'rev-parse', 'HEAD');
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/parent');
    const parentSha = await commit('b.txt', 'parent\n', 'parent work');
    const startedAt = new Date().toISOString();
    // Two children, same file, different edits — the SECOND one cannot merge.
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/one', parentSha);
    await commit('shared.txt', 'one\n', 'one side');
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/two', shared);
    await commit('shared.txt', 'two\n', 'two side');
    await git(repoRoot, 'checkout', '-q', 'cez/parent');

    const parent = mkRun({ title: 'parent', branch: 'cez/parent', status: 'running' });
    const one = mkRun({ title: 'one', branch: 'cez/one', parentId: parent.id, baseBranch: 'cez/parent', startedAt });
    const two = mkRun({ title: 'two', branch: 'cez/two', parentId: parent.id, baseBranch: 'cez/parent', startedAt });
    appendLedger(dataDir, parent.id, { type: 'dispatch', runId: one.id, parentRunId: parent.id });
    appendLedger(dataDir, parent.id, { type: 'dispatch', runId: two.id, parentRunId: parent.id });

    const started = await manager.startLandingCheck(parent.id, {});
    if (!('runId' in started)) throw new Error(started.refused);
    currentId = started.runId;
    await settle(started.runId);

    const final = store.getRun(started.runId);
    expect(final?.status).toBe('failed');
    expect(final?.landingCheck?.verdict).toBe('conflict');
    expect(final?.landingCheck?.reason).toBe('merge-conflict');
    expect(final?.landingCheck?.results).toBeUndefined();
    // NO command ran: no step was added, no check step exists, and the marker was never written.
    expect(final?.steps).toEqual([]);
    expect(existsSync(join(final?.worktreePath as string, 'gate-ran.txt'))).toBe(false);
    // The merge was aborted: the check worktree is clean and no merge is in progress.
    expect(await git(final?.worktreePath as string, 'status', '--porcelain')).toBe('');
    expect(await git(final?.worktreePath as string, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD').catch(() => '')).toBe('');
    const node = events(started.runId).find((event) => event.type === 'note' && String(event.message).includes('conflicting files'));
    expect(String(node?.message)).toContain('shared.txt');
  }, 60_000);

  it('a failed install is never green: the gate commands do not run and the verdict is could-not-run', async () => {
    // A manifest with an unusable lockfile: `npm ci` exits non-zero in well under a second and
    // touches no network — the deterministic install failure this rule is about.
    await commit(
      '.ai/agentic.config.json',
      `${JSON.stringify({ version: 1, validation: { commands: ['echo gate-ok > gate-ran.txt'] } })}\n`,
      'base',
    );
    await commit('package.json', '{"name":"fixture","version":"1.0.0"}\n', 'manifest');
    await commit('package-lock.json', 'this is not a lockfile\n', 'broken lockfile');
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/parent');
    const parentSha = await commit('b.txt', 'parent\n', 'parent work');
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/child', parentSha);
    await commit('c.txt', 'child\n', 'child work');
    await git(repoRoot, 'checkout', '-q', 'cez/parent');

    const parent = mkRun({ title: 'parent', branch: 'cez/parent', status: 'running' });
    const child = mkRun({ title: 'child', branch: 'cez/child', parentId: parent.id, baseBranch: 'cez/parent' });
    appendLedger(dataDir, parent.id, { type: 'dispatch', runId: child.id, parentRunId: parent.id });

    const started = await manager.startLandingCheck(parent.id, {});
    if (!('runId' in started)) throw new Error(started.refused);
    currentId = started.runId;
    await settle(started.runId);

    const final = store.getRun(started.runId);
    expect(final?.status).toBe('failed');
    expect(final?.landingCheck?.verdict).toBe('could-not-run');
    expect(final?.landingCheck?.reason).toBe('install-failed');
    expect(final?.landingCheck?.install).toEqual({ argv: ['npm', 'ci'], exitCode: 1, outcome: 'failed' });
    // D3: the gate was resolved and did not run — one `not-run` entry per resolved command,
    // instead of an absent `results` that said nothing about the commands left behind.
    const notRun = final?.landingCheck?.results ?? [];
    expect(notRun.map(({ command, outcome, exitCode }) => ({ command, outcome, exitCode }))).toEqual([
      { command: 'echo gate-ok > gate-ran.txt', outcome: 'not-run', exitCode: null },
    ]);
    expect(notRun[0]?.startedAt).toBe(notRun[0]?.finishedAt);
    expect(existsSync(join(final?.worktreePath as string, 'gate-ran.txt'))).toBe(false);
    // The install step is recorded as its own step, failed — visible on the run's rail.
    expect(final?.steps.map(({ id, status }) => ({ id, status }))).toEqual([{ id: 'install', status: 'failed' }]);
  }, 60_000);
});

posix('the foreign-subject trust model', () => {
  it('previews a foreign subject, runs NOTHING, and only a matching acknowledgement unlocks the gate', async () => {
    await commit('.ai/agentic.config.json', `${JSON.stringify({ version: 1, validation: { commands: ['echo gate-ok > gate-ran.txt'] } })}\n`, 'base');
    await commit(
      'package.json',
      `${JSON.stringify({ name: 'fixture', version: '1.0.0', private: true, scripts: { postinstall: 'echo x >> install-count.txt' } })}\n`,
      'manifest',
    );
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/parent');
    const parentSha = await commit('b.txt', 'parent\n', 'parent work');
    const startedAt = new Date().toISOString();
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/child', parentSha);
    const childSha = await commit('c.txt', 'child\n', 'child work', GIT_FOREIGN);
    await git(repoRoot, 'checkout', '-q', 'cez/parent');

    const parent = mkRun({ title: 'parent', branch: 'cez/parent', status: 'running' });
    const child = mkRun({ title: 'child', branch: 'cez/child', parentId: parent.id, baseBranch: 'cez/parent', startedAt });
    appendLedger(dataDir, parent.id, { type: 'dispatch', runId: child.id, parentRunId: parent.id });

    const preview = await manager.startLandingCheck(parent.id, {});
    if (!('runId' in preview)) throw new Error(preview.refused);
    currentId = preview.runId;
    await settle(preview.runId);
    const previewed = store.getRun(preview.runId);
    const digest = previewed?.landingCheck?.preview?.subjectDigest as string;
    expect(previewed?.status).toBe('failed');
    expect(previewed?.landingCheck?.verdict).toBe('could-not-run');
    expect(previewed?.landingCheck?.reason).toBe('foreign-subject-needs-ack');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(previewed?.landingCheck?.preview).toMatchObject({
      authors: ['Outsider <other@example.com>'],
      commands: ['echo gate-ok > gate-ran.txt'],
      installArgv: ['npm', 'install'],
      headSha: childSha,
    });
    expect(previewed?.landingCheck?.preview?.diffStat).toContain('c.txt');
    // The subject was still MATERIALIZED (the preview describes exact content) — and nothing else:
    // no results, no step, no install side effect, no gate side effect.
    expect(previewed?.landingCheck?.subject.treeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(previewed?.landingCheck?.results).toBeUndefined();
    expect(previewed?.landingCheck?.install).toEqual({ argv: ['npm', 'install'], exitCode: null, outcome: 'not-run' });
    expect(previewed?.steps).toEqual([]);
    const previewWorktree = previewed?.worktreePath as string;
    expect(readFileSync(join(previewWorktree, 'c.txt'), 'utf8')).toContain('child');
    expect(existsSync(join(previewWorktree, 'gate-ran.txt'))).toBe(false);
    expect(existsSync(join(previewWorktree, 'install-count.txt'))).toBe(false);

    // The matching acknowledgement: the subject is re-frozen and re-materialized, the digest
    // recomputes identically, and only then does the gate run — recording the ack it honoured.
    const ack = await manager.startLandingCheck(parent.id, { acknowledge: { digest } });
    if (!('runId' in ack)) throw new Error(ack.refused);
    currentId = ack.runId;
    await settle(ack.runId);
    const acked = store.getRun(ack.runId);
    expect(acked?.status).toBe('done');
    expect(acked?.landingCheck?.verdict).toBe('passed');
    expect(acked?.landingCheck?.ack?.digest).toBe(digest);
    expect(acked?.landingCheck?.ack?.at).toBeTruthy();
    expect(acked?.landingCheck?.preview).toBeUndefined();
    expect(acked?.landingCheck?.install?.outcome).toBe('passed');
    expect(acked?.landingCheck?.install?.argv).toEqual(['npm', 'install']);
    expect(acked?.landingCheck?.results?.map((entry) => entry.command)).toEqual(['echo gate-ok > gate-ran.txt']);
    const ackWorktree = acked?.worktreePath as string;
    expect(existsSync(join(ackWorktree, 'gate-ran.txt'))).toBe(true);
    // D1 rides along: the install ran exactly ONCE, and `results` holds the gate command only.
    expect(readFileSync(join(ackWorktree, 'install-count.txt'), 'utf8').trim().split('\n')).toHaveLength(1);
  }, 120_000);

  it('re-previews (with a NEW digest) when the subject moved between preview and acknowledgement', async () => {
    await commit('.ai/agentic.config.json', `${JSON.stringify({ version: 1, validation: { commands: ['echo gate-ok > gate-ran.txt'] } })}\n`, 'base');
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/parent');
    const parentSha = await commit('b.txt', 'parent\n', 'parent work');
    const startedAt = new Date().toISOString();
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/child', parentSha);
    await commit('c.txt', 'child\n', 'child work', GIT_FOREIGN);
    await git(repoRoot, 'checkout', '-q', 'cez/parent');

    const parent = mkRun({ title: 'parent', branch: 'cez/parent', status: 'running' });
    const child = mkRun({ title: 'child', branch: 'cez/child', parentId: parent.id, baseBranch: 'cez/parent', startedAt });
    appendLedger(dataDir, parent.id, { type: 'dispatch', runId: child.id, parentRunId: parent.id });

    const preview = await manager.startLandingCheck(parent.id, {});
    if (!('runId' in preview)) throw new Error(preview.refused);
    currentId = preview.runId;
    await settle(preview.runId);
    const firstDigest = store.getRun(preview.runId)?.landingCheck?.preview?.subjectDigest as string;
    expect(firstDigest).toMatch(/^[0-9a-f]{64}$/);

    // The child branch moves after the preview: the subject the caller saw is gone.
    await git(repoRoot, 'checkout', '-q', 'cez/child');
    const movedSha = await commit('d.txt', 'more\n', 'more work', GIT_FOREIGN);
    await git(repoRoot, 'checkout', '-q', 'cez/parent');

    const stale = await manager.startLandingCheck(parent.id, { acknowledge: { digest: firstDigest } });
    if (!('runId' in stale)) throw new Error(stale.refused);
    currentId = stale.runId;
    await settle(stale.runId);
    const again = store.getRun(stale.runId);
    expect(again?.status).toBe('failed');
    expect(again?.landingCheck?.verdict).toBe('could-not-run');
    expect(again?.landingCheck?.reason).toBe('foreign-subject-needs-ack');
    expect(again?.landingCheck?.preview?.subjectDigest).not.toBe(firstDigest);
    expect(again?.landingCheck?.preview?.headSha).toBe(movedSha);
    expect(again?.landingCheck?.ack).toBeUndefined();
    expect(again?.landingCheck?.results).toBeUndefined();
    expect(existsSync(join((again?.worktreePath as string) ?? '', 'gate-ran.txt'))).toBe(false);
  }, 120_000);

  it("keeps a fixture with NO configured user.email LOCAL — the base commit's own identities are the operator's", async () => {
    // The fixture never runs `git config user.email`; the machine's global identity is pinned
    // away so "unset" is real, and the commit identity comes from the environment (which is also
    // what lets the check's own merge commits happen). Its own `-c user.email=test@local` commits
    // must still read as local — that is the zero-config half of the rule.
    await withEnv(
      {
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@local',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@local',
      },
      async () => {
        const { parent } = await parentAndChild();
        const started = await manager.startLandingCheck(parent.id, {});
        if (!('runId' in started)) throw new Error(started.refused);
        currentId = started.runId;
        await settle(started.runId);
        const final = store.getRun(started.runId);
        expect(final?.landingCheck?.preview).toBeUndefined();
        expect(final?.landingCheck?.verdict).toBe('passed');
        expect(final?.landingCheck?.results?.map((entry) => entry.outcome)).toEqual(['passed']);
      },
    );
  }, 60_000);
});

posix('an early break records the commands it never ran (D2)', () => {
  it('a FAILED command with commands behind it is `failed`, and the ones behind it are not-run', async () => {
    await commit(
      '.ai/agentic.config.json',
      `${JSON.stringify({ version: 1, validation: { commands: ['exit 1', 'echo second > second-ran.txt'] } })}\n`,
      'base',
    );
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/parent');
    await commit('b.txt', 'parent\n', 'parent work');
    const parent = mkRun({ title: 'parent', branch: 'cez/parent', status: 'running' });

    const started = await manager.startLandingCheck(parent.id, {});
    if (!('runId' in started)) throw new Error(started.refused);
    currentId = started.runId;
    await settle(started.runId);
    const final = store.getRun(started.runId);
    expect(final?.status).toBe('failed');
    // Before D2 this read `could-not-run: cancelled` purely because a command was missing.
    expect(final?.landingCheck?.verdict).toBe('failed');
    expect(final?.landingCheck?.reason).toBe('command-failed');
    expect(final?.landingCheck?.results?.map(({ command, outcome }) => ({ command, outcome }))).toEqual([
      { command: 'exit 1', outcome: 'failed' },
      { command: 'echo second > second-ran.txt', outcome: 'not-run' },
    ]);
    // The not-run entry reuses `startedAt` as the stop time: no dedicated field exists, and the
    // record stays sortable.
    const notRun = final?.landingCheck?.results?.[1];
    expect(notRun?.exitCode).toBeNull();
    expect(notRun?.startedAt).toBe(notRun?.finishedAt);
    expect(existsSync(join(final?.worktreePath as string, 'second-ran.txt'))).toBe(false);
  }, 60_000);

  it('a TIMED-OUT command with commands behind it keeps `could-not-run: timeout`, the second entry not-run', async () => {
    await commit(
      '.ai/agentic.config.json',
      `${JSON.stringify({ version: 1, validation: { commands: ['sleep 5', 'echo second > second-ran.txt'] } })}\n`,
      'base',
    );
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ checkTimeoutMs: 500, checkGateTimeoutMs: 60_000 }));
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/parent');
    await commit('b.txt', 'parent\n', 'parent work');
    const parent = mkRun({ title: 'parent', branch: 'cez/parent', status: 'running' });

    const started = await manager.startLandingCheck(parent.id, {});
    if (!('runId' in started)) throw new Error(started.refused);
    currentId = started.runId;
    await settle(started.runId);
    const final = store.getRun(started.runId);
    expect(final?.status).toBe('failed');
    expect(final?.landingCheck?.verdict).toBe('could-not-run');
    expect(final?.landingCheck?.reason).toBe('timeout');
    expect(final?.landingCheck?.results?.map(({ command, outcome }) => ({ command, outcome }))).toEqual([
      { command: 'sleep 5', outcome: 'could-not-run' },
      { command: 'echo second > second-ran.txt', outcome: 'not-run' },
    ]);
    expect(existsSync(join(final?.worktreePath as string, 'second-ran.txt'))).toBe(false);
  }, 60_000);
});

posix('a restart after materialization (PR 4.2)', () => {
  /**
   * Rewind a check run's record to the shape a crash between materialization and the verdict
   * leaves: the subject is on the record and in the check worktree, the gate steps exist, an
   * interrupted attempt may have recorded some results — and `verdict` is missing. A crash cannot
   * be staged in-process, so a dry-run attempt (which materializes the subject and stops AT the
   * gate) stands in for the interrupted one and a NEW manager recovers the run, which is the path
   * the previous process never got to write.
   */
  const rewind = (runId: string, results?: NonNullable<RunRecord['landingCheck']>['results']): void => {
    const check = store.getRun(runId)?.landingCheck as NonNullable<RunRecord['landingCheck']>;
    const crashed = { ...check };
    delete crashed.verdict;
    delete crashed.reason;
    delete crashed.results;
    store.updateRun(runId, {
      status: 'running',
      finishedAt: undefined,
      currentStepId: undefined,
      landingCheck: results ? { ...crashed, results } : crashed,
    });
  };

  it('re-initialises the recorder: a crash after materialization still ends with a verdict', async () => {
    await commit(
      '.ai/agentic.config.json',
      `${JSON.stringify({ version: 1, validation: { commands: ['echo first > gate-1.txt', 'echo second > gate-2.txt'] } })}\n`,
      'base',
    );
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/parent');
    const parentSha = await commit('b.txt', 'parent\n', 'parent work');
    const startedAt = new Date().toISOString();
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/child', parentSha);
    await commit('c.txt', 'child\n', 'child work');
    await git(repoRoot, 'checkout', '-q', 'cez/parent');

    const parent = mkRun({ title: 'parent', branch: 'cez/parent', status: 'running' });
    const child = mkRun({ title: 'child', branch: 'cez/child', parentId: parent.id, baseBranch: 'cez/parent', startedAt });
    appendLedger(dataDir, parent.id, { type: 'dispatch', runId: child.id, parentRunId: parent.id });

    const started = await manager.startLandingCheck(parent.id, {});
    if (!('runId' in started)) throw new Error(started.refused);
    currentId = started.runId;
    // A crash cannot be staged in-process, so the first attempt IS a dry run: it materializes the
    // subject and stops AT the gate — the record a crash between materialization and the verdict
    // leaves, with no gate artifact and no autosave commit on top of the subject.
    await withEnv({ CEZ_DRY_RUN: '1' }, async () => {
      await settle(started.runId);
    });
    const dry = store.getRun(started.runId);
    expect(dry?.landingCheck?.verdict).toBe('could-not-run');
    expect(dry?.landingCheck?.reason).toBe('dry-run');
    const treeSha = dry?.landingCheck?.subject.treeSha as string;
    const interrupted = dry?.landingCheck?.results?.[0];
    expect(interrupted).toBeDefined(); // the interrupted attempt really recorded one
    manager.dispose();

    // The crash: the subject is materialized, ONE result of the interrupted attempt is recorded,
    // and no verdict was ever written.
    rewind(started.runId, interrupted ? [interrupted] : undefined);

    manager = new RunManager(store, repoRoot);
    await manager.recover();
    await settle(started.runId);

    const revived = store.getRun(started.runId);
    expect(revived?.landingCheck?.subject.treeSha).toBe(treeSha); // the same subject was re-checked
    expect(revived?.landingCheck?.verdict).toBe('passed');
    expect(revived?.status).toBe('done');
    expect(revived?.landingCheck?.results?.map((entry) => [entry.command, entry.outcome])).toEqual([
      ['echo first > gate-1.txt', 'passed'],
      ['echo second > gate-2.txt', 'passed'],
    ]);
    // The interrupted attempt's entry is REPLACED, not merged into this attempt's list: one list
    // describes one pass, and a merged list would mix two attempts' outcomes into one verdict.
    expect(revived?.landingCheck?.results?.[0]?.startedAt).not.toBe(interrupted?.startedAt);
  }, 120_000);

  it('a landing check reaching the end of the loop with nothing recorded still gets a verdict', async () => {
    await commit('.ai/agentic.config.json', `${JSON.stringify({ version: 1, validation: { commands: ['echo gate-ok > gate-ran.txt'] } })}\n`, 'base');
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/parent');
    const parentSha = await commit('b.txt', 'parent\n', 'parent work');
    const startedAt = new Date().toISOString();
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/child', parentSha);
    await commit('c.txt', 'child\n', 'child work');
    await git(repoRoot, 'checkout', '-q', 'cez/parent');

    const parent = mkRun({ title: 'parent', branch: 'cez/parent', status: 'running' });
    const child = mkRun({ title: 'child', branch: 'cez/child', parentId: parent.id, baseBranch: 'cez/parent', startedAt });
    appendLedger(dataDir, parent.id, { type: 'dispatch', runId: child.id, parentRunId: parent.id });

    const started = await manager.startLandingCheck(parent.id, {});
    if (!('runId' in started)) throw new Error(started.refused);
    currentId = started.runId;
    await withEnv({ CEZ_DRY_RUN: '1' }, async () => {
      await settle(started.runId);
    });
    expect(store.getRun(started.runId)?.landingCheck?.subject.treeSha).toMatch(/^[0-9a-f]{40}$/);
    manager.dispose();

    // The crash window: materialized, plan resolved, but the workflow record holds no gate steps
    // yet (the process died while the install step was still running, before the steps were
    // added). Re-running that record executes nothing — and must still record a non-green verdict
    // rather than leaving `verdict` undefined.
    const def = store.getRun(started.runId)?.workflowDef as NonNullable<RunRecord['workflowDef']>;
    rewind(started.runId);
    store.updateRun(started.runId, { workflowDef: { ...def, steps: [] } });

    manager = new RunManager(store, repoRoot);
    await manager.recover();
    await settle(started.runId);

    const revived = store.getRun(started.runId);
    expect(revived?.landingCheck?.verdict).toBe('could-not-run');
    expect(revived?.landingCheck?.reason).toBe('no-results');
    // A non-green verdict is never a green run: the status matches the verdict.
    expect(revived?.status).toBe('failed');
    expect(existsSync(join(revived?.worktreePath as string, 'gate-ran.txt'))).toBe(false);
  }, 120_000);

  it('never runs the gate when the resumed worktree no longer holds the subject', async () => {
    await commit('.ai/agentic.config.json', `${JSON.stringify({ version: 1, validation: { commands: ['echo gate-ok > gate-ran.txt'] } })}\n`, 'base');
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/parent');
    const parentSha = await commit('b.txt', 'parent\n', 'parent work');
    const startedAt = new Date().toISOString();
    await git(repoRoot, 'checkout', '-q', '-b', 'cez/child', parentSha);
    await commit('c.txt', 'child\n', 'child work');
    await git(repoRoot, 'checkout', '-q', 'cez/parent');

    const parent = mkRun({ title: 'parent', branch: 'cez/parent', status: 'running' });
    const child = mkRun({ title: 'child', branch: 'cez/child', parentId: parent.id, baseBranch: 'cez/parent', startedAt });
    appendLedger(dataDir, parent.id, { type: 'dispatch', runId: child.id, parentRunId: parent.id });

    const started = await manager.startLandingCheck(parent.id, {});
    if (!('runId' in started)) throw new Error(started.refused);
    currentId = started.runId;
    await settle(started.runId);
    const record = store.getRun(started.runId);
    expect(record?.landingCheck?.verdict).toBe('passed');
    manager.dispose();

    // The subject is no longer anywhere: the worktree is gone AND the check's own branch was
    // rewound to the frozen base. Re-creating the worktree would hand the gate the BASE ALONE —
    // and a passing gate would then be recorded as a green verdict about a subject never checked.
    rmSync(record?.worktreePath as string, { recursive: true, force: true });
    await git(repoRoot, 'worktree', 'prune');
    await git(repoRoot, 'branch', '-f', record?.branch as string, record?.landingCheck?.subject.baseSha as string);
    rewind(started.runId);

    manager = new RunManager(store, repoRoot);
    await manager.recover();
    await settle(started.runId);

    const revived = store.getRun(started.runId);
    expect(revived?.landingCheck?.verdict).toBe('could-not-run');
    expect(revived?.landingCheck?.reason).toBe('worktree-lost');
    expect(revived?.status).toBe('failed');
    // The base alone was never gated: the marker the command would have written is absent.
    expect(existsSync(join(revived?.worktreePath as string, 'gate-ran.txt'))).toBe(false);
  }, 120_000);

  it('says plainly on the check run that the gate is not a sandbox', async () => {
    const { parent } = await parentAndChild();
    const started = await manager.startLandingCheck(parent.id, {});
    if (!('runId' in started)) throw new Error(started.refused);
    currentId = started.runId;
    await settle(started.runId);
    expect(store.getRun(started.runId)?.landingCheck?.verdict).toBe('passed');

    const said = events(started.runId).filter(
      (event) => event.type === 'note' && String(event.message).includes('not a sandbox'),
    );
    expect(said).toHaveLength(1);
    expect(String(said[0]?.message)).toContain('runs this repository');
  }, 60_000);
});
