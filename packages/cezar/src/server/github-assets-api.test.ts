import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { hc, type InferRequestType, type InferResponseType } from 'hono/client';
import type { z } from 'zod';
import { githubAssetInputSchema, githubAssetResponseSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import type { AppType } from './app-type.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { loadGithubAsset } from './forge/github-assets.ts';
vi.mock('./forge/github-assets.ts', () => ({ loadGithubAsset: vi.fn() }));
const SOURCE = 'https://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc';
let root: string;
let store: RunStore;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-ghasset-'));
  store = RunStore.open(join(root, '.ai/cezar'));
  app = createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test' });
  vi.mocked(loadGithubAsset).mockResolvedValue({ available: true, dataUrl: 'data:image/png;base64,aGVsbG8=' });
});
afterEach(() => { vi.clearAllMocks(); store.flush(); rmSync(root, { recursive: true, force: true }); });
const request = (url: string, headers = {}) => apiRequest(app, '/api/v1/github/asset', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ url }),
});
it('serves the contract under the project family without caching private bytes', async () => {
  const res = await request(SOURCE);
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(githubAssetResponseSchema.parse(await res.json()).available).toBe(true);
  expect(loadGithubAsset).toHaveBeenCalledWith(root, SOURCE);
});
it('validates the request body before credentialed retrieval', async () => {
  expect((await request('https://127.0.0.1/secret')).status).toBe(400);
  expect(loadGithubAsset).not.toHaveBeenCalled();
});
it('rejects cross-origin browser reads through the mutating-request guard', async () => {
  expect((await request(SOURCE, { Origin: 'https://evil.test' })).status).toBe(403);
  expect(loadGithubAsset).not.toHaveBeenCalled();
});
it('never instantiates an unknown project or leaks another project asset', async () => {
  const res = await apiRequest(app, '/api/v1/p/unknown/github/asset', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: SOURCE }),
  });
  expect(res.status).toBe(404);
  expect(loadGithubAsset).not.toHaveBeenCalled();
});
it('is a typed route with exact request and response contracts in both directions', () => {
  const client = hc<AppType>('http://127.0.0.1');
  type Route = typeof client.api.v1.p[':projectId']['github']['asset']['$post'];
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
  const input: Mutual<InferRequestType<Route>['json'], z.infer<typeof githubAssetInputSchema>> = true;
  const output: Mutual<InferResponseType<Route, 200>, z.infer<typeof githubAssetResponseSchema>> = true;
  expect([input, output]).toEqual([true, true]);
});
