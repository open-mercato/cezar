import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '../runs/store.ts';
import { AlertOutbox, OUTBOX_MAX_AGE_MS, OUTBOX_MAX_ENTRIES, OUTBOX_RETRY_MS, type OutboxEntry } from './alerts-outbox.ts';
import { alertConfigFromEnv, openclawRequest, RunAlerts, type AlertDeps, type AlertSource } from './alerts.ts';

const T0 = Date.UTC(2026, 9, 21, 12, 0, 0);

const entry = (n: number, at = T0, targets: OutboxEntry['targets'] = ['hermes']): OutboxEntry => ({
  event: 'review',
  at,
  targets,
  task: { id: `task-${n}`, title: `t${n}`, status: 'review', project: 'shop' },
});

const record = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: `task ${id}`, status, workflow: 'w', task: 'x', createdAt: '', tokensUsed: 0, archived: false, steps: [], ...extra }) as unknown as RunRecord;

describe('AlertOutbox', () => {
  let dir: string;
  let now = T0;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-outbox-'));
    now = T0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips entries and survives a missing file or torn lines', () => {
    const outbox = new AlertOutbox(dir, () => now);
    expect(outbox.load()).toEqual([]);
    outbox.append(entry(1));
    writeFileSync(join(dir, 'alerts-outbox.ndjson'), `${readFileSync(join(dir, 'alerts-outbox.ndjson'), 'utf8')}{torn\n`, 'utf8');
    outbox.append(entry(2));
    expect(outbox.load().map((e) => e.task.id)).toEqual(['task-1', 'task-2']);
  });

  it('drops entries older than 24 h', () => {
    const outbox = new AlertOutbox(dir, () => now);
    outbox.append(entry(1, T0));
    now = T0 + OUTBOX_MAX_AGE_MS - 1;
    expect(outbox.load()).toHaveLength(1);
    now = T0 + OUTBOX_MAX_AGE_MS + 1;
    expect(outbox.load()).toEqual([]);
  });

  it('keeps at most 200 entries, newest', () => {
    const outbox = new AlertOutbox(dir, () => now);
    for (let n = 0; n < OUTBOX_MAX_ENTRIES + 25; n += 1) outbox.append(entry(n));
    const loaded = outbox.load();
    expect(loaded).toHaveLength(OUTBOX_MAX_ENTRIES);
    expect(loaded[0]!.task.id).toBe('task-25');
    expect(loaded.at(-1)!.task.id).toBe(`task-${OUTBOX_MAX_ENTRIES + 24}`);
  });

  it('never stores a request: no token, no signature at rest', () => {
    const outbox = new AlertOutbox(dir, () => now);
    outbox.append(entry(1, T0, ['openclaw', 'hermes']));
    const text = readFileSync(join(dir, 'alerts-outbox.ndjson'), 'utf8');
    expect(text).not.toMatch(/authorization|bearer|signature|secret|token/i);
  });

  it('never throws when the directory is unwritable', () => {
    const outbox = new AlertOutbox(join(dir, 'file-not-dir', 'x'), () => now);
    writeFileSync(join(dir, 'file-not-dir'), 'x');
    expect(() => outbox.append(entry(1))).not.toThrow();
    expect(() => outbox.replace([entry(1)])).not.toThrow();
  });
});

