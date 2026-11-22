import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { PLAN_USAGE_RETENTION_DAYS, planUsageTurnStatsSchema, type PlanUsageTracking, type PlanUsageTurnStats } from '@open-mercato/cezar-contract';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from '../paths.ts';

/**
 * The local plan-usage ledger: one append-only NDJSON file per UTC day under
 * `~/.cezar/usage-ledger/`, kept 90 days. Metadata only — readings, activity spans and the
 * cost/token weights that split them; never prompts, paths or code. On by default (approved
 * decision 1); `CEZ_USAGE_LOG=0` or a per-account switch turns writing off.
 */

const consumerSchema = z.object({
  id: z.string().max(400),
  kind: z.enum(['task', 'manager', 'internal']),
  title: z.string().max(300).catch(''),
  projectId: z.string().max(200).optional(),
  runId: z.string().max(200).optional(),
  managerId: z.string().max(200).optional(),
});
export type LedgerConsumer = z.infer<typeof consumerSchema>;

const part = z.enum(['chat', 'watch', 'job']).optional();
const ms = z.number().int().nonnegative();

export const ledgerRecordSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('reading'), at: ms, account: z.string().max(300), label: z.string().max(200).optional(),
    identity: z.string().max(64).optional(),
    window: z.enum(['five-hour', 'weekly']), usedPercent: z.number().finite().nonnegative(),
    resetsAt: ms, status: z.enum(['allowed', 'blocked', 'unknown']),
    source: z.enum(['claude-stream', 'codex-notification', 'codex-read']),
  }),
  z.object({
    t: z.literal('begin'), at: ms, account: z.string().max(300), label: z.string().max(200).optional(),
    identity: z.string().max(64).optional(),
    session: z.string().max(100), consumer: consumerSchema, part, messageId: z.string().max(200).optional(),
  }),
  z.object({
    t: z.literal('sample'), from: ms, to: ms, session: z.string().max(100),
    usd: z.number().finite().nonnegative().optional(), tokens: z.number().finite().nonnegative().optional(),
    quiet: z.boolean().optional(),
  }),
  z.object({
    t: z.literal('end'), at: ms, session: z.string().max(100), quiet: z.boolean().optional(),
    turn: planUsageTurnStatsSchema.omit({ usd: true }).optional().catch(undefined),
  }),
  z.object({ t: z.literal('attempt-failed'), at: ms, consumerId: z.string().max(400), since: ms }),
  /** Recording boundaries (QA F1): `off`/`on` when an account's switch flips, `start` the first
   *  time a process records an account. Usage across one is never attributed. */
  z.object({ t: z.literal('tracking'), at: ms, account: z.string().max(300), state: z.enum(['off', 'on', 'start']) }),
]);
export type LedgerRecord = z.infer<typeof ledgerRecordSchema>;
/** A manager turn's shape, as the ledger keeps it; the report adds its cost. */
export type LedgerTurnStats = Omit<PlanUsageTurnStats, 'usd'>;

