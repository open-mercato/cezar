import {
  RUNNER_IDS, providerBaseUrlSchema, providerMethodInputSchema,
  type AgentProviderEntry, type AgentProviderMethod, type ProviderMethodKind, type ProviderStatus,
  type Runner, type RunnerModelCatalogResponse, type RunnerModelOption,
} from '@open-mercato/cezar-contract';
import { authMethods } from '../core/agent-auth-methods.ts';
import { readAgentProviders, readAgentProviderKey, updateAgentProviders, type StoredProviderMethod } from '../workspace/agent-providers.ts';
import { fetchProviderModels } from './models.ts';

const OPENROUTER = 'https://openrouter.ai/api';
type Store = Awaited<ReturnType<typeof readAgentProviders>>;
type Origin = 'cli' | 'file' | 'cockpit';
type Definition = ReturnType<typeof authMethods>['methods'][number];

export interface ProviderChange {
  runner: Runner;
  active?: string | null;
  methods: { id: string; kind?: ProviderMethodKind; label?: string; baseUrl?: string; apiKey?: string }[];
}

function definition(runner: Runner, id: string) {
  const method = authMethods(runner).methods.find(m => m.id === id);
  if (!method) throw new Error('Unsupported method for ' + runner + '.');
  return method;
}

function remote(kind: ProviderMethodKind) { return kind === 'openrouter' || kind === 'custom'; }

function methodView(def: Definition, saved: StoredProviderMethod | undefined, login: ProviderStatus | undefined): AgentProviderMethod {
  const fromHost = !saved && !!(def.hostKeyEnv && process.env[def.hostKeyEnv]);
  const info = saved?.models;
  const knownLogin = login?.status;
  const state = def.kind === 'subscription'
    ? knownLogin === 'not-installed' ? 'disconnected' : knownLogin ?? 'unknown'
    : saved?.keyHint
      ? remote(def.kind) && !info?.ids.length ? info?.error ? 'error' : 'disconnected' : 'connected'
      : fromHost ? 'connected' : 'disconnected';
  return {
    id: def.id, kind: def.kind, label: saved?.label ?? def.label, state,
    ...(fromHost ? { origin: 'host' as const } : saved?.origin ? { origin: saved.origin } : {}),
    ...(saved?.keyHint ? { keyHint: saved.keyHint } : {}),
    ...(saved?.baseUrl ? { baseUrl: saved.baseUrl } : {}),
    ...(info ? { modelCount: info.ids.length } : {}),
    ...(info?.error ? { error: info.error } : {}),
  };
}

export function providerEntry(runner: Runner, store: Store, login?: ProviderStatus): AgentProviderEntry {
  const def = authMethods(runner);
  const saved = store.agents[runner];
  const methods = def.methods.map(m => methodView(m, saved?.methods[m.id], login));
  const active = saved ? saved.active ?? null : methods.find(m => m.state === 'connected')?.id ?? null;
  return { runner, mode: def.mode, methods, ...(saved ? { configured: true as const } : {}), ...(def.mode === 'one' ? { active } : {}) };
}

export async function providerEntries(logins: readonly ProviderStatus[]) {
  const store = await readAgentProviders();
  return RUNNER_IDS.map(runner => providerEntry(runner, store, logins.find(p => p.provider === runner)));
}

/** Validate against the latest snapshot under the writer lock. Throwing discards the whole edit. */
export async function applyProviderChanges(changes: ProviderChange[], origin: Origin, logins: readonly ProviderStatus[]) {
  const fetches: { runner: Runner; id: string }[] = [];
  await updateAgentProviders((state, keys) => {
    for (const { runner, methods, active } of changes) {
      const login = logins.find(p => p.provider === runner);
      const previous = providerEntry(runner, state, login);
      const entry = state.agents[runner] ??= { ...(previous.active != null ? { active: previous.active } : {}), methods: {} };
      for (const { id, ...input } of methods) {
        const def = definition(runner, id);
        const value = providerMethodInputSchema.parse({ ...input, kind: input.kind ?? def.kind });
        if (value.kind !== def.kind) throw new Error('Method kind does not match ' + runner + '/' + id + '.');
        if (value.baseUrl !== undefined && def.kind !== 'custom') throw new Error('Only a custom provider takes a base URL.');
        if (def.kind === 'subscription' && value.apiKey !== undefined) throw new Error('A subscription uses the vendor login.');
        const old = entry.methods[id];
        const baseUrl = def.kind === 'openrouter' ? OPENROUTER : def.kind === 'custom'
          ? providerBaseUrlSchema.parse(value.baseUrl ?? old?.baseUrl).replace(/\/+$/, '') : undefined;
        const key = value.apiKey;
        if (key && (!key.trim() || /[\r\n\0]/.test(key))) throw new Error('Invalid key for ' + runner + '/' + id + '.');
        if (def.kind !== 'subscription' && !key && !old?.keyHint) throw new Error('A key is required for ' + runner + '/' + id + '.');
        if (old?.baseUrl && baseUrl && new URL(old.baseUrl).origin !== new URL(baseUrl).origin && !key) {
          throw new Error('Enter a key for the new endpoint.');
        }
        const updated: StoredProviderMethod = {
          ...old, kind: def.kind, origin, addedAt: old?.addedAt ?? new Date().toISOString(),
          ...(value.label ? { label: value.label } : {}), ...(baseUrl ? { baseUrl } : {}),
          ...(key ? { keyHint: '…' + (key.length > 4 ? key.slice(-4) : '••••') } : {}),
        };
        if (baseUrl !== old?.baseUrl) delete updated.models;
        entry.methods[id] = updated;
        if (key) keys.set(runner, id, key);
        if (remote(def.kind)) fetches.push({ runner, id });
      }
      if (active !== undefined) {
        if (authMethods(runner).mode !== 'one') throw new Error(runner + ' uses all connected methods.');
        if (active !== null) {
          const def = definition(runner, active);
          const saved = entry.methods[active];
          const method = methodView(def, saved, login);
          const pendingFetch = methods.some(m => m.id === active) && remote(def.kind) && saved?.keyHint;
          if (!pendingFetch && method.state !== 'connected' && method.state !== 'unknown') throw new Error('Connect the method before selecting it.');
        }
        entry.active = active;
      }
    }
  });
  return fetches;
}

