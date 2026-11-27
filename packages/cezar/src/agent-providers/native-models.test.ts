import { expect, it } from 'vitest';
import { nativeProviderModels } from './native-models.ts';

it('reads the non-TTY pi catalog without mistaking banners for models', () => {
  expect(nativeProviderModels('pi', '', 'provider model context max-out thinking images\nanthropic  claude-test  1M 128K yes yes\n')).toEqual([
    { id: 'anthropic/claude-test', label: 'claude-test', description: '' },
  ]);
});

it('includes only chat models from omp and preserves the native provider prefix', () => {
  const models = [{ provider: 'openai-codex', id: 'gpt-test', kind: 'chat', name: 'GPT Test' },
    { provider: 'other', id: 'embedding', kind: 'embedding' }];
  expect(nativeProviderModels('omp', JSON.stringify({ models }), '')).toEqual([
    { id: 'openai-codex/gpt-test', label: 'GPT Test', description: '' },
  ]);
});
