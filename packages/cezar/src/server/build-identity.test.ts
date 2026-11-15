import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { BUILD_HEADER, buildIdFromHtml, readWebBuildId } from './build-identity.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

describe('the server build identity', () => {
  let dir: string;
  let store: RunStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-build-id-'));
    mkdirSync(join(dir, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(dir, '.ai/cezar'));
  });
  afterEach(() => {
    store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the stamp the web build puts in index.html', () => {
    expect(buildIdFromHtml('<head><meta name="cezar-build" content="0.21.0+abc.lz1"></head>')).toBe('0.21.0+abc.lz1');
    expect(buildIdFromHtml('<head><title>cezar</title></head>')).toBeNull();
    writeFileSync(join(dir, 'index.html'), '<meta name="cezar-build" content="b1">');
    expect(readWebBuildId(dir)).toBe('b1');
    expect(readWebBuildId(join(dir, 'missing'))).toBeNull();
  });

  it('sends the boot build on API responses, and nothing without one', async () => {
    const app = createApp({ repoRoot: dir, store, manager: {} as RunManager, version: '0.0.0', webBuildId: 'b1' });
    for (const path of ['/api/v1/workspace/self-update', '/api/v1/no-such-route']) {
      expect((await apiRequest(app, path)).headers.get(BUILD_HEADER)).toBe('b1');
    }
    const bare = createApp({ repoRoot: dir, store, manager: {} as RunManager, version: '0.0.0', webBuildId: null });
    expect((await apiRequest(bare, '/api/v1/workspace/self-update')).headers.get(BUILD_HEADER)).toBeNull();
  });
});
