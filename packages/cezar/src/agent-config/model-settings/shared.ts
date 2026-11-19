import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import type { RunnerId } from '../../core/agent-runner.ts';
import { CONFIG_FILES, type ConfigFileDef, type ConfigFormat } from '../catalog.ts';
import { readConfigFile } from '../files.ts';
import { stripJsonComments } from '../validate.ts';

export interface NativeSettingsFile {
  def: ConfigFileDef;
  content: string;
}

/** Remove JSONC trailing commas without touching commas inside string values. */
function stripJsonTrailingCommas(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index]!;
    if (inString) {
      out += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      out += character;
      continue;
    }
    if (character === ',') {
      let next = index + 1;
      while (/\s/.test(input[next] ?? '')) next++;
      if (input[next] === '}' || input[next] === ']') continue;
    }
    out += character;
  }
  return out;
}

function valueAtPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

/**
 * Parse an omp `config.yml` with the REAL YAML parser (the `yaml` dependency the repo already
 * uses for workflow files): a malformed settings file must not silently read as valid, and a
 * valid one (document markers, block scalars, anchors) must keep its meaning.
 */
export function parseYamlMapping(content: string): Record<string, unknown> {
  const parsed = parseYaml(content);
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function parseConfigContent(content: string, format: ConfigFormat): unknown {
  if (format === 'toml') return parseToml(content);
  if (format === 'yaml') return parseYamlMapping(content);
  return JSON.parse(format === 'jsonc' ? stripJsonTrailingCommas(stripJsonComments(content)) : content);
}

function stringAtPath(content: string, format: ConfigFormat, path: string): string | undefined {
  try {
    const value = valueAtPath(parseConfigContent(content, format), path);
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function readNativeSettingsFiles(
  runner: RunnerId,
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<NativeSettingsFile[]> {
  const definitions = CONFIG_FILES.filter(
    (definition) =>
      definition.kind === 'settings' &&
      definition.runners.includes(runner) &&
      definition.modelKey !== undefined &&
      definition.modelPriority !== undefined,
  ).sort((left, right) => (right.modelPriority ?? 0) - (left.modelPriority ?? 0));
  const files: NativeSettingsFile[] = [];
  for (const definition of definitions) {
    const file = await readConfigFile(definition.id, repoRoot, env);
    if (!file || 'error' in file || !file.exists) continue;
    files.push({ def: definition, content: file.content });
  }
  return files;
}

export function firstConfiguredModel(files: readonly NativeSettingsFile[]): string | undefined {
  for (const { def, content } of files) {
    for (const key of def.modelKeys ?? [def.modelKey!]) {
      const model = stringAtPath(content, def.format, key);
      if (model) return model;
    }
  }
  return undefined;
}

export function firstConfiguredProvider(files: readonly NativeSettingsFile[]): string | undefined {
  for (const { def, content } of files) {
    if (!def.modelProviderKey) continue;
    const provider = stringAtPath(content, def.format, def.modelProviderKey);
    if (provider) return provider;
  }
  return undefined;
}
