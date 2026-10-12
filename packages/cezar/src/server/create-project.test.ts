import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../telemetry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../telemetry.ts')>();
  return { ...actual, track: vi.fn() };
});
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { clearProjectProbeCache } from '../workspace/projects.ts';
import { createProject, listGithubOwners, type CommandRunner } from './create-project.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { track } from '../telemetry.ts';
import { WorkspaceEventBus, createApp, type RegisterProjectResponse, type ServerDeps } from './server.ts';

/**
 * New project (spec 2026-09-29-create-new-project): `POST /api/v1/projects/create`
 * and `GET /api/v1/projects/github-owners`. Real temp dirs; only the `git`/`gh`
 * commands are faked, and every argv is recorded so the "always private"
 * contract is asserted on what would actually run.
 */

type Call = { cmd: 'git' | 'gh'; args: string[]; cwd: string };

function recordingRunner(overrides: (call: Call) => Awaited<ReturnType<CommandRunner>> | undefined = () => undefined) {
  const calls: Call[] = [];
  const run: CommandRunner = async (cmd, args, opts) => {
    const call = { cmd, args, cwd: opts.cwd };
    calls.push(call);
    const override = overrides(call);
    if (override) return override;
    if (cmd === 'git' && args[0] === 'init') await mkdir(join(opts.cwd, '.git'), { recursive: true });
    if (cmd === 'gh' && args[1] === 'clone') await mkdir(join(args[3] ?? opts.cwd, '.git'), { recursive: true });
    if (cmd === 'gh' && args[0] === 'api') return { ok: true, stdout: '1\n' };
    return { ok: true, stdout: '' };
  };
  return { run, calls };
}