const DAY_MS = 86_400_000;
const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[cezar] ${message}`);
}

export function ledgerDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), 'usage-ledger');
}
const trackingPath = () => join(cezarHomeDir(), 'usage-tracking.json');
const dayFile = (at: number) => `${new Date(at).toISOString().slice(0, 10)}.ndjson`;

export function usageLogDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_USAGE_LOG === '0';
}

const trackingFileSchema = z.object({ accounts: z.record(z.string(), z.boolean()).catch({}) }).passthrough();
let trackingCache: { at: number; accounts: Record<string, boolean> } | undefined;

function readTrackingAccounts(): Record<string, boolean> {
  if (trackingCache && Date.now() - trackingCache.at < 5_000) return trackingCache.accounts;
  let accounts: Record<string, boolean> = {};
  try {
    accounts = trackingFileSchema.parse(JSON.parse(readFileSync(trackingPath(), 'utf8'))).accounts;
  } catch { /* absent or unreadable: every account tracked */ }
  trackingCache = { at: Date.now(), accounts };
  return accounts;
}

export function planUsageTracking(): PlanUsageTracking {
  const disabled = usageLogDisabledByEnv();
  return {
    enabled: !disabled,
    ...(disabled ? { reason: 'CEZ_USAGE_LOG=0 turns plan-limit tracking off on this machine.' } : {}),
    retentionDays: PLAN_USAGE_RETENTION_DAYS,
    accounts: readTrackingAccounts(),
  };
}

export function setAccountTracking(account: string, enabled: boolean): PlanUsageTracking {
  const path = trackingPath();
  assertCezarHomeWriteIsSandboxed(path);
  const accounts = { ...readTrackingAccounts() };
  const was = accounts[account] !== false;
  // The boundary is metadata about the switch, not usage: written while the account still
  // records (off) or once it records again (on), never under CEZ_USAGE_LOG=0.
  if (was && !enabled && !usageLogDisabledByEnv()) writeRecord({ t: 'tracking', at: Date.now(), account, state: 'off' });
  // Only an opt-out is stored: the default stays the absence of a key.
  if (enabled) delete accounts[account];
  else accounts[account] = false;
  mkdirSync(cezarHomeDir(), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ accounts }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  trackingCache = { at: Date.now(), accounts };
  if (!was && enabled && !usageLogDisabledByEnv()) writeRecord({ t: 'tracking', at: Date.now(), account, state: 'on' });
  return planUsageTracking();
}

export function accountTracked(account: string): boolean {
  return !usageLogDisabledByEnv() && readTrackingAccounts()[account] !== false;
}

let lastPrune = 0;
function pruneOld(dir: string, now: number): void {
  if (now - lastPrune < DAY_MS / 4) return;
  lastPrune = now;
  const oldest = new Date(now - PLAN_USAGE_RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);
  try {
    for (const name of readdirSync(dir)) {
      if (/^\d{4}-\d{2}-\d{2}\.ndjson$/.test(name) && name.slice(0, 10) < oldest) rmSync(join(dir, name), { force: true });
    }
  } catch { /* best effort */ }
}

/** Append one record. Never throws: usage metadata must never fail a task or a manager turn. */
const startedAccounts = new Set<string>();

export function appendLedger(record: LedgerRecord, account?: string): void {
  if (usageLogDisabledByEnv()) return;
  if (account !== undefined && !accountTracked(account)) return;
  // This process may follow a stretch nobody recorded (cezar stopped, CEZ_USAGE_LOG=0, another
  // cockpit with the account off): mark where its recording starts, once per account.
  if (account !== undefined && !startedAccounts.has(account)) {
    startedAccounts.add(account);
    const at = record.t === 'sample' ? record.from : record.at;
    writeRecord({ t: 'tracking', at, account, state: 'start' });
  }
  writeRecord(record);
}

function writeRecord(record: LedgerRecord): void {
  const dir = ledgerDir();
  try {
    const at = record.t === 'sample' ? record.to : record.at;
    const file = join(dir, dayFile(at));
    assertCezarHomeWriteIsSandboxed(file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // One short line per O_APPEND write: concurrent cezar processes never interleave inside it.
    // The leading newline seals a line a crash left torn, so it never swallows this record.
    appendFileSync(file, `\n${JSON.stringify(record)}`, { mode: 0o600 });
    pruneOld(dir, Date.now());
  } catch (error) {
    if (error instanceof Error && /sandbox/i.test(error.message)) throw error;
    warnOnce(dir, 'Plan-limit usage log unavailable; continuing without it.');
  }
}

/** Every valid record written in the last `days` days (plus one day of slack for open sessions). */
export function readLedger(days: number, now = Date.now()): LedgerRecord[] {
  const dir = ledgerDir();
  const oldest = new Date(now - (days + 1) * DAY_MS).toISOString().slice(0, 10);
  let names: string[];
  try { names = readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(n) && n.slice(0, 10) >= oldest).sort(); }
  catch { return []; }
  const out: LedgerRecord[] = [];
  for (const name of names) {
    let text: string;
    try { text = readFileSync(join(dir, name), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const parsed = ledgerRecordSchema.safeParse(JSON.parse(line));
        if (parsed.success) out.push(parsed.data);
      } catch { /* a torn last line from a crash: skip it */ }
    }
  }
  return out;
}

/** Test seam. */
export function resetLedgerCaches(): void {
  trackingCache = undefined;
  startedAccounts.clear();
  lastPrune = 0;
}
