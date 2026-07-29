import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { councilFamilyOf } from './driver.js';
import { providerFamilyOf } from './model-family.js';
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

describe('the web mirror stays in step', () => {
  const mirror = readFileSync(
    join(import.meta.dirname, '../../../web/src/routes/new-task-form.ts'),
    'utf8',
  );
  const source = readFileSync(join(import.meta.dirname, 'model-family.ts'), 'utf8');

  const table = (text: string) =>
    [...text.matchAll(/\[(\/\^[^\]]+?\/i), '([a-z]+)'\]/g)].map((m) => `${m[1]}=${m[2]}`);

  it('carries the same weight-lineage table', () => {
    const server = table(source);
    expect(server.length).toBeGreaterThan(10);
    expect(table(mirror)).toEqual(server);
  });

  it('carries the same gateway prefixes', () => {
    const prefixes = (text: string) =>
      text.match(/GATEWAY_PREFIXES: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/)?.[1]?.trim();
    expect(prefixes(mirror)).toBe(prefixes(source));
  });
});