describe('RunAlerts outbox', () => {
  let dir: string;
  let now = T0;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-outbox-run-'));
    now = T0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const env = {
    CEZ_HERMES_WEBHOOK_URL: 'http://h/webhooks/cezar',
    CEZ_HERMES_WEBHOOK_SECRET: 's',
    CEZ_OPENCLAW_URL: 'http://gw:18789',
    CEZ_OPENCLAW_HOOK_TOKEN: 'tok',
  };

  const harness = (answer: (url: string, headers: Record<string, string>, body: Record<string, unknown>) => number) => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const deps: AlertDeps = {
      fetch: (async (url: string, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        const body = JSON.parse(String(init?.body));
        seen.push({ url: String(url), headers, body });
        return new Response('{}', { status: answer(String(url), headers, body) });
      }) as never,
      sleep: async () => undefined,
      now: () => now,
      dryRun: false,
      log: () => undefined,
    };
    const source = new EventEmitter() as EventEmitter & AlertSource;
    source.listRuns = () => [record('a', 'running')];
    return { deps, seen, source };
  };

  it('a delivery that fails after its retry is parked per target; the target that worked is not', async () => {
    const { deps, seen, source } = harness((url) => (url.includes('/webhooks/') ? 503 : 200));
    const alerts = new RunAlerts(alertConfigFromEnv(env), deps);
    alerts.watch(source, 'shop', { dataDir: dir });
    source.emit('run', record('a', 'review'));
    await vi.waitFor(() => expect(new AlertOutbox(dir, () => now).load()).toHaveLength(1));
    alerts.dispose();
    expect(seen.filter((s) => s.url.includes('/webhooks/'))).toHaveLength(2); // in-line retry happened first
    const [parked] = new AlertOutbox(dir, () => now).load();
    expect(parked).toMatchObject({ event: 'review', targets: ['hermes'], task: { id: 'a', project: 'shop' } });
  });

  it('boot retry re-sends with the same request id and a FRESH signature, then empties the outbox', async () => {
    const first = harness((url) => (url.includes('/webhooks/') ? 503 : 200));
    const a1 = new RunAlerts(alertConfigFromEnv(env), first.deps);
    a1.watch(first.source, 'shop', { dataDir: dir });
    first.source.emit('run', record('a', 'review'));
    await vi.waitFor(() => expect(new AlertOutbox(dir, () => now).load()).toHaveLength(1));
    a1.dispose();
    const firstRequest = first.seen.find((s) => s.url.includes('/webhooks/'))!;

    now = T0 + 10 * 60 * 1000; // a later process: the original signature would be stale
    const second = harness(() => 200);
    const a2 = new RunAlerts(alertConfigFromEnv(env), second.deps);
    a2.watch(second.source, 'shop', { dataDir: dir });
    await vi.waitFor(() => expect(new AlertOutbox(dir, () => now).load()).toEqual([]));
    a2.dispose();
    expect(second.seen).toHaveLength(1); // only the owed target, once
    const retry = second.seen[0]!;
    expect(retry.url).toBe('http://h/webhooks/cezar');
    expect(retry.headers['x-request-id']).toBe(firstRequest.headers['x-request-id']);
    expect(retry.headers['x-webhook-timestamp']).toBe(String(Math.floor(now / 1000)));
    expect(retry.headers['x-webhook-timestamp']).not.toBe(firstRequest.headers['x-webhook-timestamp']);
    expect(retry.body.event_type).toBe('cezar.task.review');
  });

  it('retries every 5 minutes while the gateway stays down, and keeps the entry', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      new AlertOutbox(dir, () => now).append(entry(1, T0));
      const down = harness(() => 503);
      const alerts = new RunAlerts(alertConfigFromEnv(env), down.deps);
      alerts.watch(down.source, 'shop', { dataDir: dir });
      await vi.waitFor(() => expect(down.seen).toHaveLength(1)); // boot attempt, single try
      await vi.advanceTimersByTimeAsync(OUTBOX_RETRY_MS);
      await vi.waitFor(() => expect(down.seen).toHaveLength(2));
      alerts.dispose();
      expect(new AlertOutbox(dir, () => now).load()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an entry for a target that is no longer configured is dropped, not retried forever', async () => {
    new AlertOutbox(dir, () => now).append(entry(1, T0, ['openclaw']));
    const { deps, seen, source } = harness(() => 200);
    const alerts = new RunAlerts(alertConfigFromEnv({ CEZ_HERMES_WEBHOOK_URL: env.CEZ_HERMES_WEBHOOK_URL, CEZ_HERMES_WEBHOOK_SECRET: 's' }), deps);
    alerts.watch(source, 'shop', { dataDir: dir });
    await vi.waitFor(() => expect(new AlertOutbox(dir, () => now).load()).toEqual([]));
    alerts.dispose();
    expect(seen).toHaveLength(0);
    expect(existsSync(join(dir, 'alerts-outbox.ndjson'))).toBe(true);
  });

  it('without a dataDir nothing is parked and no timer runs', async () => {
    const { deps, source } = harness(() => 503);
    const alerts = new RunAlerts(alertConfigFromEnv(env), deps);
    alerts.watch(source, 'shop');
    source.emit('run', record('a', 'failed'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(join(dir, 'alerts-outbox.ndjson'))).toBe(false);
    alerts.dispose();
  });
});

describe('OpenClaw per-task session', () => {
  const alert = { event: 'needs-input' as const, at: T0, task: { id: 'abc', title: 't', status: 'waiting', project: 'shop' } };
  const target = { url: 'http://gw/hooks', token: 't', delivery: { channel: 'telegram', to: '1' } };

  it('adds sessionKey + persistent mode only with a prefix, built from prefix + project + task', () => {
    const plain = JSON.parse(openclawRequest(target, alert).body);
    expect(plain).not.toHaveProperty('sessionKey');
    expect(plain).not.toHaveProperty('sessionMode');
    const body = JSON.parse(openclawRequest({ ...target, sessionKeyPrefix: 'hook:' }, alert).body);
    expect(body).toMatchObject({ sessionKey: 'hook:cezar:shop:abc', sessionMode: 'persistent', deliver: true });
  });

  it('parses CEZ_OPENCLAW_SESSION_KEY_PREFIX, and ignores it (with a warning) without channel+to', () => {
    const base = { CEZ_OPENCLAW_URL: 'http://gw', CEZ_OPENCLAW_HOOK_TOKEN: 't' };
    const ok = alertConfigFromEnv({ ...base, CEZ_OPENCLAW_CHANNEL: 'slack', CEZ_OPENCLAW_TO: 'u', CEZ_OPENCLAW_SESSION_KEY_PREFIX: 'hook:' });
    expect(ok.openclaw?.sessionKeyPrefix).toBe('hook:');
    const bad = alertConfigFromEnv({ ...base, CEZ_OPENCLAW_SESSION_KEY_PREFIX: 'hook:' });
    expect(bad.openclaw?.sessionKeyPrefix).toBeUndefined();
    expect(bad.warnings.join()).toMatch(/SESSION_KEY_PREFIX needs/);
  });
});
