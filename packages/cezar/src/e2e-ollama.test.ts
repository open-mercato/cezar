import { describe, expect, it, vi } from 'vitest';
import { listOllamaModels } from './e2e-ollama.ts';

describe('listOllamaModels', () => {
  it('returns model names when Ollama answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      models: [{ name: 'llama3.2' }, { name: 'mistral' }],
    }), { status: 200 })));
    await expect(listOllamaModels('http://127.0.0.1:11434')).resolves.toEqual({
      available: true,
      baseUrl: 'http://127.0.0.1:11434',
      models: ['llama3.2', 'mistral'],
    });
    vi.unstubAllGlobals();
  });

  it('degrades when Ollama is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const result = await listOllamaModels('http://127.0.0.1:11434');
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toContain('ECONNREFUSED');
    vi.unstubAllGlobals();
  });
});
