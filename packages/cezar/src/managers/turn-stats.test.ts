import { describe, expect, it } from 'vitest';
import { managerToolKind, TurnStatsCollector } from './turn-stats.ts';

const bash = (command: string) => managerToolKind('Bash', { command });

describe('managerToolKind', () => {
  it('routes work through task, merge and proposal commands', () => {
    expect(bash('cez-manager task create --project cezar --title "x" --file files/a.md')).toBe('route');
    expect(bash('cez-manager task say --project cezar abc "go"')).toBe('route');
    expect(bash('cez-manager merge --project cezar 12')).toBe('route');
    expect(bash('cez-manager propose-action --connector c --tool t --args {}')).toBe('route');
    expect(bash('cez-manager memory set full-prs --kind feedback "x"')).toBe('route');
  });

  it('reads the subcommand past flags, and automation reads as looking', () => {
    expect(bash('cez-manager automation --project cezar list')).toBe('look');
    expect(bash('cez-manager automation --project cezar show a1')).toBe('look');
    expect(bash('cez-manager automation --project cezar create --file def.json')).toBe('route');
    expect(bash('cez-manager automation --project cezar enable a1')).toBe('route');
    expect(bash('cez-manager task --project cezar create "x"')).toBe('route');
    expect(bash('cez-manager --help')).toBe('look');
  });

  it('finds the subcommand behind any flag, even one whose value the CLI may add later', () => {
    expect(bash('cez-manager task --project cezar --some-new-flag value create "x"')).toBe('route');
    expect(bash('cez-manager --project cezar task say abc "go"')).toBe('route');
    expect(bash('cez-manager task --project alpha abc123')).toBe('look');
    expect(bash('cez-manager memory --kind feedback set full-prs "x"')).toBe('route');
    expect(bash('cez-manager automation --project cezar --json list')).toBe('look');
    expect(bash('cez-manager')).toBe('look');
  });

  it('counts reads of cezar state as looking', () => {
    expect(bash('cez-manager attention')).toBe('look');
    expect(bash('cez-manager task abc123 --project cezar')).toBe('look');
    expect(bash('cez-manager history --since 2h')).toBe('look');
    expect(bash('cez-manager memory list')).toBe('look');
  });

  it('counts everything else as its own work, and files as writing', () => {
    expect(bash('gh pr view 12 --json title')).toBe('own');
    expect(managerToolKind('Grep', { pattern: 'x' })).toBe('own');
    expect(managerToolKind('Write', { file_path: 'files/a.md' })).toBe('write');
  });
});

describe('TurnStatsCollector', () => {
  it('counts one request per context reading and keeps the first, peak and last', () => {
    const stats = new TurnStatsCollector();
    for (const contextTokens of [30_000, 41_000, 39_000]) stats.event({ type: 'usage-status', status: { contextTokens } });
    stats.event({ type: 'usage-status', status: { contextWindow: 1_000_000 } });
    stats.event({ type: 'tool-call', id: '1', tool: 'Bash', input: { command: 'cez-manager status' } });
    stats.event({ type: 'tool-result', toolCallId: '1', result: 'x'.repeat(120), isError: false });
    stats.event({ type: 'usage-status', status: { turnTokens: { cacheReadTokens: 70_000, cacheWriteTokens: 9_000, outputTokens: 800 } } });
    expect(stats.context).toBe(39_000);
    expect(stats.stats({ fresh: true, sessionTurn: 1 })).toEqual({
      requests: 3, contextFirst: 30_000, contextPeak: 41_000, toolResultChars: 120,
      tools: { route: 0, look: 1, own: 0, write: 0 }, fresh: true, sessionTurn: 1,
      cacheReadTokens: 70_000, cacheWriteTokens: 9_000, outputTokens: 800,
    });
  });

  it('marks a turn cold when its first request re-wrote most of the context', () => {
    const cold = new TurnStatsCollector();
    cold.event({ type: 'usage-status', status: { contextTokens: 942_220, cacheWriteTokens: 942_218 } });
    cold.event({ type: 'usage-status', status: { contextTokens: 945_000, cacheWriteTokens: 2_000 } });
    expect(cold.stats({ fresh: false, sessionTurn: 118, session: '2fd8a2fe' })).toMatchObject({ cold: true, session: '2fd8a2fe' });
    const warm = new TurnStatsCollector();
    warm.event({ type: 'usage-status', status: { contextTokens: 900_000, cacheWriteTokens: 8_000 } });
    expect(warm.stats({ fresh: false, sessionTurn: 2 }).cold).toBe(false);
  });
});
