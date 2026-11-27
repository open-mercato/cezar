import { z } from 'zod';
import { runnerSchema } from './health.ts';

export const providerMethodKindSchema = z.enum(['subscription', 'openrouter', 'custom', 'apiKey']);
export type ProviderMethodKind = z.infer<typeof providerMethodKindSchema>;
export const providerMethodIdSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/);
export const providerBaseUrlSchema = z.url().max(2048).refine((value) => {
  // Require an unambiguous authority. z.url() additionally checks the host and port.
  const parts = /^(https?):\/\/([^/?#\\@]+)(\/[^?#\\]*)?$/i.exec(value);
  if (!parts || /[\s\x00-\x1f\x7f]/.test(value)) return false;
  return parts[1]?.toLowerCase() === 'https' ||
    /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(parts[2] ?? '');
}, 'Use an HTTPS endpoint or loopback HTTP URL without credentials, query or fragment.');

export const providerMethodInputSchema = z.strictObject({
  kind: providerMethodKindSchema,
  label: z.string().trim().min(1).max(120).optional(),
  baseUrl: providerBaseUrlSchema.optional(),
  apiKey: z.string().max(16384).optional(),
});
export const providerActiveInputSchema = z.strictObject({ methodId: providerMethodIdSchema.nullable() });
export const providerMethodParamsSchema = z.object({ runner: runnerSchema, methodId: providerMethodIdSchema });
export const providerRunnerParamsSchema = providerMethodParamsSchema.pick({ runner: true });
export const providerFileMethodSchema = providerMethodInputSchema.omit({ kind: true }).extend({
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  apiKeyFile: z.string().min(1).max(4096).optional(),
}).refine((m) => [m.apiKey, m.apiKeyFile, m.apiKeyEnv].filter((v) => v !== undefined).length <= 1,
  'Choose one key source.');
export const providersFileSchema = z.strictObject({
  version: z.literal(1),
  agents: z.partialRecord(runnerSchema, z.strictObject({
    active: providerMethodIdSchema.nullable().optional(),
    methods: z.record(providerMethodIdSchema, providerFileMethodSchema).optional(),
  })),
});
export type ProvidersFile = z.infer<typeof providersFileSchema>;

export const agentProviderMethodSchema = z.object({
  id: providerMethodIdSchema,
  kind: providerMethodKindSchema,
  label: z.string(),
  state: z.enum(['connected', 'disconnected', 'error', 'unknown']),
  origin: z.enum(['host', 'cockpit', 'cli', 'file']).optional(),
  keyHint: z.string().optional(),
  baseUrl: z.string().optional(),
  modelCount: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
export type AgentProviderMethod = z.infer<typeof agentProviderMethodSchema>;
export const agentProviderEntrySchema = z.object({
  runner: runnerSchema,
  mode: z.enum(['one', 'any']),
  active: providerMethodIdSchema.nullable().optional(),
  methods: z.array(agentProviderMethodSchema),
});
export type AgentProviderEntry = z.infer<typeof agentProviderEntrySchema>;
export const agentProvidersResponseSchema = z.object({
  editable: z.boolean(),
  agents: z.array(agentProviderEntrySchema),
});
export type AgentProvidersResponse = z.infer<typeof agentProvidersResponseSchema>;
export const providerModelsResponseSchema = z.object({ models: z.array(z.string()) });
