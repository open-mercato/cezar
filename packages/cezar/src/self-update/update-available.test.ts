import { describe, expect, it, vi } from 'vitest';

import { RegistryCache } from './registry.ts';
import { SelfUpdateService } from './service.ts';

describe('SelfUpdateService.updateAvailable', () => {
  const serviceWith = (env: NodeJS.ProcessEnv) => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ 'dist-tags': { latest: '99.0.0' }, versions: { '99.0.0': {} }, time: {} })));
    const service = new SelfUpdateService({
      pkgName: '@open-mercato/cezar',
      version: '0.1.0',
      entry: '/somewhere/dist/index.js',
      restart: () => {},
      env,
      registry: new RegistryCache('@open-mercato/cezar', fetchSpy as unknown as typeof fetch),
    });
    return { service, fetchSpy };
  };

  it('a dry run never reaches the registry', async () => {
    const { service, fetchSpy } = serviceWith({ ...process.env, CEZ_DRY_RUN: '1' });
    expect(await service.updateAvailable()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('outside a dry run a newer published version is reported', async () => {
    const env = { ...process.env };
    delete env.CEZ_DRY_RUN;
    delete env.CEZ_UPDATE_CHANNEL;
    const { service, fetchSpy } = serviceWith(env);
    expect(await service.updateAvailable()).toBe('99.0.0');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
