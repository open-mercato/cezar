import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { readNdjson } from './ndjson.ts';
import {
  CodexAppServerRpc,
  endCodexAppServer,
  resolveCodexExecutable,
  spawnCodexAppServer,
  type CodexAppServerMessage,
} from './codex-app-server-transport.ts';
import type { ModelOption, ReasoningEffortOption } from './runner-model-catalog.ts';

export interface CodexModelDiscoveryOptions {
  cwd: string;
  bin?: string;
  timeoutMs?: number;
  spawn?: (bin: string, cwd: string) => ChildProcessWithoutNullStreams;
}

const modelSchema = z.object({
  model: z.string(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  hidden: z.boolean().optional(),
  // App Server added object entries after initially returning a string array. Keep both values
  // opaque at the page boundary so one malformed capability never drops the whole model catalog.
  supportedReasoningEfforts: z.unknown().optional(),
  defaultReasoningEffort: z.unknown().optional(),
}).passthrough();

const pageSchema = z.object({
  data: z.array(modelSchema),
  nextCursor: z.string().nullable().optional(),
}).passthrough();

const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
const MAX_MODEL_PAGES = 25;
const MAX_MODELS = 500;

/** Discover the visible catalog exposed by the authenticated host Codex CLI. */
export async function discoverCodexModels(options: CodexModelDiscoveryOptions): Promise<ModelOption[]> {
  const child = (options.spawn ?? spawnCodexAppServer)(
    resolveCodexExecutable(options.bin),
    options.cwd,
  );
  const rpc = new CodexAppServerRpc(child);
  let readerError: Error | undefined;
  const reader = (async () => {
    try {
      for await (const line of readNdjson(child.stdout)) {
        let message: CodexAppServerMessage;
        try {
          message = JSON.parse(line) as CodexAppServerMessage;
        } catch {
          throw new Error('Codex model discovery returned malformed NDJSON');
        }
        rpc.dispatchResponse(message);
      }
    } catch (error) {
      readerError = error instanceof Error ? error : new Error(String(error));
      rpc.rejectPending(readerError.message);
    }
  })();

  const exited = new Promise<never>((_, reject) => {
    const fail = (detail: string) => {
      const error = new Error(detail);
      rpc.rejectPending(error.message);
      reject(error);
    };
    child.once('error', () => fail('Codex model discovery child failed'));
    child.once('exit', (code) => fail(`Codex model discovery child exited (${code ?? 'unknown'})`));
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error('Codex model discovery timed out');
      rpc.rejectPending(error.message);
      reject(error);
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    return await Promise.race([
      discoverPages(rpc),
      exited,
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    endCodexAppServer(child);
    void reader.catch(() => undefined);
    if (readerError) rpc.rejectPending(readerError.message);
  }
}

async function discoverPages(rpc: CodexAppServerRpc): Promise<ModelOption[]> {
  await rpc.initialize();
  const models: ModelOption[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;

  for (let pageNumber = 0; pageNumber < MAX_MODEL_PAGES; pageNumber += 1) {
    const raw = await rpc.request('model/list', { cursor, includeHidden: false });
    const parsed = pageSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Codex model discovery returned malformed model data');

    for (const model of parsed.data.data) {
      const id = model.model.trim();
      if (!id || model.hidden || ids.has(id)) continue;
      if (models.length >= MAX_MODELS) throw new Error('Codex model discovery exceeded the size limit');
      ids.add(id);
      const reasoningEfforts = normalizeReasoningEfforts(model.supportedReasoningEfforts);
      const defaultReasoningEffort = normalizeReasoningEffort(model.defaultReasoningEffort);
      models.push({
        id,
        label: model.displayName?.trim() || id,
        description: model.description ?? '',
        ...(reasoningEfforts.length ? { reasoningEfforts } : {}),
        ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      });
    }

    const nextCursor = parsed.data.nextCursor ?? null;
    if (nextCursor === null) return models;
    if (!nextCursor || cursors.has(nextCursor)) {
      throw new Error('Codex model discovery returned a cursor loop');
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new Error('Codex model discovery exceeded the page limit');
}

/** Normalize both App Server effort-list formats without treating malformed metadata as fatal. */
function normalizeReasoningEfforts(value: unknown): ReasoningEffortOption[] {
  if (!Array.isArray(value)) return [];
  const efforts: ReasoningEffortOption[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    const normalized = normalizeReasoningEffortOption(entry);
    if (!normalized || ids.has(normalized.id)) continue;
    ids.add(normalized.id);
    efforts.push(normalized);
  }
  return efforts;
}

function normalizeReasoningEffortOption(value: unknown): ReasoningEffortOption | undefined {
  if (typeof value === 'string') {
    const id = value.trim();
    return id ? { id, description: '' } : undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = normalizeReasoningEffort(record.reasoningEffort);
  if (!id) return undefined;
  return {
    id,
    description: typeof record.description === 'string' ? record.description.trim() : '',
  };
}

function normalizeReasoningEffort(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
