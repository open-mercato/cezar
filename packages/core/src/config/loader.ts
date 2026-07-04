import { cosmiconfig } from 'cosmiconfig';
import { ConfigSchema, type Config } from './config.model.js';

export async function loadConfig(overrides: Partial<Config> = {}): Promise<Config> {
  const explorer = cosmiconfig('issuemanager');
  const result = await explorer.search();

  const raw = result?.config ?? {};

  // Merge env vars
  if (process.env.GITHUB_TOKEN) {
    raw.github = raw.github ?? {};
    raw.github.token = raw.github.token || process.env.GITHUB_TOKEN;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    raw.llm = raw.llm ?? {};
    raw.llm.apiKey = raw.llm.apiKey || process.env.ANTHROPIC_API_KEY;
  }

  // Merge CLI overrides — explicit values (including '') win over config-file values.
  const merged = deepMerge(raw, overrides as Record<string, unknown>, true);

  const result2 = ConfigSchema.safeParse(merged);
  if (!result2.success) {
    const lines = result2.error.issues.map(
      (i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return result2.data;
}

/**
 * Deep-merge `source` into `target`.
 *
 * When `allowEmpty` is false (env merging), empty/unset values (`undefined`,
 * `null`, `''`) are skipped so an unset env var never clobbers a config value.
 * When `allowEmpty` is true (CLI/override merging), only `undefined` is skipped
 * so an explicit `''` can deliberately clear a leftover value.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  allowEmpty = false,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const val = source[key];
    const skip = allowEmpty ? val === undefined : val === undefined || val === null || val === '';
    if (skip) continue;
    if (
      typeof val === 'object' &&
      val !== null &&
      !Array.isArray(val) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        val as Record<string, unknown>,
        allowEmpty,
      );
    } else {
      result[key] = val;
    }
  }
  return result;
}
