import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Runner } from '@open-mercato/cezar-contract';
import { cezarHomeDir } from '../paths.ts';
import { readPrivateFile, SecretStore, writePrivateFile } from './secrets.ts';

const optionalText = z.string().optional().catch(undefined);
const model = z.object({
  id: z.string(),
  label: optionalText,
  contextLength: z.number().int().positive().optional().catch(undefined),
}).passthrough();
const method = z.object({
  kind: z.enum(['subscription', 'openrouter', 'custom', 'apiKey']),
  addedAt: z.string().catch(''),
  label: optionalText,
  baseUrl: optionalText,
  origin: z.enum(['cockpit', 'file', 'cli']).optional().catch(undefined),
  fetchGeneration: z.number().int().nonnegative().optional().catch(undefined),
  models: z.object({
    fetchedAt: z.string(), ids: z.array(model), error: optionalText,
    generation: z.number().int().nonnegative().optional().catch(undefined),
    successGeneration: z.number().int().nonnegative().optional().catch(undefined),
  }).passthrough().optional().catch(undefined),
  // A spread of a CLI/route input must never persist an inline key alongside display metadata.
  apiKey: z.never().optional(),
  keyHint: optionalText,
  keyRef: z.uuid().optional().catch(undefined),
}).passthrough();
export type StoredProviderMethod = z.infer<typeof method>;

/** Keep the readable siblings of a malformed agent or method, including newer runners. */
function records<S extends z.ZodType>(schema: S) {
  return z.record(z.string(), z.unknown()).transform(entries => {
    const rows: [string, z.output<S>][] = [];
    for (const [id, raw] of Object.entries(entries)) {
      const result = schema.safeParse(raw);
      if (result.success) rows.push([id, result.data]);
    }
    return Object.fromEntries(rows);
  });
}
const agent = z.object({
  active: z.string().nullable().optional().catch(undefined),
  methods: records(method).catch({}),
}).passthrough();
const document = z.object({ version: z.literal(1).default(1), agents: records(agent) }).passthrough();
export interface StoredAgentProviders {
  agents: Partial<Record<Runner, z.infer<typeof agent>>>;
}
interface KeyEdits {
  set(runner: Runner, id: string, value: string): void;
  remove(runner: Runner, id: string): void;
}

