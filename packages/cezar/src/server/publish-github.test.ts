import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnCommandRunner, type CommandResult, type CommandRunner } from './create-project.ts';
import { publishToGithub } from './publish-github.ts';

/** "Publish to GitHub" (spec 2026-10-26-first-run-onboarding). Real local git; `gh` and the push are
 *  faked and every call is recorded, so "always private" is asserted on what would actually run. */
describe('publishToGithub', () => {
  let root: string;
  let calls: Array<{ cmd: string; args: string[] }>;

  const runner = (override: (cmd: string, args: string[]) => CommandResult | undefined = () => undefined): CommandRunner =>
    async (cmd, args, opts) => {
      calls.push({ cmd, args });
      const forced = override(cmd, args);
      if (forced) return forced;
      // The accounts `gh` lists: the user and one org.
      if (cmd === 'gh' && args[0] === 'api' && args[1] === 'user') return { ok: true, stdout: 'zielivia\t\n' };
      if (cmd === 'gh' && args[0] === 'api' && args[1] === 'user/orgs') return { ok: true, stdout: 'acme\t\t\n' };
      if (cmd === 'gh' || args[0] === 'push') return { ok: true, stdout: '' };
      return spawnCommandRunner(cmd, args, opts);
    };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-publish-')));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(root, 'README.md'), '# app\n');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
    calls = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('creates a private repo, adds the HTTPS origin with the gh credential helper, and pushes the branch', async () => {
    const result = await publishToGithub({ root, owner: 'zielivia', name: 'app', run: runner() });

    expect(result).toEqual({ ok: true, slug: 'zielivia/app', url: 'https://github.com/zielivia/app' });
    expect(calls.filter((call) => call.args[0] === 'repo')).toEqual([{ cmd: 'gh', args: ['repo', 'create', 'zielivia/app', '--private'] }]);
    expect(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).trim()).toBe('https://github.com/zielivia/app.git');
    expect(execFileSync('git', ['config', '--local', '--get-all', 'credential.https://github.com.helper'], { cwd: root, encoding: 'utf8' })).toContain('!gh auth git-credential');
    expect(calls.at(-1)).toEqual({ cmd: 'git', args: ['push', '-u', 'origin', 'main'] });
  });

  it('refuses a repository that already has a remote', async () => {
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/x.git'], { cwd: root });

    expect(await publishToGithub({ root, owner: 'zielivia', name: 'app', run: runner() })).toMatchObject({ ok: false, status: 409 });
    expect(calls).toEqual([]);
  });

  it('answers 503 with the install hint when gh is missing', async () => {
    const result = await publishToGithub({
      root,
      owner: 'zielivia',
      name: 'app',
      run: runner((cmd) => (cmd === 'gh' ? { ok: false, error: 'spawn gh ENOENT', notFound: true } : undefined)),
    });
    expect(result).toEqual({ ok: false, status: 503, error: 'gh CLI not found — install it and run `gh auth login`' });
  });

  it('says the GitHub repository exists when a later step fails', async () => {
    const result = await publishToGithub({
      root,
      owner: 'zielivia',
      name: 'app',
      run: runner((cmd, args) => (args[0] === 'push' ? { ok: false, error: 'remote rejected' } : undefined)),
    });
    expect(result).toEqual({ ok: false, status: 500, error: 'remote rejected\n(the private repository zielivia/app was created on GitHub)' });
  });

  it('says plainly when the name is taken on GitHub, and adds no remote', async () => {
    const result = await publishToGithub({
      root,
      owner: 'zielivia',
      name: 'app',
      run: runner((cmd, args) => (cmd === 'gh' && args[0] === 'repo' ? { ok: false, error: 'GraphQL: Name already exists on this account (createRepository)' } : undefined)),
    });
    expect(result).toEqual({ ok: false, status: 409, error: 'zielivia/app already exists on GitHub. Pick another name.' });
    expect(execFileSync('git', ['remote'], { cwd: root, encoding: 'utf8' }).trim()).toBe('');
  });

  it('publishes only under an account gh lists, and creates nothing for another owner', async () => {
    expect(await publishToGithub({ root, owner: 'acme', name: 'app', run: runner() })).toMatchObject({ ok: true, slug: 'acme/app' });
    calls = [];
    execFileSync('git', ['remote', 'remove', 'origin'], { cwd: root });

    const result = await publishToGithub({ root, owner: 'someone-else', name: 'app', run: runner() });
    expect(result).toEqual({ ok: false, status: 403, error: 'someone-else is not one of your GitHub accounts' });
    expect(calls.some((call) => call.args[0] === 'repo')).toBe(false);
  });

  it('validates the owner before running anything', async () => {
    expect(await publishToGithub({ root, owner: '-bad', name: 'app', run: runner() })).toMatchObject({ ok: false, status: 400 });
    expect(calls).toEqual([]);
  });
});
