import { describe, expect, it } from 'vitest';

import { councilFamilyOf } from './driver.js';
import { providerFamilyOf } from '@open-mercato/cezar-contract';
import { reviewerFamily } from './reviewer-binding.js';

/**
 * Review finding (2026-07-27): three functions answered "which provider family
 * is this?" three different ways, and the admission check and the quorum check
 * used different ones. The council's entire premise is independent
 * cross-checking, so the two layers disagreeing about what "independent" means
 * is the failure, not a nuance.
 */
describe('providerFamilyOf', () => {
  it('collapses one vendor reached through different runners into one family', () => {
    expect(providerFamilyOf({ runner: 'claude', model: 'sonnet-4.5' })).toBe('anthropic');
    expect(providerFamilyOf({ runner: 'opencode', model: 'opencode/claude-sonnet-4-5' })).toBe(
      'anthropic',
    );
    expect(providerFamilyOf({ runner: 'codex', model: 'gpt-5.6-sol' })).toBe('openai');
    expect(providerFamilyOf({ runner: 'opencode', model: 'opencode/gpt-5.6-luna' })).toBe('openai');
  });

  it('keeps genuinely different weights behind one gateway apart', () => {
    const behindZen = ['opencode/mimo-v2.5-free', 'opencode/glm-4.7', 'opencode/kimi-k2'];
    const families = behindZen.map((model) => providerFamilyOf({ runner: 'opencode', model }));
    expect(families).toEqual(['xiaomi', 'zhipu', 'moonshot']);
    expect(new Set(families).size).toBe(3);
  });

  it('trusts a non-gateway prefix as the provider', () => {
    expect(providerFamilyOf({ runner: 'opencode', model: 'anthropic/claude-sonnet-5' })).toBe(
      'anthropic',
    );
    expect(providerFamilyOf({ runner: 'opencode', model: 'deepseek/deepseek-v4' })).toBe('deepseek');
  });

  // a gateway-nested vendor and a vendor slug read as their own families.
  it('reads the vendor nested behind a gateway prefix', () => {
    expect(
      providerFamilyOf({ runner: 'opencode', model: 'openrouter/anthropic/claude-sonnet-5' }),
    ).toBe('anthropic');
    expect(
      councilFamilyOf({ runner: 'opencode', model: 'openrouter/anthropic/claude-sonnet-5' }),
    ).toBe(councilFamilyOf({ runner: 'claude', model: 'sonnet' }));
    expect(providerFamilyOf({ runner: 'opencode', model: 'openrouter/meta-llama/llama-4' })).toBe(
      'meta',
    );
    expect(providerFamilyOf({ runner: 'opencode', model: 'openrouter/acme/new-model' })).toBe(
      'acme',
    );
    expect(reviewerFamily('openrouter/anthropic/claude-sonnet-5', 'opencode')).toBe('anthropic');
  });

  it('normalises a vendor slug to the family its model name resolves to', () => {
    expect(providerFamilyOf({ runner: 'opencode', model: 'moonshotai/kimi-k2' })).toBe(
      providerFamilyOf({ runner: 'opencode', model: 'opencode/kimi-k2' }),
    );
    expect(providerFamilyOf({ runner: 'opencode', model: 'moonshotai/brand-new' })).toBe(
      'moonshot',
    );
    expect(providerFamilyOf({ runner: 'opencode', model: 'z-ai/glm-4.7' })).toBe('zhipu');
    expect(providerFamilyOf({ runner: 'opencode', model: 'x-ai/grok-5' })).toBe('xai');
  });

  it('lets a configured advisor declare its own family', () => {
    expect(providerFamilyOf({ runner: 'harness', model: 'kimi-subscription', family: 'moonshot' })).toBe(
      'moonshot',
    );
  });

  it('gives an unrecognised model its own family rather than merging it', () => {
    expect(providerFamilyOf({ runner: 'opencode', model: 'opencode/brand-new-thing' })).toBe(
      'opencode',
    );
    expect(providerFamilyOf({ runner: 'opencode', model: '' })).toBe('opencode');
  });

  it('is what the council quorum counts', () => {
    expect(councilFamilyOf({ runner: 'claude', model: 'sonnet-4.5' })).toBe('anthropic');
    expect(councilFamilyOf({ runner: 'opencode', model: 'opencode/claude-sonnet-4-5' })).toBe(
      'anthropic',
    );
    expect(
      new Set(
        [
          { runner: 'claude' as const, model: 'sonnet-4.5' },
          { runner: 'opencode' as const, model: 'opencode/claude-sonnet-4-5' },
        ].map(councilFamilyOf),
      ).size,
    ).toBe(1);
  });

  it('is what binding synthesis records', () => {
    expect(reviewerFamily('claude-sonnet-4-5', 'opencode')).toBe('anthropic');
    expect(reviewerFamily('mimo-v2.5-free', 'opencode')).toBe('xiaomi');
  });
});
