import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadModelsDevMetadata, metadataForRunner } from './models-dev-metadata.ts';

const homes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
describe('Models.dev advisory metadata', () => {
  it('loads new IDs, caches locally, and keeps the last good snapshot offline', async () => {
    const home = mkdtempSync('/tmp/cez-models-dev-');
    homes.push(home);
    vi.stubEnv('CEZ_HOME', home);
    const body = { anthropic: { models: { 'new-model-2030': {
      reasoning: true, tool_call: true, limit: { context: 300000 }, cost: { input: 2, output: 10 },
    } } }, openai: { models: { 'gpt-new': { reasoning: true, tool_call: true, limit: { context: 500000 }, cost: { input: 4, output: 16 } } } } };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(body)));
    const first = await loadModelsDevMetadata({ now: () => 100_000, fetcher });
    expect(metadataForRunner(first, 'opencode', 'openai/gpt-new')?.context).toBe(500000);
    expect(metadataForRunner(first, 'claude', 'new-model-2030')).toMatchObject({
      context: 300000, reasoning: true, inputUsdPerMillion: 2,
    });
    expect(existsSync(join(home, 'model-metadata.json'))).toBe(true);
    await loadModelsDevMetadata({ now: () => 100_001, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const offline = await loadModelsDevMetadata({ now: () => 100_000 + 86_400_001,
      fetcher: async () => { throw new Error('offline'); } });
    expect(metadataForRunner(offline, 'claude', 'new-model-2030')?.toolCall).toBe(true);
  });
});
