import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAttentionRequestSchema, webhookAttentionRequestSchema, webhookEventSchema } from '@open-mercato/cezar-contract';
describe('published webhook JSON Schema', () => {
  it('matches the single Zod contract and inventories every event type', () => {
    const artifact = JSON.parse(readFileSync(new URL('../../docs/webhooks.schema.json', import.meta.url), 'utf8'));
    expect(artifact).toEqual(z.toJSONSchema(webhookEventSchema));
    expect(artifact.oneOf ?? artifact.anyOf).toHaveLength(6);
  });
  it('keeps multiSelect on the run record only; the published payload has the v0.19.0 question shape', () => {
    const request = { requestId: 'r1', askedAt: new Date().toISOString(), questions: [{ question: 'Which?', multiSelect: true as const, options: [{ label: 'a' }] }] };
    expect(runAttentionRequestSchema.safeParse(request).success).toBe(true);
    expect(webhookAttentionRequestSchema.safeParse(request).success).toBe(false);
    expect(JSON.stringify(z.toJSONSchema(webhookEventSchema))).not.toContain('multiSelect');
  });
});
