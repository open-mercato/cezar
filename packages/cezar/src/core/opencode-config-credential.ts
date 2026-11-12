import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentHomePaths } from '../paths.ts';
import { parseJsonc } from '../agent-config/model-settings/shared.ts';
import { buildChildEnv } from './agent-env.ts';

type Mapping = Record<string, unknown>;

function mapping(value: unknown): value is Mapping {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(target: Mapping, source: Mapping): Mapping {
  for (const [key, value] of Object.entries(source)) {
    // Config keys are data, including names such as __proto__.
    const previous = Object.hasOwn(target, key) ? target[key] : undefined;
    Object.defineProperty(target, key, {
      value: mapping(value) ? merge(mapping(previous) ? previous : Object.create(null) as Mapping, value) : value,
      writable: true, enumerable: true, configurable: true,
    });
  }
  return target;
}

function resolvedString(value: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (typeof value !== 'string') return undefined;
  let missing = false;
  const resolved = value.replace(/\{env:([^}]+)\}/g, (_match, name: string) => {
    const replacement = env[name];
    if (!replacement?.trim()) missing = true;
    return replacement ?? '';
  });
  // File references and malformed/unresolved substitutions are not credential evidence.
  return !missing && resolved.trim() && !/[{}]/.test(resolved) ? resolved : undefined;
}

function readUserConfig(env: NodeJS.ProcessEnv): Mapping {
  const dir = agentHomePaths(env).opencodeConfig;
  let config: Mapping = Object.create(null) as Mapping;
  for (const filename of ['opencode.json', 'opencode.jsonc']) {
    let content: string;
    try {
      content = readFileSync(join(dir, filename), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const parsed = parseJsonc(content);
    if (!mapping(parsed)) throw new Error('Invalid OpenCode config');
    config = merge(config, parsed);
  }
  return config;
}

/** OpenCode 2.x auth list omits inline custom-provider keys. Only the user's native config
 * counts here: a repository's config or the public/free model catalog cannot prove a login. */
export function opencodeHasUserConfigCredential(source: NodeJS.ProcessEnv): boolean {
  const env = buildChildEnv({ backend: 'opencode', source });
  try {
    const config = readUserConfig(env);
    if (!mapping(config.providers)) return false;
    const enabled = config.enabled_providers;
    const disabled = config.disabled_providers;
    if ([enabled, disabled].some((list) => list !== undefined
      && (!Array.isArray(list) || list.some((id) => typeof id !== 'string')))) return false;
    return Object.entries(config.providers).some(([id, provider]) => {
      if (Array.isArray(enabled) && !enabled.includes(id)) return false;
      if (Array.isArray(disabled) && disabled.includes(id)) return false;
      if (!mapping(provider) || !mapping(provider.settings) || !mapping(provider.models)) return false;
      // Limit the supplement to explicitly configured compatible providers; built-in cloud
      // logins continue to use the CLI's authoritative auth-list answer.
      if (provider.package !== '@ai-sdk/openai-compatible'
        && provider.package !== '@opencode/ai/providers/openai-compatible') return false;
      if (!resolvedString(provider.settings.apiKey, env)) return false;
      const baseURL = resolvedString(provider.settings.baseURL, env);
      if (!baseURL) return false;
      let url: URL;
      try { url = new URL(baseURL); } catch { return false; }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
      return Object.values(provider.models).some((model) => mapping(model) && model.disabled !== true);
    });
  } catch {
    // Never include parser errors: their message can contain a credential's source text.
    return false;
  }
}

/** Native v2 turns reasoning effort capabilities into named variants, alongside explicit
 * variants. Expose only variants of models the CLI itself listed, preserving its catalog. */
export function opencodeUserModelVariants(source: NodeJS.ProcessEnv): Map<string, string[]> {
  const variants = new Map<string, string[]>();
  try {
    const config = readUserConfig(buildChildEnv({ backend: 'opencode', source }));
    if (!mapping(config.providers)) return variants;
    for (const [providerID, provider] of Object.entries(config.providers)) {
      if (!mapping(provider) || !mapping(provider.models)) continue;
      for (const [id, model] of Object.entries(provider.models)) {
        if (!mapping(model) || model.disabled === true) continue;
        const reasoning = mapping(model.capabilities) && mapping(model.capabilities.reasoning)
          ? model.capabilities.reasoning : undefined;
        const efforts = reasoning?.supported === true && Array.isArray(reasoning.effort) ? reasoning.effort : [];
        const explicit = Array.isArray(model.variants)
          ? model.variants.flatMap((variant) => mapping(variant) ? [variant.id] : []) : [];
        const ids = [...new Set([...efforts, ...explicit].filter((value): value is string =>
          typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,99}$/i.test(value)))];
        if (ids.length) variants.set(`${providerID}/${id}`, ids);
      }
    }
  } catch {
    // Discovery remains useful when user configuration is absent or unreadable.
  }
  return variants;
}
