import { beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isUsageExhaustion } from '../core/usage-limit.ts';
import {
  eligibleFallbackCandidates,
  fallbackConsentCurrent,
  getAgentFallbackPolicy,
  getAgentFallbackPolicySync,
  putAgentFallbackPolicy,
  type AgentFallbackPolicy,
} from './agent-fallback.ts';
import type { AgentAccountStore } from './agent-accounts.ts';

let home: string;
let repo: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cez-fallback-'));
  process.env.CEZ_HOME = home;
  repo = mkdtempSync(join(tmpdir(), 'cez-fallback-repo-'));
});

const enable = (candidates: AgentFallbackPolicy['candidates']) =>
  putAgentFallbackPolicy(repo, { expectedRevision: 0, expectedIncarnation: null, enabled: true, candidates });

async function saved(candidates: AgentFallbackPolicy['candidates']): Promise<AgentFallbackPolicy> {
  const result = await enable(candidates);
  if ('conflict' in result) throw new Error('unexpected conflict');
  return result;
}

const accounts = (rows: Array<{ id: string; provider: string }>): AgentAccountStore =>
  ({ accounts: rows.map((row) => ({ ...row, configDir: `/x/${row.id}`, label: row.id, addedAt: '2026-10-21T00:00:00Z' })) } as unknown as AgentAccountStore);

