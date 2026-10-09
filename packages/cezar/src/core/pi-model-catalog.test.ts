import { describe, expect, it } from 'vitest';
import { discoverPiModels, parsePiModelsOutput } from './pi-model-catalog.ts';

const TABLE = `provider  model                 context  max-out  thinking  images
anthropic claude-sonnet-5       200K     8K       yes       yes
openai    gpt-5.1-codex         400K     32K      yes       no
`;

describe('Pi model discovery', () => {
  it('parses provider/model rows, strips ANSI and removes duplicates', () => {
    expect(parsePiModelsOutput(`\u001b[32m${TABLE}\u001b[0m${TABLE.split('\n')[1]}\n`)).toEqual([
      { id: 'anthropic/claude-sonnet-5', label: 'claude-sonnet-5', description: 'via anthropic' },
      { id: 'openai/gpt-5.1-codex', label: 'gpt-5.1-codex', description: 'via openai' },
    ]);
  });

  it('returns an empty catalog for the documented no-model answer', () => {
    expect(parsePiModelsOutput('No models available.')).toEqual([]);
  });

  it('rejects non-table output instead of inventing picker ids', () => {
    expect(() => parsePiModelsOutput('pi warning: login required\n')).toThrow('unrecognized output');
  });

  it('runs the bounded --list-models probe with the project cwd', async () => {
    const calls: unknown[] = [];
    await expect(discoverPiModels({
      cwd: '/repo',
      bin: '/usr/local/bin/pi',
      run: async (...args) => {
        calls.push(args);
        return { stdout: TABLE, stderr: '' };
      },
    })).resolves.toHaveLength(2);
    expect(calls).toEqual([['/usr/local/bin/pi', ['--list-models'], '/repo', 10_000]]);
  });

  it('propagates probe failures for the shared unavailable fallback', async () => {
    await expect(discoverPiModels({
      cwd: '/repo',
      run: async () => { throw new Error('secret provider detail'); },
    })).rejects.toThrow('secret provider detail');
  });
});
