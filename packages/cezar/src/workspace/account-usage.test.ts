import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pickAccountUsageWindows, snapshotToRunLiveUsage, usageEntryForProfile } from './account-usage.ts';
import { defaultAgentProfile, resolveStoredProfile } from './agent-profiles.ts';
import type { UsageWindowsSnapshot } from '@open-mercato/cezar-contract';

const NOW = 1_700_000_000_000;
const home = mkdtempSync(join(tmpdir(), 'cez-account-usage-'));

beforeEach(() => {
  process.env.CEZ_HOME = home;
});

afterEach(() => {
  writeFileSync(join(home, 'usage-windows.json'), '[]');
});

const claudeWindow = (id: string, usedPercent: number | null, resetsAt: number, observedAt = NOW) => ({
  id,
  kind: id === 'five_hour' ? 'five-hour' as const : 'weekly' as const,
  applicability: 'all' as const,
  models: [],
  resetsAt,
  durationMinutes: id === 'five_hour' ? 300 : 10080,
  usedPercent,
  status: 'allowed' as const,
  observedAt,
});

describe('pickAccountUsageWindows', () => {
  it('keeps claude five_hour and seven_day in order and drops expired windows', () => {
    const snapshot: UsageWindowsSnapshot = {
      provider: 'claude',
      source: 'claude-stream',
      observedAt: NOW,
      binding: { provider: 'claude', accountId: 'work', profilePath: '/work' },
      windows: [
        claudeWindow('five_hour', 31, NOW + 3 * 3_600_000),
        claudeWindow('seven_day', 72, NOW + 3 * 86_400_000),
        claudeWindow('five_hour', 10, NOW - 1000),
      ],
    };
    expect(pickAccountUsageWindows(snapshot, NOW).map((w) => w.id)).toEqual(['five_hour', 'seven_day']);
  });

  it('skips windows where usedPercent is null', () => {
    const snapshot: UsageWindowsSnapshot = {
      provider: 'claude',
      source: 'claude-stream',
      observedAt: NOW,
      binding: { provider: 'claude', accountId: 'work', profilePath: '/work' },
      windows: [
        claudeWindow('five_hour', null, NOW + 3 * 3_600_000),
      ],
    };
    expect(pickAccountUsageWindows(snapshot, NOW)).toEqual([]);
    expect(snapshotToRunLiveUsage(snapshot, NOW)).toBeNull();
  });

  it('maps codex primary/secondary to plan windows', () => {
    const snapshot: UsageWindowsSnapshot = {
      provider: 'codex',
      source: 'codex-read',
      observedAt: NOW,
      binding: { provider: 'codex', accountId: 'default', profilePath: '/codex' },
      windows: [
        { id: 'codex:primary', kind: 'primary', applicability: 'all', models: [], resetsAt: NOW + 3_600_000, durationMinutes: 300, usedPercent: 40, status: 'allowed', observedAt: NOW },
        { id: 'codex:secondary', kind: 'secondary', applicability: 'all', models: [], resetsAt: NOW + 7 * 86_400_000, durationMinutes: 10080, usedPercent: 60, status: 'allowed', observedAt: NOW },
      ],
    };
    expect(snapshotToRunLiveUsage(snapshot, NOW)?.limits?.map((l) => l.window)).toEqual(['five_hour', 'seven_day']);
    expect(snapshotToRunLiveUsage(snapshot, NOW)?.limits?.[0]?.utilization).toBe(0.4);
  });

  it('matches codex windows by durationMinutes rather than kind (7-day primary gets seven_day)', () => {
    const snapshot: UsageWindowsSnapshot = {
      provider: 'codex',
      source: 'codex-read',
      observedAt: NOW,
      binding: { provider: 'codex', accountId: 'default', profilePath: '/codex' },
      windows: [
        { id: 'codex:primary', kind: 'primary', applicability: 'all', models: [], resetsAt: NOW + 7 * 86_400_000, durationMinutes: 10080, usedPercent: 40, status: 'allowed', observedAt: NOW },
      ],
    };
    expect(pickAccountUsageWindows(snapshot, NOW).map((w) => w.id)).toEqual(['codex:primary']);
    expect(snapshotToRunLiveUsage(snapshot, NOW)?.limits?.[0]?.window).toBe('seven_day');
  });

  it('prefers Claude terminal-limit blocked state over an older five_hour reading', () => {
    const snapshot: UsageWindowsSnapshot = {
      provider: 'claude',
      source: 'claude-stream',
      observedAt: NOW + 10_000,
      binding: { provider: 'claude', accountId: 'work', profilePath: '/work' },
      windows: [
        claudeWindow('five_hour', 20, NOW + 3 * 3_600_000, NOW - 60_000),
        {
          id: 'terminal-limit',
          kind: 'other',
          applicability: 'all',
          models: [],
          resetsAt: NOW + 2 * 3_600_000,
          durationMinutes: null,
          usedPercent: 100,
          status: 'blocked',
          observedAt: NOW,
        },
      ],
    };
    const picked = pickAccountUsageWindows(snapshot, NOW);
    expect(picked).toHaveLength(1);
    expect(picked[0]?.id).toBe('terminal-limit');
    expect(picked[0]?.status).toBe('blocked');
    const usage = snapshotToRunLiveUsage(snapshot, NOW);
    expect(usage?.limits?.[0]?.window).toBe('five_hour');
    expect(usage?.limits?.[0]?.utilization).toBe(1);
  });

  it('calculates live usage timestamp from the window observedAt, not the snapshot observedAt', () => {
    const windowObservedAt = NOW - 120_000;
    const snapshotObservedAt = NOW;
    const snapshot: UsageWindowsSnapshot = {
      provider: 'claude',
      source: 'claude-stream',
      observedAt: snapshotObservedAt,
      binding: { provider: 'claude', accountId: 'work', profilePath: '/work' },
      windows: [
        claudeWindow('five_hour', 50, NOW + 3_600_000, windowObservedAt),
      ],
    };
    const usage = snapshotToRunLiveUsage(snapshot, NOW);
    expect(usage?.at).toBe(new Date(windowObservedAt).toISOString());
  });
});

