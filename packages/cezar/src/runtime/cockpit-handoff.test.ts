import { describe, expect, it, vi } from 'vitest';
import type { CockpitRuntimeRecord } from './cockpit-runtime.ts';
import { handoffProject } from './cockpit-handoff.ts';

const runtime: CockpitRuntimeRecord = {
  schema: 1,
  slot: 'interactive',
  runtimeId: '00000000-0000-4000-8000-000000000001',
  origin: 'http://127.0.0.1:4321',
  port: 4321,
  version: '0.0.0-test',
  startedAt: '2026-10-28T00:00:00.000Z',
  owner: {
    token: '00000000-0000-4000-8000-000000000002',
    pid: 123,
    start: '42',
    boot: 'boot',
    host: 'host',
  },
};

const project = {
  id: 'my-project',
  name: 'My Project',
  root: '/work/my-project',
  addedAt: '2026-10-28T00:00:00.000Z',
  lastOpenedAt: '2026-10-28T00:00:00.000Z',
  source: 'local' as const,
  status: 'ok' as const,
};

describe('cockpit project handoff', () => {
  it.each([
    [200, true, 'added'],
    [409, false, 'opened'],
  ] as const)('treats HTTP %s as success and opens the scoped project', async (status, added, word) => {
    const open = vi.fn();
    const log = vi.fn();
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ root: '/work/my-project' });
      expect(new Headers(init?.headers).get('x-cezar-runtime-handoff')).toBe(runtime.owner.token);
      return new Response(JSON.stringify({ project, ...(status === 409 ? { error: 'already registered' } : {}) }), { status });
    });
    const result = await handoffProject(runtime, '/work/my-project', { fetcher, open, log });
    expect(result).toEqual({
      projectId: 'my-project',
      projectName: 'My Project',
      added,
      url: 'http://127.0.0.1:4321/p/my-project/',
    });
    expect(open).toHaveBeenCalledWith(result.url);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(word));
  });

  it('does not open a browser under --no-open and fails closed on malformed errors', async () => {
    const open = vi.fn();
    await handoffProject(runtime, '/work/my-project', {
      fetcher: async () => new Response(JSON.stringify({ project }), { status: 200 }),
      open,
      openBrowser: false,
      log: () => undefined,
    });
    expect(open).not.toHaveBeenCalled();

    await expect(handoffProject(runtime, '/work/my-project', {
      fetcher: async () => new Response(JSON.stringify({ error: 'no' }), { status: 500 }),
      log: () => undefined,
    })).rejects.toThrow('refused project registration');
  });
});
