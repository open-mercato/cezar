import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from '../paths.ts';
import type { RunnerId } from './agent-runner.ts';
import type { RoutingMetadata } from './adaptive-model-router.ts';

const URL = 'https://models.dev/api.json';
const REFRESH_MS = 24 * 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 24_000_000;
const providerForRunner: Partial<Record<RunnerId, string>> = { claude: 'anthropic', codex: 'openai', gemini: 'google' };
type Snapshot = { fetchedAt: number; models: Record<string, RoutingMetadata> };
let inFlight: Promise<Snapshot | undefined> | undefined;
let memorySnapshot: { path: string; snapshot: Snapshot } | undefined;
const count = z.number().finite().nonnegative();
const metadataSchema = z.object({
  id: z.string(), context: count.optional(), reasoning: z.boolean().optional(),
  toolCall: z.boolean().optional(), inputUsdPerMillion: count.optional(),
  outputUsdPerMillion: count.optional(), deprecated: z.boolean().optional(),
});
const snapshotSchema = z.object({ fetchedAt: count, models: z.record(z.string(), metadataSchema) });
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const nonnegative = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const path = () => join(cezarHomeDir(), 'model-metadata.json');

function readSnapshot(): Snapshot | undefined {
  try {
    const parsed = snapshotSchema.safeParse(JSON.parse(readFileSync(path(), 'utf8')));
    return parsed.success ? parsed.data : (memorySnapshot?.path === path() ? memorySnapshot.snapshot : undefined);
  } catch { return memorySnapshot?.path === path() ? memorySnapshot.snapshot : undefined; }
}
function extract(raw: unknown, now: number): Snapshot {
  const providers = object(raw) ?? {};
  const models: Record<string, RoutingMetadata> = {};
  for (const [providerId, value] of Object.entries(providers)) {
    const entries = object(object(value)?.models);
    if (!entries) continue;
    for (const [id, entry] of Object.entries(entries)) {
      const model = object(entry);
      if (!model) continue;
      const cost = object(model.cost);
      const limit = object(model.limit);
      const canonical = typeof model.canonical_model_id === 'string' ? model.canonical_model_id : `${providerId}/${id}`;
      models[`${providerId}/${id}`] = {
        id: canonical,
        ...(nonnegative(limit?.context) !== undefined ? { context: nonnegative(limit?.context) } : {}),
        ...(typeof model.reasoning === 'boolean' ? { reasoning: model.reasoning } : {}),
        ...(typeof model.tool_call === 'boolean' ? { toolCall: model.tool_call } : {}),
        ...(nonnegative(cost?.input) !== undefined ? { inputUsdPerMillion: nonnegative(cost?.input) } : {}),
        ...(nonnegative(cost?.output) !== undefined ? { outputUsdPerMillion: nonnegative(cost?.output) } : {}),
        ...(model.status === 'deprecated' || model.status === 'retired' ? { deprecated: true } : {}),
      };
    }
  }
  return { fetchedAt: now, models };
}

/** Optional advisory metadata; native authenticated CLI discovery remains authoritative. */
export async function loadModelsDevMetadata(
  options: { now?: () => number; fetcher?: typeof fetch } = {},
): Promise<Snapshot | undefined> {
  const now = options.now ?? Date.now;
  const saved = readSnapshot();
  if (saved && saved.fetchedAt <= now() && now() - saved.fetchedAt < REFRESH_MS) return saved;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const response = await (options.fetcher ?? fetch)(URL, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) return saved;
      const contentLength = Number(response.headers.get('content-length'));
      if (contentLength > MAX_RESPONSE_BYTES) return saved;
      const reader = response.body?.getReader();
      if (!reader) return saved;
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); return saved; }
        chunks.push(part.value);
      }
      const body = new TextDecoder().decode(Buffer.concat(chunks));
      const next = extract(JSON.parse(body), now());
      if (!Object.keys(next.models).length) return saved;
      memorySnapshot = { path: path(), snapshot: next };
      try {
        const destination = path();
        assertCezarHomeWriteIsSandboxed(destination);
        mkdirSync(cezarHomeDir(), { recursive: true, mode: 0o700 });
        const temp = `${destination}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
        renameSync(temp, destination);
      } catch { /* read-only home: in-memory answer is still usable */ }
      return next;
    } catch { return saved; }
  })().finally(() => { inFlight = undefined; });
  return inFlight;
}

export function metadataForRunner(snapshot: Snapshot | undefined, runner: RunnerId, modelId: string): RoutingMetadata | undefined {
  const provider = providerForRunner[runner];
  const baseId = modelId.replace(/\[[^\]]+\]$/, '');
  for (const id of baseId === modelId ? [modelId] : [modelId, baseId]) {
    const match = snapshot?.models[id] ?? (provider ? snapshot?.models[`${provider}/${id}`] : undefined);
    if (match) return match;
  }
  return undefined;
}
