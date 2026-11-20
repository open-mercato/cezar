import { parseArgs } from 'node:util';
import { planUsageQuerySchema } from '@open-mercato/cezar-contract';
import { formatPlanUsageReport } from './format.ts';
import { buildPlanUsageReport } from './report.ts';

export const USAGE_HELP = `cez usage — which tasks and managers used your Claude/Codex plan limits

  cez usage [--account claude:default] [--window current|previous|all|<window id>]
            [--kind five-hour|weekly] [--days N] [--intervals] [--json]

  Reads the local ledger (~/.cezar/usage-ledger, kept 90 days; CEZ_USAGE_LOG=0 turns it off).
  Shares marked ≈ are estimates: providers report usage per account, so cezar splits busy
  periods by each consumer's reported cost (Claude) or tokens (Codex).
  --json prints the versioned report (schema "cezar.usage-ledger") the cockpit reads.`;

/** `cez usage`: no server needed — the ledger is a local file, the same one the cockpit reads. */
export async function runUsageCommand(
  args: string[],
  io: { log: (line: string) => void; error: (line: string) => void } = { log: console.log, error: console.error },
): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args,
      options: {
        account: { type: 'string' }, window: { type: 'string' }, kind: { type: 'string' },
        days: { type: 'string' }, intervals: { type: 'boolean' }, json: { type: 'boolean' },
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
