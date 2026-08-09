import { describe, expect, it } from 'vitest';
import type { AgentBackend } from './agent-runner.ts';
import {
  BACKEND_MODEL_MAP,
  ModelIdentityError,
  formatModelIdentity,
  normalizeModelForBackend,
  parseModelIdentity,
  resolveModelIdentity,
  toBackendModel,
} from './model-identity.ts';

/**
 * The canonical provider/model identity (#405): one shared parser/normaliser
 * every runner keys off. These lock the two properties the issue asks for —
 * a clean round-trip per backend (a preset the composer sends survives
 * resolve → persist → render back to the same wire string) and fail-loud
 * handling of an unresolvable model instead of a silent backend default.
 */

describe('parseModelIdentity', () => {
  it('splits an explicit provider/model, lowercasing the provider', () => {
    expect(parseModelIdentity('anthropic/claude-opus-4-8')).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
    });
    expect(parseModelIdentity('OpenAI/gpt-5.1')).toEqual({ provider: 'openai', model: 'gpt-5.1' });
  });

  it('keeps only the FIRST slash as the separator (models may contain slashes)', () => {
    expect(parseModelIdentity('openrouter/anthropic/claude-3.5')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-3.5',
    });
  });

  it('returns null for anything not in provider/model form', () => {
    for (const raw of ['', '   ', 'sonnet', '/sonnet', 'anthropic/', undefined, null]) {
      expect(parseModelIdentity(raw)).toBeNull();
    }
  });
});

describe('formatModelIdentity', () => {
  it('is the inverse of parse for a well-formed identity', () => {
    const id = { provider: 'anthropic', model: 'claude-sonnet-5' };
    expect(formatModelIdentity(id)).toBe('anthropic/claude-sonnet-5');
    expect(parseModelIdentity(formatModelIdentity(id))).toEqual(id);
  });
});

describe('resolveModelIdentity — empty / auto', () => {
  it('is undefined for empty/whitespace on every backend (the backend picks)', () => {
    for (const backend of Object.keys(BACKEND_MODEL_MAP) as AgentBackend[]) {
      expect(resolveModelIdentity(backend, undefined)).toBeUndefined();
      expect(resolveModelIdentity(backend, '')).toBeUndefined();
      expect(resolveModelIdentity(backend, '   ')).toBeUndefined();
    }
  });
});

describe('resolveModelIdentity — bare ids per backend', () => {
  it('claude bare aliases and pinned ids resolve to anthropic', () => {
    expect(resolveModelIdentity('claude', 'opus')).toEqual({ provider: 'anthropic', model: 'opus' });
    expect(resolveModelIdentity('claude', 'claude-opus-4-8')).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
    });
  });

  it('the legacy claude-cli id resolves identically to claude', () => {
    expect(resolveModelIdentity('claude-cli', 'sonnet')).toEqual(
      resolveModelIdentity('claude', 'sonnet'),
    );
  });

  it('codex bare ids resolve to openai', () => {
    expect(resolveModelIdentity('codex', 'gpt-5.1-codex')).toEqual({
      provider: 'openai',
      model: 'gpt-5.1-codex',
    });
  });

  it('opencode rejects a bare id — fail-loud, no silent default', () => {
    expect(() => resolveModelIdentity('opencode', 'sonnet')).toThrow(ModelIdentityError);
    try {
      resolveModelIdentity('opencode', 'sonnet');
    } catch (err) {
      expect((err as Error).message).toContain('ambiguous');
      expect((err as Error).message).toContain('provider/model');
    }
  });

  it('an explicit provider/model resolves for a multi-provider backend (opencode), any provider', () => {
    expect(resolveModelIdentity('opencode', 'anthropic/claude-opus-4-8')).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
    });
    expect(resolveModelIdentity('opencode', 'openrouter/some-model')).toEqual({
      provider: 'openrouter',
      model: 'some-model',
    });
  });

  it("an explicit provider/model resolves on a single-provider backend when it's that backend's own provider", () => {
    expect(resolveModelIdentity('claude', 'anthropic/claude-opus-4-8')).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
    });
    expect(resolveModelIdentity('codex', 'openai/gpt-5.1-codex')).toEqual({
      provider: 'openai',
      model: 'gpt-5.1-codex',
    });
  });

  it('Claude preserves an explicit foreign provider for custom gateways', () => {
    expect(resolveModelIdentity('claude', 'deepseek/deepseek-v4-flash')).toEqual({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    });
    expect(toBackendModel('claude', { provider: 'deepseek', model: 'deepseek-v4-flash' })).toBe(
      'deepseek/deepseek-v4-flash',
    );
  });

  it('Codex accepts a foreign prefix only when it matches the configured provider', () => {
    expect(
      resolveModelIdentity('codex', 'deepseek/deepseek-chat', {
        configuredProvider: 'deepseek',
      }),
    ).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
    });
    expect(
      resolveModelIdentity('codex', 'deepseek-chat', { configuredProvider: 'deepseek' }),
    ).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
    });
    expect(toBackendModel('codex', { provider: 'deepseek', model: 'deepseek-chat' })).toBe('deepseek-chat');
  });

  it('Codex rejects an unverified or mismatched foreign provider prefix', () => {
    expect(() => resolveModelIdentity('codex', 'deepseek/deepseek-chat')).toThrow(
      ModelIdentityError,
    );
    expect(() =>
      resolveModelIdentity('codex', 'deepseek/deepseek-chat', {
        configuredProvider: 'openai',
      }),
    ).toThrow(/configured provider "openai"/);
  });
});