export async function removeProviderMethod(runner: Runner, id: string) {
  definition(runner, id);
  await updateAgentProviders((state, keys) => {
    const entry = state.agents[runner];
    if (!entry?.methods[id]) throw new Error('There is no saved method to remove.');
    delete entry.methods[id];
    keys.remove(runner, id);
    if (entry.active === id) entry.active = null;
  });
}

export async function refreshProviderModels(runner: Runner, id: string) {
  const method = (await readAgentProviders()).agents[runner]?.methods[id];
  if (!method || !remote(method.kind) || !method.baseUrl) throw new Error('This method has no configured models endpoint.');
  const key = process.env.CEZ_DRY_RUN === '1' ? '' : await readAgentProviderKey(runner, id, method);
  if (!key && process.env.CEZ_DRY_RUN !== '1') throw new Error('Provider key is unavailable.');
  let ids = method.models?.ids ?? [];
  let error: string | undefined;
  try { ids = await fetchProviderModels(method.baseUrl, key ?? ''); }
  catch { error = 'Could not load models. Check the endpoint and key, then retry.'; }
  await updateAgentProviders(state => {
    const current = state.agents[runner]?.methods[id];
    if (!current || current.baseUrl !== method.baseUrl || current.keyRef !== method.keyRef) throw new Error('Provider changed. Retry with the current settings.');
    current.models = { fetchedAt: new Date().toISOString(), ids, ...(error ? { error } : {}) };
  });
  return { models: ids.map(m => m.id), ...(error ? { error } : {}) };
}

export async function providerCatalog(runner: Runner, native: () => Promise<RunnerModelCatalogResponse>, login?: ProviderStatus): Promise<RunnerModelCatalogResponse> {
  const store = await readAgentProviders();
  const saved = store.agents[runner];
  const entry = providerEntry(runner, store, login);
  const selected = entry.methods.filter(m => entry.mode === 'any' || m.id === entry.active);
  const local = selected.filter(m => !remote(m.kind) || m.origin === 'host');
  const needsNative = !saved || local.some(m => m.state === 'connected' || m.state === 'unknown');
  const legacy = needsNative ? await native() : undefined;
  const options: RunnerModelOption[] = [];
  for (const m of selected) {
    const via = { methodId: m.id, label: m.label };
    const catalog = saved?.methods[m.id]?.models;
    if (catalog && remote(m.kind)) {
      for (const item of catalog.ids) options.push({ id: item.id, label: item.label ?? item.id,
        description: runner === 'claude' && !item.id.startsWith('anthropic/') ? 'May not support tools' : '', via });
    }
  }
  if (runner === 'claude') options.sort((a, b) => Number(b.id.startsWith('anthropic/')) - Number(a.id.startsWith('anthropic/')));
  const nativeModels = legacy?.models.flatMap(model => {
    // Native provider/model ids on additive CLIs already tell us which login serves them.
    const m = entry.mode === 'one' ? local[0] : local.find(m => model.id.startsWith(m.id + '/'));
    if (!m) return saved ? [] : [model];
    if (saved && (m.state === 'error' || m.state === 'disconnected')) return [];
    return [{ ...model, via: { methodId: m.id, label: m.label } }];
  }) ?? [];
  if (!saved && legacy) return { ...legacy, models: nativeModels };
  const models = [...nativeModels, ...options];
  return { runner, models, source: options.length ? 'cache' : legacy?.source ?? 'unavailable',
    stale: !!legacy?.stale || selected.some(m => !!m.error && !!m.modelCount),
    ...(models.length === 0 && legacy?.reason ? { reason: legacy.reason } : {}) };
}

/** Apply configured auth to the action gate only. Vendor login status remains available to Settings. */
export function configuredAuthStatus(store: Store, row: ProviderStatus, pinned?: string): ProviderStatus {
  if ((!store.agents[row.provider] && !pinned) || row.enabled === false || row.status === 'not-installed') return row;
  const entry = providerEntry(row.provider, store, row);
  const chosen = pinned ?? entry.active;
  const available = entry.methods.filter(m => chosen ? m.id === chosen : entry.mode === 'any');
  if (available.some(m => m.kind !== 'subscription' && m.state === 'connected')) return { ...row, status: 'connected' };
  return available.some(m => m.kind === 'subscription') ? row : { ...row, status: 'disconnected' };
}

export function freshMethodError(store: Store, runner: Runner, id: string, model: string | undefined, login?: ProviderStatus) {
  const entry = providerEntry(runner, store, login);
  const method = entry.methods.find(m => m.id === id);
  if (!method) return 'Unsupported method for ' + runner + '.';
  if (store.agents[runner] && entry.mode === 'one' && entry.active !== id) return 'The selected provider changed. Choose the active method.';
  if (method.state === 'error' || method.state === 'disconnected') return 'This provider is unavailable. Check Settings → Agents.';
  const cached = store.agents[runner]?.methods[id]?.models;
  if (cached && model && model !== 'auto' && !cached.ids.some(m => m.id === model)) return 'This provider no longer offers the selected model.';
  return null;
}
