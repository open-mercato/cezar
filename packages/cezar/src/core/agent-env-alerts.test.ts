import { describe, expect, it } from 'vitest';
import { ALERT_CREDENTIAL_VARS } from '../agent-gateway/alerts.ts';
import { buildChildEnv } from './agent-env.ts';

/** Alert-target credentials are cezar's own: an agent that held them could forge alerts or wake OpenClaw. */
describe('buildChildEnv — alert credentials never reach an agent', () => {
  const HOST: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    CEZ_OPENCLAW_HOOK_TOKEN: 'hook-token-value',
    CEZ_HERMES_WEBHOOK_SECRET: 'hermes-secret-value',
    CEZ_OPENCLAW_URL: 'http://127.0.0.1:18789',
    CEZ_TASK_ID: 'run-1',
    CEZ_DRY_RUN: '1',
  };

  it.each(['claude', 'codex', 'opencode'] as const)('drops both credentials for %s but keeps other CEZ_ vars', (backend) => {
    const env = buildChildEnv({ backend, source: HOST });
    expect(env.CEZ_OPENCLAW_HOOK_TOKEN).toBeUndefined();
    expect(env.CEZ_HERMES_WEBHOOK_SECRET).toBeUndefined();
    expect(env.CEZ_TASK_ID).toBe('run-1');
    expect(env.CEZ_DRY_RUN).toBe('1');
    expect(env.CEZ_OPENCLAW_URL).toBe('http://127.0.0.1:18789');
  });

  it('matches the credential case-insensitively', () => {
    const env = buildChildEnv({ backend: 'claude', source: { cez_openclaw_hook_token: 'x', CEZ_TASK_ID: 'r' } });
    expect(env).not.toHaveProperty('cez_openclaw_hook_token');
    expect(env.CEZ_TASK_ID).toBe('r');
  });

  it('every credential the alert config knows is covered by the _TOKEN/_SECRET rule', () => {
    for (const name of ALERT_CREDENTIAL_VARS) expect(name).toMatch(/_(TOKEN|SECRET)$/);
  });
});
