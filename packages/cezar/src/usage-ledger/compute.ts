import type {
  PlanUsageAccount, PlanUsageConsumer, PlanUsageInterval, PlanUsageReading, PlanUsageWindow, PlanUsageWindowKind,
} from '@open-mercato/cezar-contract';
import type { LedgerConsumer, LedgerRecord } from './store.ts';

/**
 * Plan-limit attribution (design rev 3, "How it's calculated"). Pure: ledger records in,
 * windows out, recomputed from scratch on every read so late cost reports settle earlier
 * guesses. Invariant per window, pinned by tests:
 *   beforeTracking + Σ consumers + outsideCezar + unsplit − correction = last reading.
 * Each reading delta is allocated exactly once, whatever number of sessions reported it.
 */

const MINUTE = 60_000;
const DURATION: Record<PlanUsageWindowKind, number> = { 'five-hour': 300 * MINUTE, weekly: 7 * 24 * 60 * MINUTE };
/** Provider resets jitter by seconds; two readings this close name the same window. */
const RESET_TOLERANCE = 10 * MINUTE;
/** A session with no `end` (a crashed process) counts as running this long after its last sign. */
const OPEN_SESSION_CAP = 2 * 60 * MINUTE;
const EPS = 1e-9;
/** How long after a turn starts its own first reading may arrive. */
const READING_LEAD = 20_000;

interface Sample { from: number; to: number; usd?: number; tokens?: number }
interface Session {
  id: string;
  account: string;
  consumer: LedgerConsumer;
  part?: 'chat' | 'watch' | 'job';
  messageId?: string;
  begin: number;
  end?: number;
  quiet?: boolean;
  samples: Sample[];
}
interface Reading { at: number; used: number; status: PlanUsageReading['status']; source: PlanUsageReading['source'] }
interface Share {
  consumerId: string;
  session?: Session;
  /** Time point used to decide whether this slice belonged to a failed attempt. */
  at: number;
  pp: number;
  alone: boolean;
  weight: number | null;
  interval?: number;
}

export interface ComputeOptions {
  now?: number;
  intervals?: boolean;
}

export function accountFromKey(key: string, label?: string): PlanUsageAccount {
  const [provider, ...rest] = key.split(':');
  const accountId = rest.join(':') || 'default';
  const p = provider === 'codex' ? 'codex' : 'claude';
  return { key, provider: p, accountId, label: `${p === 'claude' ? 'Claude' : 'Codex'} · ${label && label !== accountId ? label : accountId}` };
}

const round = (n: number) => Math.round(n * 100) / 100;
const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

function sessionEnd(s: Session, now: number): number {
  if (s.end !== undefined) return s.end;
  const last = Math.max(s.begin, ...s.samples.map((x) => x.to));
  return Math.min(now, last + OPEN_SESSION_CAP);
}

