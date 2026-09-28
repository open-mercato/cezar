import { describe, expect, it } from 'vitest';
import { bodyFromAddFlags, parseEvery, runAutomationCommand, type AutomationCliIo } from './automation-cli.ts';
import { AUTOMATION_SCHEMA_REFERENCE } from './prompts.ts';

/** The `cez automation` CLI is a thin client: what is pinned is the request it builds from the
 *  definition and env, how it relays a refusal, and that it never talks to a server it was not
 *  given — never the routes, which have their own tests (`server/automations-api.test.ts`). */
describe('cez automation', () => {
  const env = { CEZ_API_URL: 'http://127.0.0.1:4321/', CEZ_PROJECT_ID: 'proj' };

  const definition = {
    name: 'Review new PRs',
    events: ['pull_request.opened'],
    intervalSeconds: 300,
    filters: { lookbackDays: 7, maxRecords: 25 },
    task: { prompt: 'Review #{{github.number}}', worktree: true, autonomous: true },
  };

  type Reply = { status: number; body?: unknown };
  const harness = (replies: Reply[] | ((url: string, init?: RequestInit) => Reply), files: Record<string, string> = {}, stdin = '') => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const out: string[] = [];
    const err: string[] = [];
    const queue = Array.isArray(replies) ? [...replies] : null;
    const io: AutomationCliIo = {
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const reply = queue ? (queue.shift() ?? { status: 500, body: { error: 'unexpected call' } }) : (replies as (url: string, init?: RequestInit) => Reply)(String(url), init);
        return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
          status: reply.status,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
      log: (line) => out.push(line),
      error: (line) => err.push(line),
      readFile: async (path) => {
        if (!(path in files)) throw new Error(`ENOENT: ${path}`);
        return files[path]!;
      },
      readStdin: async () => stdin,
      sleep: async () => {},
    };
    return { calls, out, err, io };
  };

  it('create posts the definition from --file to the project-scoped route, paused, and prints the cockpit link', async () => {
    const h = harness([{ status: 201, body: { automation: { id: 'auto-1', name: 'Review new PRs', enabled: false } } }], { '/tmp/def.json': JSON.stringify(definition) });
    const code = await runAutomationCommand(['create', '--file', '/tmp/def.json'], env, h.io);
    expect(code).toBe(0);
    expect(h.calls[0]?.url).toBe('http://127.0.0.1:4321/api/v1/p/proj/automations');
    expect(h.calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(h.calls[0]?.init?.body))).toEqual(definition);
    expect(h.out[0]).toContain('created automation auto-1 "Review new PRs" — paused');
    expect(h.out[1]).toBe('cockpit: http://127.0.0.1:4321/p/proj/automations/auto-1');
    expect(h.out[2]).toContain('cez automation check auto-1');
  });

  it('create --enable (or a definition carrying enabled: true) sends the route’s enable flag, never a body key it refuses', async () => {
    const h = harness([
      { status: 201, body: { automation: { id: 'a', name: 'n', enabled: true } } },
      { status: 201, body: { automation: { id: 'b', name: 'n', enabled: true } } },
    ]);
    expect(await runAutomationCommand(['create', '--enable', '--json', JSON.stringify(definition)], env, h.io)).toBe(0);
    expect(JSON.parse(String(h.calls[0]?.init?.body))).toEqual({ ...definition, enable: true });
    expect(h.out[0]).toContain('ENABLED from a current-time baseline');
    expect(await runAutomationCommand(['create', '--json', JSON.stringify({ ...definition, enabled: true })], env, h.io)).toBe(0);
    const second = JSON.parse(String(h.calls[1]?.init?.body)) as Record<string, unknown>;
    expect(second.enable).toBe(true);
    expect('enabled' in second).toBe(false);
  });

  it('create reads the definition from stdin when neither --file nor --json is given', async () => {
    const h = harness([{ status: 201, body: { automation: { id: 'a', name: 'n', enabled: false } } }], {}, JSON.stringify(definition));
    expect(await runAutomationCommand(['create'], env, h.io)).toBe(0);
    expect(JSON.parse(String(h.calls[0]?.init?.body))).toEqual(definition);
    const empty = harness([], {}, '');
    expect(await runAutomationCommand(['create'], env, empty.io)).toBe(1);
    expect(empty.err[0]).toContain('no definition given');
    expect(empty.calls).toHaveLength(0);
  });

  it('create rejects malformed input before any request: invalid JSON, a non-object, both flags at once', async () => {
    const bad = harness([]);
    expect(await runAutomationCommand(['create', '--json', '{not json'], env, bad.io)).toBe(1);
    expect(bad.err[0]).toContain('not valid JSON');
    const array = harness([]);
    expect(await runAutomationCommand(['create', '--json', '[1]'], env, array.io)).toBe(1);
    expect(array.err[0]).toContain('must be a JSON object');
    const both = harness([], { '/d.json': '{}' });
    expect(await runAutomationCommand(['create', '--file', '/d.json', '--json', '{}'], env, both.io)).toBe(1);
    expect(both.err[0]).toContain('--file OR --json');
    expect([...bad.calls, ...array.calls, ...both.calls]).toHaveLength(0);
  });

  it('create relays the cockpit’s refusal — the automations-off 409 included — with a non-zero exit', async () => {
    const h = harness([{ status: 409, body: { error: 'GitHub automations are disabled — set CEZ_AUTOMATIONS=1 to enable them' } }]);
    expect(await runAutomationCommand(['create', '--json', JSON.stringify(definition)], env, h.io)).toBe(1);
    expect(h.err[0]).toBe('cez automation: create refused — GitHub automations are disabled — set CEZ_AUTOMATIONS=1 to enable them');
  });

  it('update reads the current definition, merges the patch over its editable keys, restates enabled and echoes the revision', async () => {
    const stored = { id: 'auto-1', revision: 3, enabled: true, createdAt: 't', updatedAt: 't', description: 'old', ...definition };
    const h = harness([
      { status: 200, body: { automation: stored } },
      { status: 200, body: { automation: { id: 'auto-1', name: 'Review new PRs', revision: 4, enabled: true } } },
    ]);
    const code = await runAutomationCommand(['update', 'auto-1', '--json', JSON.stringify({ intervalSeconds: 900, task: { prompt: 'new prompt' } })], env, h.io);
    expect(code).toBe(0);
    expect(h.calls[0]?.url).toBe('http://127.0.0.1:4321/api/v1/p/proj/automations/auto-1');
    expect(h.calls[1]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(h.calls[1]?.init?.body))).toEqual({
      name: 'Review new PRs',
      description: 'old',
      events: ['pull_request.opened'],
      intervalSeconds: 900,
      filters: { lookbackDays: 7, maxRecords: 25 },
      task: { prompt: 'new prompt' },
      enabled: true,
      expectedRevision: 3,
    });
    expect(h.out[0]).toContain('updated automation auto-1 "Review new PRs" (revision 4, enabled)');
  });

  it('check queues a preview, polls the workspace-level check until it completes, and launches nothing', async () => {
    let polls = 0;
    const h = harness((url, init) => {
      if (url.endsWith('/check')) return { status: 202, body: { checkId: 'chk-9' } };
      expect(url).toBe('http://127.0.0.1:4321/api/v1/automation-checks/chk-9');
      expect(init?.method).toBeUndefined();
      polls += 1;
      return polls < 3
        ? { status: 200, body: { id: 'chk-9', status: 'running' } }
        : { status: 200, body: { id: 'chk-9', status: 'complete', matches: 2, truncated: false } };
    });
    expect(await runAutomationCommand(['check', 'auto-1'], env, h.io)).toBe(0);
    expect(h.calls[0]?.url).toBe('http://127.0.0.1:4321/api/v1/p/proj/automations/auto-1/check');
    expect(JSON.parse(String(h.calls[0]?.init?.body))).toEqual({ mode: 'preview' });
    expect(polls).toBe(3);
    expect(h.out[0]).toBe('preview: 2 matches right now — nothing was launched');
  });

  it('check --execute sends the execute mode, and a failed check exits non-zero with its error', async () => {
    const ok = harness([
      { status: 202, body: { checkId: 'c' } },
      { status: 200, body: { status: 'complete', matches: 1 } },
    ]);
    expect(await runAutomationCommand(['check', 'auto-1', '--execute'], env, ok.io)).toBe(0);
    expect(JSON.parse(String(ok.calls[0]?.init?.body))).toEqual({ mode: 'execute' });
    expect(ok.out[0]).toContain('execute: 1 match');
    const failed = harness([
      { status: 202, body: { checkId: 'c' } },
      { status: 200, body: { status: 'error', error: 'No GitHub remote is configured' } },
    ]);
    expect(await runAutomationCommand(['check', 'auto-1'], env, failed.io)).toBe(1);
    expect(failed.err[0]).toContain('check failed — No GitHub remote is configured');
  });

  it('list, show, enable, pause and delete address the project-scoped routes', async () => {
    const list = harness([{ status: 200, body: { available: true, automations: [
      { id: 'a1', name: 'One', enabled: true, events: ['issue.opened'], intervalSeconds: 300, counts: { launched: 2, duplicates: 0, errors: 1 }, state: { nextCheckAt: '2026-09-13T10:00:00.000Z' } },
      { id: 'a2', name: 'Two', enabled: false, events: ['pull_request.opened'], intervalSeconds: 3600, counts: { launched: 0, duplicates: 0, errors: 0 } },
    ] } }]);
    expect(await runAutomationCommand(['list'], env, list.io)).toBe(0);
    expect(list.calls[0]?.url).toBe('http://127.0.0.1:4321/api/v1/p/proj/automations');
    expect(list.out[0]).toContain('a1  enabled  every 300s  issue.opened  launched 2, duplicates 0, errors 1  next 2026-09-13T10:00:00.000Z  One');
    expect(list.out[1]).toContain('a2  paused ');

    const show = harness([{ status: 200, body: { automation: { id: 'a1' }, state: { revision: 1 } } }]);
    expect(await runAutomationCommand(['show', 'a1'], env, show.io)).toBe(0);
    expect(JSON.parse(show.out[0]!)).toEqual({ automation: { id: 'a1' }, state: { revision: 1 } });

    const enable = harness([{ status: 200, body: { automation: { id: 'a1', name: 'One' } } }]);
    expect(await runAutomationCommand(['enable', 'a1'], env, enable.io)).toBe(0);
    expect(enable.calls[0]?.url).toBe('http://127.0.0.1:4321/api/v1/p/proj/automations/a1/enable');
    expect(enable.calls[0]?.init?.method).toBe('POST');
    expect(enable.out[0]).toContain('enabled automation a1 "One" from a current-time baseline');

    const pause = harness([{ status: 200, body: { automation: { id: 'a1', name: 'One' } } }]);
    expect(await runAutomationCommand(['pause', 'a1'], env, pause.io)).toBe(0);
    expect(pause.calls[0]?.url).toBe('http://127.0.0.1:4321/api/v1/p/proj/automations/a1/pause');

    const del = harness([{ status: 204 }]);
    expect(await runAutomationCommand(['delete', 'a1'], env, del.io)).toBe(0);
    expect(del.calls[0]?.init?.method).toBe('DELETE');
    expect(del.out[0]).toBe('deleted automation a1');
  });

  it('schema prints the reference without a server; every other command refuses without one', async () => {
    const schema = harness([]);
    expect(await runAutomationCommand(['schema'], {}, schema.io)).toBe(0);
    expect(schema.out[0]).toBe(AUTOMATION_SCHEMA_REFERENCE);
    const none = harness([]);
    expect(await runAutomationCommand(['list'], {}, none.io)).toBe(2);
    expect(none.err[0]).toContain('CEZ_API_URL is not set');
    expect(none.err[0]).toContain('Do not substitute a cron job');
    expect(none.calls).toHaveLength(0);
  });

  it('falls back to the unscoped API and link without a project id', async () => {
    const h = harness([{ status: 201, body: { automation: { id: 'x', name: 'n', enabled: false } } }]);
    expect(await runAutomationCommand(['create', '--json', JSON.stringify(definition)], { CEZ_API_URL: 'http://127.0.0.1:1' }, h.io)).toBe(0);
    expect(h.calls[0]?.url).toBe('http://127.0.0.1:1/api/v1/automations');
    expect(h.out[1]).toBe('cockpit: http://127.0.0.1:1/automations/x');
  });

  it('prints usage for help and for an unknown command', async () => {
    const help = harness([]);
    expect(await runAutomationCommand(['help'], {}, help.io)).toBe(0);
    expect(help.out[0]).toContain('cez automation create');
    const unknown = harness([]);
    expect(await runAutomationCommand(['frobnicate'], env, unknown.io)).toBe(2);
    expect(unknown.err[0]).toContain('unknown command "frobnicate"');
    const bare = harness([]);
    expect(await runAutomationCommand([], env, bare.io)).toBe(2);
  });
});

