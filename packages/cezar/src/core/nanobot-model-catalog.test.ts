import { describe, expect, it } from 'vitest';
import { parseNanobotDescription } from './nanobot-model-catalog.ts';

describe('Nanobot bridge metadata', () => {
  const metadata = {
    version: '0.4.1', ready: true,
    models: [{ id: 'qwen-local', label: 'Qwen local', description: 'Configured local preset' }],
  };
  it('discovers native presets without inventing reasoning capabilities', () => {
    expect(parseNanobotDescription(JSON.stringify(metadata))).toEqual(metadata);
  });
  it('retains an explicit not-ready answer', () => {
    expect(parseNanobotDescription(JSON.stringify({ ...metadata, ready: false })).ready).toBe(false);
  });
  it.each([
    'not json', '{}', JSON.stringify({ ...metadata, ready: 'yes' }),
    JSON.stringify({ ...metadata, models: [metadata.models[0], metadata.models[0]] }),
    JSON.stringify({ ...metadata, models: [{ id: '', label: 'empty', description: '' }] }),
  ])('rejects invalid metadata: %s', (stdout) => {
    expect(() => parseNanobotDescription(stdout)).toThrow();
  });
});
