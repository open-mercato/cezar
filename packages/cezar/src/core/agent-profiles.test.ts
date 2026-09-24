import { describe, expect, it } from 'vitest';
import { PROVIDER_IDS } from './provider-auth.ts';
import {
  PROFILE_CAPABLE_PROVIDERS,
  PROFILE_ENV_VAR,
  looksLikeProfileDir,
  profileEnv,
  supportsProfiles,
} from './agent-profiles.ts';

describe('PROFILE_ENV_VAR', () => {
  it('names one variable per provider that can carry an account', () => {
    expect(PROFILE_ENV_VAR.claude).toBe('CLAUDE_CONFIG_DIR');
    expect(PROFILE_ENV_VAR.codex).toBe('CODEX_HOME');
  });

  it('leaves OpenCode unsupported — its credentials do not follow its config dir', () => {
    expect(PROFILE_ENV_VAR.opencode).toBeNull();
    expect(supportsProfiles('opencode')).toBe(false);
    expect(PROFILE_CAPABLE_PROVIDERS).toEqual(['claude', 'codex']);
  });

  it('covers every provider, so adding one forces a decision here', () => {
    expect(Object.keys(PROFILE_ENV_VAR).sort()).toEqual([...PROVIDER_IDS].sort());
  });
});

describe('profileEnv', () => {
  it('points the agent at its profile dir', () => {
    expect(profileEnv('claude', '/home/u/.claude-klaudiusz')).toEqual({
      CLAUDE_CONFIG_DIR: '/home/u/.claude-klaudiusz',
    });
    expect(profileEnv('codex', '/home/u/.codex-klaudiusz')).toEqual({ CODEX_HOME: '/home/u/.codex-klaudiusz' });
  });

  it('adds NOTHING for the default profile — the zero-config path must stay untouched', () => {
    expect(profileEnv('claude', null)).toEqual({});
    expect(profileEnv('claude', undefined)).toEqual({});
    expect(profileEnv('claude', '   ')).toEqual({});
  });

  it('adds nothing for a provider with no home variable, even given a dir', () => {
    expect(profileEnv('opencode', '/home/u/.config/opencode-work')).toEqual({});
  });

  it('can never emit another provider\'s variable', () => {
    // `buildChildEnv` applies extraEnv AFTER its allowlist, so this function is the only thing
    // standing between a profile and the child env. A codex step must not be handed
    // CLAUDE_CONFIG_DIR, which would point claude's sibling tooling at the wrong home.
    for (const provider of PROVIDER_IDS) {
      const emitted = Object.keys(profileEnv(provider, '/somewhere'));
      const foreign = Object.values(PROFILE_ENV_VAR).filter(
        (name): name is string => name !== null && name !== PROFILE_ENV_VAR[provider],
      );
      expect(emitted.some((name) => foreign.includes(name))).toBe(false);
    }
  });
});

describe('looksLikeProfileDir', () => {
  it('recognises a real Claude config dir by any one marker', () => {
    expect(looksLikeProfileDir('claude', ['.claude.json', 'projects', 'sessions'])).toBe(true);
    expect(looksLikeProfileDir('claude', ['settings.json'])).toBe(true);
  });

  it('recognises a Codex home', () => {
    expect(looksLikeProfileDir('codex', ['auth.json', 'history.jsonl'])).toBe(true);
    expect(looksLikeProfileDir('codex', ['config.toml'])).toBe(true);
  });

  it('says no for an unrelated directory — advisory, so the caller still accepts it', () => {
    expect(looksLikeProfileDir('claude', ['README.md'])).toBe(false);
    expect(looksLikeProfileDir('claude', [])).toBe(false);
  });
});