describe('createProject', () => {
  let root: string;
  beforeEach(() => {
    root = join(mkdtempSync(join(realpathSync(tmpdir()), 'cez-create-')), 'projects');
  });
  afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }));

  it('local only: git init + empty initial commit, no gh at all', async () => {
    const { run, calls } = recordingRunner();
    const result = await createProject({ name: 'fresh', projectsDir: root, onProgress: () => {}, run });
    expect(result).toEqual({ ok: true, target: join(root, 'fresh'), name: 'fresh', kind: 'local' });
    expect(calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ['git', 'init', '-b', 'main'],
      ['git', 'commit', '--allow-empty', '-m', 'Initial commit'],
    ]);
    expect(calls.every((c) => c.cwd === join(root, 'fresh'))).toBe(true);
  });

  it('GitHub: creates a PRIVATE repo, wires an HTTPS origin with the gh credential helper, then pushes (#968)', async () => {
    const { run, calls } = recordingRunner();
    const events: string[] = [];
    const result = await createProject({
      name: 'fresh',
      github: { owner: 'acme' },
      projectsDir: root,
      onProgress: (e) => events.push(e.phase),
      checkoutId: 'c1',
      run,
    });
    expect(result).toMatchObject({ ok: true, slug: 'acme/fresh', kind: 'github' });
    expect(calls.slice(2).map((c) => [c.cmd, ...c.args])).toEqual([
      ['gh', 'repo', 'create', 'acme/fresh', '--private'],
      ['git', 'remote', 'add', 'origin', 'https://github.com/acme/fresh.git'],
      ['git', 'config', '--local', '--replace-all', 'credential.https://github.com.helper', ''],
      ['git', 'config', '--local', '--add', 'credential.https://github.com.helper', '!gh auth git-credential'],
      ['git', 'push', '-u', 'origin', 'main'],
    ]);
    expect(events.at(-1)).toBe('done');
  });

  it('GitHub without a git identity: still creates the repo, but does not push', async () => {
    const { run, calls } = recordingRunner((c) =>
      c.cmd === 'git' && c.args[0] === 'commit' ? { ok: false, error: 'Please tell me who you are.' } : undefined,
    );
    const result = await createProject({ name: 'fresh', github: { owner: 'acme' }, projectsDir: root, onProgress: () => {}, run });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
    expect(calls.find((c) => c.cmd === 'gh')?.args).toContain('--private');
    expect(calls.at(-1)?.args).toContain('!gh auth git-credential');
  });

  it('a failed push after the remote was created cleans up and says the remote exists', async () => {
    const { run } = recordingRunner((c) => (c.args[0] === 'push' ? { ok: false, error: 'Authentication failed' } : undefined));
    const result = await createProject({ name: 'fresh', github: { owner: 'acme' }, projectsDir: root, onProgress: () => {}, run });
    expect(result).toMatchObject({ ok: false, status: 500, stage: 'github_create' });
    expect(!result.ok && result.error).toContain('acme/fresh was created on GitHub');
    expect(readdirSync(root)).toEqual([]);
  });

  it('template: creates a private repo from the template, waits for it, then clones', async () => {
    let probes = 0;
    const { run, calls } = recordingRunner((c) => {
      if (c.cmd === 'gh' && c.args[0] === 'api') return { ok: true, stdout: ++probes < 3 ? '0\n' : '1\n' };
      return undefined;
    });
    const result = await createProject({
      name: 'fresh',
      github: { owner: 'acme', template: 'https://github.com/acme/starter' },
      projectsDir: root,
      onProgress: () => {},
      run,
      sleep: async () => {},
    });
    expect(result).toMatchObject({ ok: true, slug: 'acme/fresh', kind: 'template' });
    expect(calls[0]?.args).toEqual(['repo', 'create', 'acme/fresh', '--private', '--template', 'acme/starter']);
    expect(probes).toBe(3);
    const clone = calls.findIndex((c) => c.args[1] === 'clone');
    expect(calls[clone]?.args.slice(0, 4)).toEqual(['repo', 'clone', 'https://github.com/acme/fresh.git', join(root, 'fresh')]);
    // Only the #968 credential helper runs through git, after the clone — no init, no commit.
    expect(calls.slice(clone + 1).map((c) => [c.cmd, c.args[0]])).toEqual([
      ['git', 'config'],
      ['git', 'config'],
    ]);
    expect(calls.slice(0, clone).some((c) => c.cmd === 'git')).toBe(false);
  });

  it('refuses bad names, owners and templates without touching the disk or running anything', async () => {
    const { run, calls } = recordingRunner();
    for (const opts of [
      { name: '../escape' },
      { name: '.hidden' },
      { name: 'my project' },
      { name: 'zażółć' },
      { name: 'a'.repeat(101) },
      { name: 'ok', github: { owner: '--flag' } },
      { name: 'ok', github: { owner: 'a/b' } },
      { name: 'ok', github: { owner: 'acme', template: 'https://gitlab.com/a/b' } },
    ]) {
      const result = await createProject({ ...opts, projectsDir: root, onProgress: () => {}, run });
      expect(result).toMatchObject({ ok: false, status: 400, stage: 'invalid_input' });
    }
    expect(calls).toEqual([]);
    expect(existsSync(root)).toBe(false);
  });

  it('409s on an existing folder and leaves it alone', async () => {
    mkdirSync(join(root, 'taken'), { recursive: true });
    const { run, calls } = recordingRunner();
    const result = await createProject({ name: 'taken', projectsDir: root, onProgress: () => {}, run });
    expect(result).toMatchObject({ ok: false, status: 409, stage: 'folder_exists' });
    expect(calls).toEqual([]);
    expect(existsSync(join(root, 'taken'))).toBe(true);
  });

  it('a failed gh repo create cleans up the local folder and surfaces the error', async () => {
    const { run } = recordingRunner((c) =>
      c.cmd === 'gh' ? { ok: false, error: 'GraphQL: Name already exists on this account' } : undefined,
    );
    const result = await createProject({ name: 'fresh', github: { owner: 'acme' }, projectsDir: root, onProgress: () => {}, run });
    expect(result).toMatchObject({
      ok: false,
      status: 500,
      stage: 'github_create',
      error: 'GraphQL: Name already exists on this account',
    });
    expect(readdirSync(root)).toEqual([]);
  });

  it('a failed clone AFTER the remote was created says the remote exists', async () => {
    const { run } = recordingRunner((c) => (c.args[1] === 'clone' ? { ok: false, error: 'network down' } : undefined));
    const result = await createProject({
      name: 'fresh',
      github: { owner: 'acme', template: 'acme/starter' },
      projectsDir: root,
      onProgress: () => {},
      run,
      sleep: async () => {},
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('acme/fresh was created on GitHub');
    expect(result).toMatchObject({ stage: 'template_clone' });
    expect(readdirSync(root)).toEqual([]);
  });

  it('degrades with 503 { reason } when gh is not installed', async () => {
    const { run } = recordingRunner((c) => (c.cmd === 'gh' ? { ok: false, error: 'spawn gh ENOENT', notFound: true } : undefined));
    const result = await createProject({ name: 'fresh', github: { owner: 'acme' }, projectsDir: root, onProgress: () => {}, run });
    expect(result).toMatchObject({ ok: false, status: 503, stage: 'gh_missing' });
    expect(!result.ok && 'reason' in result && result.reason).toContain('gh CLI not found');
  });
});

