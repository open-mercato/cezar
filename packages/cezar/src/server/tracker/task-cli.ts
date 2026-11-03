import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { trackerContextSchema, trackerOperationInputSchema, trackerOperationResultSchema } from '@open-mercato/cezar-contract';

const USAGE = 'cez tracker read | comment --id <UUID> --body-file <path> | transition --id <UUID> --transition <id> --expected-status <id>';
const WRITE_HINT = 'A write may still have reached the tracker: retry with the SAME --id, never a new one.';

class UsageError extends Error {}

async function serverError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // not JSON
  }
  return `HTTP ${response.status}`;
}

/** Exit codes: 0 done, 1 usage, 2 refused/failed/not completed. */
export async function runTrackerCommand(args: string[], env: NodeJS.ProcessEnv = process.env, io = { fetch, log: console.log, error: console.error }): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === '--help') { io.log(USAGE); return 0; }
  const write = command !== 'read';
  try {
    if (!['read', 'comment', 'transition'].includes(command) || (command === 'read' && rest.length)) throw new UsageError(USAGE);
    if (!env.CEZ_API_URL || !env.CEZ_TRACKER_CAPABILITY) {
      io.error('Tracker access is available only inside an authorized tracker task.');
      return 2;
    }
    const base = new URL(env.CEZ_API_URL);
    if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || base.username || base.password) {
      io.error('Tracker operations require the local cockpit.');
      return 2;
    }
    const scope = env.CEZ_PROJECT_ID ? `/p/${encodeURIComponent(env.CEZ_PROJECT_ID)}` : '';
    const url = `${base.origin}/api/v1${scope}/tracker/task`;
    const headers = { Authorization: `Bearer ${env.CEZ_TRACKER_CAPABILITY}`, 'Content-Type': 'application/json' };
    let init: RequestInit = { headers, redirect: 'error', signal: AbortSignal.timeout(40_000) };
    if (write) {
      let values: Record<string, string | boolean | undefined>;
      try { ({ values } = parseArgs({ args: rest, options: { id: { type: 'string' }, 'body-file': { type: 'string' }, transition: { type: 'string' }, 'expected-status': { type: 'string' } } })); }
      catch (error) { throw new UsageError(`${(error as Error).message}\n${USAGE}`); }
      const bodyFile = values['body-file'];
      if (command === 'comment' && typeof bodyFile !== 'string') throw new UsageError('comment needs --body-file <path>.');
      const action = command === 'comment'
        ? { kind: 'comment', body: await readFile(bodyFile as string, 'utf8').catch(() => { throw new UsageError(`Cannot read --body-file ${String(bodyFile)}.`); }) }
        : { kind: 'transition', transitionId: values.transition, expectedStatusId: values['expected-status'] };
      const parsed = trackerOperationInputSchema.safeParse({ operationId: values.id, action });
      if (!parsed.success) throw new UsageError(`Invalid arguments: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'input'} ${issue.message}`).join('; ')}`);
      // The server may wait for another write to the same issue, then read the issue before sending.
      init = { ...init, method: 'POST', body: JSON.stringify(parsed.data), signal: AbortSignal.timeout(120_000) };
    }
    let response: Response;
    try { response = await io.fetch(url, init); }
    catch {
      io.error(`Cannot reach the cockpit.${write ? ` ${WRITE_HINT}` : ''}`);
      return 2;
    }
    if (!response.ok) {
      // A 409 can follow a vendor-confirmed write whose receipt failed to save: only input and
      // authorization errors prove nothing was sent.
      const refused = [400, 403, 404].includes(response.status);
      io.error(`Tracker request ${refused ? 'refused' : 'failed'} (${response.status}): ${await serverError(response)}${write && !refused ? ` ${WRITE_HINT}` : ''}`);
      return 2;
    }
    const data: unknown = await response.json();
    const result = write ? trackerOperationResultSchema.parse(data) : trackerContextSchema.parse(data);
    io.log(JSON.stringify(result, null, 2));
    return 'status' in result && result.status !== 'completed' ? 2 : 0;
  } catch (error) {
    if (error instanceof UsageError) { io.error(error.message); return 1; }
    io.error(`Tracker command failed: unexpected response.${write ? ` ${WRITE_HINT}` : ''}`);
    return 2;
  }
}
