import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager, setFallbackProviderCheck } from './run.ts';

const roots: string[] = [];
afterEach(() => {
  setFallbackProviderCheck(undefined);
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('adaptive routing provider admission', () => {
  it('refuses disabled and disconnected providers before routing', async () => {
    const root = mkdtempSync('/tmp/cez-routing-gate-');
    roots.push(root);
    const home = join(root, 'home');
    mkdirSync(home);
    vi.stubEnv('CEZ_HOME', home);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ disabledProviders: ['codex'] }));
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);
    try {
      setFallbackProviderCheck(async () => null);
      const allowed = (manager as unknown as { routingProviderAllowed(provider: 'codex' | 'claude'): Promise<boolean> }).routingProviderAllowed.bind(manager);
      expect(await allowed('codex')).toBe(false);
      expect(await allowed('claude')).toBe(true);
      setFallbackProviderCheck(async () => 'credentials unavailable');
      expect(await allowed('claude')).toBe(false);
    } finally { manager.dispose(); store.flush(); }
  });
});
