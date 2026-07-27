import { execFile } from 'node:child_process';
import type { ModelOption } from './runner-model-catalog.js';

/**
 * Live OpenCode model discovery — the opencode leg of the host model catalog
 * (mirrors `codex-model-catalog.ts`). `opencode models` prints one
 * `provider/model` id per line for every provider the host CLI is
 * authenticated against (API keys, subscriptions, the Zen gateway), so the
 * cockpit's pickers can offer what the user actually has instead of a static
 * preset list — the gap that hid a freshly configured DeepSeek/Kimi/GLM jury
 * from the Multi-model dropdowns.
 */

export interface OpencodeModelDiscoveryOptions {
  cwd: string;
  bin?: string;
  timeoutMs?: number;
  /** Injectable for tests: resolves with the raw `opencode models` stdout. */
  run?: (bin: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<string>;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
const MAX_MODELS = 500;
/** One `provider/model` id per line; anything else (warnings, blank lines,
 *  update banners) is noise to skip, never a parse failure. */
const MODEL_LINE = /^[A-Za-z0-9_.-]+\/[^\s/]\S*$/;

/** Parse `opencode models` output into catalog options. Pure — the discovery
 *  wrapper owns process concerns. */
export function parseOpencodeModels(stdout: string): ModelOption[] {
  const models: ModelOption[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!MODEL_LINE.test(line) || seen.has(line)) continue;
    seen.add(line);
    const slash = line.indexOf('/');
    models.push({
      id: line,
      label: line.slice(slash + 1),
      description: `via ${line.slice(0, slash)}`,
    });
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

/** Discover the models the authenticated host OpenCode CLI offers. Throws on
 *  a missing binary, timeout, or an empty list — the shared catalog turns
 *  that into its cached/unavailable answer. */
export async function discoverOpencodeModels(
  options: OpencodeModelDiscoveryOptions,
): Promise<ModelOption[]> {
  const bin = options.bin ?? process.env.CEZ_OPENCODE_BIN ?? 'opencode';
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const run =
    options.run ??
    ((binary: string, args: string[], opts: { cwd: string; timeoutMs: number }) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          binary,
          args,
          { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
          (err, stdout) => (err ? reject(err) : resolve(stdout ?? '')),
        );
      }));
  const stdout = await run(bin, ['models'], { cwd: options.cwd, timeoutMs });
  const models = parseOpencodeModels(stdout);
  if (models.length === 0) throw new Error('OpenCode model discovery returned no models');
  return models;
}
