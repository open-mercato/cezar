import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '../runs/store.ts';
import { runAlertsCommand } from './alerts-cli.ts';
import {
  alertConfigFromEnv,
  alertEventFor,
  alertText,
  defaultAlertDeps,
  deliver,
  hermesRequest,
  openclawRequest,
  RunAlerts,
  sendAlert,
  type Alert,
  type AlertDeps,
  type AlertSource,
} from './alerts.ts';

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);

const alert = (overrides: Partial<Alert['task']> = {}, event: Alert['event'] = 'needs-input'): Alert => ({
  event,
  at: NOW,
  task: { id: 'abcdef12-3456', title: 'Fix login', status: 'waiting', project: 'shop', ...overrides },
});

const deps = (fetchImpl: AlertDeps['fetch'], overrides: Partial<AlertDeps> = {}): AlertDeps & { logs: string[] } => {
  const logs: string[] = [];
  return { fetch: fetchImpl, sleep: async () => undefined, now: () => NOW, dryRun: false, log: (line) => logs.push(line), logs, ...overrides };
};

const ok = () => new Response('{}', { status: 200 });

describe('alertConfigFromEnv', () => {
  it('is inert with nothing set, defaulting to the quiet event set', () => {
    const config = alertConfigFromEnv({});
    expect(config.openclaw).toBeUndefined();
    expect(config.hermes).toBeUndefined();
    expect([...config.events].sort()).toEqual(['failed', 'needs-input', 'review']);
  });

  it('parses OpenClaw: bare gateway URL gets /hooks, channel+to go together', () => {
    const config = alertConfigFromEnv({
      CEZ_OPENCLAW_URL: 'http://127.0.0.1:18789',
      CEZ_OPENCLAW_HOOK_TOKEN: 'tok',
      CEZ_OPENCLAW_CHANNEL: 'telegram',
      CEZ_OPENCLAW_TO: '123',
      CEZ_OPENCLAW_AGENT_ID: 'main',
    });
    expect(config.openclaw).toEqual({ url: 'http://127.0.0.1:18789/hooks', token: 'tok', agentId: 'main', delivery: { channel: 'telegram', to: '123' } });
    expect(config.warnings).toEqual([]);
  });

  it('keeps an explicit hooks path and drops a half-specified destination with a warning', () => {
    const config = alertConfigFromEnv({
      CEZ_OPENCLAW_URL: 'https://gw.example.com/my-hooks/',
      CEZ_OPENCLAW_HOOK_TOKEN: 'tok',
      CEZ_OPENCLAW_CHANNEL: 'slack',
    });
    expect(config.openclaw).toEqual({ url: 'https://gw.example.com/my-hooks', token: 'tok' });
    expect(config.warnings.join()).toMatch(/CEZ_OPENCLAW_CHANNEL and CEZ_OPENCLAW_TO/);
  });

  it('turns a target off, with a warning, when its secret is missing', () => {
    const config = alertConfigFromEnv({ CEZ_OPENCLAW_URL: 'http://x', CEZ_HERMES_WEBHOOK_URL: 'http://y' });
    expect(config.openclaw).toBeUndefined();
    expect(config.hermes).toBeUndefined();
    expect(config.warnings).toHaveLength(2);
  });

  it('rejects non-http URLs', () => {
    const config = alertConfigFromEnv({ CEZ_HERMES_WEBHOOK_URL: 'file:///etc/passwd', CEZ_HERMES_WEBHOOK_SECRET: 's' });
    expect(config.hermes).toBeUndefined();
  });

  it('parses CEZ_ALERT_EVENTS, ignoring unknown names', () => {
    const config = alertConfigFromEnv({ CEZ_ALERT_EVENTS: 'done, cancelled,bogus' });
    expect([...config.events].sort()).toEqual(['cancelled', 'done']);
    expect(config.warnings.join()).toMatch(/bogus/);
    expect(alertConfigFromEnv({ CEZ_ALERT_EVENTS: 'all' }).events.size).toBe(5);
    expect(alertConfigFromEnv({ CEZ_ALERT_EVENTS: 'bogus' }).events.size).toBe(3);
  });
});

