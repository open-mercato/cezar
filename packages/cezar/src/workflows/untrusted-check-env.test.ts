import { describe, expect, it } from 'vitest';
import { untrustedCheckEnv } from './untrusted-check-env.ts';

describe('untrusted check environment', () => {
  it('preserves essential Windows spelling and locale without forwarding hooks or credentials', () => {
    const source = {
      Path: 'C:\\tools', SystemRoot: 'C:\\Windows', UserProfile: 'C:\\Users\\test',
      HOME: '/home/test', TMPDIR: '/tmp', LC_CTYPE: 'C.UTF-8',
      GITHUB_TOKEN: 'synthetic', Node_Options: '--require startup.js',
      LC_PRIVATE_TOKEN: 'synthetic', BASH_ENV: '/profile', ENV: '/profile',
      CEZ_AGENT_ENV_FULL: '1', CEZ_ENV_PASSTHROUGH: 'GITHUB_TOKEN',
      AWS_PROFILE: 'operator', SSH_AUTH_SOCK: '/ssh-agent', ABSENT: undefined,
    };
    expect(untrustedCheckEnv(source)).toEqual({
      Path: 'C:\\tools', SystemRoot: 'C:\\Windows', UserProfile: 'C:\\Users\\test',
      HOME: '/home/test', TMPDIR: '/tmp', LC_CTYPE: 'C.UTF-8',
    });
    expect(source.GITHUB_TOKEN).toBe('synthetic');
  });

  it('handles an empty environment without importing ambient process values', () => {
    expect(untrustedCheckEnv({})).toEqual({});
  });
});
