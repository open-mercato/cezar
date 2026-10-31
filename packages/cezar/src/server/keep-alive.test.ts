import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { KEEP_ALIVE_TIMEOUT_MS } from './keep-alive.ts';
import { startServer } from './server.ts';

/** Chrome's idle-socket pool lifetime; Safari's is shorter. The server must outlive both, or a
 *  browser reuses a socket we already closed and a non-retried POST fails (telemetry 7adbfbd7). */
const BROWSER_IDLE_POOL_MS = 300_000;

describe('keep-alive (telemetry 7adbfbd7)', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  let repoRoot: string;
  let home: string;
  let store: RunStore;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-keep-alive-'));
    home = mkdtempSync(join(tmpdir(), 'cez-keep-alive-home-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  it('the server startServer boots keeps idle sockets open longer than a browser pools them', async () => {
    const server = startServer(
      { repoRoot, store, manager: { isActive: () => false } as unknown as RunManager, version: '0.0.0-test' },
      0,
    ) as Server;
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      expect(server.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS);
      expect(server.keepAliveTimeout).toBeGreaterThan(BROWSER_IDLE_POOL_MS);
    } finally {
      server.close();
    }
  });
});
