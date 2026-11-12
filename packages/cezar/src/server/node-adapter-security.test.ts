import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('Node adapter static path decoding (GHSA-rmxm-3fg6-px4f)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cezar-adapter-static-'));
    await mkdir(join(root, 'static', 'admin'), { recursive: true });
    await writeFile(join(root, 'static', 'admin', 'secret.txt'), 'private fixture');
    await writeFile(join(root, 'static', 'hello world.txt'), 'public space');
    await writeFile(join(root, 'static', '炎.txt'), 'public Unicode');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('does not serve a protected file through a second path decode', async () => {
    const app = new Hono();
    app.use('/static/admin/*', (c) => c.text('Unauthorized', 401));
    app.use('/static/*', serveStatic({ root }));

    // Both ordinary spellings must still pass through the prefix middleware.
    for (const path of ['/static/admin/secret.txt', '/static/%61dmin/secret.txt']) {
      const response = await app.request(path);
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('Unauthorized');
    }

    // Routing and file lookup must not interpret this malformed encoding differently.
    const response = await app.request('/static/%%36%31dmin/secret.txt');
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('private fixture');
  });

  it('continues serving normal encoded spaces and Unicode filenames', async () => {
    const app = new Hono().use('/static/*', serveStatic({ root }));
    for (const [path, body] of [
      ['/static/hello%20world.txt', 'public space'],
      ['/static/%E7%82%8E.txt', 'public Unicode'],
    ] as const) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(body);
    }
  });
});
