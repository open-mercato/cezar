import { z } from 'zod';

/**
 * The model gateway (spec 2026-11-10-model-gateway): one API key for a service that sells many
 * models (OpenMercato Gateway, OpenRouter, or any OpenAI-compatible endpoint), on which OpenCode
 * runs. The key goes in once and never comes back out; only OpenCode's processes receive it.
 */

/** A gateway cezar knows by name; `custom` is any OpenAI-compatible endpoint. */
export const modelGatewayPresetSchema = z.enum(['openmercato', 'openrouter', 'custom']);
export type ModelGatewayPreset = z.infer<typeof modelGatewayPresetSchema>;

export const modelGatewayPresetInfoSchema = z.object({
  id: modelGatewayPresetSchema,
  name: z.string(),
  /** Absent for `custom`: the user names it. */
  baseUrl: z.string().optional(),
  /** Where a key for this gateway is made. */
  keyUrl: z.string().optional(),
});
export type ModelGatewayPresetInfo = z.infer<typeof modelGatewayPresetInfoSchema>;

const GATEWAY_URL = z.string().trim().max(2048).url().refine((value) => /^https?:\/\//i.test(value), { message: 'the base URL is http(s)' });
const GATEWAY_NAME = z.string().trim().min(1).max(60);
const GATEWAY_KEY = z.string().trim().min(8).max(4096);
/** A model id as the gateway spells it (`acme-coder`, `anthropic/claude-sonnet-5`). */
const MODEL_ID = z.string().trim().min(1).max(200).regex(/^[^\s"]+$/, { message: 'a model id has no spaces or quotes' });

/** `PUT /api/v1/workspace/model-gateway`. A known gateway needs only its key. */
export const modelGatewayInputSchema = z.discriminatedUnion('preset', [
  z.object({ preset: z.literal('openmercato'), apiKey: GATEWAY_KEY }).strict(),
  z.object({ preset: z.literal('openrouter'), apiKey: GATEWAY_KEY }).strict(),
  z.object({
    preset: z.literal('custom'),
    name: GATEWAY_NAME,
    baseUrl: GATEWAY_URL,
    apiKey: GATEWAY_KEY,
    /** Empty or absent: cezar asks the endpoint's `GET /models`. */
    models: z.array(MODEL_ID).max(500).optional(),
  }).strict(),
]);
export type ModelGatewayInput = z.infer<typeof modelGatewayInputSchema>;

/** What the cockpit may know about a stored gateway: never the key. */
export const modelGatewaySummarySchema = z.object({
  preset: modelGatewayPresetSchema,
  name: z.string(),
  baseUrl: z.string(),
  /** The models OpenCode is told about; empty for a gateway OpenCode already knows (OpenRouter). */
  models: z.array(z.string()),
  updatedAt: z.string(),
});
export type ModelGatewaySummary = z.infer<typeof modelGatewaySummarySchema>;

/** `GET /api/v1/workspace/model-gateway`. `error` says why a stored gateway cannot be read. */
export const modelGatewayStateSchema = z.object({
  presets: z.array(modelGatewayPresetInfoSchema),
  gateway: modelGatewaySummarySchema.nullable(),
  error: z.string().optional(),
});
export type ModelGatewayState = z.infer<typeof modelGatewayStateSchema>;