describe('agent fallback policy store', () => {
  it('starts disabled and persists an ordered project policy with 0600 permissions', async () => {
    expect(await getAgentFallbackPolicy(repo)).toEqual({ enabled: false, candidates: [], revision: 0, incarnation: null, revocation: null });
    const policy = await saved([{ provider: 'codex', profileId: 'default' }, { provider: 'claude', profileId: 'backup', model: 'opus' }]);
    expect(policy.candidates).toEqual([{ provider: 'codex', profileId: 'default' }, { provider: 'claude', profileId: 'backup', model: 'opus' }]);
    expect(await getAgentFallbackPolicy(repo)).toEqual(policy);
    expect(statSync(join(home, 'agent-fallback.json')).mode & 0o777).toBe(0o600);
  });

  it('serializes concurrent saves so only one writer can consume a revision', async () => {
    const results = await Promise.all([
      enable([{ provider: 'codex', profileId: 'default' }]),
      enable([{ provider: 'claude', profileId: 'default' }]),
    ]);
    expect(results.filter((result) => 'conflict' in result)).toHaveLength(1);
    expect((await getAgentFallbackPolicy(repo)).revision).toBe(1);
  });

  it('rejects a stale revision as a conflict', async () => {
    await saved([{ provider: 'codex', profileId: 'default' }]);
    expect(await enable([{ provider: 'opencode', profileId: 'default' }])).toEqual({ conflict: true });
  });

  it('rejects duplicate entries and enabling an empty list', async () => {
    await expect(enable([{ provider: 'codex', profileId: 'default' }, { provider: 'codex', profileId: 'default' }])).rejects.toThrow('duplicate');
    await expect(enable([])).rejects.toThrow('at least one');
  });

  it('rotates revocation on disable and incarnation on re-enable, so old snapshots lose consent', async () => {
    const first = await saved([{ provider: 'codex', profileId: 'default' }]);
    const off = await putAgentFallbackPolicy(repo, { expectedRevision: first.revision, expectedIncarnation: first.incarnation, enabled: false, candidates: first.candidates });
    if ('conflict' in off) throw new Error('conflict');
    expect(fallbackConsentCurrent(first, off)).toBe(false);
    const on = await putAgentFallbackPolicy(repo, { expectedRevision: off.revision, expectedIncarnation: off.incarnation, enabled: true, candidates: first.candidates });
    if ('conflict' in on) throw new Error('conflict');
    expect(on.incarnation).not.toBe(first.incarnation);
    expect(fallbackConsentCurrent(first, on)).toBe(false);
    expect(fallbackConsentCurrent(on, on)).toBe(true);
  });

  it('keeps consent across a reorder while enabled', async () => {
    const first = await saved([{ provider: 'codex', profileId: 'default' }, { provider: 'opencode', profileId: 'default' }]);
    const reordered = await putAgentFallbackPolicy(repo, { expectedRevision: first.revision, expectedIncarnation: first.incarnation, enabled: true, candidates: [...first.candidates].reverse() });
    if ('conflict' in reordered) throw new Error('conflict');
    expect(fallbackConsentCurrent(first, reordered)).toBe(true);
  });

  it('salvages valid projects next to a malformed one and never sends unknown fields', async () => {
    writeFileSync(join(home, 'agent-fallback.json'), JSON.stringify({
      version: 1,
      future: 'kept',
      projects: {
        [repo]: { enabled: true, candidates: [{ provider: 'codex', profileId: 'default', extra: 1 }], revision: 3, incarnation: 'i', revocation: null, extra: true },
        '/broken': 'not an object',
      },
    }));
    expect(await getAgentFallbackPolicy(repo)).toEqual({ enabled: true, candidates: [{ provider: 'codex', profileId: 'default' }], revision: 3, incarnation: 'i', revocation: null });
    const next = await putAgentFallbackPolicy(repo, { expectedRevision: 3, expectedIncarnation: 'i', enabled: true, candidates: [{ provider: 'opencode', profileId: 'default' }] });
    expect('conflict' in next).toBe(false);
    expect(JSON.parse(readFileSync(join(home, 'agent-fallback.json'), 'utf8')).future).toBe('kept');
  });

  it('preserves future project and candidate fields through unrelated saves and candidate reorder/model reset', async () => {
    const policy = { enabled: true, revision: 1, incarnation: 'i', revocation: null,
      futurePolicy: { mode: 'new-version' }, candidates: [
        { provider: 'codex', profileId: 'work', model: 'old-model', futureCandidate: { budget: 42 } },
        { provider: 'claude', profileId: 'default', futureCandidate: 'second' },
      ] };
    writeFileSync(join(home, 'agent-fallback.json'), JSON.stringify({ version: 1, projects: { [repo]: policy, '/other': policy } }));
    const before = await getAgentFallbackPolicy(repo);
    expect(before).not.toHaveProperty('futurePolicy');
    expect(before.candidates[0]).not.toHaveProperty('futureCandidate');
    const result = await putAgentFallbackPolicy(repo, { expectedRevision: 1, expectedIncarnation: 'i', enabled: false,
      candidates: [{ provider: 'claude', profileId: 'default' }, { provider: 'codex', profileId: 'work' }] });
    expect(result).not.toHaveProperty('futurePolicy');
    const disk = JSON.parse(readFileSync(join(home, 'agent-fallback.json'), 'utf8'));
    expect(disk.projects['/other']).toEqual(policy);
    expect(disk.projects[repo].futurePolicy).toEqual(policy.futurePolicy);
    expect(disk.projects[repo].candidates).toEqual([
      { provider: 'claude', profileId: 'default', futureCandidate: 'second' },
      { provider: 'codex', profileId: 'work', futureCandidate: { budget: 42 } },
    ]);
  });

  it.skipIf(process.platform === 'win32')('uses one policy identity for a project and its symlink', async () => {
    const alias = join(home, 'project-alias');
    symlinkSync(repo, alias, 'dir');
    const first = await saved([{ provider: 'codex', profileId: 'default' }]);
    expect(getAgentFallbackPolicySync(alias)).toEqual(first);
    const changed = await putAgentFallbackPolicy(alias, { expectedRevision: first.revision, expectedIncarnation: first.incarnation, enabled: false, candidates: first.candidates });
    expect(await getAgentFallbackPolicy(repo)).toEqual(changed);
    const disk = JSON.parse(readFileSync(join(home, 'agent-fallback.json'), 'utf8'));
    expect(Object.keys(disk.projects)).toEqual([repo]);
  });

  it('pins the transaction home before awaiting the writer lock', async () => {
    const originalHome = home;
    const other = mkdtempSync(join(tmpdir(), 'cez-fallback-other-home-'));
    const writing = saved([{ provider: 'codex', profileId: 'default' }]);
    process.env.CEZ_HOME = other;
    await writing;
    expect(existsSync(join(originalHome, 'agent-fallback.json'))).toBe(true);
    expect(existsSync(join(other, 'agent-fallback.json'))).toBe(false);
  });

  it('reclaims a lock left by a dead process and an owner-less orphan, but not a live one', async () => {
    const lock = join(home, 'agent-fallback.json.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner'), '999999999:1');
    await saved([{ provider: 'codex', profileId: 'default' }]);
    expect(existsSync(lock)).toBe(false);

    mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const current = await getAgentFallbackPolicy(repo);
    const second = await putAgentFallbackPolicy(repo, { expectedRevision: current.revision, expectedIncarnation: current.incarnation, enabled: false, candidates: current.candidates });
    expect('conflict' in second).toBe(false);

    mkdirSync(lock);
    writeFileSync(join(lock, 'owner'), `${process.pid}:`);
    const now = await getAgentFallbackPolicy(repo);
    await expect(putAgentFallbackPolicy(repo, { expectedRevision: now.revision, expectedIncarnation: now.incarnation, enabled: false, candidates: [] }))
      .rejects.toThrow('another cezar process');
  });
});

