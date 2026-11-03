import { webhookEventSchema, type WebhookProfile } from '@open-mercato/cezar-contract';
import { collectSecretValues, redactDeep } from '../core/secret-redaction.ts';
import { webhookSourceSchema, type WebhookSource } from './source.ts';
import { scrubWebhookSource } from './privacy.ts';
import type { FailureDisposition } from './lifecycle.ts';

/** Redact complete values before any lossy path scrubbing or length bounds. */
function prepareSource(source: WebhookSource, secrets: readonly string[]): WebhookSource {
  const safe = redactDeep(source, [...collectSecretValues(), ...secrets]);
  for (const [field, limit] of [['title', 512], ['error', 4000]] as const) {
    const text = safe.snapshot[field];
    if (text !== undefined && text.length > limit) {
      // A destination may become a known secret after capture. Do not persist
      // a clipped URL that later exact-secret redaction cannot recognize.
      // URL text can contain spaces, so conservatively end an oversized excerpt
      // before its first HTTP(S) URL, rather than guessing where that URL ends.
      const urlStart = text.search(/https?:\/\//i);
      safe.snapshot[field] = text.slice(0, urlStart < 0 ? limit : Math.min(limit, urlStart));
      safe.truncated = true;
    }
  }
  return scrubWebhookSource(safe);
}

export function redactSource(source: WebhookSource, secrets: readonly string[]): WebhookSource {
  const bounded = webhookSourceSchema.parse(prepareSource(source, secrets));
  if (Buffer.byteLength(JSON.stringify(bounded)) < 65536) return bounded;
  bounded.truncated = true;
  const questions = bounded.snapshot.attentionRequest?.questions;
  while (questions && questions.length > 1 && Buffer.byteLength(JSON.stringify(bounded)) >= 65536) questions.pop();
  if (Buffer.byteLength(JSON.stringify(bounded)) >= 65536) throw new Error('Webhook source exceeds its bound');
  return webhookSourceSchema.parse(bounded);
}
export function canonicalGithubLink(input: string | undefined, repository: string | undefined, kind: 'pull' | 'issues'): string | undefined {
  if (!input || !repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password) return;
    const match = /^\/([^/]+\/[^/]+)\/(pull|issues)\/([1-9][0-9]*)\/?$/.exec(url.pathname);
    if (!match || match[1]!.toLowerCase() !== repository.toLowerCase() || match[2] !== kind || !Number.isSafeInteger(Number(match[3]))) return;
    return `https://github.com/${repository}/${kind}/${Number(match[3])}`;
  } catch { return; }
}
export function renderPayload(source: WebhookSource, profile: WebhookProfile, secrets: readonly string[], disposition?: FailureDisposition, repository?: string): string {
  source = prepareSource(source, secrets);
  const task = source.snapshot;
  const title = (profile === 'standard' || task.titleOrigin === 'user') ? task.title : undefined;
  const pullRequest = [task.pullRequestUrl, task.referencedPullRequestUrl, task.automationUrl].map(url => canonicalGithubLink(url, repository, 'pull')).find(Boolean);
  const issue = source.trackerIssueUrl ?? [task.referencedIssueUrl, task.automationUrl].map(url => canonicalGithubLink(url, repository, 'issues')).find(Boolean);
  const cockpit = source.mode === 'hosted' ? source.cockpitUrl : undefined;
  const base = {
    ...(source.truncated ? { truncated: true } : {}),
    id: source.id, type: source.type, schemaVersion: 1, occurredAt: source.occurredAt, sequence: source.sequence,
    source: { instanceId: source.installationId, projectId: source.projectId, mode: source.mode },
    task: { id: task.id, status: task.status, previousStatus: source.previousStatus, ...(title ? { title } : {}) },
    ...(task.rootTaskId ? { tree: { rootTaskId: task.rootTaskId, ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}) } } : {}),
    ...(pullRequest || issue || cockpit ? { links: { ...(cockpit ? { cockpit } : {}), ...(pullRequest ? { pullRequest } : {}), ...(issue ? { issue } : {}) } } : {}),
  };
  let data: unknown;
  switch (source.type) {
    case 'task.attention_required': data = {
      episodeId: source.episodeId, since: source.occurredAt, reason: task.attentionRequest ? 'question' : 'turn_end',
      ...(task.attentionRequest ? { requestId: task.attentionRequest.requestId, ...(profile === 'standard' ? { questions: task.attentionRequest.questions } : {}) } : {}),
    }; break;
    case 'task.review_ready': data = { episodeId: source.episodeId, since: source.occurredAt }; break;
    case 'task.finished': data = { resolution: task.completionReason ?? 'unknown', finishedAt: task.finishedAt ?? source.occurredAt, ...(task.startedAt ? { startedAt: task.startedAt } : {}),
      ...([task.inputTokens, task.outputTokens, task.costUsd].some(value => value !== undefined) ? { usage: {
        ...(task.inputTokens !== undefined ? { inputTokens: task.inputTokens } : {}),
        ...(task.outputTokens !== undefined ? { outputTokens: task.outputTokens } : {}),
        ...(task.costUsd !== undefined ? { costUsd: task.costUsd } : {}),
        // Aggregate cost can cover only some steps; never promise complete coverage.
        coverage: 'partial',
      } } : {}) }; break;
    case 'task.failed':
      if (!disposition) throw new Error('Failure disposition is not ready');
      data = { episodeId: source.episodeId, failedAt: task.finishedAt ?? source.occurredAt, ...disposition, ...(profile === 'standard' && task.error ? { message: task.error } : {}) }; break;
    case 'task.cancelled': data = { at: task.finishedAt ?? source.occurredAt }; break;
  }
  const event = webhookEventSchema.parse(redactDeep({ ...base, data }, [...collectSecretValues(), ...secrets]));
  let body = JSON.stringify(event);
  if (Buffer.byteLength(body) <= 65536) return body;
  if (event.type === 'webhook.test') throw new Error('Invalid lifecycle payload');
  event.truncated = true;
  // Trim whole optional questions from the end; required episode/request identity is retained.
  if (event.type === 'task.attention_required' && event.data.questions) {
    while (event.data.questions.length && Buffer.byteLength(JSON.stringify(event)) > 65536) event.data.questions.pop();
  }
  body = JSON.stringify(webhookEventSchema.parse(event));
  if (Buffer.byteLength(body) > 65536) throw new Error('Webhook payload exceeds its bound');
  return body;
}
