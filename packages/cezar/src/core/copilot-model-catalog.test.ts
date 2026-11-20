import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { copilotModelsFromSession, discoverCopilotModels } from './copilot-model-catalog.ts';

const mockBin = fileURLToPath(new URL('../../scripts/mock-copilot-acp.mjs', import.meta.url));
const golden = JSON.parse(
  readFileSync(new URL('./__fixtures__/copilot/session-new-models.json', import.meta.url), 'utf8'),
);

describe('copilotModelsFromSession', () => {
  it('lists enabled models from the golden session/new result, keeps auto, drops disabled and duplicates', () => {
    expect(copilotModelsFromSession(golden)).toEqual([
      { id: 'auto', label: 'Auto', description: 'Let Copilot pick the best model' },
      { id: 'claude-sonnet-5.5', label: 'Claude Sonnet 5.5', description: 'Claude Sonnet 5.5' },
      { id: 'claude-opus-4.8-fast', label: 'Claude Opus 4.8 (fast)', description: 'Claude Opus 4.8 fast' },
    ]);
  });

  it('falls back to configOptions[id=model] when models is absent', () => {
    const { models: _models, ...rest } = golden;
    expect(copilotModelsFromSession(rest).map((m) => m.id)).toEqual(['auto', 'claude-sonnet-5.5']);
  });

  it('rejects a result with no model list', () => {
    expect(() => copilotModelsFromSession({ sessionId: 'x' })).toThrow(/model list/);
    expect(() => copilotModelsFromSession(null)).toThrow(/malformed/);
  });
});

describe('discoverCopilotModels', () => {
  it('reads the list over a real ACP handshake against the mock (dry run)', async () => {
    const models = await discoverCopilotModels({ bin: mockBin, cwd: process.cwd() });
    expect(models.map((m) => m.id)).toEqual(['auto', 'mock-sonnet']);
  }, 15_000);

  it('degrades to a rejection when the binary is missing', async () => {
    await expect(discoverCopilotModels({ bin: '/nonexistent/copilot-bin', cwd: process.cwd() })).rejects.toThrow();
  }, 15_000);

  it('rejects when logged out', async () => {
    const prev = process.env.CEZ_MOCK_COPILOT_UNAUTHENTICATED;
    process.env.CEZ_MOCK_COPILOT_UNAUTHENTICATED = '1';
    try {
      await expect(discoverCopilotModels({ bin: mockBin, cwd: process.cwd() })).rejects.toThrow(/Authentication/);
    } finally {
      if (prev === undefined) delete process.env.CEZ_MOCK_COPILOT_UNAUTHENTICATED;
      else process.env.CEZ_MOCK_COPILOT_UNAUTHENTICATED = prev;
    }
  }, 15_000);

  it('is bounded by its timeout', async () => {
    await expect(
      discoverCopilotModels({ bin: process.execPath, cwd: process.cwd(), timeoutMs: 300, spawn: (_b, cwd) => spawnSilent(cwd) }),
    ).rejects.toThrow(/timed out/);
  }, 15_000);
});

import { spawn } from 'node:child_process';
function spawnSilent(cwd: string) {
  return spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { cwd });
}
