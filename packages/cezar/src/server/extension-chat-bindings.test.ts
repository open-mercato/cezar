import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); vi.unstubAllEnvs(); });

// S1: a %2F-encoded provider segment must never steer the bot-bindings scan outside ~/.cezar/chat/<provider>.
it('rejects a %2F-encoded traversal in the extension-chat bot-bindings route before touching the filesystem', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-chat-bindings-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root, timeout: 5000 });
  const home = join(root, 'home');
  vi.stubEnv('CEZ_HOME', home); vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_SINGLE_PROJECT', '0'); vi.stubEnv('CEZ_REMOTE', '0');
  vi.stubEnv('CEZ_AUTOMATIONS', '0'); vi.stubEnv('CEZ_NO_BANNER', '1'); vi.stubEnv('CEZ_EXTENSIONS', '0');
  const project = await registerProject(root);
  // A binding planted where `chat/../evil/x/bots` resolves to.
  const planted = join(home, 'evil', 'x', 'bots', '123');
  await mkdir(planted, { recursive: true });
  await writeFile(join(planted, 'binding.json'), JSON.stringify({ projectId: 'victim', installationId: 'inst', root: '/elsewhere', generation: randomUUID() }));
  const app = createApp({ repoRoot: root, bootProjectId: project.id, store: RunStore.open(join(root, '.ai/cezar')), manager: { isActive: () => false } as unknown as RunManager,
    version: 'test', onDispose: fn => { cleanups.push(fn); } });
  const traversal = await apiRequest(app, '/api/v1/extension-chat/..%2Fevil/x/bot-bindings');
  const body = await traversal.text();
  expect(body).not.toContain('victim');
  expect(traversal.status).toBe(400);
  // A well-formed extension provider still answers (an empty diagnostic).
  const valid = await apiRequest(app, '/api/v1/extension-chat/acme/chat/bot-bindings');
  expect(valid.status).toBe(200); expect(await valid.json()).toEqual({ bindings: [], truncated: false });
});