describe('listGithubOwners', () => {
  it('lists the user first, then orgs sorted and deduped, with avatars and descriptions', async () => {
    const run: CommandRunner = async (_cmd, args) =>
      args[1] === 'user'
        ? { ok: true, stdout: 'octo\thttps://avatars.githubusercontent.com/u/1\n' }
        : {
            ok: true,
            stdout:
              'zeta\thttps://avatars.githubusercontent.com/u/3\t\n' +
              'acme\thttps://avatars.githubusercontent.com/u/2\tBuilds\\nrockets\n' +
              'acme\thttps://avatars.githubusercontent.com/u/2\tBuilds\\nrockets\n' +
              'octo\thttps://avatars.githubusercontent.com/u/1\t\n',
          };
    expect(await listGithubOwners(run)).toEqual({
      available: true,
      owners: [
        { login: 'octo', personal: true, avatarUrl: 'https://avatars.githubusercontent.com/u/1' },
        { login: 'acme', personal: false, avatarUrl: 'https://avatars.githubusercontent.com/u/2', description: 'Builds rockets' },
        { login: 'zeta', personal: false, avatarUrl: 'https://avatars.githubusercontent.com/u/3' },
      ],
    });
  });

  it('drops a non-https avatar and keeps the personal account when the org listing fails', async () => {
    const run: CommandRunner = async (_cmd, args) =>
      args[1] === 'user' ? { ok: true, stdout: 'octo\tjavascript:alert(1)\n' } : { ok: false, error: 'missing read:org' };
    expect(await listGithubOwners(run)).toEqual({ available: true, owners: [{ login: 'octo', personal: true }] });
  });

  it('degrades when gh is missing or unauthenticated', async () => {
    expect(await listGithubOwners(async () => ({ ok: false, error: 'ENOENT', notFound: true }))).toMatchObject({
      available: false,
      reason: expect.stringContaining('gh CLI not found'),
    });
    expect(await listGithubOwners(async () => ({ ok: false, error: 'HTTP 401' }))).toMatchObject({
      available: false,
      reason: expect.stringContaining('gh auth login'),
    });
  });
});

