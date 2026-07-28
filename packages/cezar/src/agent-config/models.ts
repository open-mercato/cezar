import { parse as parseToml } from 'smol-toml';
import type { RunnerId } from '../core/agent-runner.js';
import { CONFIG_FILES, type ConfigFormat } from './catalog.js';
import { readConfigFile } from './files.js';
import { stripJsonComments } from './validate.js';

/** The model defaults exposed by the coding agents' own settings files. */
export type AgentModelDefaults = Partial<Record<RunnerId, string>>;

/**
 * Native settings are read in the same order in which each agent applies them:
 * the first valid model wins. Cezar deliberately only reads the settings files
 * it already exposes in Settings → Agent config; managed/CLI/environment
 * overrides stay with the agent process itself.
 */
/** Remove JSONC trailing commas without touching commas inside string values. */
function stripJsonTrailingCommas(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let next = i + 1;
      while (/\s/.test(input[next] ?? '')) next++;
      if (input[next] === '}' || input[next] === ']') continue;
    }
    out += ch;
  }
  return out;
}

function modelFromContent(content: string, format: ConfigFormat, key: string): string | undefined {
  try {
    const parsed =
      format === 'toml'
        ? parseToml(content)
        : JSON.parse(
            format === 'jsonc' ? stripJsonTrailingCommas(stripJsonComments(content)) : content,
          );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const model = (parsed as Record<string, unknown>)[key];
    return typeof model === 'string' && model.trim() ? model.trim() : undefined;
  } catch {
    // A malformed higher-precedence file must not prevent a usable lower-level
    // default from appearing in the cockpit.
    return undefined;
  }
}

async function readRunnerModel(
  runner: RunnerId,
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const modelFiles = CONFIG_FILES.filter(
    (def) =>
      def.kind === 'settings' &&
      def.runners.includes(runner) &&
      def.modelKey !== undefined &&
      def.modelPriority !== undefined,
  ).sort((a, b) => (b.modelPriority ?? 0) - (a.modelPriority ?? 0));
  for (const def of modelFiles) {
    const file = await readConfigFile(def.id, repoRoot, env);
    if (!file || 'error' in file || !file.exists) continue;
    const model = modelFromContent(file.content, def.format, def.modelKey!);
    if (model) return model;
  }
  return undefined;
}

/** Read the current default model for each installed/configured coding agent. */
export async function readAgentModelDefaults(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentModelDefaults> {
  const entries = await Promise.all(
    (['claude', 'codex', 'opencode'] as const).map(async (runner) => [runner, await readRunnerModel(runner, repoRoot, env)] as const),
  );
  return Object.fromEntries(entries.filter((entry): entry is readonly [RunnerId, string] => entry[1] !== undefined));
}
