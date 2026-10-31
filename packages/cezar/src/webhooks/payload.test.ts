import { describe, expect, it, vi, afterEach } from 'vitest';
import { runLifecycleSnapshot } from '../runs/lifecycle.ts';
import { runRecordSchema } from '../runs/store.ts';
import * as payload from './payload.ts';
import type { WebhookSource } from './source.ts';
const source = (): WebhookSource => ({
  version: 1, id: 'evt_00000000-0000-4000-8000-000000000001', sequence: 1, installationId: 'inst_test', projectId: 'project', previousStatus: 'running',
  episodeId: 'task-1-1', type: 'task.attention_required', occurredAt: '2026-10-13T12:00:00Z', mode: 'local',
  snapshot: { id: 'task-1', status: 'waiting', archived: false, continuation: 0, title: 'Private title', titleOrigin: 'marker', attentionRequest: { requestId: 'question-1', askedAt: '2026-10-13T12:00:00Z', questions: [{ question: 'Private question' }] } },
});
afterEach(() => vi.unstubAllEnvs());
describe('outbound webhook payload minimization', () => {
  it('omits agent-authored title and question text from Minimal, allows user title', () => {
    const item = source(); const minimal = payload.renderPayload(item, 'minimal', []);
    expect(minimal).not.toContain('Private');
    item.snapshot.titleOrigin = 'user';
    expect(payload.renderPayload(item, 'minimal', [])).toContain('Private title');
    expect(payload.renderPayload(item, 'standard', [])).toContain('Private question');
  });
  it('redacts outbound source and body even when transcript redaction is off', () => {
    vi.stubEnv('CEZ_REDACT_SECRETS', '0');
    const item = source(); item.snapshot.title = 'confidential-secret-value';
    const redacted = payload.redactSource(item, ['confidential-secret-value']);
    expect(JSON.stringify(redacted)).not.toContain('confidential-secret-value');
    expect(payload.renderPayload(item, 'standard', ['confidential-secret-value'])).not.toContain('confidential-secret-value');
  });
  it.each(['environment', 'receiver'] as const)('redacts complete %s secrets before title/error bounds at capture and render', kind => {
    const secret = 'syntheticCredentialABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz';
    vi.stubEnv('CEZ_REDACT_SECRETS', '0');
    if (kind === 'environment') vi.stubEnv('TEST_WEBHOOK_SECRET', secret);
    const secrets = kind === 'receiver' ? [secret] : [];
    const item = source();
    item.type = 'task.failed';
    const run = runRecordSchema.parse({
      id: 'task-1', title: 't'.repeat(467) + secret, error: 'e'.repeat(3955) + secret,
      titleOrigin: 'user', workflow: 'test', task: 'test', status: 'failed', archived: false,
      steps: [], tokensUsed: 0, createdAt: item.occurredAt,
    });
    item.snapshot = runLifecycleSnapshot(run);
    const durable = payload.redactSource(item, secrets);
    for (const value of [JSON.stringify(durable), payload.renderPayload(item, 'standard', secrets, { disposition: 'manual' }), payload.renderPayload(durable, 'standard', secrets, { disposition: 'manual' })]) {
      expect(value).not.toContain(secret.slice(0, 45));
      expect(value).toContain('[REDACTED]');
    }
    expect(durable.snapshot.title!.length).toBeLessThanOrEqual(512);
    expect(durable.snapshot.error!.length).toBeLessThanOrEqual(4000);
  });
  it('keeps safe title/error bounds and flags clipping without mutating the input', () => {
    const item = source(); item.snapshot.title = 't'.repeat(600); item.snapshot.error = 'e'.repeat(5000);
    const durable = payload.redactSource(item, []);
    expect(durable.snapshot.title).toHaveLength(512);
    expect(durable.snapshot.error).toHaveLength(4000);
    expect(durable.truncated).toBe(true);
    expect(item.snapshot.title).toHaveLength(600);
  });
  it.each([['title', 512], ['error', 4000]] as const)('does not retain a partial future receiver URL in oversized %s', (field, limit) => {
    const item = source(); item.type = 'task.failed'; item.snapshot.status = 'failed';
    const url = 'https://example.invalid/private capability/' + 'z'.repeat(100);
    item.snapshot[field] = 'x'.repeat(limit - 60) + ' ' + url;
    const durable = payload.redactSource(item, []);
    expect(durable.snapshot[field]).not.toContain('https:');
    expect(durable.snapshot[field]!.length).toBeLessThanOrEqual(limit);
    expect(durable.truncated).toBe(true);
    expect(payload.renderPayload(durable, 'standard', [url], { disposition: 'manual' })).not.toContain('private capability');
  });
  it('preserves complete prose links when text fits its bound', () => {
    const item = source(); item.snapshot.error = 'See https://example.invalid/help for context';
    expect(payload.redactSource(item, []).snapshot.error).toBe(item.snapshot.error);
  });
  it('trims optional question content deterministically to 64KiB preserving required data', () => {
    const item = source(); item.snapshot.attentionRequest!.questions = Array.from({ length: 20 }, () => ({ question: '界'.repeat(2000), options: Array.from({ length: 10 }, () => ({ label: '界'.repeat(120), description: '界'.repeat(500) })) }));
    const body = payload.renderPayload(item, 'standard', []);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(65536);
    expect(JSON.parse(body)).toMatchObject({ truncated: true, data: { episodeId: 'task-1-1', reason: 'question', requestId: 'question-1' } });
    expect(payload.renderPayload(item, 'standard', [])).toBe(body);
  });
  it('bounds the redacted Standard source before durable capture', () => {
    const item = source(); item.snapshot.attentionRequest!.questions = Array.from({ length: 20 }, () => ({ question: '界'.repeat(2000), options: Array.from({ length: 10 }, () => ({ label: '界'.repeat(120), description: '界'.repeat(500) })) }));
    const bounded = payload.redactSource(item, []);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(65536);
    expect(JSON.parse(payload.renderPayload(bounded, 'standard', []))).toMatchObject({ truncated: true });
  });
  it('rebuilds links only for the configured project repository, strips query and rejects credentials', () => {
    expect(payload.canonicalGithubLink('https://github.com/acme/app/pull/12?secret=private#frag', 'acme/app', 'pull')).toBe('https://github.com/acme/app/pull/12');
    expect(payload.canonicalGithubLink('https://github.com/attacker/app/pull/12', 'acme/app', 'pull')).toBeUndefined();
    expect(payload.canonicalGithubLink('https://user@github.com/acme/app/pull/12', 'acme/app', 'pull')).toBeUndefined();
  });
  it('includes measured completion usage and uses a validated automation link as fallback', () => {
    const item = source(); item.type = 'task.finished'; item.snapshot.status = 'done';
    Object.assign(item.snapshot, { inputTokens: 120, outputTokens: 30, costUsd: 0.2, automationUrl: 'https://github.com/acme/app/issues/42?secret=drop', pullRequestUrl: 'https://github.com/foreign/repo/pull/1', referencedPullRequestUrl: 'https://github.com/acme/app/pull/3' });
    const event = JSON.parse(payload.renderPayload(item, 'minimal', [], undefined, 'acme/app'));
    expect(event.data.usage).toEqual({ inputTokens: 120, outputTokens: 30, costUsd: 0.2, coverage: 'partial' });
    expect(event.links).toEqual({ issue: 'https://github.com/acme/app/issues/42', pullRequest: 'https://github.com/acme/app/pull/3' });
    delete item.snapshot.inputTokens; delete item.snapshot.outputTokens; delete item.snapshot.costUsd;
    expect(JSON.parse(payload.renderPayload(item, 'minimal', [])).data).not.toHaveProperty('usage');
  });
  it('does not invent failure disposition before readiness', () => {
    const item = source(); item.type = 'task.failed'; item.snapshot.status = 'failed';
    expect(() => payload.renderPayload(item, 'minimal', [])).toThrow('disposition');
    expect(JSON.parse(payload.renderPayload(item, 'minimal', [], { disposition: 'manual' }))).toMatchObject({ data: { disposition: 'manual' } });
  });
});

