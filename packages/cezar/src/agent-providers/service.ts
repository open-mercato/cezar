import { homedir } from 'node:os';
import {
  RUNNER_IDS, providerBaseUrlSchema, providerMethodInputSchema,
  type AgentProviderEntry, type AgentProviderMethod, type ProviderMethodKind, type ProviderStatus,
  type Runner, type RunnerModelCatalogResponse, type RunnerModelOption,
} from '@open-mercato/cezar-contract';
import { discoverKimiModels, kimiSubscriptionModel } from '../core/kimi-model-catalog.ts';
import { modelConflictsWithRunner } from '../core/model-presets.ts';
import { providerAuthChecksDisabled, type ProviderAuthService } from '../core/provider-auth.ts';
import type { ProviderMethodStatuses } from '../core/provider-method-status.ts';
import { resolveProfileEnvForRoot } from '../workspace/agent-profiles.ts';
import { authMethods } from '../core/agent-auth-methods.ts';
import { readAgentProviders, readAgentProviderKey, updateAgentProviders, type StoredProviderMethod } from '../workspace/agent-providers.ts';
import { fetchProviderModels } from './models.ts';
import { cachedPiSubscriptions } from './pi-subscriptions.ts';

const OPENROUTER = 'https://openrouter.ai/api';
type Store = Awaited<ReturnType<typeof readAgentProviders>>;
type Origin = 'cli' | 'file' | 'cockpit';
export type ProviderLogin = ProviderStatus & { methods?: ProviderMethodStatuses };
// A named account's login can differ from the default account on the same machine.
export async function selectedProviderLogin(row: ProviderStatus, auth: Pick<ProviderAuthService, 'methodStatuses'>): Promise<ProviderLogin> {
  if (!row.profileId) return { ...row, methods: auth.methodStatuses(row.provider) };
  const { profile } = await resolveProfileEnvForRoot(undefined, row.provider, row.profileId);
  if (profile.id !== row.profileId) return row;
  return { ...row, methods: auth.methodStatuses(row.provider, profile.isDefault ? undefined : profile.path) };
}

const readPiSubscriptions = cachedPiSubscriptions();

async function configuredLogin(row: ProviderLogin | undefined, store: Store): Promise<ProviderLogin | undefined> {
  if (row?.provider !== 'pi' || !store.agents.pi || row.enabled === false || row.authFailureId ||
      row.status === 'not-installed' || row.status === 'disconnected' || process.env.CEZ_DRY_RUN === '1' || providerAuthChecksDisabled()) return row;
  const native = await readPiSubscriptions(homedir());
  return { ...row, methods: { ...row.methods, ...native } };
}

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

function methodView(def: Definition, saved: StoredProviderMethod | undefined, login: ProviderLogin | undefined): AgentProviderMethod {
  const fromHost = !saved && def.kind !== 'subscription' && (
    login?.methods?.[def.id] === 'connected' || !!(def.hostKeyEnv && process.env[def.hostKeyEnv]?.trim())
  );
  const info = saved?.models;
  let state: AgentProviderMethod['state'] = 'disconnected';
  if (def.kind === 'subscription') {
    if (login?.status !== 'not-installed' && login?.status !== 'disconnected') state = login?.methods?.[def.id] ?? 'unknown';
  } else if (saved?.keyHint) {
    if (!remote(def.kind) || info?.ids.length) state = 'connected';
    else state = 'error';
  } else if (fromHost) state = 'connected';
  return {
    id: def.id, kind: def.kind, label: saved?.label ?? def.label, state,
    ...(def.kind === 'subscription' && state === 'unknown' && canVerifyAtLaunch(login) ? { verifyAtLaunch: true } : {}),
    ...(fromHost ? { origin: 'host' as const } : saved?.origin ? { origin: saved.origin } : {}),
    ...(saved?.keyHint ? { keyHint: saved.keyHint } : {}),
    ...(saved?.baseUrl ? { baseUrl: saved.baseUrl } : {}),
    ...(info ? { modelCount: info.ids.length } : {}),
    ...(info?.error ? { error: info.error } : state === 'error' ? { error: 'Fetch the model list to use this provider.' } : {}),
  };
}

// These CLIs establish the vendor login in their launch context. Passive discovery can
// identify an installed, usable CLI without establishing which credential will serve a model.
function canVerifyAtLaunch(login?: ProviderLogin) {
  if (!login || login.enabled === false || login.authFailureId) return false;
  switch (login.provider) {
    case 'kimi':
    case 'copilot':
      return login.status === 'connected';
    case 'omp':
    case 'junie':
    case 'antigravity':
      return login.status === 'connected' || login.status === 'unknown';
    default:
      return false;
  }
}

