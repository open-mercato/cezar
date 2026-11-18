import { describe, expect, it } from 'vitest';
import { compileCodexRestrictedPolicy, codexBashArgv, CODEX_READ_PREFIXES } from './codex-restricted-policy.ts';
const policy = compileCodexRestrictedPolicy({ allowedTools: ['Read', 'Grep', 'Glob', 'Bash'], bashAllowlist: [...CODEX_READ_PREFIXES] })!;


describe('restricted Codex command approvals', () => {
  it.each(['gh pr diff 3', 'gh pr view 3 --json title,body', 'gh pr checks 3', 'git status --short', 'git rev-parse HEAD', 'git merge-base main HEAD'])('admits a declared read: %s', cmd => {
    expect(codexBashArgv(cmd, policy)).toEqual(expect.any(Array));
  });
  it.each(['touch x', 'git push', 'gh pr merge 3', 'gh pr comment 3 --body x', 'gh api repos/o/r -X POST', 'git status; touch x', 'git status && git push', 'gh pr diff 3 | sh', 'cat $(touch x)', 'cat `touch x`', 'cat <(touch x)', 'cat a > b', 'cat a\ntouch x', 'env git status', 'sh -c "git status"', './git status', '/usr/bin/git status', 'git -c core.fsmonitor=evil status', 'git ls-files --with-tree=evil', 'rg --pre touch x', 'rg --hostname-bin evil x', 'sed -n "1e touch x" a', 'sed -i a b', 'gh pr view 3 --web', 'gh pr checks 3 --watch', 'cat a &', 'cat *', 'cat a\\;touch x'])('denies mutation, execution or unsupported syntax: %s', cmd => {
    expect(codexBashArgv(cmd, policy)).toBeUndefined();
  });
  it('rejects a custom shell, raw command, and unknown shape', () => {
    for (const command of ['/tmp/evil -c "git status"', {}, null, '/bin/sh -c "git status" extra']) expect(codexBashArgv(command, policy)).toBeUndefined();
  });
  it('does not turn Read into a Bash, Grep or Glob grant', () => {
    const read = compileCodexRestrictedPolicy({ allowedTools: ['Read'] })!;
    for (const cmd of ['gh pr diff 3', 'git status', 'rg x', 'rg --files']) expect(codexBashArgv(cmd, read)).toBeUndefined();
  });
  it.each([{ allowedTools: ['Read', 'Bash'] }, { allowedTools: ['Read', 'Write'] }, { allowedTools: ['Read', 'mcp__x'] }, { allowedTools: ['Read', 'Bash'], bashAllowlist: ['gh api'] }])('refuses unavailable grants %j', spec => {
    expect(() => compileCodexRestrictedPolicy(spec)).toThrow('tool-policy enforcement unavailable');
  });
});