describe('webhook filesystem privacy', () => {
  it.each(['/home/alice/private/task.ts', '/Users/alice/private/task.ts', 'C:\\Users\\alice\\private\\task.ts', 'C:/Users/alice/private/task.ts', '\\\\server\\share\\private\\task.ts', '~/private/task.ts', '~alice/private/task.ts', '~alice.smith/Private Files/task.ts', 'file:///home/alice/private/task.ts'])(
    'removes %s from durable and emitted free text', (path) => {
      const item = source();
      item.snapshot.title = `Inspect ${path} please`;
      item.snapshot.titleOrigin = 'user';
      item.snapshot.error = `Cannot open ${path} today`;
      item.snapshot.attentionRequest!.questions = [{ question: `Read ${path}?`, options: [{ label: path, description: `Open ${path}` }] }];
      item.snapshot.pullRequestUrl = 'https://github.com/acme/app/pull/3';
      const durable = payload.redactSource(item, []);
      for (const value of [JSON.stringify(durable), payload.renderPayload(item, 'standard', [], undefined, 'acme/app'), payload.renderPayload(item, 'minimal', [], undefined, 'acme/app')]) {
        expect(value).not.toContain('private');
        expect(value).toContain('Inspect');
        expect(value).toContain('https://github.com/acme/app/pull/3');
      }
      item.type = 'task.failed'; item.snapshot.status = 'failed';
      expect(payload.renderPayload(item, 'standard', [], { disposition: 'manual' })).not.toContain('private');
      expect(item.snapshot.title).toContain(path); // no mutation of the run snapshot
    });
  it.each(['/home/alice/Private Files/task.ts', String.raw`C:\Users\Alice Smith\private\task.ts`, String.raw`\\server\Team Files\private\task.ts`, "/home/alice/Alice's private/task.ts"])(
    'does not retain suffixes of an unquoted path with spaces: %s', path => {
      const item = source();
      item.type = 'task.failed'; item.snapshot.status = 'failed';
      item.snapshot.titleOrigin = 'user';
      item.snapshot.title = `Inspect ${path} today`;
      item.snapshot.error = `Cannot read ${path} today`;
      item.snapshot.attentionRequest!.questions = [{ question: `Read ${path}?`, options: [{ label: path, description: `Open ${path}` }] }];
      const durable = payload.redactSource(item, []);
      for (const text of [JSON.stringify(durable), payload.renderPayload(item, 'standard', [], { disposition: 'manual' }), payload.renderPayload(item, 'minimal', [], { disposition: 'manual' })]) {
        expect(text).not.toContain('task.ts');
        expect(text).not.toContain('Smith');
        expect(text).not.toContain('Files');
        expect(text).toContain('Inspect');
      }
    },
  );
  it('preserves normal text, HTTP links, and validated link fields', () => {
    const item = source();
    item.snapshot.title = 'Review CI/CD and https://example.com/docs/page';
    item.trackerIssueUrl = 'https://tracker.example.com/issues/123';
    item.mode = 'hosted'; item.cockpitUrl = 'https://cezar.example.com/p/project/tasks/1';
    const durable = payload.redactSource(item, []);
    expect(durable.snapshot.title).toBe(item.snapshot.title);
    expect(JSON.parse(payload.renderPayload(durable, 'standard', [])).links).toEqual({ issue: item.trackerIssueUrl, cockpit: item.cockpitUrl });
  });
});
