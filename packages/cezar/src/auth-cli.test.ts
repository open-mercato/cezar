import { describe, expect, it, vi } from 'vitest';
import { runAuthCommand } from './auth-cli.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from './workspace/config.ts';

describe('cezar auth (spec 2026-10-20-lan-basic-auth-https)', () => {
  const io = () => {
    const lines: string[] = [];
    return { lines, io: { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) } };
  };

  it('reset turns LAN access off and forgets the credentials, leaving the rest of the config', async () => {
    await mergeWriteWorkspaceConfig((config) => {
      config.security = { lanAccess: true, auth: { username: 'alex', salt: 'ab', hash: 'cd' } };
      config.modelsLocked = true;
    });
    const status = io();
    expect(await runAuthCommand([], status.io)).toBe(0);
    expect(status.lines.join('\n')).toContain('LAN access: on');
    expect(status.lines.join('\n')).toContain('user "alex"');

    expect(await runAuthCommand(['reset'], io().io, { fetch: () => Promise.reject(new Error('offline')) })).toBe(0);
    const config = await loadWorkspaceConfig();
    expect(config.security).toBeUndefined();
    expect(config.modelsLocked).toBe(true);
  });

  it('notifies a running cockpit when reset is called and it answers', async () => {
    await mergeWriteWorkspaceConfig((config) => {
      config.security = { lanAccess: true, auth: { username: 'alex', salt: 'ab', hash: 'cd' } };
    });
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const mockFetch = vi.fn(async (input: string | URL, init?: { method?: string; body?: unknown }) => {
      calls.push({ url: String(input), method: init?.method, body: init?.body ? String(init.body) : undefined });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const out = io();
    expect(await runAuthCommand(['reset'], out.io, { fetch: mockFetch as unknown as typeof fetch, apiUrl: 'http://127.0.0.1:4321' })).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:4321/api/v1/security/lan');
    expect(calls[0]?.method).toBe('PUT');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ lanAccess: false });
    expect(out.lines.join('\n')).toContain('Notified the running cockpit — LAN listener closed.');
  });

  it('rejects an unknown subcommand with the usage', async () => {
    const out = io();
    expect(await runAuthCommand(['nope'], out.io)).toBe(1);
    expect(out.lines.join('\n')).toContain('cezar auth reset');
  });
});