describe('toBackendModel — wire form per backend', () => {
  it('single-provider backends get the bare model id', () => {
    expect(toBackendModel('claude', { provider: 'anthropic', model: 'opus' })).toBe('opus');
    expect(toBackendModel('codex', { provider: 'openai', model: 'gpt-5.1-codex' })).toBe(
      'gpt-5.1-codex',
    );
  });

  it('multi-provider backends (opencode) get the full provider/model', () => {
    expect(toBackendModel('opencode', { provider: 'anthropic', model: 'claude-opus-4-8' })).toBe(
      'anthropic/claude-opus-4-8',
    );
  });
});

describe('round-trip: composer preset → resolve → render back to the wire string', () => {
  // The exact preset ids the composer sends today (MODELS_BY_RUNNER), per backend.
  const cases: Array<{ backend: AgentBackend; presets: string[] }> = [
    { backend: 'claude', presets: ['opus', 'sonnet', 'haiku', 'claude-opus-4-8', 'claude-sonnet-5'] },
    { backend: 'codex', presets: ['gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5-codex'] },
    {
      backend: 'opencode',
      presets: ['anthropic/claude-opus-4-8', 'anthropic/claude-sonnet-5', 'openai/gpt-5.1'],
    },
  ];

  for (const { backend, presets } of cases) {
    for (const preset of presets) {
      it(`${backend}: ${preset} survives resolve→render unchanged`, () => {
        const id = resolveModelIdentity(backend, preset);
        expect(id).toBeDefined();
        expect(toBackendModel(backend, id!)).toBe(preset);
      });
    }
  }
});

describe('normalizeModelForBackend', () => {
  it('returns both the backend wire string and the canonical identity', () => {
    expect(normalizeModelForBackend('claude', 'opus')).toEqual({
      backendModel: 'opus',
      identity: { provider: 'anthropic', model: 'opus' },
    });
    expect(normalizeModelForBackend('opencode', 'anthropic/claude-sonnet-5')).toEqual({
      backendModel: 'anthropic/claude-sonnet-5',
      identity: { provider: 'anthropic', model: 'claude-sonnet-5' },
    });
    expect(
      normalizeModelForBackend('codex', 'deepseek/deepseek-chat', {
        configuredProvider: 'deepseek',
      }),
    ).toEqual({
      backendModel: 'deepseek-chat',
      identity: { provider: 'deepseek', model: 'deepseek-chat' },
    });
  });

  it('is undefined for empty/auto', () => {
    expect(normalizeModelForBackend('codex', undefined)).toBeUndefined();
    expect(normalizeModelForBackend('codex', '')).toBeUndefined();
  });

  it('propagates the fail-loud error for an unresolvable model', () => {
    expect(() => normalizeModelForBackend('opencode', 'sonnet')).toThrow(ModelIdentityError);
  });

  it('the canonical identity a claude preset persists is provider-qualified', () => {
    const normalized = normalizeModelForBackend('claude', 'sonnet');
    expect(normalized && formatModelIdentity(normalized.identity)).toBe('anthropic/sonnet');
  });
});