// Up to two 2 MiB endpoint model lists per runner, plus metadata.
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
// Keep rows written by a newer version outside the editable view. Their keys stay live
// even if another runner is the only one this version recognizes.
type OpaqueMethods = Map<string, Record<string, Record<string, unknown>>>;
async function load(path: string, opaque?: OpaqueMethods): Promise<z.infer<typeof document>> {
  try {
    const text = await readPrivateFile(path, MAX_METADATA_BYTES);
    try {
      const raw = JSON.parse(text);
      const state = document.parse(raw);
      if (opaque) {
        for (const [runner, config] of Object.entries(state.agents)) {
          const rows = raw.agents[runner].methods;
          if (!rows || typeof rows !== 'object' || Array.isArray(rows)) continue;
          const unknown = Object.entries(rows).filter((item): item is [string, Record<string, unknown>] => {
            const [id, row] = item;
            return !Object.hasOwn(config.methods, id) && row !== null && typeof row === 'object' && !Array.isArray(row);
          });
          if (unknown.length) opaque.set(runner, Object.fromEntries(unknown));
        }
      }
      return state;
    } catch {
      throw new Error('Provider metadata is corrupt or has an unsupported format.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, agents: {} };
    throw error;
  }
}

/** Metadata-only reads degrade to zero configuration, even when the keychain is locked. */
export async function readAgentProviders(): Promise<StoredAgentProviders> {
  try {
    const { agents } = await load(join(cezarHomeDir(), 'agent-providers.json'));
    return { agents };
  } catch { return { agents: {} }; }
}

/** Pass the method snapshot when using its endpoint. A concurrent rotation can never pair a
 * new key with an old URL, even when both keys have the same hint. */
export async function readAgentProviderKey(runner: Runner, id: string, expected?: StoredProviderMethod): Promise<string | undefined> {
  const home = cezarHomeDir();
  const { agents } = await load(join(home, 'agent-providers.json'));
  const current = agents[runner]?.methods[id];
  if (expected && (!current || current.keyRef !== expected.keyRef || current.baseUrl !== expected.baseUrl || current.kind !== expected.kind)) {
    throw new Error('Provider method changed; reload its configuration.');
  }
  if (!current?.keyRef) return undefined;
  return new SecretStore({ ...process.env, CEZ_HOME: home }).openProviderKey(`${runner}/${id}`, current.keyRef);
}

function methodsBySlot(state: StoredAgentProviders): Map<string, StoredProviderMethod> {
  const slots = new Map<string, StoredProviderMethod>();
  for (const [runner, config] of Object.entries(state.agents)) {
    for (const [id, row] of Object.entries(config.methods)) slots.set(`${runner}/${id}`, row);
  }
  return slots;
}

async function applyKeyEdits(
  current: StoredAgentProviders,
  next: StoredAgentProviders,
  changes: Map<string, string | null>,
  store: SecretStore,
): Promise<void> {
  const before = methodsBySlot(current);
  const after = methodsBySlot(next);
  for (const [slot, value] of changes) {
    if (value !== null && (!value || !after.has(slot) || after.get(slot)?.kind === 'subscription')) {
      throw new Error('A provider key requires a non-subscription method and a nonempty value.');
    }
  }

  for (const [slot, row] of after) {
    if (row.apiKey !== undefined) throw new Error('Supply provider keys through keys.set.');
    const prior = before.get(slot);
    const value = changes.get(slot);
    // Only key operations own these fields. Replacing a metadata row must preserve an unedited key.
    delete row.keyHint;
    delete row.keyRef;
    if (value === null || row.kind === 'subscription') {
      if (prior?.keyRef) delete row.models;
      continue;
    }
    let ref = prior?.keyRef;
    if (value !== undefined) {
      // A re-apply is idempotent. A freshly supplied key can also repair damaged ciphertext.
      const oldKey = ref ? await store.openProviderKey(slot, ref).catch(() => undefined) : undefined;
      if (value !== oldKey) {
        ref = await store.stageProviderKey(slot, value);
        delete row.models;
      }
      row.keyHint = value.length > 4 ? `…${value.slice(-4)}` : '…';
    } else if (prior?.keyHint) {
      row.keyHint = prior.keyHint;
    }
    if (ref) row.keyRef = ref;
  }
}

async function retireUnusedKeys(store: SecretStore, state: StoredAgentProviders, opaque: OpaqueMethods): Promise<void> {
  const live = new Set<string>();
  for (const row of methodsBySlot(state).values()) {
    if (row.keyRef) live.add(row.keyRef);
  }
  for (const rows of opaque.values()) {
    for (const row of Object.values(rows)) {
      if (typeof row.keyRef === 'string') live.add(row.keyRef);
    }
  }
  // Publication is complete; a later edit retries any failed cleanup.
  await store.retireProviderKeys(live).catch(() => {});
}

/** Stage immutable ciphertext, then publish all selected references in one durable metadata
 * rename. Readers never take the writer lock. Only a successful publish can retire old keys. */
export async function updateAgentProviders<T>(edit: (state: StoredAgentProviders, keys: KeyEdits) => T | Promise<T>): Promise<T> {
  const home = cezarHomeDir();
  const path = join(home, 'agent-providers.json');
  const store = new SecretStore({ ...process.env, CEZ_HOME: home });
  return store.withAgentProviderLock(async () => {
    const opaque: OpaqueMethods = new Map();
    const current = await load(path, opaque); // Refuse to overwrite an unreadable file.
    const next = structuredClone(current);
    const changes = new Map<string, string | null>();
    const result = await edit(next, {
      set: (runner, id, value) => { changes.set(`${runner}/${id}`, value); },
      remove: (runner, id) => { changes.set(`${runner}/${id}`, null); },
    });

    for (const [runner, rows] of opaque) {
      const edited = next.agents[runner];
      if (!edited || Object.keys(rows).some(id => Object.hasOwn(edited.methods, id) || changes.has(`${runner}/${id}`))) {
        throw new Error('This edit would replace an unsupported provider method. Use the version that saved it.');
      }
    }

    try {
      await applyKeyEdits(current, next, changes, store);
      if (isDeepStrictEqual(current, next)) return result;
      const agents = Object.fromEntries(Object.entries(next.agents).map(([runner, config]) =>
        [runner, opaque.has(runner) ? { ...config, methods: { ...opaque.get(runner), ...config.methods } } : config]));
      const body = `${JSON.stringify({ ...next, agents })}\n`;
      if (Buffer.byteLength(body) > MAX_METADATA_BYTES) throw new Error('Provider metadata is too large.');
      await writePrivateFile(path, body);
    } catch (error) {
      // A failed directory fsync may follow a successful rename. Keep BOTH generations
      // in that case until a later durable commit. A failure before rename can roll back.
      const visible = await load(path).catch(() => undefined);
      if (visible && isDeepStrictEqual(visible, current)) await retireUnusedKeys(store, current, opaque);
      throw error;
    }
    await retireUnusedKeys(store, next, opaque);
    return result;
  });
}
