import { describe, expect, it } from 'vitest';
import { chainChanged, chainOf, cutOffNote, earliestRelease, failoverReason, hasChain, holdFor, nextRow, pickRow, switchNoticeText, withRow, type ChainHold, type ChainRow } from './agent-chain.ts';

const now = Date.parse('2026-11-25T10:00:00Z');
const rows: ChainRow[] = [{ slot: 0, runner: 'claude' }, { slot: 1, runner: 'claude', agentProfile: 'personal' }, { slot: 2, runner: 'codex' }];
const hold = (until: number): ChainHold => ({ until: new Date(until).toISOString(), reason: 'usage-limit' });

describe('agent chain', () => {
  it('row #1 is the manager’s own agent; no backups is no chain', () => {
    const manager = { runner: 'claude', agentProfile: 'work', model: 'opus', effort: 'medium' as const };
    expect(hasChain({})).toBe(false);
    expect(hasChain({ backups: [] })).toBe(false);
    expect(chainOf({ ...manager, backups: [{ runner: 'codex' }] })).toEqual([
      { slot: 0, runner: 'claude', agentProfile: 'work', model: 'opus', effort: 'medium' },
      { slot: 1, runner: 'codex' },
    ]);
  });

  it('a row replaces all four agent fields, dropping #1’s model on a backup without one', () => {
    const manager = { id: 'm', runner: 'claude', model: 'opus', effort: 'high' as const };
    expect(withRow(manager, { slot: 1, runner: 'codex' })).toEqual({ id: 'm', runner: 'codex' });
  });

  it('fails over only for causes another account can get around', () => {
    expect(failoverReason('unknown', true)).toBe('usage-limit');
    expect(failoverReason('usage-limit', false)).toBe('usage-limit');
    expect(failoverReason('auth', false)).toBe('auth');
    expect(failoverReason('billing', false)).toBe('billing');
    expect(failoverReason('missing-cli', false)).toBe('missing-cli');
    for (const kind of ['busy', 'network', 'session', 'unknown'] as const) expect(failoverReason(kind, false)).toBeUndefined();
  });

  it('a limit holds until its reset; a login retries after 15 minutes, then an hour', () => {
    expect(holdFor('usage-limit', undefined, now, now + 5_000).until).toBe(new Date(now + 5_000).toISOString());
    expect(holdFor('usage-limit', undefined, now).until).toBe(new Date(now + 60 * 60_000).toISOString());
    const first = holdFor('auth', undefined, now);
    expect(first).toMatchObject({ streak: 1, until: new Date(now + 15 * 60_000).toISOString() });
    expect(holdFor('auth', first, now)).toMatchObject({ streak: 2, until: new Date(now + 60 * 60_000).toISOString() });
    expect(holdFor('auth', holdFor('auth', first, now), now).until).toBe(new Date(now + 60 * 60_000).toISOString());
  });

  it('starts from the preferred row, skipping held ones, and falls back to it when all are held', () => {
    const held = new Map<number, ChainHold>([[0, hold(now + 1)]]);
    expect(pickRow(rows, 0, (row) => held.get(row.slot)).row.slot).toBe(1);
    expect(pickRow(rows, 2, () => undefined).row.slot).toBe(2);
    const all = pickRow(rows, 0, () => hold(now + 1));
    expect(all.row.slot).toBe(0);
    expect(all.skipped).toHaveLength(3);
  });

  it('never retries a row the turn already tried', () => {
    expect(nextRow(rows, 0, new Set([0]), () => undefined)?.slot).toBe(1);
    expect(nextRow(rows, 1, new Set([0, 1]), () => undefined)?.slot).toBe(2);
    expect(nextRow(rows, 2, new Set([0, 1, 2]), () => undefined)).toBeUndefined();
  });

  it('every row out waits for the earliest reset', () => {
    expect(earliestRelease([hold(now + 9), undefined, hold(now + 3)])).toBe(now + 3);
    expect(earliestRelease([undefined])).toBeUndefined();
  });

  it('notes the commands a cut-off turn ran, and nothing when it ran none', () => {
    expect(cutOffNote('#1 claude · Work', [])).toBe('');
    expect(cutOffNote('#1 claude · Work', [{ summary: 'cez-manager task create', output: 'run 1a2b\nmore' }])).toContain('- cez-manager task create → run 1a2b');
  });

  it('a chain edit or a failback change counts as a change; a rename does not', () => {
    expect(chainChanged({ runner: 'claude' }, { runner: 'claude' })).toBe(false);
    expect(chainChanged({ runner: 'claude' }, { runner: 'claude', backups: [{ runner: 'codex' }] })).toBe(true);
    expect(chainChanged({ runner: 'claude' }, { runner: 'claude', failback: 'manual' })).toBe(true);
  });

  it('writes the notice line an older cockpit shows', () => {
    const from = { slot: 0, runner: 'claude', profileId: 'default', label: 'Automations' };
    const to = { slot: 1, runner: 'codex', profileId: 'work', label: 'Work', model: 'gpt-5.5' };
    expect(switchNoticeText(from, to, 'usage-limit', '2026-11-25T18:40:00.000Z', ['connectors']))
      .toBe('#1 claude · Automations is out of usage limits until 18:40 UTC. Continuing with #2 codex · Work (gpt-5.5). Connectors are off on codex.');
    expect(switchNoticeText(to, from, 'back')).toBe('Back on #1 claude · Automations.');
  });
});
