/** Default Ollama OpenAI-compatible base (spec: Ollama e2e provider). */
export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

const ollamaTagsResponseSchema = {
  parse(data: unknown): string[] {
    if (!data || typeof data !== 'object' || !('models' in data)) return [];
    const models = (data as { models?: unknown }).models;
    if (!Array.isArray(models)) return [];
    const names: string[] = [];
    for (const row of models) {
      if (row && typeof row === 'object' && 'name' in row && typeof (row as { name: unknown }).name === 'string') {
        names.push((row as { name: string }).name);
      }
    }
    return names.sort((a, b) => a.localeCompare(b));
  },
};

/** Lists models from a local Ollama instance — never throws. */
export async function listOllamaModels(baseUrl = OLLAMA_DEFAULT_BASE_URL): Promise<
  { available: true; models: string[]; baseUrl: string } | { available: false; reason: string; baseUrl: string }
> {
  const normalized = baseUrl.replace(/\/$/, '');
  const url = `${normalized}/api/tags`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      return { available: false, reason: `Ollama answered ${response.status}`, baseUrl: normalized };
    }
    const models = ollamaTagsResponseSchema.parse(await response.json());
    return { available: true, models, baseUrl: normalized };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'could not reach Ollama';
    return { available: false, reason, baseUrl: normalized };
  }
}
