import { randomUUID } from 'node:crypto';
import { constants, existsSync, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';
import type { ModelGatewayInput, ModelGatewayPresetInfo, ModelGatewaySummary } from '@open-mercato/cezar-contract';

import { renameWithRetry } from '../fs-rename.ts';
import { assertCezarHomeWriteIsSandboxed } from '../paths.ts';
import { modelGatewayPath } from './model-gateway-path.ts';
import { SecretStore, type SecretStoreOptions } from './secrets.ts';

/**
 * The model gateway (spec 2026-11-10-model-gateway): one key for a service that sells many models,
 * stored sealed under the secrets data key and handed ONLY to OpenCode's processes. Never in a
 * config file, never in `process.env`, never to another backend.
 */

export const MODEL_GATEWAY_PRESETS: readonly ModelGatewayPresetInfo[] = [
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/settings/keys' },
  { id: 'custom', name: 'Custom (OpenAI-compatible)' },
];

/** The env var a custom gateway's OpenCode config reads its key from (`{env:…}`). */
export const GATEWAY_KEY_ENV = 'CEZAR_MODEL_GATEWAY_KEY';
const MAX_RECORD_BYTES = 65_536;
const MAX_MODELS = 500;
const REQUEST_TIMEOUT_MS = 10_000;
const NAMESPACE = 'model-gateway';
const RECORD_ID = 'gateway';

const recordSchema = z.object({
  preset: z.enum(['openrouter', 'custom']),
  name: z.string(),
  baseUrl: z.string(),
  apiKey: z.string(),
  models: z.array(z.string()),
  updatedAt: z.string(),
});
export type StoredModelGateway = z.infer<typeof recordSchema>;

export class ModelGatewayError extends Error {}


export class ModelGatewayStore {
  private readonly directory: string;
  private readonly path: string;
  private readonly vault: SecretStore;

  constructor(env: NodeJS.ProcessEnv = process.env, options: SecretStoreOptions = {}) {
    this.path = modelGatewayPath(env);
    this.directory = dirname(this.path);
    this.vault = new SecretStore(env, options);
  }

  /** Cheap and synchronous, for the provider-status probe: a gateway is stored. */
  configured(): boolean {
    return existsSync(this.path);
  }

  /** The stored gateway, or null when none is. Throws when one is stored but cannot be opened. */
  async read(): Promise<StoredModelGateway | null> {
    let text: string;
    try {
      text = await this.readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return recordSchema.parse(JSON.parse(await this.vault.openManaged(NAMESPACE, RECORD_ID, text)));
  }

  async save(record: StoredModelGateway): Promise<void> {
    assertCezarHomeWriteIsSandboxed(this.path);
    const text = await this.vault.sealManaged(NAMESPACE, RECORD_ID, JSON.stringify(record));
    if (Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) throw new ModelGatewayError('The gateway is too large to store.');
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.write(join(this.directory, '.gitignore'), '# Managed private model-gateway key; never commit this directory.\n*\n');
    await this.write(this.path, text);
  }

  async remove(): Promise<void> {
    await fs.unlink(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  /** What an OpenCode process is given. Empty when nothing is stored or it cannot be read: a run
   *  then starts as it always did, and OpenCode's own error names the missing provider. */
  async agentEnv(): Promise<Record<string, string>> {
    const record = await this.read().catch(() => null);
    return record ? gatewayAgentEnv(record) : {};
  }

  private async readFile(path: string): Promise<string> {
    const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
        throw new ModelGatewayError('The stored gateway is unusable: it must be a regular 0600 file.');
      }
      return await file.readFile('utf8');
    } finally {
      await file.close();
    }
  }

  private async write(path: string, text: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(text);
        await file.sync();
      } finally {
        await file.close();
      }
      await renameWithRetry(temporary, path);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }
}

export function gatewaySummary(record: StoredModelGateway): ModelGatewaySummary {
  return { preset: record.preset, name: record.name, baseUrl: record.baseUrl, models: record.models, updatedAt: record.updatedAt };
}

/** OpenCode's provider id for a custom gateway: its name, as OpenCode spells ids. */
export function gatewayProviderId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'gateway';
}

