import { describe, expect, it } from 'vitest';
import { codexReasoningEffortOf, thinkingBudgetFor } from './reasoning-effort.js';

/**
 * Reasoning effort across backends (user feedback 2026-07-24): one neutral
 * four-tier scale on the seam, mapped to each backend's own dial — claude's
 * thinking-token budget and codex's reasoning-effort levels. The mapping is
 * pure so both runners share one tested source of truth.
 */
describe('reasoning effort mappings', () => {
  it('maps the neutral scale to claude thinking-token budgets', () => {
    expect(thinkingBudgetFor('low')).toBe(4096);
    expect(thinkingBudgetFor('medium')).toBe(16384);
    expect(thinkingBudgetFor('high')).toBe(32768);
    expect(thinkingBudgetFor('max')).toBe(63999);
    expect(thinkingBudgetFor(undefined)).toBeNull();
  });

  it('maps the neutral scale to codex reasoning-effort levels', () => {
    expect(codexReasoningEffortOf('low')).toBe('low');
    expect(codexReasoningEffortOf('medium')).toBe('medium');
    expect(codexReasoningEffortOf('high')).toBe('high');
    expect(codexReasoningEffortOf('max')).toBe('xhigh');
    expect(codexReasoningEffortOf(undefined)).toBeNull();
  });
});
