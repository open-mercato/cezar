import { describe, expect, it } from 'vitest';
import { scriptAwareCommand } from './claude-cli-runner.ts';

/**
 * `CEZ_DRY_RUN=1` on Windows: the bundled mock is a `.mjs`, which Windows cannot execute by its
 * shebang — every session died at spawn with `EFTYPE`. A script binary is run through Node there,
 * and NOTHING else changes: a real executable and every other platform pass through untouched.
 */
describe('scriptAwareCommand', () => {
  it('runs a script binary through Node on Windows', () => {
    expect(scriptAwareCommand('C:\cezar\scripts\mock-claude.mjs', ['-p', 'hi'], 'win32')).toEqual([
      process.execPath,
      ['C:\cezar\scripts\mock-claude.mjs', '-p', 'hi'],
    ]);
  });

  it.each(['claude.exe', 'claude.cmd', 'C:\bin\claude'])('leaves a real Windows executable alone: %s', (bin) => {
    expect(scriptAwareCommand(bin, ['-p'], 'win32')).toEqual([bin, ['-p']]);
  });

  it.each(['linux', 'darwin'] as const)('leaves a script alone on %s, where the shebang runs it', (platform) => {
    expect(scriptAwareCommand('/x/mock-claude.mjs', ['-p'], platform)).toEqual(['/x/mock-claude.mjs', ['-p']]);
  });
});
