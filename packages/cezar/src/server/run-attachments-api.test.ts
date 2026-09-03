import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { createApp } from './server.ts';

/**
 * `GET /runs/:id/images/:file` — the one route that hands a run's attachment bytes back to the
 * browser. Since text attachments landed there it serves USER-supplied content from the
 * cockpit's own origin, which makes its response headers a security surface rather than a
 * convenience: the content type must come from the extension cezar itself wrote, never from
 * anything the file claims, and the answer must be un-sniffable and un-executable.
 */
describe('run attachment serving', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let record: RunRecord;

  const put = (name: string, body: string) => {
    const dir = join(repoRoot, '.ai/cezar', 'runs', `${record.id}-images`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), body);
  };
  const get = (name: string) =>
    apiRequest(app, `/api/v1/runs/${record.id}/images/${name}`, { method: 'GET' });

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-attachments-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    record = store.createRun({ title: 't', workflow: 'quick-task', task: 'the task', steps: [] });
    app = createApp({
      repoRoot,
      store,
      manager: {} as unknown as RunManager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
    });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('serves an image attachment as its own image type', async () => {
    put('pasted-1.png', 'not-really-a-png');
    const res = await get('pasted-1.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  /** Every text attachment is `text/plain`, whatever its extension suggests — answering with
   *  the type the file claims (`text/html`, `image/svg+xml`) is what would hand this origin a
   *  script. */
  it('serves a text attachment as plain text, and says so with a charset', async () => {
    put('pasted-2.md', '# brief\n');
    const res = await get('pasted-2.md');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toBe('# brief\n');
  });

  /** The headers that make the content-type map fail safe rather than fail open: a sniffing
   *  client must not upgrade the answer, and nothing in it may execute if one does. */
  it('answers un-sniffable and sandboxed, for every attachment kind', async () => {
    put('pasted-3.md', 'text');
    put('pasted-4.png', 'bytes');
    for (const name of ['pasted-3.md', 'pasted-4.png']) {
      const res = await get(name);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toContain('sandbox');
    }
  });

  /** An extension the map cannot name is not rendered at all — it downloads. */
  it('forces an unknown extension to download instead of rendering it', async () => {
    put('pasted-5.weird', 'mystery');
    const res = await get('pasted-5.weird');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="pasted-5.weird"');
  });

  it('404s for a file that is not in the run’s own folder', async () => {
    const res = await get('nothing-here.md');
    expect(res.status).toBe(404);
  });
});