describe('alertEventFor', () => {
  it('maps only transitions, and only to attention statuses', () => {
    expect(alertEventFor('running', { status: 'waiting' })).toBe('needs-input');
    expect(alertEventFor('running', { status: 'review' })).toBe('review');
    expect(alertEventFor('review', { status: 'done' })).toBe('done');
    expect(alertEventFor('running', { status: 'failed' })).toBe('failed');
    expect(alertEventFor('running', { status: 'cancelled' })).toBe('cancelled');
    expect(alertEventFor('waiting', { status: 'waiting' })).toBeUndefined();
    expect(alertEventFor('queued', { status: 'running' })).toBeUndefined();
  });

  it('treats a session lost on an unanswered question as needs-input, not failed', () => {
    expect(alertEventFor('waiting', { status: 'failed', awaitingAnswerSince: '2026-10-21T00:00:00Z' })).toBe('needs-input');
  });
});

describe('payloads', () => {
  it('text carries title, project, question, branch, PR and link', () => {
    const text = alertText(alert({ question: 'Which DB?', branch: 'cez/abc', prUrl: 'https://github.com/o/r/pull/1', url: 'http://127.0.0.1:4321/p/shop/tasks/abcdef12-3456' }));
    expect(text).toContain('"Fix login" needs your input (project shop, task abcdef12)');
    expect(text).toContain('Question: Which DB?');
    expect(text).toContain('Branch: cez/abc');
    expect(text).toContain('PR: https://github.com/o/r/pull/1');
    expect(text).toContain('Open: http://127.0.0.1:4321/p/shop/tasks/abcdef12-3456');
  });

  it('needs-input without an ask carries the clipped last message; failed carries the error', () => {
    expect(alertText(alert({ detail: 'I need the staging URL.' }))).toContain('Last message: I need the staging URL.');
    expect(alertText(alert({ detail: 'npm test exited 1' }, 'failed'))).toContain('Error: npm test exited 1');
  });

  it('OpenClaw without a destination posts a wake with bearer auth', () => {
    const request = openclawRequest({ url: 'http://gw/hooks', token: 'tok', agentId: 'main' }, alert());
    expect(request.url).toBe('http://gw/hooks/wake');
    expect(request.headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(request.body)).toMatchObject({ mode: 'now', agentId: 'main', text: expect.stringContaining('Fix login') });
  });

  it('OpenClaw with channel+to posts an agent turn that delivers, with an idempotency key', () => {
    const request = openclawRequest({ url: 'http://gw/hooks', token: 'tok', delivery: { channel: 'telegram', to: '42' } }, alert());
    expect(request.url).toBe('http://gw/hooks/agent');
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({ name: 'cezar', deliver: true, channel: 'telegram', to: '42', wakeMode: 'now' });
    expect(body.message).toContain('cezar_send_message');
    expect(body.idempotencyKey).toBe('cezar-abcdef12-3456-needs-input-' + NOW);
    expect(request.headers['idempotency-key']).toBe(body.idempotencyKey);
  });

  it('Hermes signs "<timestamp>.<body>" with HMAC-SHA256 (generic V2) and names the event', () => {
    const request = hermesRequest({ url: 'http://h/webhooks/cezar', secret: 's3cret' }, alert({ question: 'Q?' }, 'review'));
    const timestamp = String(NOW / 1000);
    expect(request.headers['x-webhook-timestamp']).toBe(timestamp);
    expect(request.headers['x-webhook-signature-v2']).toBe(createHmac('sha256', 's3cret').update(`${timestamp}.${request.body}`).digest('hex'));
    expect(request.headers['x-request-id']).toBe('cezar-abcdef12-3456-review-' + NOW);
    const body = JSON.parse(request.body);
    expect(body.event_type).toBe('cezar.task.review');
    expect(body.task).toMatchObject({ id: 'abcdef12-3456', title: 'Fix login', project: 'shop', question: 'Q?' });
    expect(body.message).toContain('Fix login');
  });

  it('never carries more than the allowlisted task fields', () => {
    const run = { id: 'r1', title: 't', status: 'waiting', task: 'SECRET PROMPT', systemPrompt: 'SECRET', steps: [], archived: false, workflow: 'w', createdAt: '', tokensUsed: 0 } as unknown as RunRecord;
    const source = new EventEmitter() as EventEmitter & AlertSource;
    source.listRuns = () => [{ ...run, status: 'running' }];
    const sent: string[] = [];
    const alerts = new RunAlerts(alertConfigFromEnv({ CEZ_HERMES_WEBHOOK_URL: 'http://h/x', CEZ_HERMES_WEBHOOK_SECRET: 's' }), deps(async (_url, init) => { sent.push(String(init?.body)); return ok(); }));
    alerts.watch(source, 'p');
    source.emit('run', run);
    return vi.waitFor(() => expect(sent).toHaveLength(1)).then(() => expect(sent[0]).not.toContain('SECRET'));
  });
});

