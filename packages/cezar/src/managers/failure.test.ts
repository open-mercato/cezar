import { describe, expect, it } from 'vitest';
import { classifyManagerFailure, failureCause, managerFailureMessage, retryPlan, type ManagerFailureKind } from './failure.ts';

// What the Claude CLI really printed before "exited with code 1" on failed watch checks.
const OBSERVED: Array<[string, ManagerFailureKind]> = [
  ['Failed to authenticate: OAuth session expired and could not be refreshed', 'auth'],
  ['You’ve hit your session limit · resets 6:10am (Europe/Warsaw)', 'usage-limit'],
  ["API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)", 'network'],
  ["Prompt is too long · automatic compaction failed: API Error: Can't reach the API server (ENOTFOUND)", 'session'],
  ['No conversation found with session ID: 0d35a1be', 'session'],
  ['API Error: 529 overloaded', 'busy'],
  ['spawn claude ENOENT', 'missing-cli'],
  ['claude CLI exited with code 1', 'unknown'],
];

describe('manager failures', () => {
  it.each(OBSERVED)('classifies %s', (cause, kind) => {
    expect(classifyManagerFailure(cause)).toBe(kind);
  });

  it('never says "exited with code" to the user', () => {
    for (const [cause, kind] of OBSERVED) {
      expect(managerFailureMessage(kind, cause, 'claude')).not.toMatch(/exited with code/);
    }
    expect(managerFailureMessage('unknown', 'claude CLI exited with code 1 — boom', 'claude')).toBe('Claude Code stopped before answering: boom');
  });

  it('names what to do', () => {
    expect(managerFailureMessage('auth', '', 'claude')).toMatch(/^Sign in to Claude Code again/);
    expect(managerFailureMessage('usage-limit', '', 'claude', new Date('2026-11-11T13:00:00Z'))).toMatch(/^Usage limit reached until \d{2}.\d{2}/);
    expect(managerFailureMessage('usage-limit', '', 'claude')).toBe('Usage limit reached. Try again once it resets.');
    expect(managerFailureMessage('network', '', 'codex')).toBe("Can't reach Codex's servers. Check this computer's internet connection.");
  });

  it('reads the cause from the reply only when the error is the bare exit line', () => {
    const exit = 'claude CLI exited with code 1';
    expect(failureCause(exit, 'Failed to authenticate: OAuth session expired')).toBe('Failed to authenticate: OAuth session expired');
    expect(failureCause(exit, 'Half done')).toBe(exit);
    expect(failureCause('Credit balance is too low', 'Failed to authenticate')).toBe('Credit balance is too low');
  });

  it('retries only what a retry can fix', () => {
    expect(retryPlan('network', false)).toBe('again');
    expect(retryPlan('busy', true)).toBe('again');
    expect(retryPlan('session', true)).toBe('fresh');
    expect(retryPlan('unknown', true)).toBe('fresh');
    for (const kind of ['auth', 'billing', 'usage-limit', 'missing-cli'] as const) expect(retryPlan(kind, true)).toBe('none');
  });
});
