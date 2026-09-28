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
      for (const record of records) output.log(`${record.id}\t${JSON.stringify(record.root ?? 'unknown')}\t${record.provider ?? 'unknown'}\t${record.status}`);
    } else if (args.length === 2 && args[0] === 'remove') {
      await store.removeId(args[1]!);
      output.log('Local credential entry removed. This does not revoke the vendor token.');
    } else {
      output.error('Usage: cez tracker-connections list | remove <64-hex-id>');
      return 1;
    }
    return 0;
  } catch {
    output.error('Cannot access tracker credentials. Check the connection ID and local storage permissions.');
    return 1;
  }
}
