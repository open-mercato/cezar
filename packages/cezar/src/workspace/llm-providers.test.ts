import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  createLlmProviderSchema,
  llmProviderCommand,
  supportsLlmProvider,
} from '@open-mercato/cezar-contract';
import { LlmProviders } from './llm-providers.ts';
import { SecretStore } from './secrets.ts';

let home: string;
let secrets: SecretStore;
const input = {
  name: 'OpenRouter',
  kind: 'openrouter' as const,
  baseUrl: 'https://openrouter.ai/api/v1',
  protocol: 'openai-completions' as const,
  apiKey: 'test-provider-key-never-return-this',
};
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'llm-provider-test-'));
  vi.stubEnv('CEZ_HOME', home);
  secrets = new SecretStore(process.env, { keychain: async () => null });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

it('stores keys encrypted, returns metadata only, and keeps them out of check steps', async () => {
  const store = new LlmProviders(secrets);
  const provider = await store.add(input);
  expect(JSON.stringify(provider)).not.toContain(input.apiKey);
  expect(await store.list()).toMatchObject({
    keyBackend: 'file',
    providers: [{ id: provider.id, hasApiKey: true }],
  });
  expect(JSON.stringify(await store.list())).not.toContain(input.apiKey);
  expect(await readFile(join(home, 'config.json'), 'utf8')).not.toContain(
    input.apiKey,
  );
  expect(
    await readFile(join(home, 'secrets/workspace.json'), 'utf8'),
  ).not.toContain(input.apiKey);
  expect((await secrets.resolve(undefined, 'checks')).values).toEqual({});
  expect((await store.resolve(provider.id, 'pi')).apiKey).toBe(input.apiKey);
  await store.remove(provider.id);
  await expect(store.resolve(provider.id)).rejects.toThrow('removed');
});

it('uses the selected endpoint and credential, filters non-tool OpenRouter models and isolates caches', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'vendor/code',
              name: 'Code',
              supported_parameters: ['tools'],
            },
            { id: 'image-only', supported_parameters: [] },
            { id: 'vendor/code' },
          ],
        }),
      ),
    );
  const store = new LlmProviders(secrets, request);
  const a = await store.add(input);
  const b = await store.add({
    ...input,
    name: 'Other account',
    apiKey: 'other-test-key',
  });
  expect(await store.models(a.id)).toEqual([
    { id: 'vendor/code', label: 'Code', description: 'via OpenRouter' },
  ]);
  await store.models(a.id);
  expect(request).toHaveBeenCalledTimes(1);
  request.mockResolvedValueOnce(
    new Response(JSON.stringify({ data: [{ id: 'second/model' }] })),
  );
  expect(await store.models(b.id)).toMatchObject([{ id: 'second/model' }]);
  expect(request.mock.calls[0]).toMatchObject([
    'https://openrouter.ai/api/v1/models',
    { headers: { Authorization: `Bearer ${input.apiKey}` }, redirect: 'error' },
  ]);
  expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({
    Authorization: 'Bearer other-test-key',
  });
});

it('never forwards redirects or includes upstream error text / secrets in discovery errors', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(input.apiKey, { status: 401 }));
  const store = new LlmProviders(secrets, request);
  const provider = await store.add(input);
  await expect(store.models(provider.id)).rejects.toThrow(
    'No native catalog was substituted',
  );
  await expect(store.models(provider.id)).rejects.not.toThrow(input.apiKey);
});

it.each([
  'file:///etc/passwd',
  'https://user:password@gateway.test/v1',
  'https://gateway.test/v1?key=secret',
  'https://gateway.test/v1#secret',
])('refuses unsafe API base URL %s', (baseUrl) => {
  expect(
    createLlmProviderSchema.safeParse({ ...input, kind: 'custom', baseUrl })
      .success,
  ).toBe(false);
});

it('offers only supported protocol/runner combinations and safe credential-free terminal commands', () => {
  const provider = {
    ...input,
    id: '12345678-1234-4234-8234-123456789abc',
    kind: 'custom' as const,
  };
  expect(supportsLlmProvider('claude', provider)).toBe(false);
  expect(supportsLlmProvider('codex', provider)).toBe(false);
  expect(supportsLlmProvider('pi', provider)).toBe(true);
  expect(
    supportsLlmProvider('cursor', { ...provider, kind: 'openrouter' }),
  ).toBe(false);
  expect(
    llmProviderCommand(
      provider.id,
      'pi',
      'vendor/model',
      'pi --session safe-id',
    ),
  ).toBe(
    `cez llm-providers exec ${provider.id} pi --model vendor/model -- --session safe-id`,
  );
  expect(
    llmProviderCommand(
      provider.id,
      'pi',
      'model;touch /tmp/attack',
      'pi --session safe-id',
    ),
  ).toBeNull();
});
