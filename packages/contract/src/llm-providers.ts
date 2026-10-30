import { z } from 'zod';

export const llmProtocolSchema = z.enum([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
]);
export const llmProviderIdSchema = z.string().uuid();
export const llmBaseUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine(
    (value) => /^https?:\/\/[^/?#@]+(?:\/[^?#]*)?$/.test(value),
    'Use an HTTP(S) API base URL without credentials, query parameters or fragment',
  );

export const llmProviderSchema = z
  .object({
    id: llmProviderIdSchema,
    name: z.string().trim().min(1).max(80),
    kind: z.enum(['openrouter', 'custom']),
    baseUrl: llmBaseUrlSchema,
    protocol: llmProtocolSchema,
  })
  .passthrough();
export type LlmProvider = z.infer<typeof llmProviderSchema>;
export const createLlmProviderSchema = llmProviderSchema
  .omit({ id: true })
  .extend({
    apiKey: z
      .string()
      .min(1)
      .max(16384)
      .refine(
        (value) => !/[\r\n\0]/.test(value),
        'API key must be a single line',
      ),
  })
  .strict();
export type CreateLlmProvider = z.infer<typeof createLlmProviderSchema>;
export const llmProvidersResponseSchema = z.object({
  providers: z.array(llmProviderSchema.extend({ hasApiKey: z.boolean() })),
  keyBackend: z.enum(['keychain', 'file']),
});
export type LlmProvidersResponse = z.infer<typeof llmProvidersResponseSchema>;
export const llmProviderParamsSchema = z.object({ id: llmProviderIdSchema });

export function supportsLlmProvider(
  runner: string,
  provider: LlmProvider,
): boolean {
  if (runner === 'cursor') return false;
  if (provider.kind === 'openrouter') return true;
  if (runner === 'claude') return provider.protocol === 'anthropic-messages';
  if (runner === 'codex') return provider.protocol === 'openai-responses';
  return ['pi', 'opencode', 'junie', 'copilot'].includes(runner);
}

/** Copyable handoffs contain references only, never credentials or shell-active model text. */
export function llmProviderCommand(
  id: string,
  runner: string,
  model: string,
  nativeCommand: string,
): string | null {
  if (
    !llmProviderIdSchema.safeParse(id).success ||
    !['claude', 'codex', 'pi', 'junie', 'opencode', 'copilot'].includes(
      runner,
    ) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_./:@+~-]*$/.test(model)
  )
    return null;
  return `cez llm-providers exec ${id} ${runner} --model ${model} -- ${nativeCommand.replace(/^\S+\s?/, '')}`.trimEnd();
}
