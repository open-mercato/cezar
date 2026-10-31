import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { codexIdentity, probeCodexIdentity, probeCodexUsageWindows } from './codex-usage-probe.ts';
import type { ResolvedAgentProfile } from '../workspace/agent-profiles.ts';
const bin = fileURLToPath(new URL('./__fixtures__/codex/usage-metadata.mjs', import.meta.url));
function profile(mode = 'ok'): ResolvedAgentProfile {
  const path = mkdtempSync(join(tmpdir(), 'usage-probe-'));
  writeFileSync(join(path, 'config.toml'), mode);
  return { id: path, provider: 'codex', path, configDir: path, isDefault: false, label: 'test' };
}
beforeEach(() => { vi.stubEnv('CEZ_CODEX_BIN', bin); vi.stubEnv('CEZ_DRY_RUN', '0'); });
afterEach(() => vi.unstubAllEnvs());
it('makes only metadata calls, binds the profile, caches and coalesces concurrent previews', async () => {
  const p = profile();
  const [a, b] = await Promise.all([probeCodexUsageWindows(p), probeCodexUsageWindows(p)]);
  expect(a).toEqual(b);
  expect(a?.binding).toEqual({ provider: 'codex', accountId: p.id, profilePath: p.path, identity: codexIdentity({ type: 'chatgpt', email: 'user@example.test' }) });
  expect(a?.observation.windows[0]).toMatchObject({ durationMinutes: 10080, usedPercent: 23 });
  expect(await probeCodexUsageWindows(p)).toEqual(a);
  const calls = readFileSync(join(p.path, 'calls.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(calls.map((c) => c.method)).toEqual(['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
  expect(calls[2].params).toEqual({ refreshToken: false });
  writeFileSync(join(p.path, 'config.toml'), 'changed');
  const changed = await probeCodexUsageWindows(p, { force: true });
  expect(changed?.binding.identity).not.toBe(a?.binding.identity);
  expect(JSON.stringify(a)).not.toContain('user@example.test');
});
it.each(['error', 'noidentity', 'flood', 'stderr'])('degrades %s to no data and allows forced retry', async (mode) => {
  const p = profile(mode);
  expect(await probeCodexUsageWindows(p)).toBeNull();
  writeFileSync(join(p.path, 'config.toml'), 'ok');
  expect(await probeCodexUsageWindows(p, { force: true })).not.toBeNull();
});
it('bounds concurrency and hung subprocess lifetime', async () => {
  const start = Date.now();
  const reads = Array.from({ length: 4 }, () => probeCodexUsageWindows(profile('hang')));
  expect(await probeCodexUsageWindows(profile())).toBeNull();
  expect(await Promise.all(reads)).toEqual([null, null, null, null]);
  expect(Date.now() - start).toBeLessThan(7000);
}, 10000);
it('does not spawn for dry-run, unsupported providers or missing profiles', async () => {
  const p = profile();
  vi.stubEnv('CEZ_DRY_RUN', '1');
  expect(await probeCodexUsageWindows(p)).toBeNull();
  vi.stubEnv('CEZ_DRY_RUN', '0');
  expect(await probeCodexUsageWindows({ ...p, provider: 'claude' })).toBeNull();
  expect(await probeCodexUsageWindows({ ...p, path: join(p.path, 'absent') })).toBeNull();
  expect(codexIdentity({ type: 'apiKey', apiKey: 'secret' })).toBeNull();
});

it('launch revalidation reads identity without querying quotas or starting a turn', async () => {
  const p = profile();
  const result = await probeCodexUsageWindows(p, { force: true, identityOnly: true });
  expect(result?.binding.identity).toBeTruthy();
  const calls = readFileSync(join(p.path, 'calls.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(calls.map(c => c.method)).toEqual(['initialize', 'initialized', 'account/read']);
});

it('launch identity reads tell a timeout or saturation from a definitive answer (#1340)', async () => {
  expect(await probeCodexIdentity(profile())).toEqual({ identity: codexIdentity({ type: 'chatgpt', email: 'user@example.test' }) });
  expect(await probeCodexIdentity(profile('noidentity'))).toEqual({ identity: null });
  const hung = Array.from({ length: 4 }, () => probeCodexIdentity(profile('hang')));
  expect(await probeCodexIdentity(profile())).toEqual({ unavailable: true });
  expect(await Promise.all(hung)).toEqual(Array.from({ length: 4 }, () => ({ unavailable: true })));
}, 10000);