describe('cez automation add / run (spec 2026-09-14)', () => {
  const env = { CEZ_API_URL: 'http://127.0.0.1:4321', CEZ_PROJECT_ID: 'proj' };
  const harness = (replies: Array<{ status: number; body?: unknown }>) => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const out: string[] = [];
    const err: string[] = [];
    const io: AutomationCliIo = {
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const reply = replies.shift() ?? { status: 500, body: { error: 'unexpected call' } };
        return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
      log: (line) => out.push(line),
      error: (line) => err.push(line),
      readFile: async (path) => (path === '/tmp/prompt.md' ? 'Bump deps on {{date}}' : Promise.reject(new Error('ENOENT'))),
      sleep: async () => {},
    };
    return { calls, out, err, io };
  };

  it('add --cron posts a schedule built from the flags and prints its label', async () => {
    const h = harness([{ status: 201, body: { automation: { id: 's1', name: 'Nightly', enabled: false, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 } } } }]);
    const code = await runAutomationCommand(['add', '--name', 'Nightly', '--cron', '0 4 * * *', '--prompt-file', '/tmp/prompt.md', '--workflow', 'fix-and-verify', '--runner', 'claude', '--model', 'sonnet', '--dispatch', '--max-subtasks', '4', '--review-child'], env, h.io);
    expect(code).toBe(0);
    expect(JSON.parse(String(h.calls[0]?.init?.body))).toEqual({
      name: 'Nightly', kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 },
      task: { prompt: 'Bump deps on {{date}}', worktree: true, autonomous: true, workflow: 'fix-and-verify', runner: 'claude', model: 'sonnet', dispatch: { maxSubtasks: 4, reviewChild: true } },
    });
    expect(h.out[0]).toContain('paused — every day at 04:00');
    expect(h.out[2]).toContain('cez automation run s1');
  });

  it('add --on posts a GitHub poll with labels, authors and the interval; --enable rides along', async () => {
    const h = harness([{ status: 201, body: { automation: { id: 'g1', name: 'Triage', enabled: true, kind: 'github' } } }]);
    const code = await runAutomationCommand(['add', '--name', 'Triage', '--on', 'issue.opened,issue.labeled', '--every', '1h', '--label', 'bug', '--label', 'regression', '--author', 'alice', '--no-autonomous', '--enable', '--prompt', 'Read {{github.url}}'], env, h.io);
    expect(code).toBe(0);
    expect(JSON.parse(String(h.calls[0]?.init?.body))).toEqual({
      name: 'Triage', kind: 'github', events: ['issue.opened', 'issue.labeled'], intervalSeconds: 3600,
      filters: { lookbackDays: 7, maxRecords: 25, anyLabels: ['bug', 'regression'], authors: ['alice'] },
      task: { prompt: 'Read {{github.url}}', worktree: true, autonomous: false }, enable: true,
    });
    expect(h.out[0]).toContain('ENABLED from a current-time baseline');
  });

  it('add refuses a cron shape it cannot express, and missing flags, as usage errors before any request', async () => {
    const h = harness([]);
    expect(await runAutomationCommand(['add', '--name', 'x', '--cron', '*/15 * * * *', '--prompt', 'p'], env, h.io)).toBe(2);
    expect(h.err[0]).toContain('not one of the shapes');
    expect(h.err[0]).toContain('cez automation schema');
    expect(await runAutomationCommand(['add', '--name', 'x', '--prompt', 'p'], env, h.io)).toBe(2);
    expect(await runAutomationCommand(['add', '--cron', '0 4 * * *', '--prompt', 'p'], env, h.io)).toBe(2);
    expect(await runAutomationCommand(['add', '--name', 'x', '--cron', '0 4 * * *', '--on', 'issue.opened', '--prompt', 'p'], env, h.io)).toBe(2);
    expect(h.calls).toEqual([]);
  });

  it('run posts to the run route and reports the queued task', async () => {
    const h = harness([{ status: 202, body: { runId: 'run-9' } }]);
    expect(await runAutomationCommand(['run', 's1'], env, h.io)).toBe(0);
    expect(h.calls[0]).toMatchObject({ url: 'http://127.0.0.1:4321/api/v1/p/proj/automations/s1/run', init: { method: 'POST' } });
    expect(h.out[0]).toContain('task run-9 is queued');
    const refused = harness([{ status: 409, body: { error: 'a GitHub automation is run through check with mode execute' } }]);
    expect(await runAutomationCommand(['run', 'g1'], env, refused.io)).toBe(1);
    expect(refused.err[0]).toContain('run refused — a GitHub automation is run through check');
  });

  it('parses --every and maps flags to a body', () => {
    expect(parseEvery('5m')).toBe(300);
    expect(parseEvery('2h')).toBe(7200);
    expect(parseEvery('90s')).toBe(90);
    expect(parseEvery('45')).toBe(45);
    expect(() => parseEvery('soon')).toThrow('--every');
    expect(bodyFromAddFlags({ name: 'w', cron: '30 7 * * 1-5' }, 'p')).toMatchObject({ kind: 'schedule', schedule: { type: 'weekdays', hour: 7, minute: 30 } });
  });
});

