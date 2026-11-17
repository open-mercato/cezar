import { expect, it, vi } from 'vitest';
import { SlackTokenRotation, type SlackRotationStorage } from './rotation.ts';
import { decodeSlackCredentials } from './identity.ts';
const credentials = { appToken: 'xoxe.xapp-original-token', botToken: 'xoxb-original-token', appRefreshToken: 'xoxe-original-refresh', clientId: '123.456', clientSecret: 'a'.repeat(32) };
function harness() {
 const values = new Map<string, string>(); let now = 1_800_000_000_000, tail = Promise.resolve();
 const storage: SlackRotationStorage = {
  read: async key => values.get(key), write: async (key, value) => { values.set(key, value); },
  async lock(_key, action) { const before = tail; let release!: () => void; tail = new Promise(resolve => { release = resolve; }); await before; try { return await action(); } finally { release(); } },
 };
 const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true, token_type: 'app_level', access_token: 'xoxe.xapp-renewed-token', refresh_token: 'xoxe-renewed-refresh', expires_in: 43200 })));
 const rotation = () => new SlackTokenRotation(storage, fetcher, () => now);
 return { values, storage, fetcher, rotation, advance: () => { now += 43200_000; } };
}
it('keeps legacy tokens offline and requires complete rotating credentials', async () => {
 const h = harness(); expect(await h.rotation().token(credentials, 'bot')).toBe(credentials.botToken); expect(h.fetcher).not.toHaveBeenCalled();
 expect(() => decodeSlackCredentials(JSON.stringify({ appToken: credentials.appToken, botToken: credentials.botToken }))).toThrow();
 expect(decodeSlackCredentials(JSON.stringify(credentials))).toEqual(credentials);
});
it('renews once across concurrent wires, survives restart, and exchanges the newest refresh token after expiry', async () => {
 const h = harness(), first = h.rotation(), second = h.rotation();
 expect(await Promise.all([first.token(credentials, 'app'), second.token(credentials, 'app')])).toEqual(['xoxe.xapp-renewed-token', 'xoxe.xapp-renewed-token']);
 expect(h.fetcher).toHaveBeenCalledTimes(1);
 const body = new URLSearchParams(h.fetcher.mock.calls[0]![1]!.body as string);
 expect(body.get('client_id')).toBe(credentials.clientId); expect(body.get('refresh_token')).toBe(credentials.appRefreshToken);
 expect(await h.rotation().token(credentials, 'app')).toBe('xoxe.xapp-renewed-token'); expect(h.fetcher).toHaveBeenCalledTimes(1);
 h.advance(); await h.rotation().token(credentials, 'app');
 expect(new URLSearchParams(h.fetcher.mock.calls[1]![1]!.body as string).get('refresh_token')).toBe('xoxe-renewed-refresh');
});
it('does not replay a possibly consumed refresh token after network loss or restart', async () => {
 const h = harness(); h.fetcher.mockRejectedValue(new Error('network response lost'));
 await expect(h.rotation().token(credentials, 'app')).rejects.toMatchObject({ failure: { kind: 'auth' } });
 await expect(h.rotation().token(credentials, 'app')).rejects.toMatchObject({ failure: { kind: 'auth' } });
 expect(h.fetcher).toHaveBeenCalledTimes(1);
});
it('does not send a refresh if the vault cannot record its pending state', async () => {
 const h = harness(); h.storage.write = async () => { throw new Error('read only'); };
 await expect(h.rotation().token(credentials, 'app')).rejects.toMatchObject({ failure: { kind: 'transient' } });
 expect(h.fetcher).not.toHaveBeenCalled();
});
it('saves a consumed refresh token even when the caller is cancelled during the exchange', async () => {
 const h = harness(); let valid = true;
 h.fetcher.mockImplementationOnce(async () => { valid = false; return new Response(JSON.stringify({ ok: true, token_type: 'app_level', access_token: 'xoxe.xapp-renewed-token', refresh_token: 'xoxe-renewed-refresh', expires_in: 43200 })); });
 await expect(h.rotation().token(credentials, 'app', undefined, () => valid)).rejects.toMatchObject({ failure: { kind: 'blocked' } });
 expect(await h.rotation().token(credentials, 'app')).toBe('xoxe.xapp-renewed-token'); expect(h.fetcher).toHaveBeenCalledTimes(1);
});
it('retries explicit rate limiting without losing the refresh token', async () => {
 const h = harness(); h.fetcher.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '2' } }));
 await expect(h.rotation().token(credentials, 'app')).rejects.toMatchObject({ failure: { kind: 'rate_limited', retryAfterMs: 2000 } });
 await h.rotation().token(credentials, 'app'); expect(h.fetcher).toHaveBeenCalledTimes(2);
});
it('renews bot tokens independently of app tokens', async () => {
 const h = harness(); h.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, token_type: 'bot', access_token: 'xoxe.xoxb-renewed-token', refresh_token: 'xoxe-new-bot-refresh', expires_in: 43200 })));
 expect(await h.rotation().token({ ...credentials, botToken: 'xoxe.xoxb-original-token', botRefreshToken: 'xoxe-original-bot-refresh' }, 'bot')).toBe('xoxe.xoxb-renewed-token');
 expect(new URLSearchParams(h.fetcher.mock.calls[0]![1]!.body as string).get('refresh_token')).toBe('xoxe-original-bot-refresh');
});
it('never sends a refresh after cancellation and never exposes provider error text', async () => {
 const h = harness();
 await expect(h.rotation().token(credentials, 'app', undefined, () => false)).rejects.toMatchObject({ failure: { kind: 'blocked' } });
 expect(h.fetcher).not.toHaveBeenCalled();
 h.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'invalid_refresh_token', secret: credentials.clientSecret })));
 await expect(h.rotation().token(credentials, 'app')).rejects.toMatchObject({ failure: { kind: 'auth' }, message: 'Chat transport: auth' });
 await expect(h.rotation().token(credentials, 'app')).rejects.toMatchObject({ failure: { kind: 'auth' } });
 expect(h.fetcher).toHaveBeenCalledTimes(1);
});
it('does not repeat an exchange when saving its result fails', async () => {
 const h = harness(), write = h.storage.write; let writes = 0;
 h.storage.write = async (key, value) => { if (++writes === 2) throw new Error('disk full'); await write(key, value); };
 await expect(h.rotation().token(credentials, 'app')).rejects.toMatchObject({ failure: { kind: 'transient' } });
 await expect(h.rotation().token(credentials, 'app')).rejects.toMatchObject({ failure: { kind: 'auth' } });
 expect(h.fetcher).toHaveBeenCalledTimes(1);
});
it('persists renewed credentials encrypted with cezar-only audience across a real vault restart', async () => {
 const { mkdtemp, readFile, rm } = await import('node:fs/promises');
 const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
 const { SecretStore } = await import('../../../workspace/secrets.ts');
 const { slackRotationStorage } = await import('./rotation.ts');
 const root = await mkdtemp(join(tmpdir(), 'slack-rotation-'));
 try {
  const home = join(root, 'home'), scope = { kind: 'project' as const, projectId: 'rotation-test', root };
  const create = () => new SecretStore({ ...process.env, CEZ_HOME: home }, { keychain: async () => null });
  const h = harness(), store = create();
  const rotation = new SlackTokenRotation(slackRotationStorage(scope, store), h.fetcher);
  await rotation.token(credentials, 'app');
  const disk = await readFile(join(home, 'secrets/rotation-test.json'), 'utf8');
  expect(disk).not.toContain('xoxe'); expect(disk).not.toContain(credentials.clientSecret);
  expect((await store.resolve({ projectId: scope.projectId, root }, 'checks')).values).toEqual({});
  const restarted = new SlackTokenRotation(slackRotationStorage(scope, create()), h.fetcher);
  expect(await restarted.token(credentials, 'app')).toBe('xoxe.xapp-renewed-token');
  expect(h.fetcher).toHaveBeenCalledTimes(1);
 } finally { await rm(root, { recursive: true, force: true }); }
});
it('keeps the refresh token reusable when cancelled before the exchange starts', async () => {
 const h = harness(), write = h.storage.write; let valid = true;
 h.storage.write = async (key, value) => { await write(key, value); if (JSON.parse(value).phase === 'pending') valid = false; };
 await expect(h.rotation().token(credentials, 'app', undefined, () => valid)).rejects.toMatchObject({ failure: { kind: 'blocked' } });
 expect(h.fetcher).not.toHaveBeenCalled();
 h.storage.write = write;
 expect(await h.rotation().token(credentials, 'app')).toBe('xoxe.xapp-renewed-token');
 expect(h.fetcher).toHaveBeenCalledTimes(1);
});
it('keeps the refresh token when the exchange never left the machine (offline, DNS, refused)', async () => {
 const h = harness();
 h.fetcher.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
 await expect(h.rotation().token(credentials, 'app')).rejects.toMatchObject({ failure: { kind: 'transient' } });
 expect(await h.rotation().token(credentials, 'app')).toBe('xoxe.xapp-renewed-token');
 expect(new URLSearchParams(h.fetcher.mock.calls[1]![1]!.body as string).get('refresh_token')).toBe(credentials.appRefreshToken);
});
it('bounds refresh responses and preserves pending uncertainty after an oversized reply', async () => {
 const h = harness()
 h.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ok:true,token_type:'app_level',access_token:'xoxe.xapp-renewed-token',refresh_token:'xoxe-renewed-refresh',expires_in:43200,padding:'x'.repeat(65536)})))
 await expect(h.rotation().token(credentials,'app')).rejects.toBeDefined()
 await expect(h.rotation().token(credentials,'app')).rejects.toMatchObject({failure:{kind:'auth'}})
 expect(h.fetcher).toHaveBeenCalledTimes(1)
})
