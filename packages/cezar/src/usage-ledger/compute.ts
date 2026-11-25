import type {
  PlanUsageAccount, PlanUsageConsumer, PlanUsageInterval, PlanUsageReading, PlanUsageWindow, PlanUsageWindowKind, PlanUsageTurnStats,
} from '@open-mercato/cezar-contract';
import type { LedgerConsumer, LedgerRecord, LedgerTurnStats } from './store.ts';

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
/** Quiet time after a turn that still counts as that turn's (reading at the next turn's start). */
const IDLE_GRACE = 15 * MINUTE;
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
  turn?: LedgerTurnStats;
  samples: Sample[];
  /** No `end` was recorded: `end` is the open-session bound, not evidence the turn was live. */
  capped?: boolean;
}
/** A manager turn's stats plus its reported cost, for the message it wrote. */
/** A reply's turn stats: its last attempt's shape (a retry is the one that answered) and the cost of
 *  every attempt, since each one spent the limit. */
function turnOf(attempts: readonly Session[]): { turn?: PlanUsageTurnStats } {
  const last = attempts.filter((a) => a.turn).reduce<Session | undefined>((a, b) => (!a || b.begin >= a.begin ? b : a), undefined);
  if (!last?.turn) return {};
  const usd = attempts.reduce((sum, a) => sum + a.samples.reduce((total, sample) => total + (sample.usd ?? 0), 0), 0);
  return { turn: { ...last.turn, ...(usd > 0 ? { usd: Math.round(usd * 10_000) / 10_000 } : {}) } };
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

/** One login inside one account folder: a re-login never shares windows or turns with the old one. */
const LOGIN_SEP = '\u0001';
const loginKey = (account: string, identity?: string) => (identity ? `${account}${LOGIN_SEP}${identity}` : account);
const splitLogin = (key: string) => {
  const [account, identity] = key.split(LOGIN_SEP);
  return { account: account!, ...(identity ? { identity } : {}) };
};

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

/**
 * Time in (a, b] inside quiet stretches longer than IDLE_GRACE with no cezar turn — before the
 * first turn, between turns or after the last — counting only what exceeds the grace (QA R3).
 */
function idleBeyondGrace(ranges: Array<[number, number]>, a: number, b: number): number {
  const merged: Array<[number, number]> = [];
  for (const [x, y] of ranges.map(([x, y]) => [Math.max(a, x), Math.min(b, Math.max(x, y))] as [number, number]).sort((p, q) => p[0] - q[0])) {
    const last = merged.at(-1);
    if (last && x <= last[1]) last[1] = Math.max(last[1], y);
    else merged.push([x, y]);
  }
  let idle = 0;
  let cursor = a;
  for (const [x, y] of merged) {
    idle += Math.max(0, x - cursor - IDLE_GRACE);
    cursor = Math.max(cursor, y);
  }
  return idle + Math.max(0, b - cursor - IDLE_GRACE);
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
  rawReadings: Array<{ account: string; kind: PlanUsageWindowKind; resetsAt: number } & Reading>;
  failures: Array<{ consumerId: string; since: number; at: number }>;
  labels: Map<string, string>;
  /** Stretches an account was not recorded, by plain account key (QA F1). */
  gaps: Map<string, Gap[]>;
}

export interface Gap { from: number; to: number | null; reason: 'tracking-off' | 'recording-started' }

/**
 * Where recording stopped and resumed. `off`…`on` is an explicit stretch; a `start` means this
 * process began recording, so whatever happened since the account's previous record is unknown.
 */
function trackingGaps(markers: Array<Extract<LedgerRecord, { t: 'tracking' }>>, readings: Ledger['rawReadings'], sessions: Session[]): Map<string, Gap[]> {
  const gaps = new Map<string, Gap[]>();
  const seen = new Map<string, number[]>();
  const note = (account: string, at: number) => {
    const list = seen.get(account);
    if (list) list.push(at);
    else seen.set(account, [at]);
  };
  for (const r of readings) note(splitLogin(r.account).account, r.at);
  for (const x of sessions) {
    const account = splitLogin(x.account).account;
    note(account, x.begin);
    if (x.end !== undefined) note(account, x.end);
    for (const sample of x.samples) note(account, sample.to);
  }
  for (const m of [...markers].sort((a, b) => a.at - b.at)) {
    const list = gaps.get(m.account) ?? [];
    const open = list.at(-1)?.to === null ? list.at(-1) : undefined;
    if (m.state === 'off') {
      if (!open) list.push({ from: m.at, to: null, reason: 'tracking-off' });
    } else if (open) {
      open.to = m.at;
    } else if (m.state === 'start') {
      // A turn recorded on both sides of the marker proves another cezar process was recording
      // the account all along (a headless `cezar run` starting beside the cockpit): no gap (QA R2).
      if (sessions.some((x) => splitLogin(x.account).account === m.account && x.begin < m.at
        && ((x.end !== undefined && x.end > m.at) || x.samples.some((sample) => sample.to > m.at)))) {
        gaps.set(m.account, list);
        continue;
      }
      const before = (seen.get(m.account) ?? []).filter((at) => at < m.at);
      // The very first record of an account has nothing before it to cut off.
      if (before.length === 0) {
        gaps.set(m.account, list);
        continue;
      }
      const from = Math.max(...before);
      const last = list.at(-1);
      // Nothing recorded since the previous gap closed (the usual `on` then `start`): one gap.
      if (last && last.to !== null && from <= last.to) last.to = Math.max(last.to, m.at);
      else list.push({ from, to: m.at, reason: 'recording-started' });
    }
    gaps.set(m.account, list);
  }
  return gaps;
}

/** The gap a slice crosses, if any: nobody can be named for usage across it. */
function crossedGap(gaps: Gap[], a: number, b: number): Gap | undefined {
  return gaps.find((g) => g.from < b && (g.to === null || g.to > a));
}

/** The last closed gap before `a`. */
function lastGapBefore(gaps: Gap[], a: number): Gap | undefined {
  let found: Gap | undefined;
  for (const g of gaps) if (g.to !== null && g.to <= a && (!found || g.to > found.to!)) found = g;
  return found;
}

/**
 * Turns begun before a recording gap never carry over it (QA F1). One exception: a turn whose
 * own records continue past a `recording-started` gap was live in another process the whole time
 * (a second cockpit or `cezar run` starting up), so that gap did not interrupt it.
 */
function carriesOver(session: Session, gap: Gap | undefined): boolean {
  if (!gap || session.begin >= gap.to!) return true;
  if (gap.reason !== 'recording-started') return false;
  return (!session.capped && session.end !== undefined && session.end > gap.to!) || session.samples.some((x) => x.to > gap.to!);
}

export function indexLedger(records: LedgerRecord[]): Ledger {
  const sessions = new Map<string, Session>();
  const rawReadings: Ledger['rawReadings'] = [];
  const failures: Ledger['failures'] = [];
  const labels = new Map<string, string>();
  const latestConsumer = new Map<string, LedgerConsumer>();
  const markers: Array<Extract<LedgerRecord, { t: 'tracking' }>> = [];
  for (const r of records) {
    if (r.t === 'reading') {
      rawReadings.push({ account: loginKey(r.account, r.identity), kind: r.window, resetsAt: r.resetsAt, at: r.at, used: r.usedPercent, status: r.status, source: r.source });
      if (r.label) labels.set(r.account, r.label);
    } else if (r.t === 'begin') {
      if (sessions.has(r.session)) continue;
      sessions.set(r.session, { id: r.session, account: loginKey(r.account, r.identity), consumer: r.consumer, ...(r.part ? { part: r.part } : {}), ...(r.messageId ? { messageId: r.messageId } : {}), begin: r.at, samples: [] });
      if (r.label) labels.set(r.account, r.label);
      latestConsumer.set(r.consumer.id, r.consumer);
    } else if (r.t === 'sample') {
      sessions.get(r.session)?.samples.push({ from: r.from, to: r.to, ...(r.usd !== undefined ? { usd: r.usd } : {}), ...(r.tokens !== undefined ? { tokens: r.tokens } : {}) });
    } else if (r.t === 'end') {
      const s = sessions.get(r.session);
      if (s && s.end === undefined) {
        s.end = r.at;
        if (r.quiet !== undefined) s.quiet = r.quiet;
        if (r.turn) s.turn = r.turn;
      }
    } else if (r.t === 'tracking') {
      markers.push(r);
      continue;
    } else failures.push({ consumerId: r.consumerId, since: r.since, at: r.at });
  }
  // A later title (auto-naming, a rename) wins for every session of that consumer.
  for (const s of sessions.values()) {
    const latest = latestConsumer.get(s.consumer.id);
    if (latest?.title) s.consumer = { ...s.consumer, title: latest.title };
  }
  return { sessions: [...sessions.values()], rawReadings, failures, labels, gaps: trackingGaps(markers, rawReadings, [...sessions.values()]) };
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

function attribute(sessions: Session[], a: number, b0: number, delta: number, source?: PlanUsageReading['source']): { shares: Share[]; outside: number; unsplit: number; interval: Omit<PlanUsageInterval, 'from' | 'to' | 'deltaPp'> } {
  const b = b0 > a ? b0 : a + 1;
  const active = sessions.map((s) => ({ s, start: Math.max(s.begin, a), stop: Math.min(sessionEnd(s, Number.MAX_SAFE_INTEGER), b) }))
    // Closed overlap: a call that began and answered within one instant still ran in the slice.
    .filter((x) => x.s.begin <= b && sessionEnd(x.s, Number.MAX_SAFE_INTEGER) > a)
    // A reading taken as a turn starts predates its spend, so that turn is no candidate. Claude
    // sends its reading after a request's answer, which already counts that request's input: once
    // a turn has a per-request sample that ended by `b`, the reading includes it (a re-cached
    // history read 16 s into a turn showed the whole jump, spec 2026-11-21 § 1.3).
    .filter((x) => !(x.s.begin > b - READING_LEAD && sessionEnd(x.s, Number.MAX_SAFE_INTEGER) > b)
      || (source === 'claude-stream' && x.s.samples.some((sample) => sample.from >= x.s.begin && sample.to <= b && sample.to < sessionEnd(x.s, Number.MAX_SAFE_INTEGER))));
  const consumerIds = new Set(active.map((x) => x.s.consumer.id));
  if (consumerIds.size === 0) {
    return { shares: [], outside: delta, unsplit: 0, interval: { outcome: 'outside', weightUnit: null, allocations: [], outsideCezarPp: round(delta), unsplitPp: 0 } };
  }
  // Someone in cezar ran: the slice is theirs (≈, since your own sessions are not excluded) —
  // except stretches longer than IDLE_GRACE with no cezar turn at all. The next reading also
  // carries the last turn's spend, so that time is unknown, never the short turn's alone (QA F1).
  const outside = 0;
  const span = b - a;
  const idle = idleBeyondGrace(active.map((x) => [x.start, x.stop] as [number, number]), a, b);
  const idleUnsplit = span > 0 && idle > 0 ? delta * idle / span : 0;
  const inside = delta - idleUnsplit;
  const shares: Share[] = [];
  let unsplit = idleUnsplit;
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
    // Added to the idle share above, never replacing it (QA R1).
    const unknown = inside * u;
    unsplit += unknown;
    const rest = inside - unknown;
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

function windowId(login: string, kind: PlanUsageWindowKind, resetsAt: number): string {
  const { account, identity } = splitLogin(login);
  return `win:${account}${identity ? `@${identity.slice(0, 8)}` : ''}:${kind}:${new Date(resetsAt).toISOString().slice(0, 16)}Z`;
}

/** The login an account folder held most recently (by its newest reading or turn). */
function latestLogin(ledger: Ledger, account: string): string | undefined {
  let best: { at: number; login: string } | undefined;
  for (const r of ledger.rawReadings) {
    if (splitLogin(r.account).account === account && (!best || r.at > best.at)) best = { at: r.at, login: r.account };
  }
  for (const s of ledger.sessions) {
    if (splitLogin(s.account).account === account && (!best || s.begin > best.at)) best = { at: s.begin, login: s.account };
  }
  return best?.login;
}
function earlierLogin(login: string, ledger: Ledger): boolean {
  const latest = latestLogin(ledger, splitLogin(login).account);
  return latest !== undefined && latest !== login;
}
function windowAccount(login: string, ledger: Ledger): PlanUsageAccount {
  const { account, identity } = splitLogin(login);
  const base = accountFromKey(account, ledger.labels.get(account));
  const earlier = earlierLogin(login, ledger);
  return { ...base, ...(identity ? { identity } : {}), ...(earlier ? { earlierLogin: true, label: `${base.label} (earlier login)` } : {}) };
}

function buildWindow(seed: WindowSeed, ledger: Ledger, options: ComputeOptions): PlanUsageWindow {
  const now = options.now ?? Date.now();
  const startsAt = seed.resetsAt - DURATION[seed.kind];
  const end = seed.supersededAt ?? seed.resetsAt;
  const sessions = ledger.sessions.filter((s) => s.account === seed.account && s.begin < end && sessionEnd(s, now) > startsAt)
    .map((s) => (s.end === undefined ? { ...s, end: sessionEnd(s, now), capped: true } : s));
  const readings = seed.readings;
  const first = readings[0]!;
  let hwm = first.used;
  // When the current high-water level was first reported: a flat whole-percent reading after it
  // does not end the spend that the next rise reveals.
  let hwmAt = first.at;
  let outside = 0;
  let unsplit = 0;
  const shares: Share[] = [];
  const intervals: PlanUsageInterval[] = [];
  const gaps = ledger.gaps.get(splitLogin(seed.account).account) ?? [];
  // A window whose start fell inside a recording gap opened while cezar was not recording: its
  // first reading is untracked usage, not "before cezar's first reading" (QA R4).
  const openingGap = gaps.find((g) => g.from < first.at && (g.to === null || g.to > startsAt));
  let untracked = openingGap ? first.used : 0;
  for (let i = 1; i < readings.length; i++) {
    const prev = readings[i - 1]!;
    const cur = readings[i]!;
    const gap = crossedGap(gaps, prev.at, cur.at);
    if (gap) {
      // Across a recording gap the provider total stands, but nobody is charged; the first
      // reading after it is the new baseline (QA F1).
      if (cur.used > hwm) {
        untracked += cur.used - hwm;
        if (options.intervals) intervals.push({ from: new Date(prev.at).toISOString(), to: new Date(cur.at).toISOString(), deltaPp: round(cur.used - hwm), outcome: 'untracked', reason: gap.reason, weightUnit: null, allocations: [], outsideCezarPp: 0, unsplitPp: 0 });
        hwm = cur.used;
      }
      hwmAt = cur.at;
      continue;
    }
    if (cur.used <= hwm) continue;
    const delta = cur.used - hwm;
    const from = hwmAt;
    hwm = cur.used;
    hwmAt = cur.at;
    // The slice since the high-water reading, not since a later flat or lower (corrected) one;
    // turns begun before the last recording gap never carry over it.
    const gapBefore = lastGapBefore(gaps, from);
    const result = attribute(sessions.filter((x) => carriesOver(x, gapBefore)), from, cur.at, delta, cur.source);
    outside += result.outside;
    unsplit += result.unsplit;
    for (const share of result.shares) shares.push({ ...share, interval: i });
    if (options.intervals) intervals.push({ from: new Date(from).toISOString(), to: new Date(cur.at).toISOString(), deltaPp: round(delta), ...result.interval });
  }
  const last = readings.at(-1)!;
  const correction = Math.max(0, hwm - last.used);
  const limitHit = readings.find((r) => r.used >= 100 || r.status === 'blocked');

  const consumers = new Map<string, PlanUsageConsumer & { _partners: Set<string> }>();
  const failuresBy = new Map<string, Ledger['failures']>();
  for (const f of ledger.failures) failuresBy.set(f.consumerId, [...(failuresBy.get(f.consumerId) ?? []), f]);
  // Every attempt of a reply in this window, shares or not: until the next reading the answering
  // attempt has none, yet its shape and spend are the reply's.
  const attemptsOf = new Map<string, Session[]>();
  for (const s of sessions) {
    if (s.messageId) attemptsOf.set(s.messageId, [...(attemptsOf.get(s.messageId) ?? []), s]);
  }
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
        ranTogetherWith: { tasks: 0, managers: 0, internal: 0 }, evidence: 'account-level',
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
      let m = c.messages.find((x) => x.messageId === s.messageId);
      if (!m) {
        m = { messageId: s.messageId, part: s.part, at: new Date(s.begin).toISOString(), estimatePp: 0, aloneInferredPp: 0, sharedEstimatePp: 0, ...turnOf(attemptsOf.get(s.messageId) ?? [s]) };
        c.messages.push(m);
      }
      m.estimatePp += share.pp;
      if (share.alone) m.aloneInferredPp += share.pp;
      else m.sharedEstimatePp += share.pp;
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
      ranTogetherWith: { tasks: partners.filter((k) => k === 'task').length, managers: partners.filter((k) => k === 'manager').length, internal: partners.filter((k) => k === 'internal').length },
      ...(c.parts ? { parts: { chat: round(c.parts.chat), watch: round(c.parts.watch), job: round(c.parts.job) } } : {}),
      ...(c.kind === 'manager' ? {
        turns: { chat: own.filter((s) => s.part === 'chat').length, watch: own.filter((s) => s.part === 'watch').length, job: own.filter((s) => s.part === 'job').length },
        quietWatchTurns: own.filter((s) => s.part === 'watch' && s.quiet === true).length,
        messages: (c.messages ?? []).map((m) => ({ ...m, estimatePp: round(m.estimatePp), aloneInferredPp: round(m.aloneInferredPp), sharedEstimatePp: round(m.sharedEstimatePp) })),
      } : {}),
    };
  }).filter((c) => c.estimatePp > 0).sort((x, y) => y.estimatePp - x.estimatePp);

  return {
    id: windowId(seed.account, seed.kind, seed.resetsAt),
    account: windowAccount(seed.account, ledger),
    kind: seed.kind,
    startsAt: new Date(startsAt).toISOString(),
    resetsAt: new Date(seed.resetsAt).toISOString(),
    current: seed.resetsAt > now && seed.supersededAt === undefined && !earlierLogin(seed.account, ledger),
    usedPercent: { first: round(first.used), last: round(last.used) },
    ...(limitHit ? { limitReachedAt: new Date(limitHit.at).toISOString() } : {}),
    readings: readings.map((r) => ({ at: new Date(r.at).toISOString(), usedPercent: round(r.used), status: r.status, source: r.source })),
    consumers: list,
    beforeTrackingPp: openingGap ? 0 : round(first.used),
    outsideCezarPp: round(outside),
    unsplitPp: round(unsplit),
    untrackedPp: round(untracked),
    trackingGaps: gaps.filter((g) => g.from <= end && (g.to === null || g.to >= startsAt))
      .map((g) => ({ from: new Date(g.from).toISOString(), to: g.to === null ? null : new Date(g.to).toISOString(), reason: g.reason })),
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
