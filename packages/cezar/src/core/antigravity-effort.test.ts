import { describe, expect, it } from 'vitest';
import { antigravityVariantOf, resolveAntigravityEffort } from './antigravity-effort.ts';

// `agy models` ids, as listed live (account-specific; never hardcoded in the mapper).
const models = [
  'gemini-4-neon-high', 'gemini-4-neon-xhigh', 'gemini-4-neon-medium', 'gemini-4-neon-low',
  'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
  'gemini-pro-orchestrator', 'gemini-pro-orchestrator-neon', 'gpt-oss-120b-medium',
];

describe('antigravityVariantOf', () => {
  it('splits an effort suffix off the family', () => {
    expect(antigravityVariantOf('gemini-4-neon-xhigh')).toEqual({ family: 'gemini-4-neon', variant: 'xhigh' });
    expect(antigravityVariantOf('gemini-3.8-flash-low')).toEqual({ family: 'gemini-3.8-flash', variant: 'low' });
  });

  it('is undefined for an id that carries no effort', () => {
    expect(antigravityVariantOf('gemini-pro-orchestrator-neon')).toBeUndefined();
    expect(antigravityVariantOf('gemini-pro-orchestrator')).toBeUndefined();
  });
});

describe('resolveAntigravityEffort', () => {
  it('maps low/medium/high directly on the given family', () => {
    for (const effort of ['low', 'medium', 'high']) {
      expect(resolveAntigravityEffort({ effort, model: 'gemini-4-neon', models })).toEqual({ model: `gemini-4-neon-${effort}`, note: `effort ${effort} -> gemini-4-neon-${effort}` });
    }
  });

  it('maps max to the highest listed variant of the family', () => {
    expect(resolveAntigravityEffort({ effort: 'max', model: 'gemini-4-neon', models })).toEqual({ model: 'gemini-4-neon-xhigh', note: 'effort max -> gemini-4-neon-xhigh' });
    expect(resolveAntigravityEffort({ effort: 'max', model: 'gemini-3.8-flash', models })).toMatchObject({ model: 'gemini-3.8-flash-high' });
  });

  it('takes the family from the default model, replacing its variant', () => {
    expect(resolveAntigravityEffort({ effort: 'low', defaultModel: 'gemini-4-neon-medium', models })).toMatchObject({ model: 'gemini-4-neon-low' });
  });

  it('accepts an explicit full id whose variant agrees, refuses one that conflicts', () => {
    expect(resolveAntigravityEffort({ effort: 'high', model: 'gemini-4-neon-high', models })).toMatchObject({ model: 'gemini-4-neon-high' });
    expect(resolveAntigravityEffort({ effort: 'max', model: 'gemini-4-neon-xhigh', models })).toMatchObject({ model: 'gemini-4-neon-xhigh' });
    const conflict = resolveAntigravityEffort({ effort: 'low', model: 'gemini-4-neon-high', models });
    expect(conflict).toEqual({ error: expect.stringContaining("--model gemini-4-neon-high already sets effort 'high', which conflicts with --effort low") });
    expect(resolveAntigravityEffort({ effort: 'max', model: 'gemini-4-neon-high', models })).toHaveProperty('error');
  });

  it('refuses an effort with no matching variant, listing the valid ones', () => {
    const refused = resolveAntigravityEffort({ effort: 'low', model: 'gpt-oss-120b', models });
    expect(refused).toEqual({ error: "antigravity has no 'low' variant of gpt-oss-120b. Valid for gpt-oss-120b: gpt-oss-120b-medium (--effort medium, max)" });
  });

  it('refuses a model with no variants, and no model at all', () => {
    expect(resolveAntigravityEffort({ effort: 'high', model: 'gemini-pro-orchestrator', models })).toEqual({ error: expect.stringContaining('has no effort variants') });
    expect(resolveAntigravityEffort({ effort: 'high', models })).toEqual({ error: expect.stringContaining('Families: gemini-4-neon, gemini-3.8-flash, gpt-oss-120b') });
  });

  it('without a model list, accepts only a full id that already names the effort', () => {
    expect(resolveAntigravityEffort({ effort: 'high', model: 'gemini-4-neon-high' })).toMatchObject({ model: 'gemini-4-neon-high' });
    expect(resolveAntigravityEffort({ effort: 'high', model: 'gemini-4-neon' })).toEqual({ error: expect.stringContaining('model list is unavailable') });
  });
});
