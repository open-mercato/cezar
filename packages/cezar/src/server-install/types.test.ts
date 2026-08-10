import { describe, expect, it } from 'vitest';
import { freshServerState, serverStateSchema } from './types.ts';

describe('serverStateSchema', () => {
  it('round-trips a full server.json', () => {
    const full = {
      schema: 1,
      platform: 'ubuntu-vps',
      installed: true,
      createdAt: '2026-07-16T09:00:00.000Z',
      primaryPort: 4321,
      steps: {
        deps: { status: 'done', created: { artifacts: [{ kind: 'shared', type: 'package', name: 'gh' }] } },
        'nginx-proxy': {
          status: 'done',
          created: {
            artifacts: [
              { kind: 'owned', type: 'file', path: '/etc/nginx/sites-available/cezar' },
              { kind: 'owned', type: 'htpasswd', path: '/etc/cezar/htpasswd' },
            ],
          },
        },
        ssl: { status: 'skipped', created: null },
      },
    };
    const parsed = serverStateSchema.parse(full);
    expect(parsed.platform).toBe('ubuntu-vps');
    expect(parsed.steps['nginx-proxy']?.created?.artifacts).toHaveLength(2);
    expect(parsed.steps.ssl?.created).toBeNull();
  });

  it('is additive-safe — unknown fields are ignored, defaults fill in', () => {
    const parsed = serverStateSchema.parse({ futureField: 'ignored', platform: 'macosx-ngrok' });
    expect(parsed.installed).toBe(false);
    expect(parsed.primaryPort).toBe(4321);
    expect(parsed.steps).toEqual({});
  });

  it('freshServerState is a valid empty record', () => {
    const s = freshServerState();
    expect(s.installed).toBe(false);
    expect(s.schema).toBe(1);
  });
});
