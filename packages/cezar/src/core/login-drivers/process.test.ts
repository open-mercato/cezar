import { execFile } from 'node:child_process';
import { delimiter } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { allowedVerificationUrl, createBrowserShim, findDeviceCode, findUrl, stripAnsi } from './process.ts';

describe('allowedVerificationUrl', () => {
  it('accepts only https pages on the provider\'s hosts', () => {
    expect(allowedVerificationUrl('claude', 'https://claude.com/cai/oauth/authorize?x=1')).toBe('https://claude.com/cai/oauth/authorize?x=1');
    expect(allowedVerificationUrl('claude', 'http://claude.com/x')).toBeUndefined();
    expect(allowedVerificationUrl('claude', 'https://claude.com.evil.example/x')).toBeUndefined();
    expect(allowedVerificationUrl('claude', 'https://user:pw@claude.com/x')).toBeUndefined();
    expect(allowedVerificationUrl('codex', 'https://claude.com/x')).toBeUndefined();
    expect(allowedVerificationUrl('opencode:unknown', 'https://auth.openai.com/x')).toBeUndefined();
    expect(allowedVerificationUrl('kimi', 'https://kimi.com/x')).toBeUndefined();
  });
});

describe('output parsing', () => {
  it('reads only whitespace-terminated URLs, so a half-printed one waits', () => {
    expect(findUrl('visit: https://claude.com/a?b', /^https:/)).toBeUndefined();
    expect(findUrl('visit: https://claude.com/a?b\n', /^https:/)).toBe('https://claude.com/a?b');
  });

  it('finds device codes and strips ANSI', () => {
    expect(findDeviceCode(stripAnsi('code: \u001b[94mABCD-EFGHI\u001b[0m\n'))).toBe('ABCD-EFGHI');
    expect(findDeviceCode('no code here')).toBeUndefined();
  });
});

describe.skipIf(process.platform === 'win32')('createBrowserShim', () => {
  it('records the URL a CLI hands to open/xdg-open instead of opening it', async () => {
    const shim = await createBrowserShim();
    if (!shim) throw new Error('no shim');
    try {
      const env = { ...process.env, PATH: `${shim.dir}${delimiter}${process.env.PATH ?? ''}` };
      await promisify(execFile)('sh', ['-c', 'open https://claude.com/x?y=1 && xdg-open https://claude.ai/z'], { env });
      expect(await shim.urls()).toEqual(['https://claude.com/x?y=1', 'https://claude.ai/z']);
    } finally {
      await shim.dispose();
    }
  });
});
