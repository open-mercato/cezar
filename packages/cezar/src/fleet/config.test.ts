import { describe, expect, it } from 'vitest';
import { fleetConfigFromEnv } from './config.ts';

const TOKEN = 't'.repeat(32);

describe('fleetConfigFromEnv', () => {
  it('is off with no fleet variables, even with a token present', () => {
    expect(fleetConfigFromEnv({})).toEqual({ role: 'off' });
    expect(fleetConfigFromEnv({ CEZ_FLEET_TOKEN: TOKEN })).toEqual({ role: 'off' });
  });
  it('configures a hub with defaults', () => {
    expect(fleetConfigFromEnv({ CEZ_FLEET_HUB: '1', CEZ_FLEET_TOKEN: TOKEN, CEZ_FLEET_NODE_ID: 'n' })).toEqual({
      role: 'hub', token: TOKEN, nodeId: 'n', port: 4330, bind: '0.0.0.0',
    });
  });
  it('configures a worker and trims the hub URL', () => {
    expect(fleetConfigFromEnv({ CEZ_FLEET_HUB_URL: 'http://hub:4330/', CEZ_FLEET_TOKEN: TOKEN, CEZ_FLEET_NODE_ID: 'w' })).toEqual({
      role: 'worker', token: TOKEN, nodeId: 'w', hubUrl: 'http://hub:4330',
    });
  });
  it('refuses a missing or short token for any role', () => {
    expect(fleetConfigFromEnv({ CEZ_FLEET_HUB: '1' })).toMatchObject({ role: 'invalid' });
    expect(fleetConfigFromEnv({ CEZ_FLEET_HUB_URL: 'http://h', CEZ_FLEET_TOKEN: 'short' })).toMatchObject({ role: 'invalid' });
  });
  it('refuses hub + worker at once, a non-http hub URL and a bad port', () => {
    expect(fleetConfigFromEnv({ CEZ_FLEET_HUB: '1', CEZ_FLEET_HUB_URL: 'http://h', CEZ_FLEET_TOKEN: TOKEN })).toMatchObject({ role: 'invalid' });
    expect(fleetConfigFromEnv({ CEZ_FLEET_HUB_URL: 'ftp://h', CEZ_FLEET_TOKEN: TOKEN })).toMatchObject({ role: 'invalid' });
    expect(fleetConfigFromEnv({ CEZ_FLEET_HUB: '1', CEZ_FLEET_TOKEN: TOKEN, CEZ_FLEET_PORT: 'x' })).toMatchObject({ role: 'invalid' });
  });
});
