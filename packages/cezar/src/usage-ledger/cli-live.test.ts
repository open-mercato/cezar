import { describe, expect, it, vi } from 'vitest';
import { formatAccountUsage, runUsageCommand } from './cli.ts';

const report = { generatedAt: 'now', accounts: [
  { key: 'codex:work', provider: 'codex', accountId: 'work', label: 'Work', status: 'ok', source: 'probe', windows: [{ kind: 'five-hour', usedPercent: 41.6, resetsAt: '2026-11-27T10:00:00.000Z' }] },
  { key: 'claude:default', provider: 'claude', accountId: 'default', label: 'Default', status: 'not-allowed', message: 'usage check not allowed', windows: [] },
] };
const io = () => { const out: string[] = []; const err: string[] = []; return { out, err, io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) } }; };

describe('cez usage --live', () => {
  it('prints one line per account, with "not allowed" never as 0%', async () => {
    const t = io();
    const doFetch = vi.fn(async () => new Response(JSON.stringify(report))) as unknown as typeof fetch;
    expect(await runUsageCommand(['--live'], t.io, { CEZ_API_URL: 'http://127.0.0.1:1/' }, doFetch)).toBe(0);
    expect(t.out[0]).toContain('codex:work (Work): five-hour 42% used, resets 2026-11-27T10:00:00.000Z');
    expect(t.out[0]).toContain('claude:default (Default): not-allowed');
    expect(t.out[0]).not.toContain('0%');
    expect(doFetch).toHaveBeenCalledWith('http://127.0.0.1:1/api/v1/workspace/account-usage');
  });

  it('passes --account and prints JSON', async () => {
    const t = io();
    const doFetch = vi.fn(async () => new Response(JSON.stringify(report))) as unknown as typeof fetch;
    await runUsageCommand(['--live', '--account', 'codex:work', '--json'], t.io, { CEZ_API_URL: 'http://h' }, doFetch);
    expect(doFetch).toHaveBeenCalledWith('http://h/api/v1/workspace/account-usage?account=codex%3Awork');
    expect(JSON.parse(t.out[0]!).accounts).toHaveLength(2);
  });

  it('explains a missing cockpit instead of reading anything locally', async () => {
    const t = io();
    expect(await runUsageCommand(['--live'], t.io, { CEZ_TASK_ID: 'x' }, vi.fn() as unknown as typeof fetch)).toBe(2);
    expect(t.err.join('\n')).toContain('CEZ_API_URL is not set');
  });

  it('reports a refused or unreachable cockpit without the body', async () => {
    const t = io();
    const refused = vi.fn(async () => new Response(JSON.stringify({ error: 'local only' }), { status: 409 })) as unknown as typeof fetch;
    expect(await runUsageCommand(['--live'], t.io, { CEZ_API_URL: 'http://h' }, refused)).toBe(1);
    expect(t.err[0]).toBe('cez usage --live: local only');
    const down = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await runUsageCommand(['--live'], t.io, { CEZ_API_URL: 'http://h' }, down)).toBe(1);
  });

  it('formats an empty report', () => { expect(formatAccountUsage({ generatedAt: 'x', accounts: [] })).toMatch(/No agent accounts/); });
});
