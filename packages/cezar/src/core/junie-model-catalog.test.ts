import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discoverJunieModels } from './junie-model-catalog.ts';

const mockBin = fileURLToPath(new URL('../../scripts/mock-junie-acp.mjs', import.meta.url));

describe('discoverJunieModels', () => {
  it('reads model choices from ACP session config options and closes the short-lived process', async () => {
    await expect(discoverJunieModels({ bin: mockBin, cwd: process.cwd() })).resolves.toEqual([
      { id: 'v1:model:junie:sonnet', label: 'Sonnet', description: 'Balanced' },
      { id: 'v1:model:junie:opus', label: 'Opus', description: 'Reasoning' },
    ]);
  }, 15_000);
});