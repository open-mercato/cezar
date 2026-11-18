import { TrackerConnections } from './connections.ts';

/** Local-only credential inventory; never resolves repositories or calls a vendor. */
export async function runTrackerConnectionsCommand(
  args: string[], env: NodeJS.ProcessEnv = process.env,
  output: Pick<Console, 'log' | 'error'> = console,
): Promise<number> {
  const store = new TrackerConnections(env);
  try {
    if (args.length === 1 && args[0] === 'list') {
      const records = await store.inventory();
      output.log('ID\tROOT\tPROVIDER\tSTATUS');
      // Shared records (spec 2026-11-18-shared-tracker-connections) have no root of their own.
      for (const record of records) output.log(`${record.id}\t${JSON.stringify(record.root ?? (record.links === undefined ? 'unknown' : '(shared)'))}\t${record.provider ?? 'unknown'}\t${record.status}`);
    } else if (args.length === 2 && args[0] === 'remove') {
      const links = args[1]!.startsWith('shared-')
        ? (await store.inventory().catch(() => [])).find(record => record.id === args[1])?.links ?? 0 : 0;
      await store.removeId(args[1]!);
      output.log('Local credential entry removed. This does not revoke the vendor token.');
      if (links > 0) output.log(`${links} project(s) used this shared connection and must pick another one or save credentials.`);
    } else {
      output.error('Usage: cez tracker-connections list | remove <64-hex-id | shared-<uuid>>');
      return 1;
    }
    return 0;
  } catch {
    output.error('Cannot access tracker credentials. Check the connection ID and local storage permissions.');
    return 1;
  }
}