it('tracker flags build a provider event trigger with a 30 minute default', () => {
  expect(bodyFromAddFlags({ name: 'Jira work', kind: 'tracker', on: 'issue.status_changed', 'to-status': ['todo-id'] }, 'Implement')).toMatchObject({
    kind: 'tracker', intervalSeconds: 1800,
    trackerTrigger: { events: ['issue.status_changed'], targetStatusIds: ['todo-id'] },
  });
});
it('rejects tracker-only filters on GitHub flags instead of silently dropping them', () => {
  expect(() => bodyFromAddFlags({ name: 'work', on: 'issue.opened', 'to-status': ['todo'] }, 'Implement')).toThrow(/tracker/);
});

it('tracker add resolves the project association before posting the trigger', async () => {
  const association = { kind: 'jira', source: { id: 'cloud', webUrl: 'https://example.atlassian.net' }, externalId: '100', externalName: 'Team', connectionId: '11111111-1111-4111-8111-111111111111' };
  const calls: Array<{ url: string; body?: unknown }> = [];
  const errors: string[] = [];
  const code = await runAutomationCommand(['add', '--kind', 'tracker', '--name', 'Jira work', '--on', 'issue.status_changed', '--to-status', 'todo-id', '--require-label', 'bug', '--require-label', 'urgent', '--prompt', 'Implement'], { CEZ_API_URL: 'http://localhost:4321', CEZ_PROJECT_ID: 'project' }, {
    fetch: (async (input, init) => {
      const url = String(input); calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      return new Response(JSON.stringify(url.endsWith('/automation-options')
        ? { available: true, association, events: ['issue.status_changed'], statuses: [{ id: 'todo-id', name: 'To Do' }], labels: [], limitations: [] }
        : { automation: { id: 'auto', name: 'Jira work', kind: 'tracker', enabled: false } }), { status: url.endsWith('/automation-options') ? 200 : 201, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
    log: () => {}, error: message => errors.push(message),
  });
  expect(errors).toEqual([]); expect(code).toBe(0);
  expect(calls[0]?.url).toBe('http://localhost:4321/api/v1/p/project/tracker/automation-options');
  expect(calls[1]?.body).toMatchObject({ trackerTrigger: { association, events: ['issue.status_changed'], targetStatusIds: ['todo-id'], requiredLabels: ['bug', 'urgent'] } });
});

it('rejects required tracker labels on other automation kinds', () => {
  expect(() => bodyFromAddFlags({ name: 'work', on: 'issue.opened', 'require-label': ['bug'] }, 'Implement')).toThrow(/tracker/);
});
