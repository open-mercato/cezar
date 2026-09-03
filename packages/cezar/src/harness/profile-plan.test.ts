import { describe, expect, it } from 'vitest';
import { resolveHarnessPlan } from './profile-plan.js';

const config = {
  models: {
    codex: {
      family: 'openai',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
      commands: { worker: ['codex', 'exec'], review: ['codex', 'exec'] },
    },
    deepseek: { family: 'deepseek', adapter: 'preset' },
  },
  profiles: {
    optimized: { workers: ['codex'], reviewers: [], reviewPolicy: { mode: 'advisory' } },
    multi: { workers: [], reviewers: ['codex', 'deepseek'], reviewPolicy: { mode: 'all-required' } },
    'multi-optimized': {
      workers: ['codex'],
      reviewers: ['codex', 'deepseek'],
      reviewPolicy: { mode: 'all-required' },
    },
    'high-assurance': {
      workers: ['codex'],
      reviewers: ['codex', 'deepseek'],
      reviewPolicy: { mode: 'all-required' },
    },
  },
};

describe('resolveHarnessPlan', () => {
  it('resolves standard without configuration', () => {
    const result = resolveHarnessPlan('standard', undefined);
    expect(result).toMatchObject({
      ok: true,
      plan: { implementer: { runner: 'claude' }, reviewers: [], packetized: false },
    });
  });

  it.each([
    ['optimized', 0, false],
    ['multi', 2, false],
    ['multi-optimized', 2, false],
    ['high-assurance', 2, true],
  ] as const)('resolves %s as a driven plan', (profile, reviewers, packetized) => {
    const result = resolveHarnessPlan(profile, config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.reviewers).toHaveLength(reviewers);
    expect(result.plan.packetized).toBe(packetized);
    if (profile.includes('optimized') || profile === 'high-assurance') {
      expect(result.plan.implementer).toMatchObject({
        runner: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'max',
      });
    }
  });

  it('fails loudly when a selected profile or binding is missing', () => {
    expect(resolveHarnessPlan('multi', undefined)).toMatchObject({ ok: false });
    expect(
      resolveHarnessPlan('multi', {
        profiles: { multi: { reviewers: ['missing'] } },
        models: {},
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('missing reviewer') });
  });

  it('preserves an explicitly configured resilient quorum policy', () => {
    const result = resolveHarnessPlan('multi', {
      ...config,
      profiles: {
        ...config.profiles,
        multi: {
          ...config.profiles.multi,
          reviewPolicy: { mode: 'quorum' },
        },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      plan: { reviewPolicy: 'quorum' },
    });
  });
});
