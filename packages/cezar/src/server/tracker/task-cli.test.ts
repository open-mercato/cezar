import { expect, it, vi } from 'vitest';
import { runTrackerCommand } from './task-cli.ts';
const env = { CEZ_API_URL: 'http://127.0.0.1:1234', CEZ_PROJECT_ID: 'example', CEZ_TRACKER_CAPABILITY: 'synthetic-session-capability' };
it('refuses a missing capability or non-loopback server without making requests', async () => {
  const io = { fetch: vi.fn(), log: vi.fn(), error: vi.fn() };
  expect(await runTrackerCommand(['read'], {}, io)).toBe(2);
  expect(await runTrackerCommand(['read'], { ...env, CEZ_API_URL: 'https://example.com' }, io)).toBe(2);
  expect(io.fetch).not.toHaveBeenCalled();
  expect(JSON.stringify(io.error.mock.calls)).not.toContain(env.CEZ_TRACKER_CAPABILITY);
});
it('sends typed status actions with a stable ID, carries the capability only in a header, and surfaces unknown results', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const io = { fetch: vi.fn(async () => new Response(JSON.stringify({ operationId: id, status: 'unknown', message: 'Inspect issue.' }))), log: vi.fn(), error: vi.fn() };
  expect(await runTrackerCommand(['transition', '--id', id, '--transition', 'done', '--expected-status', 'todo'], env, io)).toBe(2);
  expect(io.fetch).toHaveBeenCalledWith('http://127.0.0.1:1234/api/v1/p/example/tracker/task', expect.objectContaining({ redirect: 'error', headers: { Authorization: `Bearer ${env.CEZ_TRACKER_CAPABILITY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId: id, action: { kind: 'transition', transitionId: 'done', expectedStatusId: 'todo' } }) }));
  expect(JSON.stringify(io.log.mock.calls)).not.toContain(env.CEZ_TRACKER_CAPABILITY);
});
it('passes the server reason through and tells usage errors apart', async () => {
  const io = { fetch: vi.fn(async () => new Response(JSON.stringify({ error: 'Tracker task access denied.' }), { status: 403 })), log: vi.fn(), error: vi.fn() };
  expect(await runTrackerCommand(['read'], env, io)).toBe(2);
  expect(io.error).toHaveBeenLastCalledWith('Tracker request refused (403): Tracker task access denied.');
  expect(await runTrackerCommand(['comment', '--id', 'not-a-uuid', '--body-file', '/nonexistent/file'], env, io)).toBe(1);
  expect(String(io.error.mock.lastCall?.[0])).toContain('Cannot read --body-file');
  expect(await runTrackerCommand(['transition', '--id', 'not-a-uuid', '--transition', 'a', '--expected-status', 'b'], env, io)).toBe(1);
  expect(String(io.error.mock.lastCall?.[0])).toContain('operationId');
  expect(await runTrackerCommand(['delete'], env, io)).toBe(1);
  expect(io.fetch).toHaveBeenCalledTimes(1);
});
it('warns that a write may have landed when the cockpit cannot be reached', async () => {
  const io = { fetch: vi.fn(async () => { throw new TypeError('fetch failed'); }), log: vi.fn(), error: vi.fn() };
  expect(await runTrackerCommand(['transition', '--id', '11111111-1111-4111-8111-111111111111', '--transition', 'a', '--expected-status', 'b'], env, io)).toBe(2);
  expect(String(io.error.mock.lastCall?.[0])).toContain('SAME --id');
});
it('warns that a write may have landed when the server fails after authorizing it', async () => {
  const io = { fetch: vi.fn(async () => new Response(JSON.stringify({ error: 'Tracker operation unavailable.' }), { status: 409 })), log: vi.fn(), error: vi.fn() };
  expect(await runTrackerCommand(['transition', '--id', '11111111-1111-4111-8111-111111111111', '--transition', 'a', '--expected-status', 'b'], env, io)).toBe(2);
  expect(String(io.error.mock.lastCall?.[0])).toMatch(/^Tracker request failed \(409\).*SAME --id/);
});
