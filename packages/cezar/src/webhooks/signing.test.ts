import { describe, expect, it } from 'vitest';
import * as signing from './signing.ts';
import { redactSecrets } from '../core/secret-redaction.ts';
const key = () => 'whsec_' + Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64');
describe('Standard Webhooks signing', () => {
  it('signs exact id.timestamp.body bytes with the decoded key', () => {
    expect(signing.signWebhook('evt_test', 1700000000, '{"test":true}', [key()])).toBe('v1,EDPF6GVoskYYe+d9w094v65AAtQqtCZ3fPADF6taliA=');
  });
  it('emits two signatures during overlap and uses attempt time', () => {
    const other = 'whsec_' + Buffer.alloc(32, 42).toString('base64');
    const both = signing.signWebhook('evt_test', 1700000000, '{}', [key(), other]);
    expect(both.split(' ')).toHaveLength(2);
    expect(signing.verifyWebhook('evt_test', 1700000000, '{}', both, [other], 1700000300)).toBe(true);
    expect(signing.verifyWebhook('evt_test', 1700000000, '{}', both, [key()], 1700000301)).toBe(false);
    expect(signing.verifyWebhook('evt_test', 1700000000, '{ }', both, [key()], 1700000000)).toBe(false);
  });
  it('rejects malformed keys without echoing their value', () => {
    expect(() => signing.signWebhook('evt_test', 1700000000, '{}', ['private-invalid-key'])).toThrow('Invalid signing key');
  });
  it('redacts signing keys independent of collected env secrets', () => {
    expect(redactSecrets('key: ' + key(), [])).toBe('key: [REDACTED]');
  });
});
