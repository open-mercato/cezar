import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { accountLoginFingerprint } from '../agent-config/account-identity.ts';

describe('the plan-usage login fingerprint', () => {
  it('changes with the Claude login in the folder and never contains it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-fp-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', dir);
    const write = (uuid: string) => writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: uuid, organizationUuid: 'org-1', emailAddress: 'me@example.com' } }));
    write('acc-1');
    const one = await accountLoginFingerprint('claude', dir);
    write('acc-2');
    const two = await accountLoginFingerprint('claude', dir);
    expect(one).toMatch(/^[a-f0-9]{16}$/);
    expect(two).not.toBe(one);
    expect(`${one}${two}`).not.toContain('acc-');
    writeFileSync(join(dir, '.claude.json'), '{}');
    expect(await accountLoginFingerprint('claude', dir)).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('reads Codex claims, not tokens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-fp-'));
    mkdirSync(dir, { recursive: true });
    const claims = Buffer.from(JSON.stringify({ sub: 'user-1', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-9' } })).toString('base64url');
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ tokens: { id_token: `x.${claims}.y`, access_token: 'secret' } }));
    expect(await accountLoginFingerprint('codex', dir)).toMatch(/^[a-f0-9]{16}$/);
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-x' }));
    expect(await accountLoginFingerprint('codex', dir)).toBeUndefined();
  });
});
