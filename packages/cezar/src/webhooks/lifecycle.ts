import type { CreateWebhook, WebhookTaskEventType } from '@open-mercato/cezar-contract';
import type { RunLifecycleSnapshot } from '../runs/lifecycle.ts';

export function transitionType(before: RunLifecycleSnapshot | undefined, after: RunLifecycleSnapshot | undefined): WebhookTaskEventType | undefined {
  if (!before || !after || after.archived) return;
  if (after.status === 'waiting' && (before.status !== 'waiting' || before.attentionRequest?.requestId !== after.attentionRequest?.requestId)) return 'task.attention_required';
  if (after.status !== before.status) {
    switch (after.status) {
      case 'review': return 'task.review_ready';
      case 'done': return 'task.finished';
      case 'failed': return 'task.failed';
      case 'cancelled': return 'task.cancelled';
    }
  }
  if (after.status === 'failed' && before.autoResumeAt && !after.autoResumeAt) return 'task.failed';
}
export interface LifecycleCandidate {
  type: WebhookTaskEventType;
  occurredAt: string;
  episodeId: string;
  snapshot: RunLifecycleSnapshot;
}
export type FailureDisposition = { disposition: 'manual' } | { disposition: 'scheduled'; autoResumeAt: string };
export type Freshness = { kind: 'defer' } | { kind: 'superseded'; reason: string } | ({ kind: 'ready' } & Partial<FailureDisposition>);
export interface FreshnessContext {
  current: RunLifecycleSnapshot | undefined;
  now: number;
  active: boolean;
  context: 'ready' | 'recovering' | 'unopened';
  resumeScheduled?: boolean;
  frozen?: FailureDisposition;
  currentEpisodeId?: string;
}
export function freshness(source: LifecycleCandidate, state: FreshnessContext): Freshness {
  if (source.type === 'task.finished' || source.type === 'task.cancelled') return { kind: 'ready' };
  const superseded = (reason: string): Freshness => ({ kind: 'superseded', reason });
  if (state.context === 'recovering') return { kind: 'defer' };
  const current = state.current;
  if (!current) return superseded('task_deleted');
  if (current.archived) return superseded('task_archived');
  if (current.continuation !== source.snapshot.continuation) return superseded('newer_continuation');
  if (current.status !== source.snapshot.status) return superseded('status_changed');
  if (state.currentEpisodeId !== undefined && state.currentEpisodeId !== source.episodeId) return superseded('episode_changed');
  if (source.type !== 'task.failed') {
    if (state.context === 'unopened') return superseded('owner_restarted');
    if (current.attentionRequest?.requestId !== source.snapshot.attentionRequest?.requestId) return superseded('question_changed');
    return { kind: 'ready' };
  }
  if (state.active || state.now < Date.parse(source.occurredAt) + 30_000) return { kind: 'defer' };
  const disposition: FailureDisposition = state.context === 'ready' && state.resumeScheduled === true && current.autoResumeAt
    ? { disposition: 'scheduled', autoResumeAt: current.autoResumeAt }
    : { disposition: 'manual' };
  if (state.frozen && (state.frozen.disposition !== disposition.disposition ||
    (state.frozen.disposition === 'scheduled' && disposition.disposition === 'scheduled' && state.frozen.autoResumeAt !== disposition.autoResumeAt))) {
    return superseded('failure_schedule_changed');
  }
  return { kind: 'ready', ...disposition };
}
export function selected(receiver: Pick<CreateWebhook, 'preset' | 'events' | 'includeScheduledFailures' | 'scope'>, type: WebhookTaskEventType, task: RunLifecycleSnapshot): boolean {
  const events: readonly WebhookTaskEventType[] = receiver.preset === 'custom' ? receiver.events
    : receiver.preset === 'all' ? ['task.attention_required', 'task.review_ready', 'task.finished', 'task.failed', 'task.cancelled']
    : ['task.attention_required', 'task.review_ready', 'task.finished', 'task.failed'];
  if (!events.includes(type)) return false;
  return receiver.scope === 'every_task' || !task.parentTaskId || (type === 'task.attention_required' && task.attentionRequest !== undefined);
}
