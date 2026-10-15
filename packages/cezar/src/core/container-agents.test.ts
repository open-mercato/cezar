import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTAINER_AGENTS, missingLoginNote, syncContainerAgentLogin, withoutRefreshTokens } from './container-agents.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-agent-login-'));
  dirs.push(dir);
  return dir;
};

describe('a runner login passed into a container', () => {
  it('blanks every refresh token, whatever the CLI calls it, keeping the key its CLI requires', () => {
    // Codex (`tokens.refresh_token`), OpenCode and pi (`refresh` per provider), Claude (`refreshToken`).
    expect(withoutRefreshTokens({
      OPENAI_API_KEY: null,
      tokens: { access_token: 'a', refresh_token: 'r', id_token: 'i' },
      anthropic: { type: 'oauth', access: 'a2', refresh: 'r2', expires: 1 },
      openai: { type: 'api', key: 'k' },
      claudeAiOauth: { accessToken: 'a3', refreshToken: 'r3', refreshTokenExpiresAt: 2 },
    })).toEqual({
      OPENAI_API_KEY: null,
      tokens: { access_token: 'a', refresh_token: '', id_token: 'i' },
      anthropic: { type: 'oauth', access: 'a2', refresh: '', expires: 1 },
      openai: { type: 'api', key: 'k' },
      claudeAiOauth: { accessToken: 'a3', refreshToken: '', refreshTokenExpiresAt: 2 },
    });
  });

  it('copies the host login file into the per-project home, stripped', () => {
    const home = temp();
    const agentHome = temp();
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r' } }));
    expect(syncContainerAgentLogin(CONTAINER_AGENTS.codex, agentHome, {}, home)).toBe(true);
    const copied = readFileSync(join(agentHome, 'auth.json'), 'utf8');
    expect(JSON.parse(copied)).toEqual({ tokens: { access_token: 'a', refresh_token: '' } });
  });

  it('honours an agent account that relocates the login', () => {
    const home = temp();
    const account = temp();
    const agentHome = temp();
    writeFileSync(join(account, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-x' }));
    expect(syncContainerAgentLogin(CONTAINER_AGENTS.codex, agentHome, { CODEX_HOME: account }, home)).toBe(true);
    expect(JSON.parse(readFileSync(join(agentHome, 'auth.json'), 'utf8'))).toEqual({ OPENAI_API_KEY: 'sk-x' });
  });

  it('never copies a file whose refresh tokens it cannot remove', () => {
    const home = temp();
    const agentHome = temp();
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(join(home, '.pi', 'agent', 'auth.json'), 'refresh=r not json');
    expect(syncContainerAgentLogin(CONTAINER_AGENTS.pi, agentHome, {}, home)).toBe(false);
    expect(existsSync(join(agentHome, 'agent', 'auth.json'))).toBe(false);
  });

  it('counts a static key in the environment as a login, and names it when there is none', () => {
    const agentHome = temp();
    expect(syncContainerAgentLogin(CONTAINER_AGENTS.cursor, agentHome, {}, temp())).toBe(false);
    expect(syncContainerAgentLogin(CONTAINER_AGENTS.cursor, agentHome, { CURSOR_API_KEY: 'k' }, temp())).toBe(true);
    expect(missingLoginNote(CONTAINER_AGENTS.cursor)).toContain('CURSOR_API_KEY');
    expect(missingLoginNote(CONTAINER_AGENTS.junie)).toContain('JUNIE_API_KEY');
  });
});
