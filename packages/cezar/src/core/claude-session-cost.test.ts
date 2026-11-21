import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeSessionCost, claudeProjectSlug, resetClaudeSessionCosts, transcriptCostTotal } from './claude-session-cost.ts';

describe('ClaudeSessionCost', () => {
  let config: string;
  beforeEach(() => {
    resetClaudeSessionCosts();
    config = mkdtempSync(join(tmpdir(), 'cez-claude-cost-'));
  });
  afterEach(() => rmSync(config, { recursive: true, force: true }));

  const transcript = (cwd: string, id: string, lines: unknown[]) => {
    const dir = join(config, 'projects', claudeProjectSlug(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  };

  it('reports a new session’s totals as increments, turn by turn', () => {
    const cost = new ClaudeSessionCost('s1', false, '/w', config);
    expect(cost.increment(0.5)).toBeCloseTo(0.5);
    expect(cost.increment(0.8)).toBeCloseTo(0.3);
  });

  it('subtracts what the session cost before a resume, remembered in process', () => {
    new ClaudeSessionCost('s1', false, '/w', config).increment(50);
    const resumed = new ClaudeSessionCost('s1', true, '/w', config);
    expect(resumed.increment(58.36)).toBeCloseTo(8.36);
  });

  it('reads the baseline from the transcript’s last cost-state after a restart', () => {
    transcript('/w/x.y', 's2', [
      { type: 'cost-state', sessionId: 's2', totalCostUSD: 10 },
      { type: 'user', sessionId: 's2' },
      { type: 'cost-state', sessionId: 's2', totalCostUSD: 42.5 },
      { type: 'assistant', sessionId: 's2' },
    ]);
    expect(transcriptCostTotal('s2', '/w/x.y', config)).toBe(42.5);
    expect(new ClaudeSessionCost('s2', true, '/w/x.y', config).increment(43)).toBeCloseTo(0.5);
  });

  it('keeps the old behavior when the baseline is unknown', () => {
    expect(new ClaudeSessionCost('gone', true, '/w', config).increment(7)).toBe(7);
  });

  it('treats a total below the baseline as a fresh count', () => {
    new ClaudeSessionCost('s3', false, '/w', config).increment(5);
    expect(new ClaudeSessionCost('s3', true, '/w', config).increment(1)).toBe(1);
  });
});
