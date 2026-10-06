import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shadowDir } from './ledger.ts';
import { discardShadowIntent, promoteShadowIntent, type PromoteContext } from './promote.ts';
import { prepareShadowRun, withEnvOverrides } from './setup.ts';
import { runShim, type ShimIo } from './shim.ts';
import { loadShadowIntents } from './view.ts';

/**
 * Promotion end to end against a real git: a local bare repository stands in for GitHub, so a
 * promoted push really lands somewhere and a refused one really does not. `gh` is the one thing
 * faked - through the `exec`/`findGh` seams - because a real gh would need a real GitHub.
 */
// Real git, real hooks and a node start per hook: well past vitest's 5 s default on a loaded Windows host.
describe('promoting shadow intents (real git)', { timeout: 30_000 }, () => {
  let root: string;
  let origin: string;
  let repo: string;
  let dataDir: string;
  const RUN = 'run-promote';

  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-shadow-promote-'));
    origin = join(root, 'origin.git');
    git(root, 'init', '--bare', '--quiet', origin);
    repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '--quiet', '-b', 'main');
    git(repo, 'config', 'user.name', 'Shadow Test');
    git(repo, 'config', 'user.email', 'shadow@example.com');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '--quiet', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '--quiet', 'origin', 'main'); // a real push BEFORE shadow: origin/main exists
    dataDir = join(repo, '.ai', 'cezar');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Arm the run, commit, and let the "agent" push through the shadow environment. */
  async function shadowPush(ref: string): Promise<string> {
    const shadow = await prepareShadowRun({ dataDir, runId: RUN, repoRoot: repo });
    writeFileSync(join(repo, `${ref.replace(/\W/g, '_')}.txt`), 'work\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', `work for ${ref}`);
    const push = spawnSync('git', ['push', 'origin', `HEAD:${ref}`], { cwd: repo, env: withEnvOverrides(process.env, shadow.env), encoding: 'utf8' });
    expect(push.status).not.toBe(0);
    return git(repo, 'rev-parse', 'HEAD').trim();
  }

  /** The shim with in-memory IO, so a `gh` write is recorded exactly as an agent's would be. */
  function recordGh(args: string[], files: Record<string, string> = {}): string {
    const out: string[] = [];
    const io: ShimIo = {
      argv: ['gh', shadowDir(dataDir, RUN), ...args],
      cwd: repo,
      stdout: (text) => out.push(text),
      stderr: (text) => out.push(text),
      readStdin: () => Buffer.alloc(0),
      readFile: (path) => {
        const content = files[path];
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return Buffer.from(content);
      },
      runReal: () => {
        throw new Error('a write must never reach the real gh');
      },
      git: () => ({ ok: true }),
      secrets: () => [],
      now: () => new Date(),
    };
    expect(runShim(io)).toBe(0);
    return out.join('');
  }

  const context = (extra: Partial<PromoteContext> = {}): PromoteContext => ({ dataDir, runId: RUN, repoRoot: repo, ...extra });
  const intents = async () => (await loadShadowIntents(context())).entries.map((entry) => entry.view);

  it('promotes a new branch with a plain push, records the decision, and never runs it twice', async () => {
    const head = await shadowPush('refs/heads/feature');
    const [push] = await intents();
    expect(push).toMatchObject({ kind: 'push', promotable: 'click', state: 'pending', push: { relation: 'new', pinned: true } });

    const outcome = await promoteShadowIntent(context(), push?.id as string);

    expect(outcome).toMatchObject({ ok: true, intent: { state: 'promoted' } });
    expect(git(origin, 'rev-parse', 'refs/heads/feature').trim()).toBe(head);
    expect(await promoteShadowIntent(context(), push?.id as string)).toMatchObject({ ok: false, status: 409 });
  });

  it('never promotes a push to the default branch, and hands back the command instead', async () => {
    await shadowPush('refs/heads/main');
    const [push] = await intents();
    expect(push).toMatchObject({ promotable: 'manual', push: { relation: 'fast-forward' } });

    const outcome = await promoteShadowIntent(context(), push?.id as string);

    expect(outcome).toMatchObject({ ok: false, status: 409 });
    expect(outcome.ok ? '' : outcome.manual).toMatch(/^git push origin [0-9a-f]{40}:refs\/heads\/main$/);
    expect(git(origin, 'rev-parse', 'refs/heads/main').trim()).not.toBe(git(repo, 'rev-parse', 'HEAD').trim());
  });

  it('opens a recorded PR only after its branch push, with the captured body and no shell', async () => {
    await shadowPush('refs/heads/feature');
    recordGh(['pr', 'create', '--title', 'Fix login', '--body-file', 'body.md'], { 'body.md': 'Fixes the login race.' });
    const views = await intents();
    const push = views.find((intent) => intent.kind === 'push');
    const pr = views.find((intent) => intent.kind === 'forge');
    expect(pr).toMatchObject({ promotable: 'click', forge: { files: [{ name: 'body.md', preview: 'Fixes the login race.' }] } });

    const calls: Array<{ bin: string; args: string[]; body: string }> = [];
    const gh = context({
      findGh: () => '/opt/gh/bin/gh',
      exec: async (bin, args) => {
        if (bin === 'git') return { ok: true, stdout: '', stderr: '' };
        const bodyPath = args[args.indexOf('--body-file') + 1] as string;
        calls.push({ bin, args, body: readFileSync(bodyPath, 'utf8') });
        return { ok: true, stdout: 'https://github.com/acme/widget/pull/7\n', stderr: '' };
      },
    });

    const tooEarly = await promoteShadowIntent(gh, pr?.id as string);
    expect(tooEarly).toMatchObject({ ok: false, status: 409 });
    expect(tooEarly.ok ? '' : tooEarly.error).toMatch(/first/);

    expect(await promoteShadowIntent(gh, push?.id as string)).toMatchObject({ ok: true });
    const opened = await promoteShadowIntent(gh, pr?.id as string);

    expect(opened).toMatchObject({ ok: true, intent: { state: 'promoted', detail: 'https://github.com/acme/widget/pull/7' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ bin: '/opt/gh/bin/gh', body: 'Fixes the login race.' });
    expect(calls[0]?.args.slice(0, 4)).toEqual(['pr', 'create', '--title', 'Fix login']);
  });

  it('refuses a manual-class gh write and returns the exact command', async () => {
    await prepareShadowRun({ dataDir, runId: RUN, repoRoot: repo });
    recordGh(['pr', 'merge', '12', '--squash']);
    const [merge] = await intents();
    const outcome = await promoteShadowIntent(context({ findGh: () => '/opt/gh/bin/gh' }), merge?.id as string);
    expect(outcome).toMatchObject({ ok: false, status: 409, manual: 'gh pr merge 12 --squash' });
  });

  it('discards once, and a discarded intent can no longer be promoted', async () => {
    await prepareShadowRun({ dataDir, runId: RUN, repoRoot: repo });
    recordGh(['issue', 'comment', '3', '--body', 'ack']);
    const [comment] = await intents();
    expect(await discardShadowIntent(context(), comment?.id as string)).toMatchObject({ ok: true, intent: { state: 'discarded' } });
    expect(await discardShadowIntent(context(), comment?.id as string)).toMatchObject({ ok: false, status: 409 });
    expect(await promoteShadowIntent(context({ findGh: () => '/opt/gh/bin/gh' }), comment?.id as string)).toMatchObject({ ok: false, status: 409 });
  });

  it('never lets a click publish what the reviewer could not see: a secret, or a body past the preview', async () => {
    await prepareShadowRun({ dataDir, runId: RUN, repoRoot: repo });
    const token = `ghp_${'a1B2'.repeat(9)}`; // GitHub-token shaped: redacted by pattern
    recordGh(['issue', 'comment', '3', '--body', `debug: ${token}`]);
    recordGh(['issue', 'comment', '4', '--body-file', 'long.md'], { 'long.md': 'x'.repeat(16_001) });
    const [secret, long] = await intents();

    expect(secret).toMatchObject({ promotable: 'manual' });
    expect(secret?.command).not.toContain(token);
    expect(readFileSync(join(shadowDir(dataDir, RUN), 'intents.ndjson'), 'utf8')).not.toContain(token); // not on disk either
    expect(long).toMatchObject({ promotable: 'manual' });
    expect(long?.reason).toMatch(/longer than the review preview/);
  });

  it('refuses a body file the argv does not actually name (a tampered ledger index)', async () => {
    await prepareShadowRun({ dataDir, runId: RUN, repoRoot: repo });
    recordGh(['issue', 'comment', '3', '--body-file', 'note.md', '--body', 'x'], { 'note.md': 'hello' });
    const path = join(shadowDir(dataDir, RUN), 'intents.ndjson');
    const line = JSON.parse(readFileSync(path, 'utf8').trim()) as { files: Array<{ index: number }> };
    (line.files[0] as { index: number }).index = 6; // point the "body file" at `x`, the inline body
    writeFileSync(path, `${JSON.stringify(line)}\n`);
    const [comment] = await intents();
    const outcome = await promoteShadowIntent(context({ findGh: () => '/opt/gh/bin/gh', exec: async () => ({ ok: true, stdout: '', stderr: '' }) }), comment?.id as string);
    expect(outcome).toMatchObject({ ok: false, status: 409 });
    expect(outcome.ok ? '' : outcome.error).toMatch(/disagree/);
  });

  it('answers 404 for an id the ledger does not hold', async () => {
    await prepareShadowRun({ dataDir, runId: RUN, repoRoot: repo });
    expect(await promoteShadowIntent(context(), 'mg000000-abcdef')).toMatchObject({ ok: false, status: 404 });
  });
});
