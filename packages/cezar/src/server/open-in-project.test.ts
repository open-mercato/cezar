import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp, type ServerDeps } from './server.ts';

/**
 * `POST /api/v1/open-in` — Settings → "Project folder" → Open with.
 *
 * The route takes NO path: the folder is the scoped project's own root, so what has to be pinned
 * is which TARGETS it accepts and that hosted mode refuses before anything launches. `openInApp`
 * and the detection are mocked, so the suite never spawns a GUI app and never depends on which
 * editors happen to be installed on the machine running it.
 */
vi.mock('./open-in-app.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./open-in-app.ts')>();
  return {
    ...actual,
    detectOpenTargets: vi.fn(() => [
      { id: 'finder', label: 'Finder', icon: 'folder' },
      { id: 'terminal', label: 'Terminal', icon: 'terminal' },
      { id: 'cli:claude', label: 'Claude CLI', icon: 'claude' },
    ]),
    openInApp: vi.fn().mockResolvedValue(true),
  };
});

import { openInApp } from './open-in-app.ts';
import { apiRequest } from './loopback-request.testkit.ts';

describe('POST /api/v1/open-in — the project folder in a local app', () => {
  let repoRoot: string;
  let store: RunStore;
  const savedRemote = process.env.CEZ_REMOTE;

  beforeEach(() => {
    vi.clearAllMocks();
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-openproject-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    delete process.env.CEZ_REMOTE;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
  });

  const post = (body: unknown, over: Partial<ServerDeps> = {}) =>
    apiRequest(
      createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over }),
      '/api/v1/open-in',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    );

  it('opens the project root and answers the path it opened', async () => {
    const res = await post({ target: 'finder' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { opened: boolean; path: string };
    expect(body.opened).toBe(true);
    // The server's own resolved root (realpath-normalized), not anything the client sent.
    expect(realpathSync(body.path)).toBe(realpathSync(repoRoot));
    expect(openInApp).toHaveBeenCalledWith('finder', body.path);
  });

  it('409s in hosted mode (CEZ_REMOTE=1) without launching anything', async () => {
    process.env.CEZ_REMOTE = '1';
    const res = await post({ target: 'finder' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('hosted mode');
    expect(openInApp).not.toHaveBeenCalled();
  });

  it('refuses an agent CLI: it would start a session in the checkout, not a worktree', async () => {
    const res = await post({ target: 'cli:claude' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('task worktree');
    expect(openInApp).not.toHaveBeenCalled();
  });

  it('refuses an app this machine does not have', async () => {
    const res = await post({ target: 'vscode' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('no such app');
    expect(openInApp).not.toHaveBeenCalled();
  });

  it('rejects a missing target as a validation error, not a launch attempt', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(openInApp).not.toHaveBeenCalled();
  });

  it('a launcher that could not start is a 409 carrying the path', async () => {
    vi.mocked(openInApp).mockResolvedValueOnce(false);
    const res = await post({ target: 'terminal' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; path: string };
    expect(body.error).toContain('could not open terminal');
    expect(realpathSync(body.path)).toBe(realpathSync(repoRoot));
  });
});