describe('POST /api/v1/projects/create', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const savedProjectsDir = process.env.CEZ_PROJECTS_DIR;
  let home: string;
  let repoRoot: string;
  let checkoutRoot: string;
  let store: RunStore;

  beforeEach(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-create-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-create-boot-'));
    checkoutRoot = join(home, 'projects');
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_PROJECTS_DIR;
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    clearProjectProbeCache();
    await mergeWriteWorkspaceConfig((config) => {
      config.projectsDir = checkoutRoot;
    });
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [
      ['CEZ_HOME', savedHome],
      ['CEZ_DRY_RUN', savedDryRun],
      ['CEZ_PROJECTS_DIR', savedProjectsDir],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over });

  const post = async (body: unknown, over: Partial<ServerDeps> = {}) => {
    const res = await apiRequest(makeApp(over), '/api/v1/projects/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Partial<RegisterProjectResponse> & { error?: string } };
  };

  it('creates a local project with real git under CEZ_DRY_RUN and registers it as local', async () => {
    const bus = new WorkspaceEventBus();
    const seen: string[] = [];
    bus.on((event) => seen.push(event));
    const { status, body } = await post({ name: 'brand-new', checkoutId: 'c9' }, { workspaceEvents: bus });
    expect(status).toBe(200);
    expect(body.project).toMatchObject({ name: 'brand-new', source: 'local', status: 'ok' });
    expect(body.project?.root).toBe(join(checkoutRoot, 'brand-new'));
    expect(existsSync(join(checkoutRoot, 'brand-new', '.git'))).toBe(true);
    expect(seen).toContain('checkout-progress');
    expect(seen.at(-1)).toBe('project-added');
  });

  it('a GitHub-backed project registers as checkout and never passes a visibility other than --private', async () => {
    const { run, calls } = recordingRunner();
    const { status, body } = await post(
      { name: 'gh-new', github: { owner: 'acme' }, visibility: 'public', public: true },
      { projectCommandRunner: run },
    );
    expect(status).toBe(200);
    expect(body.project?.source).toBe('checkout');
    const create = calls.find((c) => c.cmd === 'gh' && c.args[1] === 'create');
    expect(create?.args).toContain('--private');
    expect(create?.args).not.toContain('--public');
    expect(create?.args).not.toContain('--internal');
  });

  it('counts a created project as project_added new_<kind>, and a failure by its stage only', async () => {
    vi.mocked(track).mockClear();
    expect((await post({ name: 'loc' })).status).toBe(200);
    const tpl = recordingRunner((c) => (c.args[0] === 'api' ? { ok: true, stdout: '1\n' } : undefined));
    expect((await post({ name: 'tpl', github: { owner: 'acme', template: 'acme/starter' } }, { projectCommandRunner: tpl.run })).status).toBe(200);
    expect(vi.mocked(track).mock.calls.map(([event, extra]) => [event, extra?.label])).toEqual([
      ['project_added', 'new_local'],
      ['project_added', 'new_template'],
    ]);

    vi.mocked(track).mockClear();
    expect((await post({ name: 'loc' })).status).toBe(409);
    const ghDown = recordingRunner((c) => (c.cmd === 'gh' ? { ok: false, error: 'HTTP 502 for acme/secret-name' } : undefined));
    expect((await post({ name: 'gh-fail', github: { owner: 'acme' } }, { projectCommandRunner: ghDown.run })).status).toBe(500);
    expect(vi.mocked(track).mock.calls).toEqual([
      ['project_create_failed', { label: 'folder_exists' }, { sid: undefined }],
      ['project_create_failed', { label: 'github_create' }, { sid: undefined }],
    ]);
  });

  it('a dry-run GitHub project is a real repo with an HTTPS origin and the gh credential helper (#968)', async () => {
    for (const [name, github] of [
      ['gh-empty', { owner: 'acme' }],
      ['gh-tpl', { owner: 'acme', template: 'acme/starter' }],
    ] as const) {
      const { status } = await post({ name, github });
      expect(status).toBe(200);
      const dir = join(checkoutRoot, name);
      const config = (args: string[]) => execFileSync('git', ['-C', dir, 'config', '--local', ...args], { encoding: 'utf8' }).trim();
      // `--local` reads THIS repo's config: the fake clone is a real `git init`, not a bare `.git` folder.
      expect(execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()).toBe(dir);
      if (name === 'gh-empty') expect(config(['--get', 'remote.origin.url'])).toBe('https://github.com/acme/gh-empty.git');
      const helpers = execFileSync('git', ['-C', dir, 'config', '--local', '--get-all', 'credential.https://github.com.helper'], { encoding: 'utf8' });
      expect(helpers.split('\n').slice(0, -1)).toEqual(['', '!gh auth git-credential']);
    }
  });

  it('400s a malformed body and an invalid name', async () => {
    expect((await post(null)).status).toBe(400);
    expect((await post({ name: '' })).status).toBe(400);
    expect((await post({ name: '../x' })).status).toBe(400);
    expect((await post({ name: 'has space' })).status).toBe(400);
  });

  it('GET /api/v1/projects/github-owners answers the dry-run owners', async () => {
    const res = await apiRequest(makeApp(), '/api/v1/projects/github-owners');
    expect(await res.json()).toMatchObject({
      available: true,
      owners: [
        { login: 'dry-run-user', personal: true },
        { login: 'dry-run-org', personal: false },
      ],
    });
  });
});
