import { parseArgs } from 'node:util';
import { accountUsageReportSchema, planUsageQuerySchema, type AccountUsageReport } from '@open-mercato/cezar-contract';
import { missingCockpitMessage } from '../cockpit-address.ts';
import { formatPlanUsageReport } from './format.ts';
import { buildPlanUsageReport } from './report.ts';

export const USAGE_HELP = `cez usage — which tasks and managers used your Claude/Codex plan limits

  cez usage [--account claude:default] [--window current|previous|all|<window id>]
            [--kind five-hour|weekly] [--days N] [--intervals] [--json]

  Reads the local ledger (~/.cezar/usage-ledger, kept 90 days; CEZ_USAGE_LOG=0 turns it off).
  Shares marked ≈ are estimates: providers report usage per account, so cezar splits busy
  periods by each consumer's reported cost (Claude) or tokens (Codex).
  --json prints the versioned report (schema "cezar.usage-ledger") the cockpit reads.

  cez usage --live [--account codex:work] [--json]
  Asks the cockpit how much of each agent account's subscription is left (5h and weekly used %,
  reset time). Only accounts the user switched on in Settings → Agent accounts ("Allow agents to
  check this account's usage") are queried; the rest say "not allowed". Numbers only, never a
  credential. For an occasional check before a large task, never in a loop. Needs CEZ_API_URL
  (set inside a task) and, on a multi-project cockpit, CEZ_PROJECT_ID.`;

export interface UsageCliEnv { CEZ_API_URL?: string; CEZ_TASK_ID?: string }

/** One line per account, then its windows; a non-ok status says why in fixed words. */
export function formatAccountUsage(report: AccountUsageReport): string {
  if (report.accounts.length === 0) return 'No agent accounts to report.';
  return report.accounts.map((a) => {
    const head = `${a.key}${a.label && a.label !== a.accountId ? ` (${a.label})` : ''}`;
    if (a.status !== 'ok') return `${head}: ${a.status}${a.message ? ` — ${a.message}` : ''}`;
    const windows = a.windows.map((w) => `${w.kind} ${w.usedPercent === null ? 'unknown' : `${Math.round(w.usedPercent)}% used`}${w.resetsAt ? `, resets ${w.resetsAt}` : ''}`).join('; ');
    return `${head}: ${windows}${a.source === 'ledger' ? ` (last recorded${a.observedAt ? ` ${a.observedAt}` : ''})` : ''}`;
  }).join('\n');
}

async function runLiveUsage(
  account: string | undefined, json: boolean,
  io: { log: (line: string) => void; error: (line: string) => void },
  env: UsageCliEnv, doFetch: typeof fetch,
): Promise<number> {
  const url = env.CEZ_API_URL?.replace(/\/+$/, '');
  if (!url) {
    io.error(missingCockpitMessage({
      command: 'cez usage --live', example: 'cez usage --live',
      insideTask: 'the cockpit sets it inside a task. Tell the user the live usage check is unavailable; do not look for credentials yourself.',
    }, env));
    return 2;
  }
  try {
    const response = await doFetch(`${url}/api/v1/workspace/account-usage${account ? `?account=${encodeURIComponent(account)}` : ''}`);
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : `${response.status} ${response.statusText}`;
      io.error(`cez usage --live: ${error}`);
      return 1;
    }
    const report = accountUsageReportSchema.parse(body);
    io.log(json ? JSON.stringify(report, null, 2) : formatAccountUsage(report));
    return 0;
  } catch {
    io.error('cez usage --live: the cockpit could not be reached or answered something unexpected');
    return 1;
  }
}

/** `cez usage`: no server needed — the ledger is a local file, the same one the cockpit reads. */
export async function runUsageCommand(
  args: string[],
  io: { log: (line: string) => void; error: (line: string) => void } = { log: console.log, error: console.error },
  env: UsageCliEnv = process.env,
  doFetch: typeof fetch = fetch,
): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args,
      options: {
        account: { type: 'string' }, window: { type: 'string' }, kind: { type: 'string' },
        days: { type: 'string' }, intervals: { type: 'boolean' }, live: { type: 'boolean' }, json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    io.error(USAGE_HELP);
    return 2;
  }
  if (values.help) {
    io.log(USAGE_HELP);
    return 0;
  }
  if (values.live) return runLiveUsage(typeof values.account === 'string' ? values.account : undefined, values.json === true, io, env, doFetch);
  const parsed = planUsageQuerySchema.safeParse({
    ...(values.account ? { account: values.account } : {}),
    ...(values.window ? { window: values.window } : {}),
    ...(values.kind ? { kind: values.kind } : {}),
    ...(values.days ? { days: values.days } : {}),
    ...(values.intervals ? { intervals: '1' } : {}),
  });
  if (!parsed.success) {
    io.error(`cez usage: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return 2;
  }
  const report = buildPlanUsageReport(parsed.data);
  io.log(values.json ? JSON.stringify(report, null, 2) : formatPlanUsageReport(report));
  return 0;
}
