import { providerBaseUrlSchema } from '@open-mercato/cezar-contract';
import { z } from 'zod';

const MAX_BYTES = 2 * 1024 * 1024;
const modelSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(256).optional(),
  display_name: z.string().max(256).optional(),
  context_length: z.number().int().positive().optional(),
});

/** Never return a provider's error body: some gateways echo the Authorization header. */
export async function fetchProviderModels(baseUrl: string, key: string, request = fetch) {
  const base = providerBaseUrlSchema.parse(baseUrl).replace(/\/+$/, '');
  if (process.env.CEZ_DRY_RUN === '1') return [{ id: 'anthropic/test-model' }, { id: 'test-model' }];
  const url = new URL(base + '/v1/models');
  const signal = AbortSignal.timeout(10_000);
  let response: Response | undefined;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      response = await request(url, { headers: { authorization: 'Bearer ' + key }, redirect: 'manual', signal });
      if (response.status < 300 || response.status >= 400) break;
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error();
      const next = new URL(location, url);
      if (next.origin !== url.origin || next.username || next.password) throw new Error();
      url.href = next.href;
    }
    if (!response?.ok || !response.body || Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error(); }
      chunks.push(value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const { data } = z.object({ data: z.array(z.unknown()).max(20000) }).parse(body);
    const seen = new Set<string>();
    const ids = data.flatMap(row => {
      const result = modelSchema.safeParse(row);
      if (!result.success) return [];
      const { id, name, display_name, context_length } = result.data;
      const label = name ?? display_name;
      if (seen.has(id) || /[\x00-\x1f\x7f]/.test(id) || (key && (id.includes(key) || label?.includes(key)))) return [];
      seen.add(id);
      return [{ id, ...(label ? { label } : {}), ...(context_length ? { contextLength: context_length } : {}) }];
    });
    if (!ids.length) throw new Error();
    return ids;
  } catch {
    await response?.body?.cancel().catch(() => {});
    throw new Error('Could not load models. Check the endpoint and key, then retry.');
  }
}
