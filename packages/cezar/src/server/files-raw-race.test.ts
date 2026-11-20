import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';

const boundary = vi.hoisted(() => ({ target: '', replace: undefined as (() => void) | undefined }));

// Replace the real path only after the validated reader closes its real descriptor.
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]) === boundary.target) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          const replace = boundary.replace;
          boundary.replace = undefined;
          replace?.();
        };
      }
      return handle;
    },
  };
});

import { createApp } from './server.ts';

describe('raw Files responses retain validated image bytes (#2006)', () => {
  let dir: string;
  let root: string;
  let store: RunStore;
  const image = Buffer.from([137, 80, 78, 71, 0, 13, 10, 26, 10]);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-raw-race-'));
    root = join(dir, 'repo');
    mkdirSync(root);
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    writeFileSync(join(root, '.gitignore'), '.ai/\n');
    writeFileSync(join(root, 'image.png'), image);
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@local', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'demo image']);
    store = RunStore.open(join(root, '.ai/cezar'));
    boundary.target = join(root, 'image.png');
  });

  afterEach(() => {
    boundary.target = '';
    boundary.replace = undefined;
    store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const surface of ['repo', 'run'] as const) {
    for (const replacement of ['regular', 'symlink'] as const) {
      it.skipIf(replacement === 'symlink' && process.platform === 'win32')(
        `${surface}: does not reopen an image replaced by an outside ${replacement} after validation`,
        async () => {
          const app = createApp({ repoRoot: root, store, manager: {} as unknown as RunManager, version: 'test' });
          const run = store.createRun({ title: 'demo', workflow: 'w', task: 't', worktree: false, steps: [] });
          const outside = join(dir, 'private.png');
          writeFileSync(outside, 'OUTSIDE-DEMO-CONTENT');
          boundary.replace = () => {
            renameSync(boundary.target, `${boundary.target}.old`);
            if (replacement === 'symlink') symlinkSync(outside, boundary.target);
            else writeFileSync(boundary.target, 'REPLACEMENT-DEMO-CONTENT');
          };
          const path = surface === 'repo' ? '/api/v1/repo/files' : `/api/v1/runs/${run.id}/files`;
          const response = await apiRequest(app, `${path}?path=image.png&raw=1`);
          expect(response.status, response.status === 200 ? undefined : await response.text()).toBe(200);
          expect(response.headers.get('content-type')).toBe('image/png');
          expect(response.headers.get('content-security-policy')).toContain('sandbox');
          expect(Buffer.from(await response.arrayBuffer())).toEqual(image);
          expect(boundary.replace).toBeUndefined();
        },
      );
    }
  }
});