function unionLength(ranges: Array<[number, number]>): number {
  const sorted = ranges.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur: [number, number] | undefined;
  for (const r of sorted) {
    if (!cur || r[0] > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [r[0], r[1]];
    } else cur[1] = Math.max(cur[1], r[1]);
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

/** Sample weight inside (a, b], spread evenly over the time the sample covers. */
function sampleWeight(sample: Sample, unit: 'usd' | 'tokens', a: number, b: number): number {
  const value = unit === 'usd' ? sample.usd ?? 0 : sample.tokens ?? 0;
  if (sample.to <= sample.from) return sample.to > a && sample.to <= b ? value : 0;
  return value * overlap(sample.from, sample.to, a, b) / (sample.to - sample.from);
}

function sampleCoverage(sample: Sample, a: number, b: number): number {
  return overlap(sample.from, sample.to, a, b);
}

export interface Ledger {
  sessions: Session[];
  readings: Map<string, Map<PlanUsageWindowKind, Reading[] & { resetsAt?: number }>>;
  rawReadings: Array<{ account: string; kind: PlanUsageWindowKind; resetsAt: number } & Reading>;
  failures: Array<{ consumerId: string; since: number; at: number }>;
  labels: Map<string, string>;
}

export function indexLedger(records: LedgerRecord[]): Ledger {
  const sessions = new Map<string, Session>();
  const rawReadings: Ledger['rawReadings'] = [];
  const failures: Ledger['failures'] = [];
  const labels = new Map<string, string>();
  const latestConsumer = new Map<string, LedgerConsumer>();
  for (const r of records) {
    if (r.t === 'reading') {
      rawReadings.push({ account: r.account, kind: r.window, resetsAt: r.resetsAt, at: r.at, used: r.usedPercent, status: r.status, source: r.source });
      if (r.label) labels.set(r.account, r.label);
    } else if (r.t === 'begin') {
      if (sessions.has(r.session)) continue;
      sessions.set(r.session, { id: r.session, account: r.account, consumer: r.consumer, ...(r.part ? { part: r.part } : {}), ...(r.messageId ? { messageId: r.messageId } : {}), begin: r.at, samples: [] });
      if (r.label) labels.set(r.account, r.label);
      latestConsumer.set(r.consumer.id, r.consumer);
    } else if (r.t === 'sample') {
      sessions.get(r.session)?.samples.push({ from: r.from, to: r.to, ...(r.usd !== undefined ? { usd: r.usd } : {}), ...(r.tokens !== undefined ? { tokens: r.tokens } : {}) });
    } else if (r.t === 'end') {
      const s = sessions.get(r.session);
      if (s && s.end === undefined) {
        s.end = r.at;
        if (r.quiet !== undefined) s.quiet = r.quiet;
      }
    } else failures.push({ consumerId: r.consumerId, since: r.since, at: r.at });
  }
  // A later title (auto-naming, a rename) wins for every session of that consumer.
  for (const s of sessions.values()) {
    const latest = latestConsumer.get(s.consumer.id);
    if (latest?.title) s.consumer = { ...s.consumer, title: latest.title };
  }
  return { sessions: [...sessions.values()], readings: new Map(), rawReadings, failures, labels };
}

interface WindowSeed { account: string; kind: PlanUsageWindowKind; resetsAt: number; readings: Reading[]; supersededAt?: number }

function windowSeeds(ledger: Ledger): WindowSeed[] {
  const groups = new Map<string, Ledger['rawReadings']>();
  for (const r of ledger.rawReadings) {
    const key = `${r.account}\u0000${r.kind}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const seeds: WindowSeed[] = [];
  for (const list of groups.values()) {
    const byReset = [...list].sort((a, b) => a.resetsAt - b.resetsAt);
    const clusters: Array<typeof list> = [];
    for (const r of byReset) {
      const cluster = clusters.at(-1);
      if (cluster && r.resetsAt - cluster[0]!.resetsAt <= RESET_TOLERANCE) cluster.push(r);
      else clusters.push([r]);
    }
    const built = clusters.map((cluster) => {
      const readings = cluster.sort((a, b) => a.at - b.at);
      // The newest reading names the reset: earlier ones may predate a provider adjustment.
      const resetsAt = readings.at(-1)!.resetsAt;
      return {
        account: cluster[0]!.account, kind: cluster[0]!.kind, resetsAt,
        readings: readings.filter((r) => r.at <= resetsAt).map(({ at, used, status, source }) => ({ at, used, status, source })),
      } satisfies WindowSeed;
    }).filter((w) => w.readings.length > 0);
    // A newer window that starts before this one's reset (an early reset or another login)
    // ends this one: its later readings never extend the older window.
    for (let i = 0; i < built.length - 1; i++) {
      const next = built[i + 1]!;
      const current = built[i]!;
      const firstNext = next.readings[0]!.at;
      if (firstNext < current.resetsAt) {
        (current as WindowSeed).supersededAt = firstNext;
        current.readings = current.readings.filter((r) => r.at <= firstNext);
      }
    }
    seeds.push(...built);
  }
  return seeds;
}

function attribute(sessions: Session[], a: number, b0: number, delta: number): { shares: Share[]; outside: number; unsplit: number; interval: Omit<PlanUsageInterval, 'from' | 'to' | 'deltaPp'> } {
  const b = b0 > a ? b0 : a + 1;
  const active = sessions.map((s) => ({ s, start: Math.max(s.begin, a), stop: Math.min(sessionEnd(s, Number.MAX_SAFE_INTEGER), b) }))
    .filter((x) => x.stop > x.start || (x.s.begin <= a && sessionEnd(x.s, Number.MAX_SAFE_INTEGER) >= b))
    // Claude reads the account when a request starts: the turn whose start produced reading `b`
    // had spent nothing yet, so it is not a candidate for the slice that reading closes.
    .filter((x) => !(x.s.begin > b - READING_LEAD && sessionEnd(x.s, Number.MAX_SAFE_INTEGER) > b));
  const consumerIds = new Set(active.map((x) => x.s.consumer.id));
  if (consumerIds.size === 0) {
    return { shares: [], outside: delta, unsplit: 0, interval: { outcome: 'outside', weightUnit: null, allocations: [], outsideCezarPp: round(delta), unsplitPp: 0 } };
  }
  // Someone in cezar ran: the slice is theirs (≈, since your own sessions are not excluded).
  const outside = 0;
  const inside = delta;
  const shares: Share[] = [];
  let unsplit = 0;
  let unit: 'usd' | 'tokens' | null = null;

  if (consumerIds.size === 1) {
    // Ran alone: no split needed. Spread across its sessions by time, then by samples, so a
    // manager's chat/watch/job parts and failed attempts still get their own slice.
    const totalTime = active.reduce((sum, x) => sum + Math.max(x.stop - x.start, EPS), 0);
    for (const x of active) {
      const sessionPp = inside * Math.max(x.stop - x.start, EPS) / totalTime;
      const len = Math.max(x.stop - x.start, EPS);
      let assigned = 0;
      for (const sample of x.s.samples) {
        const cov = sampleCoverage(sample, x.start, x.stop);
        if (cov <= 0) continue;
        const pp = sessionPp * cov / len;
        assigned += pp;
        shares.push({ consumerId: x.s.consumer.id, session: x.s, at: Math.min(sample.to, x.stop), pp, alone: true, weight: null });
      }
      if (sessionPp - assigned > EPS) shares.push({ consumerId: x.s.consumer.id, session: x.s, at: x.stop, pp: sessionPp - assigned, alone: true, weight: null });
    }
  } else {
    const overlapping = active.flatMap((x) => x.s.samples.filter((sample) => sampleCoverage(sample, a, b) > 0 || (sample.to > a && sample.to <= b)).map((sample) => ({ x, sample })));
    unit = overlapping.length > 0 && overlapping.every(({ sample }) => sample.usd !== undefined) ? 'usd'
      : overlapping.length > 0 && overlapping.every(({ sample }) => sample.tokens !== undefined) ? 'tokens' : null;
    // Time no cost report covers yet (a turn still running, or one that stopped mid-reply) can't be split.
    let activeTime = 0;
    let unknownTime = 0;
    for (const x of active) {
      const len = Math.max(x.stop - x.start, 0);
      const cov = Math.min(len, unionLength(x.s.samples.map((sample) => [Math.max(sample.from, x.start), Math.min(sample.to, x.stop)] as [number, number])));
      activeTime += len;
      unknownTime += len - cov;
    }
    const u = activeTime > 0 ? unknownTime / activeTime : 1;
    unsplit = inside * u;
    const rest = inside - unsplit;
    const weighted = unit ? overlapping.map(({ x, sample }) => ({ x, sample, w: sampleWeight(sample, unit!, a, b) })) : [];
    const total = weighted.reduce((sum, item) => sum + item.w, 0);
    if (total <= 0) unsplit += rest;
    else {
      for (const item of weighted) {
        if (item.w <= 0) continue;
        shares.push({ consumerId: item.x.s.consumer.id, session: item.x.s, at: Math.min(item.sample.to, b), pp: rest * item.w / total, alone: false, weight: item.w });
      }
    }
  }
  const byConsumer = new Map<string, { pp: number; weight: number | null }>();
  for (const share of shares) {
    const entry = byConsumer.get(share.consumerId) ?? { pp: 0, weight: share.weight === null ? null : 0 };
    entry.pp += share.pp;
    if (share.weight !== null) entry.weight = (entry.weight ?? 0) + share.weight;
    byConsumer.set(share.consumerId, entry);
  }
  const allocated = shares.reduce((sum, s) => sum + s.pp, 0);
  const outcome: PlanUsageInterval['outcome'] = allocated <= EPS ? 'unsplit'
    : outside > EPS || unsplit > EPS ? 'mixed' : consumerIds.size === 1 ? 'alone' : 'split';
  return {
    shares, outside, unsplit,
    interval: {
      outcome, weightUnit: unit,
      allocations: [...byConsumer.entries()].map(([consumerId, v]) => ({ consumerId, estimatePp: round(v.pp), weight: v.weight === null ? null : round(v.weight * 1e6) / 1e6 })),
      outsideCezarPp: round(outside), unsplitPp: round(unsplit),
    },
  };
}

function windowId(account: string, kind: PlanUsageWindowKind, resetsAt: number): string {
  return `win:${account}:${kind}:${new Date(resetsAt).toISOString().slice(0, 16)}Z`;
}

function buildWindow(seed: WindowSeed, ledger: Ledger, options: ComputeOptions): PlanUsageWindow {
  const now = options.now ?? Date.now();
  const startsAt = seed.resetsAt - DURATION[seed.kind];
  const end = seed.supersededAt ?? seed.resetsAt;
  const sessions = ledger.sessions.filter((s) => s.account === seed.account && s.begin < end && sessionEnd(s, now) > startsAt)
    .map((s) => (s.end === undefined ? { ...s, end: sessionEnd(s, now) } : s));
  const readings = seed.readings;
  const first = readings[0]!;
  let hwm = first.used;
  let outside = 0;
  let unsplit = 0;
  const shares: Share[] = [];
  const intervals: PlanUsageInterval[] = [];
  for (let i = 1; i < readings.length; i++) {
    const prev = readings[i - 1]!;
    const cur = readings[i]!;
    if (cur.used <= hwm) continue;
    const delta = cur.used - hwm;
    hwm = cur.used;
    // The slice since the high-water reading, not since a lower (corrected) one.
    const result = attribute(sessions, prev.at, cur.at, delta);
    outside += result.outside;
    unsplit += result.unsplit;
    for (const share of result.shares) shares.push({ ...share, interval: i });
    if (options.intervals) intervals.push({ from: new Date(prev.at).toISOString(), to: new Date(cur.at).toISOString(), deltaPp: round(delta), ...result.interval });
  }
  const last = readings.at(-1)!;
  const correction = Math.max(0, hwm - last.used);
  const limitHit = readings.find((r) => r.used >= 100 || r.status === 'blocked');

  const consumers = new Map<string, PlanUsageConsumer & { _partners: Set<string> }>();
  const failuresBy = new Map<string, Ledger['failures']>();
  for (const f of ledger.failures) failuresBy.set(f.consumerId, [...(failuresBy.get(f.consumerId) ?? []), f]);
  for (const share of shares) {
    const s = share.session!;
    let c = consumers.get(share.consumerId);
    if (!c) {
      c = {
        id: s.consumer.id, kind: s.consumer.kind, title: s.consumer.title || s.consumer.id,
        ...(s.consumer.projectId ? { projectId: s.consumer.projectId } : {}),
        ...(s.consumer.runId ? { runId: s.consumer.runId } : {}),
        ...(s.consumer.managerId ? { managerId: s.consumer.managerId } : {}),
        estimatePp: 0, aloneInferredPp: 0, sharedEstimatePp: 0, retryWasteEstimatePp: 0,
        ranTogetherWith: { tasks: 0, managers: 0 }, evidence: 'account-level',
        ...(s.consumer.kind === 'manager' ? { parts: { chat: 0, watch: 0, job: 0 }, messages: [] } : {}),
        _partners: new Set<string>(),
      };
      consumers.set(share.consumerId, c);
    }
    c.estimatePp += share.pp;
    if (share.alone) c.aloneInferredPp += share.pp;
    else c.sharedEstimatePp += share.pp;
    if ((failuresBy.get(share.consumerId) ?? []).some((f) => share.at > f.since && share.at <= f.at)) c.retryWasteEstimatePp += share.pp;
    if (c.parts && s.part) c.parts[s.part] += share.pp;
    if (c.messages && s.messageId && s.part) {
      const m = c.messages.find((x) => x.messageId === s.messageId);
      if (m) m.estimatePp += share.pp;
      else c.messages.push({ messageId: s.messageId, part: s.part, estimatePp: share.pp });
    }
  }
  // "Ran together with": other consumers holding a shared slice of the same reading pair.
  const byInterval = new Map<number, Set<string>>();
  for (const share of shares) {
    if (share.alone || share.interval === undefined) continue;
    byInterval.set(share.interval, (byInterval.get(share.interval) ?? new Set()).add(share.consumerId));
  }
  for (const ids of byInterval.values()) {
    for (const id of ids) for (const other of ids) if (other !== id) consumers.get(id)!._partners.add(other);
  }
  const managerSessions = sessions.filter((s) => s.consumer.kind === 'manager' && s.begin >= startsAt && s.begin < end);
  const list: PlanUsageConsumer[] = [...consumers.values()].map(({ _partners, ...c }) => {
    const partners = [..._partners].map((id) => consumers.get(id)!.kind);
    const own = managerSessions.filter((s) => s.consumer.id === c.id);
    return {
      ...c,
      estimatePp: round(c.estimatePp), aloneInferredPp: round(c.aloneInferredPp), sharedEstimatePp: round(c.sharedEstimatePp),
      retryWasteEstimatePp: round(c.retryWasteEstimatePp),
      ranTogetherWith: { tasks: partners.filter((k) => k === 'task').length, managers: partners.filter((k) => k === 'manager').length },
      ...(c.parts ? { parts: { chat: round(c.parts.chat), watch: round(c.parts.watch), job: round(c.parts.job) } } : {}),
      ...(c.kind === 'manager' ? {
        turns: { chat: own.filter((s) => s.part === 'chat').length, watch: own.filter((s) => s.part === 'watch').length, job: own.filter((s) => s.part === 'job').length },
        quietWatchTurns: own.filter((s) => s.part === 'watch' && s.quiet === true).length,
        messages: (c.messages ?? []).map((m) => ({ ...m, estimatePp: round(m.estimatePp) })),
      } : {}),
    };
  }).filter((c) => c.estimatePp > 0).sort((x, y) => y.estimatePp - x.estimatePp);

  return {
    id: windowId(seed.account, seed.kind, seed.resetsAt),
    account: accountFromKey(seed.account, ledger.labels.get(seed.account)),
    kind: seed.kind,
    startsAt: new Date(startsAt).toISOString(),
    resetsAt: new Date(seed.resetsAt).toISOString(),
    current: seed.resetsAt > now && seed.supersededAt === undefined,
    usedPercent: { first: round(first.used), last: round(last.used) },
    ...(limitHit ? { limitReachedAt: new Date(limitHit.at).toISOString() } : {}),
    readings: readings.map((r) => ({ at: new Date(r.at).toISOString(), usedPercent: round(r.used), status: r.status, source: r.source })),
    consumers: list,
    beforeTrackingPp: round(first.used),
    outsideCezarPp: round(outside),
    unsplitPp: round(unsplit),
    correctionPp: round(correction),
    leftPp: round(Math.max(0, 100 - last.used)),
    ...(options.intervals ? { intervals } : {}),
  };
}

/** Every window the ledger has readings for, newest reset first. */
export function computeWindows(records: LedgerRecord[], options: ComputeOptions = {}): PlanUsageWindow[] {
  const ledger = indexLedger(records);
  return windowSeeds(ledger).map((seed) => buildWindow(seed, ledger, options))
    .sort((a, b) => Date.parse(b.resetsAt) - Date.parse(a.resetsAt) || a.account.key.localeCompare(b.account.key));
}

/** Every account the ledger knows (readings or activity), labelled. */
export function ledgerAccounts(records: LedgerRecord[]): PlanUsageAccount[] {
  const labels = new Map<string, string | undefined>();
  for (const r of records) {
    if (r.t === 'reading' || r.t === 'begin') labels.set(r.account, r.label ?? labels.get(r.account));
  }
  return [...labels.entries()].map(([key, label]) => accountFromKey(key, label)).sort((a, b) => a.key.localeCompare(b.key));
}
