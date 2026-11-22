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
    expect(stats.context).toBe(39_000);
    expect(stats.stats({ fresh: true, sessionTurn: 1 })).toEqual({
      requests: 3, contextFirst: 30_000, contextPeak: 41_000, toolResultChars: 120,
      tools: { route: 0, look: 1, own: 0, write: 0 }, fresh: true, sessionTurn: 1,
    });
  });
});
