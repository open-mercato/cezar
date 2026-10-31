import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { kimiHome } from './kimi-home.ts';
import type { ModelOption } from './runner-model-catalog.ts';

export interface KimiModelDiscoveryOptions {
  /** Defaults to `process.env`; `KIMI_CODE_HOME` relocates the config like it does for the CLI. */
  env?: NodeJS.ProcessEnv;
}

const MAX_MODELS = 200;

/**
 * Discover the models the host's Kimi Code offers by reading its own `config.toml`: every
 * `[models."<alias>"]` table is a model Kimi can select, keyed by exactly the alias cezar hands
 * `session/set_config_option` (`kimi-code/k3`). `kimi login` writes these tables for the account's
 * plan, so the list follows the account without cezar naming a single release.
 *
 * Read-only and process-free — a file read, no CLI spawn. A missing or unparseable file throws,
 * which `RunnerModelCatalog` turns into an `unavailable` answer; `auto` stays selectable.
 */
export async function discoverKimiModels(options: KimiModelDiscoveryOptions = {}): Promise<ModelOption[]> {
  const content = await readFile(join(kimiHome(options.env ?? process.env), 'config.toml'), 'utf8');
  return kimiModelsFromConfig(parseToml(content));
}

/** The picker entries a parsed Kimi config declares — the pure half, for tests. */
export function kimiModelsFromConfig(config: unknown): ModelOption[] {
  if (!isRecord(config) || !isRecord(config.models)) return [];
  const defaultModel = typeof config.default_model === 'string' ? config.default_model : undefined;
  const models: ModelOption[] = [];
  for (const [id, table] of Object.entries(config.models)) {
    if (models.length >= MAX_MODELS) break;
    if (!id.trim() || !isRecord(table)) continue;
    const label = typeof table.display_name === 'string' && table.display_name.trim() ? table.display_name.trim() : id;
    const context = typeof table.max_context_size === 'number' ? contextLabel(table.max_context_size) : undefined;
    const parts = [id, ...(context ? [`${context} context`] : []), ...(id === defaultModel ? ['your Kimi default'] : [])];
    models.push({ id, label, description: parts.join(' · ') });
  }
  return models;
}

function contextLabel(tokens: number): string | undefined {
  if (!Number.isFinite(tokens) || tokens <= 0) return undefined;
  return tokens >= 1_000_000 ? `${Math.round(tokens / 1_048_576)}M` : `${Math.round(tokens / 1_024)}K`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
