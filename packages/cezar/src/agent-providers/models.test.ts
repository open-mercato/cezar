import { afterEach, expect, it, vi } from 'vitest';
import { fetchProviderModels } from './models.ts';

afterEach(() => vi.unstubAllEnvs());

it('reads both catalog shapes and requests the base path on the server', async () => {
  vi.stubEnv('CEZ_DRY_RUN', '0');
  const request = vi.fn(async () => Response.json({ data: [{ id: 'a', name: 'First', context_length: 4000 },
    { id: 'b', display_name: 'Second' }, { id: 'b' }, { id: 'fixture-key' }] }));
  expect(await fetchProviderModels('https://example.test/api/', 'fixture-key', request)).toEqual([
    { id: 'a', label: 'First', contextLength: 4000 }, { id: 'b', label: 'Second' },
  ]);
  expect(request).toHaveBeenCalledWith(new URL('https://example.test/api/v1/models'), expect.objectContaining({
    headers: { authorization: 'Bearer fixture-key' }, redirect: 'manual', signal: expect.any(AbortSignal),
  }));
});

it('refuses an origin change before forwarding any credentials', async () => {
  vi.stubEnv('CEZ_DRY_RUN', '0');
  const request = vi.fn(async () => Response.redirect('https://other.test/models'));
  await expect(fetchProviderModels('https://example.test', 'fixture-key', request)).rejects.toThrow('Could not load models');
  expect(request).toHaveBeenCalledTimes(1);
});

it('caps the streamed response even without a content-length header', async () => {
  vi.stubEnv('CEZ_DRY_RUN', '0');
  const request = vi.fn(async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)));
  await expect(fetchProviderModels('http://localhost:4000', 'fixture-key', request)).rejects.toThrow('Could not load models');
});

it('uses a repeatable model list offline in dry run', async () => {
  vi.stubEnv('CEZ_DRY_RUN', '1');
  const request = vi.fn();
  expect(await fetchProviderModels('https://example.test/api', '', request)).toContainEqual({ id: 'anthropic/test-model' });
  expect(request).not.toHaveBeenCalled();
});
