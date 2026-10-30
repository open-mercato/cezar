import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createLlmProviderSchema,
  supportsLlmProvider,
  type CreateLlmProvider,
  type LlmProvider,
  type LlmProvidersResponse,
} from '@open-mercato/cezar-contract';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from './config.ts';
import { SecretStore } from './secrets.ts';
import type { ModelOption } from '../core/runner-model-catalog.ts';

const scope = { kind: 'workspace' } as const;
const keyName = (id: string) =>
  `LLM_PROVIDER_${id.replaceAll('-', '_').toUpperCase()}`;
export class LlmProviderError extends Error {}
export type ResolvedLlmProvider = { provider: LlmProvider; apiKey: string };

/** Values use the existing vault, with the cezar audience; no process-global credentials. */
export class LlmProviders {
  private readonly cache = new Map<
    string,
    { until: number; models: ModelOption[] }
  >();
  constructor(
    private readonly secrets = new SecretStore(),
    private readonly request: typeof fetch = fetch,
  ) {}

  async list(): Promise<LlmProvidersResponse> {
    const [config, keys, keyBackend] = await Promise.all([
      loadWorkspaceConfig(),
      this.secrets.list(scope),
      this.secrets.keyBackend(),
    ]);
    return {
      providers: config.llmProviders.map(
        ({ id, name, kind, baseUrl, protocol }) => ({
          id,
          name,
          kind,
          baseUrl,
          protocol,
          hasApiKey: keys.secrets.some((key) => key.name === keyName(id)),
        }),
      ),
      keyBackend,
    };
  }

  async add(input: CreateLlmProvider): Promise<LlmProvider> {
    const parsed = createLlmProviderSchema.parse(input);
    const { apiKey, ...metadata } = parsed;
    if (
      metadata.kind === 'openrouter' &&
      metadata.baseUrl.replace(/\/$/, '') !== 'https://openrouter.ai/api/v1'
    ) {
      throw new LlmProviderError(
        'OpenRouter uses https://openrouter.ai/api/v1. Choose Custom for another endpoint.',
      );
    }
    const provider = {
      ...metadata,
      baseUrl: metadata.baseUrl.replace(/\/+$/, ''),
      id: randomUUID(),
    };
    await this.secrets.set(scope, keyName(provider.id), apiKey, ['cezar']);
    try {
      await mergeWriteWorkspaceConfig((config) => {
        if (config.llmProviders.length >= 100)
          throw new LlmProviderError('At most 100 LLM providers can be saved');
        config.llmProviders.push(provider);
      });
    } catch (error) {
      await this.secrets.unset(scope, keyName(provider.id));
      throw error;
    }
    return provider;
  }

  async remove(id: string): Promise<void> {
    await mergeWriteWorkspaceConfig((config) => {
      config.llmProviders = config.llmProviders.filter(
        (provider) => provider.id !== id,
      );
    });
    await this.secrets.unset(scope, keyName(id));
    this.cache.delete(id);
  }

  async resolve(id: string, runner?: string): Promise<ResolvedLlmProvider> {
    const provider = (await loadWorkspaceConfig()).llmProviders.find(
      (provider) => provider.id === id,
    );
    if (!provider)
      throw new LlmProviderError(
        'The selected LLM provider was removed. Select a connection explicitly; native authentication was not used.',
      );
    if (runner && !supportsLlmProvider(runner, provider))
      throw new LlmProviderError(
        `This LLM provider is not compatible with ${runner}`,
      );
    const resolved = await this.secrets.resolve(undefined, 'cezar', [
      keyName(id),
    ]);
    const apiKey = resolved.values[keyName(id)];
    if (!apiKey)
      throw new LlmProviderError(
        'The selected LLM provider has no readable API key. Save its credentials again.',
      );
    return { provider, apiKey };
  }

  async models(id: string): Promise<ModelOption[]> {
    const { provider, apiKey } = await this.resolve(id);
    const cached = this.cache.get(id);
    if (cached && Date.now() < cached.until) return cached.models;
    try {
      const headers: Record<string, string> =
        provider.protocol === 'anthropic-messages' &&
        provider.kind !== 'openrouter'
          ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
          : { Authorization: `Bearer ${apiKey}` };
      const response = await this.request(`${provider.baseUrl}/models`, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error();
      // Bound the stream, not only Content-Length (which may be absent or dishonest).
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 4 * 1024 * 1024) throw new Error();
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const parsed = z
        .object({
          data: z
            .array(
              z.object({
                id: z.string().min(1).max(200),
                name: z.string().optional(),
                display_name: z.string().optional(),
                supported_parameters: z.array(z.string()).optional(),
              }),
            )
            .max(5000),
        })
        .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const seen = new Set<string>();
      const models = parsed.data.flatMap((model) => {
        if (
          seen.has(model.id) ||
          (provider.kind === 'openrouter' &&
            model.supported_parameters &&
            !model.supported_parameters.includes('tools'))
        )
          return [];
        seen.add(model.id);
        return [
          {
            id: model.id,
            label: model.name ?? model.display_name ?? model.id,
            description: `via ${provider.name}`,
          },
        ];
      });
      this.cache.set(id, { until: Date.now() + 300_000, models });
      return models;
    } catch {
      throw new LlmProviderError(
        'Could not list models from this provider. Check its API base URL, key and /models support. No native catalog was substituted.',
      );
    }
  }
}
