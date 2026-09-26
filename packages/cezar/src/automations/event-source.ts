import type { TrackerAssociation, TrackerAutomationEvent } from '@open-mercato/cezar-contract';

export interface TrackerEventCandidate {
  eventId: string;
  timestamp: string;
  tieBreaker: string;
  provider: 'jira' | 'linear';
  event: TrackerAutomationEvent;
  association: TrackerAssociation;
  issueId: string;
  key: string;
  title: string;
  url: string;
  status: string;
  labels: string[];
  change: { fromId?: string; toId?: string; labelId?: string; labelName?: string };
}
export interface PollPage<C> { candidates: C[]; checkpoint: string; complete: boolean; gaps?: { issueId: string; key: string; reason: string }[] }
export interface AutomationEventSource<C> {
  poll(input: { baselineAt: string; checkpoint?: string; limit: number; signal: AbortSignal }): Promise<PollPage<C>>;
  isCurrent(): Promise<boolean>;
}
