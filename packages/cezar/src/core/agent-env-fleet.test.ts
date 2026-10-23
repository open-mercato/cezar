import { describe, expect, it } from 'vitest';
import { buildChildEnv } from './agent-env.ts';

/** The fleet token lets its holder queue work on every node: an agent must never receive it. */
describe('buildChildEnv — cezar credentials stay out of agents', () => {
  const HOST: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    CEZ_FLEET_TOKEN: 'f'.repeat(40),
    CEZ_FLEET_HUB_URL: 'http://hub:4330',
    CEZ_ALERT_SECRET: 'shh',
    cez_fleet_token: 'lowercase-spelling',
    CEZ_DRY_RUN: '1',
    CEZ_HANDOFF_FILE: '/tmp/h.md',
  };

  for (const backend of ['claude', 'codex', 'opencode'] as const) {
    it(`drops *_TOKEN / *_SECRET CEZ_ vars for ${backend}, keeps the rest of the namespace`, () => {
      const env = buildChildEnv({ backend, source: HOST });
      expect(env.CEZ_FLEET_TOKEN).toBeUndefined();
      expect(env.CEZ_ALERT_SECRET).toBeUndefined();
      expect(env.cez_fleet_token).toBeUndefined();
      expect(env.CEZ_DRY_RUN).toBe('1');
      expect(env.CEZ_HANDOFF_FILE).toBe('/tmp/h.md');
      expect(env.CEZ_FLEET_HUB_URL).toBe('http://hub:4330');
    });
  }

  it('a per-run extra still wins (cezar sets it deliberately)', () => {
    const env = buildChildEnv({ backend: 'claude', source: HOST, extraEnv: { CEZ_RUN_TOKEN: 'x' } });
    expect(env.CEZ_RUN_TOKEN).toBe('x');
  });
});
