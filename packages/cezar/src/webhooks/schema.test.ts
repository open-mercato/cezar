import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { webhookEventSchema } from '@open-mercato/cezar-contract';
describe('published webhook JSON Schema', () => {
  it('matches the single Zod contract and inventories every event type', () => {
    const artifact = JSON.parse(readFileSync(new URL('../../docs/webhooks.schema.json', import.meta.url), 'utf8'));
    expect(artifact).toEqual(z.toJSONSchema(webhookEventSchema));
    expect(artifact.oneOf ?? artifact.anyOf).toHaveLength(6);
  });
});