describe('defaultAlertDeps', () => {
  it('CEZ_DRY_RUN mutes alerts unless the test-only CEZ_ALERTS_LIVE_IN_DRY_RUN=1 is also set', () => {
    expect(defaultAlertDeps({ CEZ_DRY_RUN: '1' }).dryRun).toBe(true);
    expect(defaultAlertDeps({ CEZ_DRY_RUN: '1', CEZ_ALERTS_LIVE_IN_DRY_RUN: '1' }).dryRun).toBe(false);
    expect(defaultAlertDeps({ CEZ_ALERTS_LIVE_IN_DRY_RUN: '1' }).dryRun).toBe(false);
    expect(defaultAlertDeps({}).dryRun).toBe(false);
  });
});

describe('delivery', () => {
  const request = () => hermesRequest({ url: 'http://h/x', secret: 's' }, alert());

  it('retries once after a network error, then succeeds', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce(ok());
    const sleep = vi.fn(async () => undefined);
    const result = await deliver(request(), deps(fetchMock as never, { sleep }));
    expect(result).toMatchObject({ ok: true, detail: '200' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('retries a 5xx but not a 4xx, and reports failure without throwing', async () => {
    const five = vi.fn(async () => new Response('', { status: 503 }));
    expect(await deliver(request(), deps(five as never))).toMatchObject({ ok: false, detail: 'HTTP 503' });
    expect(five).toHaveBeenCalledTimes(2);
    const four = vi.fn(async () => new Response('', { status: 401 }));
    expect(await deliver(request(), deps(four as never))).toMatchObject({ ok: false, detail: 'HTTP 401' });
    expect(four).toHaveBeenCalledTimes(1);
  });

  it('applies a 5s timeout signal', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return ok();
    });
    await deliver(request(), deps(fetchMock as never));
    expect(fetchMock).toHaveBeenCalled();
  });

  it('dry run only logs', async () => {
    const fetchMock = vi.fn();
    const d = deps(fetchMock as never, { dryRun: true });
    expect(await deliver(request(), d)).toMatchObject({ ok: true, detail: 'dry-run' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(d.logs[0]).toMatch(/dry run/);
  });

  it('logs an undelivered alert once', async () => {
    const d = deps((async () => new Response('', { status: 500 })) as never);
    await sendAlert(alertConfigFromEnv({ CEZ_HERMES_WEBHOOK_URL: 'http://h/x', CEZ_HERMES_WEBHOOK_SECRET: 's' }), alert(), d);
    expect(d.logs).toHaveLength(1);
    expect(d.logs[0]).toMatch(/hermes alert for task abcdef12 not delivered/);
  });
});

describe('RunAlerts.watch', () => {
  const record = (id: string, status: string, extra: Record<string, unknown> = {}) =>
    ({ id, title: `task ${id}`, status, workflow: 'w', task: 'x', createdAt: '', tokensUsed: 0, archived: false, steps: [], ...extra }) as unknown as RunRecord;

  const setup = (runs: RunRecord[], env: Record<string, string> = {}) => {
    const source = new EventEmitter() as EventEmitter & AlertSource;
    source.listRuns = () => runs;
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    const d = deps(async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return ok();
    });
    const alerts = new RunAlerts(
      alertConfigFromEnv({ CEZ_HERMES_WEBHOOK_URL: 'http://h/x', CEZ_HERMES_WEBHOOK_SECRET: 's', ...env }),
      d,
      'http://127.0.0.1:4321',
    );
    alerts.watch(source, 'shop');
    return { source, sent };
  };

  it('does not watch when nothing is configured', () => {
    const source = new EventEmitter() as EventEmitter & AlertSource;
    source.listRuns = () => [];
    new RunAlerts(alertConfigFromEnv({}), deps(vi.fn() as never)).watch(source, 'p');
    expect(source.listenerCount('run')).toBe(0);
  });

  it('treats statuses on record at attach time as baseline (no replay)', async () => {
    const { source, sent } = setup([record('a', 'review')]);
    source.emit('run', record('a', 'review'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toHaveLength(0);
  });

  it('alerts on a transition once, not on every update of the same status', async () => {
    const { source, sent } = setup([record('a', 'running')]);
    source.emit('run', record('a', 'review', { branch: 'cez/a', pullRequestUrl: 'https://github.com/o/r/pull/9' }));
    source.emit('run', record('a', 'review', { costUsd: 1 }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body.event_type).toBe('cezar.task.review');
    expect(sent[0]!.body.task).toMatchObject({ project: 'shop', branch: 'cez/a', prUrl: 'https://github.com/o/r/pull/9', url: 'http://127.0.0.1:4321/p/shop/tasks/a' });
  });

  it('attaches the agent question to a needs-input alert', async () => {
    const { source, sent } = setup([record('a', 'running')]);
    source.emit('event', { runId: 'a', event: { type: 'ask.requested', questions: [{ question: 'Which DB?', options: [{ label: 'pg' }, { label: 'sqlite' }] }] } });
    source.emit('run', record('a', 'waiting'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body.task).toMatchObject({ question: 'Which DB? [pg / sqlite]' });
  });

  it('falls back to the last agent message, clipped, when no question was asked', async () => {
    const { source, sent } = setup([record('a', 'running')]);
    const long = 'x'.repeat(500);
    source.emit('event', { runId: 'a', event: { type: 'item.completed', item: { kind: 'message', role: 'assistant', id: 'm', text: long } } });
    source.emit('run', record('a', 'waiting'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const task = sent[0]!.body.task as { detail: string; question?: string };
    expect(task.question).toBeUndefined();
    expect(task.detail).toHaveLength(280);
    expect(sent[0]!.body.message).toContain('Last message: ');
  });

  it('sends the run error on failed, and never a stale last message', async () => {
    const { source, sent } = setup([record('a', 'running')]);
    source.emit('event', { runId: 'a', event: { type: 'text', text: 'working on it' } });
    source.emit('run', record('a', 'failed', { error: 'agent crashed' }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect((sent[0]!.body.task as { detail: string }).detail).toBe('agent crashed');
  });

  it('skips events outside CEZ_ALERT_EVENTS and uses CEZ_ALERT_COCKPIT_URL for the link', async () => {
    const { source, sent } = setup([record('a', 'running')], { CEZ_ALERT_EVENTS: 'done', CEZ_ALERT_COCKPIT_URL: 'https://cezar.example.com/' });
    source.emit('run', record('a', 'review'));
    source.emit('run', record('a', 'done'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body.event_type).toBe('cezar.task.done');
    expect((sent[0]!.body.task as { url: string }).url).toBe('https://cezar.example.com/p/shop/tasks/a');
  });

  it('a gateway that is down never throws into the emitter', async () => {
    const source = new EventEmitter() as EventEmitter & AlertSource;
    source.listRuns = () => [record('a', 'running')];
    const d = deps((async () => { throw new Error('down'); }) as never);
    new RunAlerts(alertConfigFromEnv({ CEZ_HERMES_WEBHOOK_URL: 'http://h/x', CEZ_HERMES_WEBHOOK_SECRET: 's' }), d).watch(source, 'p');
    expect(() => source.emit('run', record('a', 'failed'))).not.toThrow();
    await vi.waitFor(() => expect(d.logs.length).toBeGreaterThan(0));
  });
});

describe('cezar alerts test', () => {
  it('exits 2 with guidance when nothing is configured', async () => {
    const err: string[] = [];
    const code = await runAlertsCommand(['test'], {}, deps(vi.fn() as never), { log: () => undefined, error: (l) => err.push(l) });
    expect(code).toBe(2);
    expect(err.join()).toMatch(/no target configured/);
  });

  it('sends to every configured target and reports each', async () => {
    const urls: string[] = [];
    const out: string[] = [];
    const code = await runAlertsCommand(
      ['test'],
      { CEZ_OPENCLAW_URL: 'http://gw:18789', CEZ_OPENCLAW_HOOK_TOKEN: 't', CEZ_HERMES_WEBHOOK_URL: 'http://h/webhooks/cezar', CEZ_HERMES_WEBHOOK_SECRET: 's' },
      deps((async (url: string) => { urls.push(String(url)); return ok(); }) as never),
      { log: (l) => out.push(l), error: () => undefined },
    );
    expect(code).toBe(0);
    expect(urls.sort()).toEqual(['http://gw:18789/hooks/wake', 'http://h/webhooks/cezar']);
    expect(out).toEqual(['openclaw: ok (200)', 'hermes: ok (200)']);
  });

  it('exits 1 when a target fails', async () => {
    const code = await runAlertsCommand(
      ['test'],
      { CEZ_HERMES_WEBHOOK_URL: 'http://h/x', CEZ_HERMES_WEBHOOK_SECRET: 's' },
      deps((async () => new Response('', { status: 401 })) as never),
      { log: () => undefined, error: () => undefined },
    );
    expect(code).toBe(1);
  });
});
