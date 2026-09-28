import type { TrackerDriver } from '../server/tracker/types.ts';
import type { TrackerAutomationDefinition } from './types.ts';
import type { TrackerEventCandidate, PollPage } from './event-source.ts';
export type TrackerAutomationCandidate = TrackerEventCandidate;
export type TrackerPollResult = PollPage<TrackerEventCandidate> & { truncated: boolean };

/** Provider history is the only source of tracker triggers; current status never fabricates events. */
export class TrackerPoller {
  async poll(driver: TrackerDriver, definition: TrackerAutomationDefinition, input: {
    baselineAt: string; checkpoint?: string; signal?: AbortSignal;
  }): Promise<TrackerPollResult> {
    if (!definition.trackerTrigger) throw new Error('Choose an event to finish configuring this automation');
    if (!driver.pollEvents) throw new Error('This tracker does not support automation events');
    const trigger = definition.trackerTrigger;
    const page = await driver.pollEvents({ ...input, ...(trigger.events.length === 1 ? { event: trigger.events[0] } : {}), limit: definition.filters.maxRecords, signal: input.signal ?? new AbortController().signal });
    return { ...page, truncated: !page.complete, candidates: page.candidates.filter(candidate =>
      trigger.events.includes(candidate.event)
      && (!trigger.requiredLabels?.length || trigger.requiredLabels.every(label => candidate.labels.includes(label)))
      && (candidate.event !== 'issue.status_changed' || !trigger.targetStatusIds?.length || trigger.targetStatusIds.includes(candidate.change.toId ?? ''))
      && (!['issue.labeled', 'issue.unlabeled'].includes(candidate.event) || !trigger.changedLabelIds?.length || trigger.changedLabelIds.includes(candidate.change.labelId ?? ''))
    ) };
  }
}
