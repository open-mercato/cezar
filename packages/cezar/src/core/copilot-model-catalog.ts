import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AcpClient } from './acp-client.ts';
import { buildCopilotEnv, resolveCopilotBin } from './copilot-acp-runner.ts';
import { endJunieAcp } from './junie-acp-transport.ts';
import type { ModelOption } from './runner-model-catalog.ts';
import { spawnableCommand } from './windows-shim.ts';

export interface CopilotModelDiscoveryOptions {
  cwd: string;
  bin?: string;
  timeoutMs?: number;
  spawn?: (bin: string, cwd: string) => ChildProcessWithoutNullStreams;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 20_000;
const MAX_MODELS = 200;

/**
 * Discover the signed-in Copilot CLI's models from a throwaway ACP `session/new` handshake (#1903).
 * `models.list` is NOT served over ACP (-32601); the list rides in the `session/new` result as
 * `models.availableModels` (with per-model `_meta.copilotEnablement`) and `configOptions[id=model]`.
 * No prompt is sent. A missing or logged-out CLI throws, which `RunnerModelCatalog` turns into an
 * `unavailable` answer — the picker keeps `auto`.
 */
export async function discoverCopilotModels(options: CopilotModelDiscoveryOptions): Promise<ModelOption[]> {
  const bin = resolveCopilotBin(options.bin);
  const child = options.spawn
    ? options.spawn(bin, options.cwd)
    : spawnCopilotForDiscovery(bin, options.cwd);
  child.stdin.on('error', () => {});
  child.stderr.resume();
  const client = new AcpClient(child.stdin, child.stdout);
  const reader = client.run().catch(() => undefined);
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  let timeout: NodeJS.Timeout | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Copilot model discovery timed out')), timeoutMs);
      timeout.unref?.();
    });
    const failed = new Promise<never>((_, reject) => {
      child.once('error', (error: NodeJS.ErrnoException) => reject(
        error.code === 'ENOENT' ? new Error(`\`${bin}\` not found on PATH`) : error,
      ));
      child.once('exit', (code) => reject(new Error(`Copilot model discovery child exited (${code ?? 'unknown'})`)));
    });
    const handshake = (async () => {
      await client.initialize(timeoutMs);
      return copilotModelsFromSession(await client.newSession(options.cwd, timeoutMs));
    })();
    // A rejected losing branch must not surface as an unhandled rejection.
    void handshake.catch(() => undefined);
    void failed.catch(() => undefined);
    return await Promise.race([handshake, deadline, failed]);
  } finally {
    if (timeout) clearTimeout(timeout);
    client.close('Copilot model discovery finished');
    endJunieAcp(child);
    void reader;
  }
}

function spawnCopilotForDiscovery(bin: string, cwd: string): ChildProcessWithoutNullStreams {
  const [file, argv] = spawnableCommand(bin, ['--acp', '--no-auto-update']);
  return nodeSpawn(file, argv, { cwd, env: buildCopilotEnv('copilot') });
}

/** The picker entries a `session/new` result declares — the pure half, for tests and golden fixtures. */
export function copilotModelsFromSession(session: unknown): ModelOption[] {
  if (!isRecord(session)) throw new Error('Copilot model discovery returned a malformed session');
  const fromModels = availableModels(session.models);
  const entries = fromModels ?? configModelOptions(session.configOptions);
  if (!entries) throw new Error('Copilot model discovery did not return a model list');
  if (entries.length > MAX_MODELS) throw new Error('Copilot model discovery exceeded the size limit');
  const seen = new Set<string>();
  return entries.flatMap((entry) => {
    const id = entry.id.trim();
    // `auto` has no `_meta`; a model the account is not entitled to carries a non-"enabled" value.
    if (!id || seen.has(id) || (entry.enablement !== undefined && entry.enablement !== 'enabled')) return [];
    seen.add(id);
    return [{ id, label: entry.name?.trim() || id, description: entry.description?.trim() || '' }];
  });
}

interface RawModel {
  id: string;
  name?: string;
  description?: string;
  enablement?: string;
}

function availableModels(models: unknown): RawModel[] | undefined {
  if (!isRecord(models) || !Array.isArray(models.availableModels)) return undefined;
  return models.availableModels.flatMap((m): RawModel[] => {
    if (!isRecord(m) || typeof m.modelId !== 'string') return [];
    const meta = isRecord(m._meta) ? m._meta : undefined;
    return [{
      id: m.modelId,
      ...(typeof m.name === 'string' ? { name: m.name } : {}),
      ...(typeof m.description === 'string' ? { description: m.description } : {}),
      ...(typeof meta?.copilotEnablement === 'string' ? { enablement: meta.copilotEnablement } : {}),
    }];
  });
}

function configModelOptions(configOptions: unknown): RawModel[] | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  const model = configOptions.find((o) => isRecord(o) && o.id === 'model');
  if (!isRecord(model) || !Array.isArray(model.options)) return undefined;
  return model.options.flatMap((o): RawModel[] => {
    if (!isRecord(o) || typeof o.value !== 'string') return [];
    return [{
      id: o.value,
      ...(typeof o.name === 'string' ? { name: o.name } : {}),
      ...(typeof o.description === 'string' ? { description: o.description } : {}),
    }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
