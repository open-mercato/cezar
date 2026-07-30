import { describe, expect, it } from 'vitest';
import { isSafeGitRef } from './git-refs.ts';

/**
 * Dash-guard for git revision args (#431). A `-`/`--`-prefixed base/from ref
 * is argument injection: `git diff --output=/path` writes an arbitrary file.
 */
describe('isSafeGitRef', () => {
  it('accepts ordinary refs (branch names, shas, remote-tracking refs)', () => {
    for (const ref of ['main', 'origin/main', 'cez/ab12cd34', 'HEAD', 'feature/x', 'a1b2c3d']) {
      expect(isSafeGitRef(ref)).toBe(true);
    }
  });

  it('rejects option-like refs (leading dash)', () => {
    for (const ref of ['-x', '--output=/tmp/evil', '--upload-pack=touch /tmp/pwn', '-']) {
      expect(isSafeGitRef(ref)).toBe(false);
    }
  });

  it('rejects the empty ref (git would resolve it to an unexpected default)', () => {
    expect(isSafeGitRef('')).toBe(false);
  });
});
