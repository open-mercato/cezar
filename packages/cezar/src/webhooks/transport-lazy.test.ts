import { afterEach, expect, it, vi } from 'vitest';

// A disabled webhook service must not load its HTTP client as a boot dependency.
vi.mock('undici', () => { throw new Error('webhook HTTP client loaded'); });
afterEach(() => { vi.unstubAllEnvs(); });
it('loads the disabled service without importing the HTTP client', async () => {
  vi.stubEnv('CEZ_WEBHOOKS', '0');
  const { webhooksEnabled } = await import('./service.ts');
  expect(webhooksEnabled()).toBe(false);
});
