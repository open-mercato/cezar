import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workspaceConfigPath } from '../paths.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';
import type { FsBrowseResponse } from './fs-browse.ts';

/**
 * `GET /api/v1/fs/browse` (multi-project spec, step 4.1) — the directory picker
 * behind "Add project → open local folder".
 *
 * The escape cases below are built out of REAL temp directories and REAL
 * symlinks and asserted through the real app: this route is the one place the
 * cockpit hands the operator's filesystem to a browser, and a mocked
 * filesystem would only ever confirm the answer the mock was written to give.
 * Every test therefore proves containment against a directory that genuinely
 * exists outside the browse root.
 */
describe('GET /api/v1/fs/browse (step 4.1)', () => {
  const savedHome = process.env.HOME;
  const savedCezHome = process.env.CEZ_HOME;
  const savedRemote = process.env.CEZ_REMOTE;
  const savedBrowseRoot = process.env.CEZ_BROWSE_ROOT;
  /** Stands in for the operator's `$HOME` — `os.homedir()` honors it on posix. */
  let home: string;
  /** A real directory that is NOT under `home`: the escape target. */
  let outside: string;
  let app: Hono;
  let store: RunStore;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'cez-fs-browse-home-')));
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'cez-fs-browse-outside-')));
    process.env.HOME = home;
    process.env.CEZ_HOME = join(home, '.cezar');
    delete process.env.CEZ_REMOTE; // local mode is the default under test
    delete process.env.CEZ_BROWSE_ROOT;

    mkdirSync(join(home, 'projects/repo/.git'), { recursive: true });
    mkdirSync(join(home, 'projects/plain'), { recursive: true });
    mkdirSync(join(home, '.hidden'), { recursive: true });
    mkdirSync(join(outside, 'secrets'), { recursive: true });
    writeFileSync(join(home, 'notes.txt'), 'not a directory', 'utf8');
    // The two links that make or break the containment rule.
    symlinkSync(outside, join(home, 'link-outside'));
    symlinkSync(join(home, 'projects/repo'), join(home, 'link-inside'));

    const repoRoot = join(home, 'boot');
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
    });
  });

  afterEach(() => {
    store.flush();
    for (const [key, value] of [
      ['HOME', savedHome],
      ['CEZ_HOME', savedCezHome],
      ['CEZ_REMOTE', savedRemote],
      ['CEZ_BROWSE_ROOT', savedBrowseRoot],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [home, outside]) rmSync(dir, { recursive: true, force: true });
  });

  const browse = (query = '') => apiRequest(app, `/api/v1/fs/browse${query}`);
  const body = async (res: Response) => (await res.json()) as FsBrowseResponse;
  const error = async (res: Response) => ((await res.json()) as { error: string }).error;
  const names = (payload: FsBrowseResponse) => payload.dirs.map((d) => d.name);

  // ---- the happy path ------------------------------------------------------

  it('defaults to the home root: directories only, no parent, dotfolders hidden', async () => {
    const res = await browse();
    expect(res.status).toBe(200);
    const payload = await body(res);
    expect(payload.path).toBe(home);
    // There is no "up" out of the root — the picker must not be able to try.
    expect(payload.parent).toBeNull();
    expect(names(payload)).toContain('projects');
    expect(names(payload)).not.toContain('notes.txt'); // files are never listed
    expect(names(payload)).not.toContain('.hidden'); // dotfolders are opt-in
    expect(payload.truncated).toBe(false);
  });

  it('showHidden=1 opts dotfolders back in', async () => {
    expect(names(await body(await browse('?showHidden=1')))).toContain('.hidden');
  });

  it('flags git repos with isRepo and still lists plain folders', async () => {
    const payload = await body(await browse(`?path=${encodeURIComponent(join(home, 'projects'))}`));
    expect(payload.path).toBe(join(home, 'projects'));
    expect(payload.parent).toBe(home);
    expect(payload.dirs).toEqual(
      expect.arrayContaining([
        { name: 'repo', path: join(home, 'projects/repo'), isRepo: true },
        { name: 'plain', path: join(home, 'projects/plain'), isRepo: false },
      ]),
    );
  });

  it('a relative path resolves against the root', async () => {
    expect((await body(await browse('?path=projects'))).path).toBe(join(home, 'projects'));
  });

  // ---- escape vectors ------------------------------------------------------

  it('rejects `..` traversal out of the root (absolute and relative spellings)', async () => {
    for (const path of [join(home, 'projects/../..'), join(home, '..'), '../..', 'projects/../../..']) {
      // Every case here is percent-encoded on the wire: the containment check
      // has to sit AFTER query decoding, which is where the handler reads it.
      const res = await browse(`?path=${encodeURIComponent(path)}`);
      expect(res.status, path).toBe(400);
      expect(await error(res)).toBe('path is outside the browsable root');
    }
    // Double-encoded traversal is not an escape — it decodes ONCE, so the
    // handler sees a literal `..%2F..%2F` child name that simply isn't there.
    // Asserting the 404 pins that it is never decoded a second time.
    const doubled = await browse(`?path=${encodeURIComponent(encodeURIComponent('../../'))}`);
    expect(doubled.status).toBe(404);
  });

  it('rejects an absolute path outside the root — without echoing it back', async () => {
    const res = await browse(`?path=${encodeURIComponent(join(outside, 'secrets'))}`);
    expect(res.status).toBe(400);
    const message = await error(res);
    expect(message).toBe('path is outside the browsable root');
    // An error string carrying the resolved path would be the very leak the
    // containment exists to prevent.
    expect(message).not.toContain(outside);
  });

  it('rejects a SYMLINK that escapes the root, even though it spells as inside', async () => {
    // `~/link-outside` passes any lexical check — only realpath sees `outside`.
    for (const path of [join(home, 'link-outside'), join(home, 'link-outside/secrets')]) {
      const res = await browse(`?path=${encodeURIComponent(path)}`);
      expect(res.status, path).toBe(400);
      const message = await error(res);
      expect(message).toBe('path is outside the browsable root');
      expect(message).not.toContain(outside);
    }
  });

  it('never LISTS an escaping symlink either (no click needed to learn it exists)', async () => {
    const payload = await body(await browse());
    expect(names(payload)).not.toContain('link-outside');
    // …while a symlink that stays inside the root is a normal, usable folder.
    expect(names(payload)).toContain('link-inside');
    expect((await body(await browse(`?path=${encodeURIComponent(join(home, 'link-inside'))}`))).path)
      // Navigating a contained link lands on its realpath.
      .toBe(join(home, 'projects/repo'));
  });

  it('404s for a missing path, a file, and a NUL byte — never a filesystem detail', async () => {
    expect((await browse(`?path=${encodeURIComponent(join(home, 'nope'))}`)).status).toBe(404);
    // A file answers exactly like an absent path: confirming "this is a file"
    // would leak a name the picker never showed.
    const fileRes = await browse(`?path=${encodeURIComponent(join(home, 'notes.txt'))}`);
    expect(fileRes.status).toBe(404);
    expect(await error(fileRes)).toBe('no such directory');
    expect((await browse('?path=%00')).status).toBe(400);
  });

  // ---- configured browse root ---------------------------------------------

  describe('an independent browseRoot', () => {
    beforeEach(() => {
      // Stored with a literal `~`, exactly as PUT /api/v1/workspace/config keeps
      // it — so this also proves the hosted root expands the tilde.
      mkdirSync(join(home, '.cezar'), { recursive: true });
      writeFileSync(
        workspaceConfigPath(),
        JSON.stringify({ browseRoot: '~/projects', projectsDir: '~/checkouts' }),
        'utf8',
      );
      process.env.CEZ_REMOTE = '1';
    });

    it('roots the listing at browseRoot instead of projectsDir or home', async () => {
      const payload = await body(await browse());
      expect(payload.path).toBe(join(home, 'projects'));
      expect(payload.parent).toBeNull(); // browseRoot IS the ceiling now
      expect(names(payload)).toEqual(expect.arrayContaining(['repo', 'plain']));
    });

    it('rejects the home directory in both hosted and local mode', async () => {
      const res = await browse(`?path=${encodeURIComponent(home)}`);
      expect(res.status).toBe(400);
      expect(await error(res)).toBe('path is outside the browsable root');
      delete process.env.CEZ_REMOTE;
      expect((await browse(`?path=${encodeURIComponent(home)}`)).status).toBe(400);
    });

    it('404s when browseRoot does not exist yet', async () => {
      writeFileSync(workspaceConfigPath(), JSON.stringify({ browseRoot: '~/not-created' }), 'utf8');
      const res = await browse();
      expect(res.status).toBe(404);
      expect(await error(res)).toBe('browse root is not available');
    });
  });

  it('takes the zero-config browse root from CEZ_BROWSE_ROOT', async () => {
    process.env.CEZ_BROWSE_ROOT = '~/projects';
    const payload = await body(await browse());
    expect(payload.path).toBe(join(home, 'projects'));
    expect(payload.parent).toBeNull();
  });

  // ---- mounting ------------------------------------------------------------

  it('is workspace-level: never mirrored under /api/v1/p/', async () => {
    expect((await apiRequest(app, '/api/v1/p/default/fs/browse')).status).toBe(404);
  });
});
