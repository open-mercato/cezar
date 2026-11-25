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

describe('ClaudeSessionCost.result', () => {
  let config: string;
  beforeEach(() => {
    resetClaudeSessionCosts();
    config = mkdtempSync(join(tmpdir(), 'cez-claude-cost-'));
  });
  afterEach(() => rmSync(config, { recursive: true, force: true }));

  const frame = (total: number, inputTokens: number, costUSD = total) => ({
    type: 'result',
    total_cost_usd: total,
    modelUsage: { opus: { inputTokens, costUSD, contextWindow: 200000, maxOutputTokens: 64000 } },
  });

  it('turns modelUsage counters into increments and leaves the limits alone', () => {
    const cost = new ClaudeSessionCost('m1', false, '/w', config);
    expect(cost.result(frame(1, 100))).toEqual(frame(1, 100));
    expect(cost.result(frame(1.5, 160))).toEqual({
      type: 'result',
      total_cost_usd: 0.5,
      modelUsage: { opus: { inputTokens: 60, costUSD: 0.5, contextWindow: 200000, maxOutputTokens: 64000 } },
    });
  });

  it('reads the per-model baseline from the transcript’s cost-state', () => {
    const dir = join(config, 'projects', claudeProjectSlug('/w'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'm2.jsonl'), `${JSON.stringify({ type: 'cost-state', sessionId: 'm2', totalCostUSD: 4, modelUsage: { opus: { inputTokens: 400, costUSD: 4 } } })}\n`);
    const out = new ClaudeSessionCost('m2', true, '/w', config).result(frame(5, 450));
    expect(out.total_cost_usd).toBeCloseTo(1);
    expect(out.modelUsage.opus.inputTokens).toBe(50);
    expect(out.modelUsage.opus.costUSD).toBeCloseTo(1);
  });

  it('passes a frame with no total through untouched', () => {
    const msg = { type: 'result', modelUsage: { opus: { costUSD: 3 } } };
    expect(new ClaudeSessionCost('m3', true, '/w', config).result(msg)).toBe(msg);
  });
});
