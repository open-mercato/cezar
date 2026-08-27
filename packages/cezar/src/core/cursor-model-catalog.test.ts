import { describe, expect, it, vi } from 'vitest';
import { discoverCursorModels, parseCursorModelsOutput } from './cursor-model-catalog.ts';

describe('parseCursorModelsOutput', () => {
  it('parses id/label lines and skips auto, headers, and tips', () => {
    const models = parseCursorModelsOutput(`Available models

auto - Auto (current, default)
composer-2.5 - Composer 2.5
gpt-5.2 - GPT-5.2

Tip: use --model <id> to switch.
`);
    expect(models).toEqual([
      { id: 'composer-2.5', label: 'Composer 2.5', description: '' },
      { id: 'gpt-5.2', label: 'GPT-5.2', description: '' },
    ]);
  });

  it('dedupes repeated ids', () => {
    expect(
      parseCursorModelsOutput(`composer-2.5 - A\ncomposer-2.5 - B\n`),
    ).toEqual([{ id: 'composer-2.5', label: 'A', description: '' }]);
  });
});

describe('discoverCursorModels', () => {
  it('runs agent models and returns parsed options', async () => {
    const run = vi.fn(async () => ({
      stdout: 'Available models\n\ncomposer-2.5 - Composer 2.5\n',
      stderr: '',
    }));
    await expect(discoverCursorModels({ bin: '/bin/agent', run })).resolves.toEqual([
      { id: 'composer-2.5', label: 'Composer 2.5', description: '' },
    ]);
    expect(run).toHaveBeenCalledWith('/bin/agent', process.env, 15_000);
  });

  it('fails when the CLI returns no parseable models', async () => {
    await expect(
      discoverCursorModels({
        run: async () => ({ stdout: 'Available models\n\n', stderr: '' }),
      }),
    ).rejects.toThrow('no models');
  });
});
