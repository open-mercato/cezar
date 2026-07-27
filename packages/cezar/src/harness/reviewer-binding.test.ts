import { describe, expect, it } from 'vitest';
import { reviewerFamily, synthesizeReviewerBinding } from './reviewer-binding.js';

/**
 * The port's central defect (2026-07-25): cezar ran council reviewers as full
 * agentic CLI sessions, where the om harness makes one schema-constrained API
 * call. Measured on one spec, one day, one model — `mimo-v2.5-free` answered as
 * an advisor in 62 seconds and never finished as a session across a 30-minute
 * and two 60-minute budgets.
 *
 * These pin the translation from a picker-chosen reviewer to the binding shape
 * `harness.mjs` reviews through.
 */

describe('synthesizeReviewerBinding', () => {
  it('routes an opencode gateway model to the Zen endpoint with auth-store credentials', () => {
    const binding = synthesizeReviewerBinding({
      runner: 'opencode',
      model: 'opencode/mimo-v2.5-free',
    });
    expect(binding).not.toBeNull();
    expect(binding!.entry).toMatchObject({
      adapter: 'preset',
      model: 'mimo-v2.5-free', // the BARE id — the gateway prefix is wire info
      endpoint: 'https://opencode.ai/zen/v1/chat/completions',
      authStoreProvider: 'opencode',
      roles: ['reviewer'],
    });
    // Never a credential value, only where to find one.
    expect(JSON.stringify(binding!.entry)).not.toMatch(/sk-|Bearer/);
  });

  it('routes a direct deepseek model to the deepseek endpoint', () => {
    const binding = synthesizeReviewerBinding({ runner: 'opencode', model: 'deepseek/deepseek-v4-pro' });
    expect(binding!.entry).toMatchObject({
      endpoint: 'https://api.deepseek.com/chat/completions',
      authStoreProvider: 'deepseek',
      model: 'deepseek-v4-pro',
      family: 'deepseek',
    });
  });

  it('gives codex its schema-constrained read-only CLI command', () => {
    const binding = synthesizeReviewerBinding({ runner: 'codex', model: 'gpt-5.6-sol' });
    const review = (binding!.entry.commands as { review: string[] }).review;
    expect(binding!.entry).toMatchObject({ adapter: 'command', family: 'openai' });
    expect(review).toContain('--output-schema');
    expect(review).toContain('read-only'); // a reviewer must not mutate the worktree
    expect(review).toContain('{schemaFile}');
  });

  it('returns null for claude — the host has no endpoint on a subscription login', () => {
    // Deliberate: the om contract has the wrapper supply a fresh Claude
    // context, and the Claude session path is the one that never failed.
    expect(synthesizeReviewerBinding({ runner: 'claude', model: 'opus' })).toBeNull();
  });

  it('returns null for a gateway it cannot reach, rather than inventing an endpoint', () => {
    expect(synthesizeReviewerBinding({ runner: 'opencode', model: 'mystery/some-model' })).toBeNull();
    expect(synthesizeReviewerBinding({ runner: 'opencode', model: 'no-slash' })).toBeNull();
  });

  it('carries the role’s effort dial through when set', () => {
    const binding = synthesizeReviewerBinding({
      runner: 'opencode',
      model: 'opencode/glm-5.2',
      effort: 'max',
    });
    expect(binding!.entry.reasoningEffort).toBe('max');
  });

  it('mints ids that are distinct, stable, and safe as JSON keys', () => {
    const a = synthesizeReviewerBinding({ runner: 'opencode', model: 'opencode/glm-5.2' })!;
    const b = synthesizeReviewerBinding({ runner: 'opencode', model: 'opencode/mimo-v2.5-free' })!;
    expect(a.id).not.toBe(b.id);
    expect(a.id).toBe(synthesizeReviewerBinding({ runner: 'opencode', model: 'opencode/glm-5.2' })!.id);
    for (const id of [a.id, b.id]) expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('reviewerFamily', () => {
  it('reads weight lineage, so two models behind one gateway stay independent', () => {
    // Both arrive via the Zen gateway but are unrelated models — collapsing
    // them into one "family" would wrongly fail the council's diversity rule.
    expect(reviewerFamily('glm-5.2', 'opencode')).toBe('zhipu');
    expect(reviewerFamily('mimo-v2.5-free', 'opencode')).toBe('xiaomi');
    expect(reviewerFamily('kimi-k2.6', 'opencode')).toBe('moonshot');
    expect(reviewerFamily('gpt-5.1', 'opencode')).toBe('openai');
  });

  it('falls back to the gateway for an unrecognised model instead of guessing', () => {
    expect(reviewerFamily('big-pickle', 'opencode')).toBe('opencode');
  });
});
