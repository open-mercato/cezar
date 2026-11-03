import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentUsageHolds } from './agent-usage-holds.ts';

describe('durable account usage holds', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-holds-'));
    vi.stubEnv('CEZ_HOME', home);
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
  const hold = (account: string, minutes: number) => ({ account, until: new Date(Date.now() + minutes * 60000).toISOString() });

  it('reads without creating state when no fallback has exhausted an account', () => {
    expect(new AgentUsageHolds().active()).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  it('merges independent writers and keeps the later hold when an earlier one expires', () => {
    const one = new AgentUsageHolds();
    const two = new AgentUsageHolds();
    const first = hold('claude:default', 5);
    const later = hold('claude:default', 60);
    const other = hold('codex:work', 60);
    expect(two.active()).toEqual([]);
    one.remember(later);
    two.remember(first);
    two.remember(other);
    const restarted = new AgentUsageHolds();
    expect(restarted.active()).toEqual(expect.arrayContaining([first, later, other]));
    expect(restarted.active(Date.parse(first.until) + 1)).toEqual(expect.arrayContaining([later, other]));
    expect(restarted.active(Date.parse(later.until) + 1000)).toEqual([]);
    expect(new AgentUsageHolds().active()).toEqual([]);
  });

  it('salvages valid holds and ignores malformed records and temporary files', () => {
    const valid = hold('claude:work', 60);
    new AgentUsageHolds().remember(valid);
    writeFileSync(join(home, 'agent-usage-holds', '0'.repeat(64) + '.json'), '{broken');
    writeFileSync(join(home, 'agent-usage-holds', 'pending.tmp'), '{}');
    expect(new AgentUsageHolds().active()).toEqual([valid]);
  });

  it('pins the original home and degrades to memory if persistence is unavailable', () => {
    writeFileSync(join(home, 'agent-usage-holds'), 'not a directory');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = new AgentUsageHolds();
      vi.stubEnv('CEZ_HOME', join(home, 'different-home'));
      const first = hold('claude:default', 5);
      store.remember(first);
      store.remember(hold('codex:default', 5));
      expect(store.active()).toContainEqual(first);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(readdirSync(home)).toEqual(['agent-usage-holds']);
    } finally { warn.mockRestore(); }
  });
});
