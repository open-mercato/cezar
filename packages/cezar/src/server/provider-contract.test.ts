import { describe, expect, it } from 'vitest';
import { providersFileSchema, providerBaseUrlSchema } from '@open-mercato/cezar-contract';

describe('provider setup input', () => {
  it.each(['https://example.org/api', 'http://[::1]:4040', 'http://127.0.0.2'])('accepts endpoint %s', url => {
    expect(providerBaseUrlSchema.safeParse(url).success).toBe(true);
  });
  it.each(['http://example.org', 'https://user:pass@example.org', 'https://x/#key',
    'https://x/?key=1', 'file:///tmp/models'])('rejects endpoint %s', url => {
    expect(providerBaseUrlSchema.safeParse(url).success).toBe(false);
  });
  it('validates every entry and refuses ambiguous key sources', () => {
    const file = (methods: unknown) => ({ version: 1, agents: { claude: { methods } } });
    expect(providersFileSchema.safeParse(file({ openrouter: { apiKeyEnv: 'ROUTER' } })).success).toBe(true);
    expect(providersFileSchema.safeParse(file({ openrouter: { apiKey: 'a', apiKeyEnv: 'B' } })).success).toBe(false);
    expect(providersFileSchema.safeParse({ version: 1, agents: { unknown: {} } }).success).toBe(false);
  });
});
