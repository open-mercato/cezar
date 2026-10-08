import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { readNdjson } from './ndjson.ts';
import {
  endJunieAcp,
  JunieAcpRpc,
  junieSpawnError,
  resolveJunieExecutable,
  spawnJunieAcp,
  type JunieAcpMessage,
} from './junie-acp-transport.ts';
import type { ModelOption } from './runner-model-catalog.ts';

export interface JunieModelDiscoveryOptions {
  cwd: string;
  bin?: string;
  timeoutMs?: number;
  spawn?: (bin: string, cwd: string) => ChildProcessWithoutNullStreams;
}

const modelChoiceSchema = z.object({
  value: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
}).passthrough();

const modelChoiceGroupSchema = z.object({
  group: z.string(),
  name: z.string().optional(),
  options: z.array(modelChoiceSchema),
}).passthrough();

const modelConfigSchema = z.object({
  id: z.string(),
  options: z.array(z.union([modelChoiceSchema, modelChoiceGroupSchema])),
}).passthrough();

const configOptionsSchema = z.object({ configOptions: z.array(modelConfigSchema) }).passthrough();
const DEFAULT_DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_MODELS = 200;

/** Discover the authenticated Junie CLI's model choices from ACP's session config options. */
export async function discoverJunieModels(
  options: JunieModelDiscoveryOptions,
): Promise<ModelOption[]> {
  const child = (options.spawn ?? spawnJunieAcp)(resolveJunieExecutable(options.bin), options.cwd);
  const rpc = new JunieAcpRpc(child);
  let readerError: Error | undefined;
  const reader = (async () => {
    try {
      for await (const line of readNdjson(child.stdout)) {
        let message: JunieAcpMessage;
        try {
          message = JSON.parse(line) as JunieAcpMessage;
        } catch {
          throw new Error('Junie model discovery returned malformed NDJSON');
        }
        rpc.dispatchResponse(message);
      }
    } catch (error) {
      readerError = error instanceof Error ? error : new Error(String(error));
      rpc.rejectPending(readerError.message);
    }
  })();

  let timeout: NodeJS.Timeout | undefined;
  try {
    const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        rpc.rejectPending('Junie model discovery timed out');
        reject(new Error('Junie model discovery timed out'));
      }, timeoutMs);
      timeout.unref?.();
    });
    const exited = new Promise<never>((_, reject) => {
      const fail = (error: Error) => {
        rpc.rejectPending(error.message);
        reject(error);
      };
      // The spawn error (ENOENT when the binary is missing) carries `.code` via `junieSpawnError`
      // so `probeJunieAuthentication` can tell "not installed" apart from any other failure.
      child.once('error', (error) => fail(junieSpawnError(error, resolveJunieExecutable(options.bin))));
      child.once('exit', (code) => fail(new Error(`Junie model discovery child exited (${code ?? 'unknown'})`)));
    });

    return await Promise.race([discoverOverAcp(rpc, options.cwd), deadline, exited]);
  } finally {
    if (timeout) clearTimeout(timeout);
    rpc.rejectPending();
    endJunieAcp(child);
    void reader.catch(() => undefined);
    if (readerError) rpc.rejectPending(readerError.message);
  }
}

async function discoverOverAcp(rpc: JunieAcpRpc, cwd: string): Promise<ModelOption[]> {
  const initialized = await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const authMethods = Array.isArray(initialized.authMethods) ? initialized.authMethods : [];
  const authMethod = authMethods.find((method) =>
    method !== null && typeof method === 'object' && typeof (method as { id?: unknown }).id === 'string');
  if (authMethod) {
    await rpc.request('authenticate', { methodId: (authMethod as { id: string }).id });
  }
  const session = await rpc.request('session/new', { cwd, mcpServers: [] });
  const parsed = configOptionsSchema.safeParse(session);
  if (!parsed.success) throw new Error('Junie model discovery returned malformed config options');
  const modelOption = parsed.data.configOptions.find((option) => option.id === 'model');
  if (!modelOption) throw new Error('Junie model discovery did not return a model option');
  const choices = modelOption.options.flatMap((entry) => 'value' in entry
    ? [entry as z.infer<typeof modelChoiceSchema>]
    : (entry as z.infer<typeof modelChoiceGroupSchema>).options);
  if (choices.length > MAX_MODELS) throw new Error('Junie model discovery exceeded the size limit');
  const seen = new Set<string>();
  return choices.flatMap((choice) => {
    const id = choice.value.trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ id, label: choice.name?.trim() || id, description: choice.description ?? '' }];
  });
}