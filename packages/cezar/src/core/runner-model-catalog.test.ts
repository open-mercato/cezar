import { describe, expect, it, vi } from 'vitest';
import { RunnerModelCatalog, type ModelOption } from './runner-model-catalog.ts';

const models: ModelOption[] = [
  { id: 'gpt-latest', label: 'GPT Latest', description: 'Latest model' },
];

describe('RunnerModelCatalog', () => {
  it('returns a live discovery, then a cached value for five minutes', async () => {
    let now = 1_000;
    const discover = vi.fn(async () => models);
    const catalog = new RunnerModelCatalog({ adapters: { codex: { discover } }, now: () => now });

    await expect(catalog.get('codex')).resolves.toEqual({
      runner: 'codex', models, source: 'live', stale: false,
    });
    now += 299_999;
    await expect(catalog.get('codex')).resolves.toEqual({
      runner: 'codex', models, source: 'cache', stale: false,
    });
    expect(discover).toHaveBeenCalledTimes(1);

    now += 1;
    await catalog.get('codex');
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent refreshes into the same discovery', async () => {
    let resolveDiscovery!: (value: ModelOption[]) => void;
    const discover = vi.fn(() => new Promise<ModelOption[]>((resolve) => { resolveDiscovery = resolve; }));
    const catalog = new RunnerModelCatalog({ adapters: { codex: { discover } } });

    const first = catalog.get('codex');
    const second = catalog.get('codex');
    expect(discover).toHaveBeenCalledTimes(1);
    resolveDiscovery(models);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { runner: 'codex', models, source: 'live', stale: false },
      { runner: 'codex', models, source: 'live', stale: false },
    ]);
  });

  it('returns stale last-known-good data when a refresh fails', async () => {
    let now = 0;
    const discover = vi.fn()
      .mockResolvedValueOnce(models)
      .mockRejectedValueOnce(new Error('token=/secret/path account@example.test'));
    const catalog = new RunnerModelCatalog({
      adapters: { codex: { discover } },
      now: () => now,
      ttlMs: 10,
    });

    await catalog.get('codex');
    now = 10;
    await expect(catalog.get('codex')).resolves.toEqual({
      runner: 'codex',
      models,
      source: 'cache',
      stale: true,
      reason: 'Codex model discovery is temporarily unavailable',
    });
    await catalog.get('codex');
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('returns a sanitized unavailable result when no good value exists', async () => {
    const discover = vi.fn().mockRejectedValue(new Error('spawn /private/bin ENOENT: API_KEY=secret'));
    const catalog = new RunnerModelCatalog({ adapters: { codex: { discover } } });

    const result = await catalog.get('codex');
    expect(result).toEqual({
      runner: 'codex',
      models: [],
      source: 'unavailable',
      stale: false,
      reason: 'Codex model discovery is temporarily unavailable',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('/private');
    await catalog.get('codex');
    expect(discover).toHaveBeenCalledOnce();
  });

  it('does not let one runner cache or in-flight request affect another', async () => {
    const codex = vi.fn(async () => models);
    const claude = vi.fn(async () => [{ id: 'opus', label: 'Opus', description: '' }]);
    const catalog = new RunnerModelCatalog({ adapters: { codex: { discover: codex }, claude: { discover: claude } } });

    await Promise.all([catalog.get('codex'), catalog.get('claude')]);
    expect(codex).toHaveBeenCalledOnce();
    expect(claude).toHaveBeenCalledOnce();
  });
});