describe('fallback candidate eligibility', () => {
  const policy: AgentFallbackPolicy = {
    enabled: true, revision: 1, incarnation: 'i', revocation: null,
    candidates: [
      { provider: 'claude', profileId: 'default' },
      { provider: 'codex', profileId: 'work' },
      { provider: 'codex', profileId: 'personal' },
      { provider: 'opencode', profileId: 'default' },
    ],
  };
  const store = accounts([{ id: 'work', provider: 'codex' }, { id: 'personal', provider: 'codex' }]);

  it('never returns the starting agent or one already tried — Claude → Codex → (Codex limit) never goes back to Claude', () => {
    const { eligible } = eligibleFallbackCandidates(policy, new Set(['claude:default', 'codex:work']), new Set(), store);
    expect(eligible.map((c) => `${c.provider}:${c.profileId}`)).toEqual(['codex:personal', 'opencode:default']);
  });

  it('treats another account of the same provider as a distinct candidate', () => {
    const { eligible } = eligibleFallbackCandidates(policy, new Set(['codex:work']), new Set(), store);
    expect(eligible.map((c) => `${c.provider}:${c.profileId}`)).toContain('codex:personal');
  });

  it('skips accounts on hold and accounts that no longer exist, with a reason, and fails closed on unreadable accounts', () => {
    const { eligible, skipped } = eligibleFallbackCandidates(policy, new Set(['claude:default']), new Set(['codex:work']), accounts([{ id: 'work', provider: 'codex' }]));
    expect(eligible.map((c) => `${c.provider}:${c.profileId}`)).toEqual(['opencode:default']);
    expect(skipped.map((s) => s.reason)).toEqual(['waiting out its own usage limit', 'account no longer exists']);
    expect(eligibleFallbackCandidates(policy, new Set(), new Set(), null).eligible.every((c) => c.profileId === 'default')).toBe(true);
  });

  it('offers nothing when the policy is disabled', () => {
    expect(eligibleFallbackCandidates({ ...policy, enabled: false }, new Set(), new Set(), store).eligible).toEqual([]);
  });
});

describe('usage exhaustion classifier', () => {
  it('switches on a proven exhausted allowance', () => {
    expect(isUsageExhaustion('Claude AI usage limit reached|1760000000')).toBe(true);
    expect(isUsageExhaustion("You've hit your usage limit. Upgrade to Pro or try again in 2 hours.")).toBe(true);
    expect(isUsageExhaustion('5-hour limit reached ∙ resets 3pm')).toBe(true);
    expect(isUsageExhaustion('insufficient_quota: You exceeded your current quota')).toBe(true);
    expect(isUsageExhaustion("You've hit your session limit · resets 3:10pm (UTC)")).toBe(true);
    expect(isUsageExhaustion("You've hit your limit · resets 3pm (Europe/Warsaw)")).toBe(true);
    expect(isUsageExhaustion("You've hit your weekly limit · resets Oct 24, 9am (Europe/Warsaw)")).toBe(true);
    expect(isUsageExhaustion("Error code: 429 - {'message': 'You exceeded your current quota', 'type': 'insufficient_quota'}")).toBe(true);
  });

  it('never switches on a transient throttle or an unrelated rate limit', () => {
    expect(isUsageExhaustion('rate_limit_error: Number of request tokens has exceeded your per-minute rate limit')).toBe(false);
    expect(isUsageExhaustion('429 Too Many Requests')).toBe(false);
    expect(isUsageExhaustion('gh: API rate limit exceeded for user')).toBe(false);
    expect(isUsageExhaustion('session limit of 200 turns reached')).toBe(false);
    expect(isUsageExhaustion(undefined)).toBe(false);
  });
});
