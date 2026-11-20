import {
  PLAN_USAGE_SCHEMA, PLAN_USAGE_VERSION, formatPlanPp,
  type PlanUsageConsumersResponse, type PlanUsageHint, type PlanUsageQuery, type PlanUsageReport, type PlanUsageWindow,
} from '@open-mercato/cezar-contract';
import { computeWindows, ledgerAccounts } from './compute.ts';
import { planUsageTracking, readLedger, type LedgerRecord } from './store.ts';

const DEFAULT_DAYS = 8;

export interface ReportInput {
  records?: LedgerRecord[];
  now?: number;
  /** Format clock times in hints; the server's own zone by default. */
  timeZone?: string;
}

/** `current` (default): the window holding now per account; `previous`: the one before it;
 *  `all`: every window in range; anything else: one window id. */
export function selectWindows(all: PlanUsageWindow[], query: Pick<PlanUsageQuery, 'account' | 'kind' | 'window'>): PlanUsageWindow[] {
  const scoped = all.filter((w) => (!query.account || w.account.key === query.account) && (!query.kind || w.kind === query.kind));
  const selector = query.window ?? 'current';
  if (selector === 'all') return scoped;
  if (selector !== 'current' && selector !== 'previous') return scoped.filter((w) => w.id === selector);
  const out: PlanUsageWindow[] = [];
  const groups = new Map<string, PlanUsageWindow[]>();
  for (const w of scoped) groups.set(`${w.account.key}|${w.kind}`, [...(groups.get(`${w.account.key}|${w.kind}`) ?? []), w]);
  for (const list of groups.values()) {
    // Already newest-first. "current" is the live window; without one there is nothing current.
    const currentIndex = list.findIndex((w) => w.current);
    if (selector === 'current') {
      if (currentIndex >= 0) out.push(list[currentIndex]!);
    } else {
      const previous = currentIndex >= 0 ? list[currentIndex + 1] : list.find((w) => !w.current);
      if (previous) out.push(previous);
    }
  }
  return out;
}

const fmtPp = formatPlanPp;

function clock(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
}

/** The designed "Worth a look" hints, each with the numbers behind it. */
export function planUsageHints(windows: PlanUsageWindow[], all: PlanUsageWindow[], timeZone?: string): PlanUsageHint[] {
  const hints: PlanUsageHint[] = [];
  for (const w of windows) {
    for (const c of w.consumers) {
      if (c.kind !== 'task' || c.retryWasteEstimatePp < 1) continue;
      hints.push({
        id: `retry-waste:${w.id}:${c.id}`, kind: 'retry-waste', windowId: w.id,
        text: `≈ ${fmtPp(c.retryWasteEstimatePp)}% of ${w.account.label}'s ${w.kind === 'weekly' ? 'weekly' : '5-hour'} limit went to attempts of "${c.title}" that then failed a check step. Running the check before the long agent turn would catch it sooner.`,
        evidence: { consumerId: c.id, retryWasteEstimatePp: c.retryWasteEstimatePp, estimatePp: c.estimatePp },
      });
    }
    const tasks = w.consumers.filter((c) => c.kind === 'task' && c.sharedEstimatePp > 0);
    if (w.limitReachedAt && tasks.length >= 2) {
      const spare = all.filter((o) => o.current === w.current && o.kind === w.kind && o.account.provider === w.account.provider
        && o.account.key !== w.account.key && o.usedPercent && o.usedPercent.last < 50
        && Date.parse(o.startsAt) < Date.parse(w.resetsAt) && Date.parse(o.resetsAt) > Date.parse(w.limitReachedAt!));
      const other = spare.sort((x, y) => x.usedPercent!.last - y.usedPercent!.last)[0];
      if (other) {
        const pause = Math.max(0, Math.round((Date.parse(w.resetsAt) - Date.parse(w.limitReachedAt)) / 60_000));
        hints.push({
          id: `parallel-limit:${w.id}`, kind: 'parallel-limit', windowId: w.id,
          text: `${tasks.length} tasks shared ${w.account.label} and hit the limit at ${clock(w.limitReachedAt, timeZone)} while ${other.account.label} sat at ${fmtPp(other.usedPercent!.last)}%. Spreading them would have avoided the ${pause}-minute pause.`,
          evidence: { limitReachedAt: w.limitReachedAt, resetsAt: w.resetsAt, otherWindowId: other.id, otherUsedPercent: other.usedPercent!.last, tasks: tasks.map((t) => t.id) },
        });
      }
    }
    for (const c of w.consumers) {
      const watches = c.turns?.watch ?? 0;
      if (c.kind !== 'manager' || watches < 3 || (c.quietWatchTurns ?? 0) !== watches || !c.parts || c.parts.watch <= 0) continue;
      hints.push({
        id: `quiet-watch:${w.id}:${c.id}`, kind: 'quiet-watch', windowId: w.id,
        text: `Watch checks of "${c.title}" cost ≈ ${fmtPp(c.parts.watch)}% and found nothing in ${watches} runs. A longer watch interval would save most of it.`,
        evidence: { consumerId: c.id, watchPp: c.parts.watch, watchTurns: watches, quietWatchTurns: c.quietWatchTurns ?? 0 },
      });
    }
  }
  return hints;
}

export function buildPlanUsageReport(query: PlanUsageQuery, input: ReportInput = {}): PlanUsageReport {
  const now = input.now ?? Date.now();
  const days = query.days ?? (query.window && !['current', 'previous'].includes(query.window) ? 90 : DEFAULT_DAYS);
  const records = input.records ?? readLedger(days, now);
  const all = computeWindows(records, { now, intervals: query.intervals === '1' });
  const windows = selectWindows(all, query);
  return {
    schema: PLAN_USAGE_SCHEMA,
    version: PLAN_USAGE_VERSION,
    generatedAt: new Date(now).toISOString(),
    tracking: planUsageTracking(),
    accounts: ledgerAccounts(records),
    windows,
    hints: planUsageHints(windows, all, input.timeZone),
  };
}

export function buildPlanUsageConsumers(ids: string[] | undefined, days: number, input: ReportInput = {}): PlanUsageConsumersResponse {
  const now = input.now ?? Date.now();
  const records = input.records ?? readLedger(days, now);
  const wanted = ids ? new Set(ids) : undefined;
  const entries = computeWindows(records, { now }).flatMap((w) => w.consumers
    .filter((c) => !wanted || wanted.has(c.id))
    .map((consumer) => ({ windowId: w.id, account: w.account, kind: w.kind, startsAt: w.startsAt, resetsAt: w.resetsAt, current: w.current, consumer })));
  return { schema: PLAN_USAGE_SCHEMA, version: PLAN_USAGE_VERSION, generatedAt: new Date(now).toISOString(), tracking: planUsageTracking(), entries };
}

/** Consumer ids, spelled once for every writer and reader. */
export const taskConsumerId = (projectId: string, runId: string) => `run:${projectId}/${runId}`;
export const managerConsumerId = (managerId: string) => `mgr:${managerId}`;
