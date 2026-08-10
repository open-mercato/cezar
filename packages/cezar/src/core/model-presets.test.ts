import { describe, expect, it } from 'vitest';
import { KNOWN_PRESETS_BY_RUNNER, modelConflictsWithRunner } from './model-presets.ts';

describe('modelConflictsWithRunner', () => {
  it('never rejects auto or a runner\'s own preset', () => {
    expect(modelConflictsWithRunner('', 'opencode')).toBe(false);
    expect(modelConflictsWithRunner('opus', 'claude')).toBe(false);
    expect(modelConflictsWithRunner('gpt-5.1-codex', 'codex')).toBe(false);
  });

  it('rejects another runner\'s preset', () => {
    expect(modelConflictsWithRunner('opus', 'codex')).toBe(true);
    expect(modelConflictsWithRunner('gpt-5.1-codex', 'claude')).toBe(true);
    expect(modelConflictsWithRunner('claude-opus-4-8', 'codex')).toBe(true);
    // …but an unlisted gateway id stays usable on claude, which supports them by design.
    expect(modelConflictsWithRunner('openai/gpt-5.4', 'claude')).toBe(false);
  });

  it('rejects a provider the runner cannot serve, without naming any model', () => {
    expect(modelConflictsWithRunner('anthropic/claude-opus-4-8', 'codex')).toBe(true);
    // A model that did not exist when this code was written is guarded just the same.
    expect(modelConflictsWithRunner('anthropic/claude-opus-9', 'codex')).toBe(true);
    expect(modelConflictsWithRunner('openai/gpt-5.4', 'codex')).toBe(false);
  });

  it('leaves an unfamiliar prefix alone — it may be the runner\'s configured gateway', () => {
    // The run-time gate reads the runner's configured provider and can accept this; this
    // synchronous guard cannot, so it must not pre-empt that decision.
    expect(modelConflictsWithRunner('my-org/custom-tune', 'codex')).toBe(false);
  });

  it('never rejects a provider prefix for OpenCode, which serves every provider', () => {
    expect(modelConflictsWithRunner('anthropic/claude-sonnet-5', 'opencode')).toBe(false);
    expect(modelConflictsWithRunner('openai/gpt-5.4', 'opencode')).toBe(false);
    // …while another runner's bare preset is still recognizably not an OpenCode id.
    expect(modelConflictsWithRunner('opus', 'opencode')).toBe(true);
  });

  it('accepts every provider-qualified OpenCode id, including ones no release knows (#794)', () => {
    for (const model of ['openai/gpt-5.5-fast', 'anthropic/claude-sonnet-5', 'zed/some-future-model']) {
      expect(modelConflictsWithRunner(model, 'opencode')).toBe(false);
    }
  });

  it('keeps no hard-coded OpenCode catalog to drift', () => {
    expect(KNOWN_PRESETS_BY_RUNNER.opencode).toEqual([]);
  });
});
