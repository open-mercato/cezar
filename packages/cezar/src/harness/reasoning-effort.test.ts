import { describe, expect, it } from 'vitest';
import { codexReasoningEffortOf, thinkingBudgetFor } from './reasoning-effort.js';

describe('harness reasoning effort mappings', () => {
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
