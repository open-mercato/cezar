import { execFile } from 'node:child_process';
import { buildChildEnv } from './agent-env.ts';
import { resolveClaudeExecutable } from './claude-cli-runner.ts';
import { spawnableCommand } from './windows-shim.ts';
import { isClaudeSubscription, openCodeSubscriptionStatus } from './provider-method-status.ts';
import { piSubscriptionStatus } from '../agent-providers/pi-subscriptions.ts';
import { providerAuthChecksDisabled } from './provider-auth.ts';
import { agentModelsLocked } from './agent-model-policy.ts';
import { pickCheapModel } from '../runs/namer-model.ts';
import { AgentProviderUnavailable, type RunnerId } from './agent-runner.ts';
import { authMethods, providerHostKey, providerLaunch } from './agent-auth-methods.ts';
import { readAgentProviderKey, readAgentProviders, type StoredAgentProviders } from '../workspace/agent-providers.ts';

export { AgentProviderUnavailable } from './agent-runner.ts';

export type AgentProviderLaunch = ReturnType<typeof providerLaunch> & {
  methodId: string;
  kind: ReturnType<typeof authMethods>['methods'][number]['kind'];
  /** Unqualified catalog identity; multi-provider adapters may add a private ID on the wire. */
  catalogModel?: string;
  /** Only for redacting this invocation's output. Never put the launch object in a record. */
  secret?: string;
  hostKey?: true;
};

export interface MethodSelection {
  model?: string;
  requested?: string;
  /** A one-shot helper may substitute an offered model for its preferred native alias. */
  preferCheapModel?: boolean;
  modelsLocked?: boolean;
  /** Replay a previously launched method even if the workspace active selection has changed. */
  saved?: string;
  savedHost?: true;
}

const REMOVED = "This task's provider was removed. Pick another in Settings → Agents.";

/** Resolve an unpinned method from public metadata. Queue checks must never open a key. */
export function implicitProviderMethod(runner: RunnerId, entry: StoredAgentProviders['agents'][RunnerId], model?: string, preferCheapModel = false) {
  if (!entry) return undefined;
  const { mode, methods } = authMethods(runner);
  if (mode === 'one') return entry.active ?? undefined;
  const prefix = model?.includes('/') ? model.split('/')[0] : undefined;
  const native = methods.find(method => method.id === prefix);
  if (native?.kind === 'subscription') return native.id;
  const matches = Object.entries(entry.methods).filter(([, method]) => model && method.models?.ids.some(item => item.id === model));
  if (matches.length > 1) throw new AgentProviderUnavailable('Several providers serve this model. Pick its provider in the model menu.');
  if (matches.length === 1 || native) return matches[0]?.[0] ?? native?.id;
  if (!model || preferCheapModel) {
    const ids = Object.keys(entry.methods);
    if (ids.length === 1) return ids[0];
    if (ids.length > 1) throw new AgentProviderUnavailable('Pick a model to choose which provider serves this task.');
  }
  return undefined;
}

/** Managed keys are shared across login profiles. Historical native holds keep their account key. */
export function providerQuotaKey(runner: RunnerId, accountKey: string, methodId?: string, store?: StoredAgentProviders, model?: string) {
  if (!methodId && store && !providerAuthChecksDisabled()) {
    try { methodId = implicitProviderMethod(runner, store.agents[runner], model === 'auto' ? undefined : model); }
    catch { /* An ambiguous request has no known provider budget. Launch will ask for a choice. */ }
  }
  if (!methodId || methodId === 'subscription') return accountKey;
  const method = authMethods(runner).methods.find(item => item.id === methodId);
  return method?.kind === 'subscription' ? accountKey + ':' + methodId : runner + ':provider:' + methodId;
}

