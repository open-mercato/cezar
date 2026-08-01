import { afterEach, describe, expect, it } from 'vitest';
import { applyProviderEnablement, isProviderUsable } from './provider-availability.ts';

describe('provider availability', () => {
  const savedModelsLocked = process.env.CEZ_AGENT_MODELS_LOCKED;

  afterEach(() => {
    if (savedModelsLocked === undefined) delete process.env.CEZ_AGENT_MODELS_LOCKED;
    else process.env.CEZ_AGENT_MODELS_LOCKED = savedModelsLocked;
  });

  const response = {
    providers: [
      { provider: 'claude' as const, status: 'connected' as const },
      { provider: 'codex' as const, status: 'disconnected' as const },
      { provider: 'opencode' as const, status: 'not-installed' as const },
    ],
  };

  it('decorates every row without changing discovery truth', () => {
    expect(applyProviderEnablement(response, ['claude'])).toEqual({
      providers: [
        { provider: 'claude', status: 'connected', enabled: false },
        { provider: 'codex', status: 'disconnected', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    });
  });

  it('requires both credentials and enablement for use', () => {
    expect(isProviderUsable({ provider: 'claude', status: 'connected', enabled: true })).toBe(true);
    expect(isProviderUsable({ provider: 'claude', status: 'connected', enabled: false })).toBe(false);
    expect(isProviderUsable({ provider: 'claude', status: 'disconnected', enabled: true })).toBe(false);
  });

  it('ignores Cezar provider-disable preferences under the explicit model lock', () => {
    process.env.CEZ_AGENT_MODELS_LOCKED = '1';

    expect(applyProviderEnablement(response, ['claude', 'codex', 'opencode'])).toEqual({
      providers: [
        { provider: 'claude', status: 'connected', enabled: true },
        { provider: 'codex', status: 'disconnected', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    });
  });
});
