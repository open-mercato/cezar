import { describe, expect, it } from 'vitest';
import { decodeWebhookInvalidation } from './webhook-events.ts';
describe('webhook invalidation decoder', () => {
  it('accepts only bounded project invalidations without payloads or secrets', () => {
    expect(decodeWebhookInvalidation('change', '{"changeSequence":4}')).toEqual({ type: 'change', changeSequence: 4 });
    expect(decodeWebhookInvalidation('resync', '{"changeSequence":0}')).toEqual({ type: 'resync', changeSequence: 0 });
    for (const data of ['{', 'null', '[]', '{"changeSequence":-1}', '{"changeSequence":1,"secret":"hidden"}', '{"changeSequence":1,"type":"resync"}']) expect(decodeWebhookInvalidation('change', data)).toBeUndefined();
    expect(decodeWebhookInvalidation('message', '{"changeSequence":1}')).toBeUndefined();
  });
});