export async function agentProviderEnv(runner: RunnerId, selection: MethodSelection = {}): Promise<AgentProviderLaunch | undefined> {
  const { requested, saved } = selection;
  if (providerAuthChecksDisabled()) {
    if (saved || requested) throw new AgentProviderUnavailable('Provider selection is locked to native agent authentication.', saved ?? requested);
    return undefined;
  }
  const entry = (await readAgentProviders()).agents[runner];
  const model = selection.model?.trim() === 'auto' ? undefined : selection.model;
  if (!entry && !requested && !saved) return undefined;
  const { mode, methods } = authMethods(runner);
  let methodId = saved ?? requested;
  if (!saved && entry && mode === 'one') {
    if (!entry.active) throw new AgentProviderUnavailable('No provider selected. Pick a method in Settings → Agents.');
    if (requested && requested !== entry.active) {
      throw new AgentProviderUnavailable('The selected provider changed. Pick the active method in Settings → Agents.');
    }
    methodId = entry.active;
  }
  methodId ??= implicitProviderMethod(runner, entry, model, selection.preferCheapModel);
  if (!methodId) throw new AgentProviderUnavailable('Pick a model and its provider in Settings → Agents.');
  const method = methods.find(item => item.id === methodId);
  const stored = entry?.methods[methodId];
  if (!method || (stored && stored.kind !== method.kind)) throw new AgentProviderUnavailable(REMOVED, methodId);
  let key: string | undefined;
  let hostKey: true | undefined;
  if (method.kind !== 'subscription') {
    if (!stored && saved && !selection.savedHost) throw new AgentProviderUnavailable(REMOVED, methodId);
    if (stored && (method.kind === 'custom' || method.kind === 'openrouter') && !stored.models?.ids.length) {
      throw new AgentProviderUnavailable('This provider has no available models. Refresh them in Settings → Agents.', methodId);
    }
    if (stored) {
      try {
        key = process.env.CEZ_DRY_RUN === '1' ? (stored.keyHint ? 'cezar-dry-run-provider-key' : undefined)
          : await readAgentProviderKey(runner, methodId, stored);
      } catch (error) {
        if (error instanceof Error && error.message === 'Provider method changed; reload its configuration.') {
          throw new AgentProviderUnavailable('The provider changed while starting this task. Check Settings → Agents and retry.', methodId);
        }
        throw new AgentProviderUnavailable('The provider key store is unavailable. Unlock the OS keychain and retry.', methodId);
      }
    } else if (method.hostKeyEnv) {
      const host = providerHostKey(runner, method);
      if (host?.trim()) {
        hostKey = true;
        key = process.env.CEZ_DRY_RUN === '1' ? 'cezar-dry-run-provider-key' : host;
      }
    }
    if (!key) throw new AgentProviderUnavailable('This provider has no key. Add it in Settings → Agents.', methodId);
  }
  const endpoint = method.kind === 'custom' || method.kind === 'openrouter';
  // CLI defaults can name models the selected endpoint does not serve (including the internal namer).
  const offered = stored?.models?.ids;
  let providerModel = model;
  if (selection.modelsLocked) {
    providerModel = undefined;
    if (mode === 'any' || endpoint && runner === 'kimi') {
      throw new AgentProviderUnavailable('This provider requires a model override. Unlock agent models in Settings and retry.', methodId);
    }
  } else if (endpoint && offered?.length) {
    if (!model) providerModel = offered[0]!.id;
    else if (!offered.some(item => item.id === model)) {
      // Naming used to skip a call without a cheap model. Preserve that spending limit on gateways.
      providerModel = selection.preferCheapModel
        ? pickCheapModel(offered.map(({ id, label }) => ({ id, label: label ?? id, description: '' })))?.model
        : undefined;
      if (!providerModel) throw new AgentProviderUnavailable('The provider does not offer the selected model. Choose an available model in Settings → Agents.', methodId);
    }
  }
  const remoteModel = endpoint && hostKey && mode === 'any' && providerModel?.startsWith(methodId + '/')
    ? providerModel.slice(methodId.length + 1) : providerModel;
  let launch;
  try {
    launch = providerLaunch(runner, methodId, { baseUrl: stored?.baseUrl, key, model: remoteModel });
  } catch {
    throw new AgentProviderUnavailable('This provider cannot start with the selected model or endpoint. Check Settings → Agents.', methodId);
  }
  // Native aliases still pass through the runner's existing model normalization.
  if (!endpoint && launch.model === model) delete launch.model;
  return { ...launch, methodId, kind: method.kind, ...(endpoint && { catalogModel: remoteModel }), ...(key && { secret: key }), ...(hostKey && { hostKey }) };
}

/** Some CLIs prefer a stored API key to their login. Ask the same executable in the
 * selected account environment before it can make a model call. Keep all probe output private. */
export async function verifyProviderLogin(
  runner: RunnerId, provider: AgentProviderLaunch | undefined, cwd: string, extraEnv?: Record<string, string>,
): Promise<void> {
  if (provider?.kind !== 'subscription' || process.env.CEZ_DRY_RUN === '1' || providerAuthChecksDisabled()) return;
  if (!['claude', 'pi', 'opencode'].includes(runner)) return;
  const env = buildChildEnv({ backend: runner, provider, extraEnv });
  const probe = (bin: string, args: string[]): Promise<string> => {
    const [file, argv] = spawnableCommand(bin, args, { env });
    return new Promise((resolve, reject) => {
      const child = execFile(file, argv, { cwd, env, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024, windowsHide: true },
        (error, stdout) => error ? reject(error) : resolve(stdout));
      child.stdin?.end();
    });
  };
  try {
    if (runner === 'claude') {
      const status = JSON.parse(await probe(resolveClaudeExecutable(), ['auth', 'status', '--json']));
      if (isClaudeSubscription(status)) return;
    } else if (runner === 'pi') {
      if (await piSubscriptionStatus(provider.methodId, cwd, env) === 'connected') return;
    } else if (runner === 'opencode') {
      const executable = process.env.CEZ_OPENCODE_BIN ?? 'opencode';
      const check = (stdout: string) => openCodeSubscriptionStatus({ stdout, stderr: '', exitCode: 0 });
      const basic = check(await probe(executable, ['auth', 'list']).catch(() => ''));
      if (basic === 'connected') return;
      if (basic === 'unknown' && check(await probe(executable, ['auth', 'list', '--standalone', '--format', 'json'])) === 'connected') return;
    }
  } catch {
    // Both malformed answers and unavailable CLIs must stop before a different credential can be used.
  }
  throw new AgentProviderUnavailable('The CLI could not confirm the selected subscription. Check the login in Settings → Agents.', provider.methodId);
}

export function oneShotProvider(runner: RunnerId, cwd: string, selection: MethodSelection) {
  return agentProviderEnv(runner, { ...selection, preferCheapModel: true, modelsLocked: agentModelsLocked(cwd) });
}