export function providerEntry(runner: Runner, store: Store, login?: ProviderLogin): AgentProviderEntry {
  const def = authMethods(runner);
  const saved = store.agents[runner];
  const methods = def.methods.map(m => methodView(m, saved?.methods[m.id], login));
  const active = saved ? saved.active ?? null : methods.find(m => m.state === 'connected')?.id ?? null;
  return { runner, mode: def.mode, methods, ...(saved ? { configured: true as const } : {}), ...(def.mode === 'one' ? { active } : {}) };
}

export async function providerEntries(logins: readonly ProviderLogin[]) {
  const store = await readAgentProviders();
  return Promise.all(RUNNER_IDS.map(async runner =>
    providerEntry(runner, store, await configuredLogin(logins.find(p => p.provider === runner), store))));
}

/** Validate against the latest snapshot under the writer lock. Throwing discards the whole edit. */
export async function applyProviderChanges(changes: ProviderChange[], origin: Origin, logins: readonly ProviderLogin[]) {
  const fetches: { runner: Runner; id: string }[] = [];
  await updateAgentProviders((state, keys) => {
    for (const { runner, methods, active } of changes) {
      if (!methods.length && active === undefined) continue;
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
          if (!pendingFetch && method.state !== 'connected' && !method.verifyAtLaunch) throw new Error('Connect the method before selecting it.');
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
  // Both the server and the headless CLI can refresh this catalog. Reserve the request's
  // order under their shared metadata lock, then release it before going to the network.
  const method = await updateAgentProviders(state => {
    const row = state.agents[runner]?.methods[id];
    if (!row || !remote(row.kind) || !row.baseUrl) throw new Error('This method has no configured models endpoint.');
    row.fetchGeneration = (row.fetchGeneration ?? 0) + 1;
    return { ...row, baseUrl: row.baseUrl, fetchGeneration: row.fetchGeneration };
  });
  const key = process.env.CEZ_DRY_RUN === '1' ? '' : await readAgentProviderKey(runner, id, method);
  if (!key && process.env.CEZ_DRY_RUN !== '1') throw new Error('Provider key is unavailable.');
  let ids: NonNullable<StoredProviderMethod['models']>['ids'] = [];
  let error: string | undefined;
  try { ids = await fetchProviderModels(method.baseUrl, key ?? ''); }
  catch { error = 'Could not load models. Check the endpoint and key, then retry.'; }
  const catalog = await updateAgentProviders(state => {
    const current = state.agents[runner]?.methods[id];
    if (!current || current.kind !== method.kind || current.baseUrl !== method.baseUrl || current.keyRef !== method.keyRef) throw new Error('Provider changed. Retry with the current settings.');
    const fetchedAt = new Date().toISOString();
    const models = current.models ??= { fetchedAt, ids: [] };
    const lastOutcome = models.generation ?? 0;
    // Older metadata recorded only the latest outcome. Preserve its list until a newer request succeeds.
    models.successGeneration ??= models.ids.length ? lastOutcome : 0;
    if (!error && method.fetchGeneration > models.successGeneration) {
      models.ids = ids;
      models.successGeneration = method.fetchGeneration;
    }
    if (method.fetchGeneration > lastOutcome) {
      models.generation = method.fetchGeneration;
      models.fetchedAt = fetchedAt;
      if (error) models.error = error;
      else delete models.error;
    }
    return models;
  });
  return { models: catalog.ids.map(m => m.id), ...(catalog.error ? { error: catalog.error } : {}) };
}

export async function providerCatalog(
  runner: Runner, native: () => Promise<RunnerModelCatalogResponse>,
  loginFor?: (configured: boolean) => ProviderLogin | undefined | Promise<ProviderLogin | undefined>,
): Promise<RunnerModelCatalogResponse> {
  if (providerAuthChecksDisabled()) return native();
  const store = await readAgentProviders();
  const saved = store.agents[runner];
  if (runner === 'kimi' && !saved) return native();
  const login = await loginFor?.(!!saved);
  const entry = providerEntry(runner, store, await configuredLogin(login, store));
  const selected = entry.methods.filter(m => entry.mode === 'any' || m.id === entry.active);
  const local = selected.filter(m => (!remote(m.kind) || m.origin === 'host') && (m.state === 'connected' || m.verifyAtLaunch));
  const kimiMethod = runner === 'kimi' && local.find(m => m.kind === 'subscription');
  if (kimiMethod) {
    // A cached native list can outlive a TOML provider change. Read aliases and ownership together.
    const via = { methodId: kimiMethod.id, label: kimiMethod.label };
    try {
      const models = await discoverKimiModels({ env: await kimiAccountEnv(login), subscriptionOnly: true });
      return { runner, models: models.map(m => ({ ...m, via })), source: 'live', stale: false };
    } catch {
      return { runner, models: [], source: 'unavailable', stale: false, reason: 'Kimi model discovery is temporarily unavailable' };
    }
  }
  const needsNative = !saved || local.length > 0;
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
    return [{ ...model, via: { methodId: m.id, label: m.label } }];
  }) ?? [];
  if (!saved && legacy) return { ...legacy, models: nativeModels };
  const models = [...nativeModels, ...options];
  return { runner, models, source: options.length ? 'cache' : legacy?.source ?? 'unavailable',
    stale: !!legacy?.stale || selected.some(m => !!m.error && !!m.modelCount),
    ...(models.length === 0 && legacy?.reason ? { reason: legacy.reason } : {}) };
}

/** Apply configured auth to the action gate only. Vendor login status remains available to Settings. */
export async function configuredAuthStatus(store: Store, row: ProviderLogin, pinned?: string): Promise<ProviderStatus> {
  if ((!store.agents[row.provider] && !pinned) || row.enabled === false || row.status === 'not-installed') return row;
  const entry = providerEntry(row.provider, store, await configuredLogin(row, store));
  const chosen = pinned ?? entry.active;
  const available = entry.methods.filter(m => chosen ? m.id === chosen : entry.mode === 'any');
  if (available.some(m => m.kind !== 'subscription' && m.state === 'connected')) return { ...row, status: 'connected' };
  if (available.some(m => m.verifyAtLaunch)) return row;
  const login = available.find(m => m.kind === 'subscription' && m.state === 'connected') ??
    available.find(m => m.kind === 'subscription' && m.state === 'unknown');
  return { ...row, status: login?.state === 'connected' ? 'connected' : login?.state === 'unknown' ? 'unknown' : 'disconnected' };
}

// Native runner guards also apply to synchronous dispatch and Continue. Only the selected
// endpoint's actual catalog can authorize an otherwise foreign native model name.
export async function providerModelAdmission(runner: Runner, model?: string, recordedMethod?: string): Promise<{ providerModel?: string }> {
  if (providerAuthChecksDisabled() || !model || !modelConflictsWithRunner(model, runner)) return {};
  const entry = (await readAgentProviders()).agents[runner];
  if (!entry) return {};
  const selected = recordedMethod ?? entry.active;
  const matches = Object.entries(entry.methods).filter(([id, method]) =>
    (selected ? id === selected : authMethods(runner).mode === 'any') &&
    remote(method.kind) && method.keyRef && method.models?.ids.some(item => item.id === model));
  return matches.length === 1 ? { providerModel: model } : {};
}

async function kimiAccountEnv(login?: ProviderLogin): Promise<NodeJS.ProcessEnv> {
  if (!login?.profileId) return process.env;
  const { env } = await resolveProfileEnvForRoot(undefined, 'kimi', login.profileId);
  return { ...process.env, ...env };
}

export async function freshMethodError(store: Store, runner: Runner, id: string, model: string | undefined, login?: ProviderLogin) {
  const entry = providerEntry(runner, store, login);
  const method = entry.methods.find(m => m.id === id);
  if (!method) return 'Unsupported method for ' + runner + '.';
  if (store.agents[runner] && entry.mode === 'one' && entry.active !== id) return 'The selected provider changed. Choose the active method.';
  if (method.state === 'error' || method.state === 'disconnected') return 'This provider is unavailable. Check Settings → Agents.';
  if (runner === 'kimi' && method.kind === 'subscription') {
    const alias = model?.trim();
    if (!await kimiSubscriptionModel(await kimiAccountEnv(login), alias || undefined)) {
      return 'The Kimi subscription cannot serve the selected model. Choose a managed model in Settings → Agents.';
    }
  }
  const cached = store.agents[runner]?.methods[id]?.models;
  if (cached && model && model !== 'auto' && !cached.ids.some(m => m.id === model)) return 'This provider no longer offers the selected model.';
  return null;
}
