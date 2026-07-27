import { describe, expect, it } from 'vitest';
import { discoverOpencodeModels, parseOpencodeModels } from './opencode-model-catalog.js';

describe('parseOpencodeModels', () => {
  it('turns provider/model lines into options and skips noise', () => {
    const stdout = [
      '', // blank
      'opencode v1.17.7', // banner noise — no slash-id shape
      'opencode/glm-5.2',
      'opencode/kimi-k2.7-code',
      'opencode/mimo-v2.5-free',
      'deepseek/deepseek-v4-pro',
      'deepseek/deepseek-v4-pro', // duplicate
      'not a model line',
    ].join('\n');
    expect(parseOpencodeModels(stdout)).toEqual([
      { id: 'opencode/glm-5.2', label: 'glm-5.2', description: 'via opencode' },
      { id: 'opencode/kimi-k2.7-code', label: 'kimi-k2.7-code', description: 'via opencode' },
      { id: 'opencode/mimo-v2.5-free', label: 'mimo-v2.5-free', description: 'via opencode' },
      { id: 'deepseek/deepseek-v4-pro', label: 'deepseek-v4-pro', description: 'via deepseek' },
    ]);
  });

  it('returns empty for output with no model ids', () => {
    expect(parseOpencodeModels('no models here\n')).toEqual([]);
  });
});

describe('discoverOpencodeModels', () => {
  it('runs `opencode models` and parses the result', async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const models = await discoverOpencodeModels({
      cwd: '/tmp',
      bin: 'opencode-test',
      run: async (bin, args) => {
        calls.push({ bin, args });
        return 'deepseek/deepseek-chat\n';
      },
    });
    expect(calls).toEqual([{ bin: 'opencode-test', args: ['models'] }]);
    expect(models).toEqual([
      { id: 'deepseek/deepseek-chat', label: 'deepseek-chat', description: 'via deepseek' },
    ]);
  });

  it('throws on an empty catalog so the shared cache reports unavailable', async () => {
    await expect(
      discoverOpencodeModels({ cwd: '/tmp', run: async () => 'nothing\n' }),
    ).rejects.toThrow('no models');
  });
});
