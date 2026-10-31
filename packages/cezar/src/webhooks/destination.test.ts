import { describe, expect, it } from 'vitest';
import * as policy from './destination.ts';
const consent = { mode: 'local' as const, allowLocalNetwork: true, serverPorts: [4317, 4318] };
describe('webhook destination policy', () => {
  it.each(['0.0.0.0', '::', '169.254.169.254', 'fd00:ec2::254', 'fe80::1', '224.0.0.1', '100.64.1.1', '192.0.2.1', '2001:db8::1', '64:ff9b::7f00:1', '64:ff9b:1::1', '2002:7f00:1::', '2001::1', '3fff::1'])('always denies special address %s', address => {
    expect(policy.classifyAddress(address)).toBe('denied');
  });
  it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '::1', 'fd12::1', '::ffff:127.0.0.1', '::127.0.0.1'])('classifies private address %s', address => {
    expect(policy.classifyAddress(address)).toBe('private');
  });
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])('permits public unicast %s', address => {
    expect(policy.classifyAddress(address)).toBe('public');
  });
  it('normalizes unusual numeric hosts before applying private consent', async () => {
    for (const url of ['http://2130706433', 'http://0x7f.1', 'http://[::ffff:7f00:1]']) {
      await expect(policy.validateDestination(url, { ...consent, allowLocalNetwork: false })).rejects.toThrow('local_consent_required');
      expect((await policy.validateDestination(url, consent)).private).toBe(true);
    }
  });
  it('blocks every own-server port even on public IPs and with consent', async () => {
    await expect(policy.validateDestination('https://8.8.8.8:4317/secret', consent)).rejects.toThrow('server_port');
  });
  it('rejects a whole DNS answer set with mixed public/private or any denied answer', async () => {
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }];
    await expect(policy.validateDestination('https://example.com', consent, lookup)).rejects.toThrow('mixed_dns');
    await expect(policy.validateDestination('https://example.com', consent, async () => [{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }])).rejects.toThrow('denied_address');
  });
  it('requires hosted public HTTPS and rejects credentials, fragments and metadata names', async () => {
    for (const url of ['http://8.8.8.8', 'https://127.0.0.1']) await expect(policy.validateDestination(url, { ...consent, mode: 'hosted' })).rejects.toThrow();
    for (const url of ['https://user:pass@example.com', 'https://example.com/#secret', 'file:///etc/passwd', 'http://metadata.google.internal']) await expect(policy.validateDestination(url, consent)).rejects.toThrow();
  });
  it('returns only masked origins for UI display, including invalid URLs', () => {
    expect(policy.maskDestination('https://example.com/secret?token=private')).toBe('https://example.com/…');
    expect(policy.maskDestination('https://secret@bad/hidden')).not.toContain('secret');
  });
});