describe('usageEntryForProfile', () => {
  it('picks the newest snapshot per account path and ignores stale identities', () => {
    const path = join(home, 'personal');
    const profile = resolveStoredProfile({ id: 'personal', provider: 'claude', label: 'PRV', configDir: path, addedAt: '' });
    const snapshots: UsageWindowsSnapshot[] = [
      {
        provider: 'claude',
        source: 'claude-stream',
        observedAt: NOW - 60_000,
        binding: { provider: 'claude', accountId: 'personal', profilePath: path },
        windows: [claudeWindow('five_hour', 10, NOW + 3_600_000, NOW - 60_000)],
      },
      {
        provider: 'claude',
        source: 'claude-stream',
        observedAt: NOW,
        binding: { provider: 'claude', accountId: 'personal', profilePath: path, identity: 'a'.repeat(64) },
        windows: [claudeWindow('five_hour', 55, NOW + 2 * 3_600_000, NOW)],
      },
    ];
    const entry = usageEntryForProfile(profile, snapshots, NOW);
    expect(entry?.usage.limits?.[0]?.utilization).toBe(0.55);
    expect(entry?.label).toBe('PRV');
  });

  it('matches profile when profile.path is a symlink to stored binding path', () => {
    const realDir = mkdtempSync(join(home, 'real-account-'));
    const symlinkDir = join(home, 'symlink-account');
    symlinkSync(realDir, symlinkDir);

    const profile = resolveStoredProfile({ id: 'pers', provider: 'claude', label: 'PERS', configDir: symlinkDir, addedAt: '' });
    const snapshots: UsageWindowsSnapshot[] = [
      {
        provider: 'claude',
        source: 'claude-stream',
        observedAt: NOW,
        binding: { provider: 'claude', accountId: 'pers', profilePath: realDir },
        windows: [claudeWindow('five_hour', 65, NOW + 3_600_000, NOW)],
      },
    ];
    const entry = usageEntryForProfile(profile, snapshots, NOW);
    expect(entry).not.toBeNull();
    expect(entry?.usage.limits?.[0]?.utilization).toBe(0.65);
  });

  it('returns null when every window has reset', () => {
    const profile = defaultAgentProfile('claude');
    const snapshot: UsageWindowsSnapshot = {
      provider: 'claude',
      source: 'claude-stream',
      observedAt: NOW,
      binding: { provider: 'claude', accountId: 'default', profilePath: profile.path },
      windows: [claudeWindow('five_hour', 90, NOW - 1)],
    };
    expect(usageEntryForProfile(profile, [snapshot], NOW)).toBeNull();
  });
});