/**
 * OpenRouter is a provider OpenCode already knows, so its own env var is enough. A custom gateway
 * is declared through `OPENCODE_CONFIG_CONTENT` (loaded after the project's config; the runner
 * merges private MCP servers on top), with the key read from the environment, never inlined.
 */
export function gatewayAgentEnv(record: StoredModelGateway): Record<string, string> {
  if (record.preset === 'openrouter') return { OPENROUTER_API_KEY: record.apiKey };
  const provider = {
    npm: '@ai-sdk/openai-compatible',
    name: record.name,
    options: { baseURL: record.baseUrl, apiKey: `{env:${GATEWAY_KEY_ENV}}` },
    models: Object.fromEntries(record.models.map((model) => [model, {}])),
  };
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { [gatewayProviderId(record.name)]: provider } }),
    [GATEWAY_KEY_ENV]: record.apiKey,
  };
}

type Fetch = typeof fetch;

async function request(fetchImpl: Fetch, url: string, apiKey: string): Promise<Response> {
  try {
    return await fetchImpl(url, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ModelGatewayError(`Could not reach ${new URL(url).host}. Check the address and your connection.`);
  }
}

/** The endpoint's own model list (`GET {baseUrl}/models`, OpenAI's shape). It also proves the key. */
export async function discoverGatewayModels(baseUrl: string, apiKey: string, fetchImpl: Fetch = fetch): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const response = await request(fetchImpl, url, apiKey);
  if (response.status === 401 || response.status === 403) throw new ModelGatewayError('The gateway rejected this key.');
  if (!response.ok) throw new ModelGatewayError(`The gateway answered ${response.status} for ${url}. Enter the model ids yourself.`);
  const parsed = z.object({ data: z.array(z.object({ id: z.string().min(1) }).passthrough()) }).passthrough().safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new ModelGatewayError(`${url} did not answer a model list. Enter the model ids yourself.`);
  const models = [...new Set(parsed.data.data.map((model) => model.id.trim()).filter((id) => id && !/[\s"]/.test(id)))].slice(0, MAX_MODELS);
  if (models.length === 0) throw new ModelGatewayError(`${url} lists no models. Enter the model ids yourself.`);
  return models;
}

/** OpenRouter's model list is public, so the key is checked against its own key endpoint. */
async function verifyOpenRouterKey(apiKey: string, fetchImpl: Fetch): Promise<void> {
  const response = await request(fetchImpl, 'https://openrouter.ai/api/v1/key', apiKey);
  if (response.status === 401 || response.status === 403) throw new ModelGatewayError('OpenRouter rejected this key.');
  if (!response.ok) throw new ModelGatewayError(`OpenRouter answered ${response.status} while checking the key. Try again.`);
}

/** The record a request stores, after the gateway itself has accepted the key. */
export async function resolveGatewayInput(input: ModelGatewayInput, options: { fetch?: Fetch; now?: () => Date; dryRun?: boolean } = {}): Promise<StoredModelGateway> {
  const fetchImpl = options.fetch ?? fetch;
  const updatedAt = (options.now ?? (() => new Date()))().toISOString();
  if (input.preset === 'openrouter') {
    const preset = MODEL_GATEWAY_PRESETS.find((candidate) => candidate.id === 'openrouter')!;
    if (!options.dryRun) await verifyOpenRouterKey(input.apiKey, fetchImpl);
    return { preset: 'openrouter', name: preset.name, baseUrl: preset.baseUrl!, apiKey: input.apiKey, models: [], updatedAt };
  }
  const baseUrl = input.baseUrl.replace(/\/+$/, '');
  const listed = input.models?.length ? [...new Set(input.models)] : options.dryRun ? [] : await discoverGatewayModels(baseUrl, input.apiKey, fetchImpl);
  return { preset: 'custom', name: input.name, baseUrl, apiKey: input.apiKey, models: listed, updatedAt };
}
