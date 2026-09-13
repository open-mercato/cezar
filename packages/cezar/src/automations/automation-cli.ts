/**
 * `cez automation …` — the CLI a running agent (or a human at a shell) uses to create and manage
 * GitHub automations on a running cockpit (spec `.ai/specs/2026-09-13-automations-from-prompt.md`).
 *
 * A thin HTTP client over the automations family, addressed like `cez task` is: `CEZ_API_URL`
 * (the cockpit) and `CEZ_PROJECT_ID` (which project the run belongs to), both put in every agent's
 * environment by the engine while the cockpit is reachable. No server: the command says so and
 * exits 2. Automations off on the cockpit (`CEZ_AUTOMATIONS` unset): every route answers 409 with
 * the flag's name, which this command relays verbatim and exits 1 — the agent is told to stop and
 * report, never to substitute a cron job or a polling script.
 *
 * The definition travels as JSON (`--file`, `--json`, or stdin) rather than as flags: it has
 * nested filters and a task block, and an agent writes JSON to a file more reliably than it
 * quotes a dozen flags in a shell.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { AUTOMATION_SCHEMA_REFERENCE } from './prompts.ts';

export interface AutomationCliEnv {
  CEZ_API_URL?: string;
  CEZ_PROJECT_ID?: string;
}

export interface AutomationCliIo {
  fetch: typeof fetch;
  log: (line: string) => void;
  error: (line: string) => void;
  /** Reads `--file`; injectable so the tests never touch the disk. */
  readFile?: (path: string) => Promise<string>;
  /** Reads the definition from stdin when neither `--file` nor `--json` is given. */
  readStdin?: () => Promise<string>;
  /** The check poll's pause; injectable so the tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
}

const USAGE = `cez automation — create and manage GitHub automations on a running cockpit (CEZ_AUTOMATIONS=1)

  cez automation schema                         print the definition shape, bounds and prompt placeholders
  cez automation create [--file <def.json> | --json '<json>'] [--enable]
                                                create one from a JSON definition (stdin when neither flag is given);
                                                paused unless --enable
  cez automation update <id> [--file | --json]  replace the definition's editable keys (name, description, events,
                                                intervalSeconds, filters, task); keys you omit keep their value
  cez automation check <id> [--execute]         run the filter now — preview counts matches and launches nothing,
                                                --execute launches a task per match exactly as a scheduled poll would
  cez automation list                           every automation of this project, with state and counts
  cez automation show <id>                      one definition with its runtime state, as JSON
  cez automation enable <id>                    enable it from a current-time baseline (the backlog is never launched)
  cez automation pause <id>                     pause it (the definition and its history stay)
  cez automation delete <id>                    delete it`;

const CHECK_POLL_MS = 500;
const CHECK_TIMEOUT_MS = 120_000;

/** The keys `PUT /automations/:id` accepts besides `enabled` and `expectedRevision`. */
const EDITABLE_KEYS = ['name', 'description', 'events', 'intervalSeconds', 'filters', 'task'] as const;

function base(env: AutomationCliEnv): { url: string; scope: string; projectId?: string } | null {
  const url = env.CEZ_API_URL?.replace(/\/+$/, '');
  if (!url) return null;
  const projectId = env.CEZ_PROJECT_ID || undefined;
  const scope = projectId ? `${url}/api/v1/p/${encodeURIComponent(projectId)}` : `${url}/api/v1`;
  return { url, scope, projectId };
}

/** Where the cockpit shows this automation — the link every mutating command prints. */
function pageUrl(api: { url: string; projectId?: string }, id: string): string {
  const prefix = api.projectId ? `${api.url}/p/${encodeURIComponent(api.projectId)}` : api.url;
  return `${prefix}/automations/${encodeURIComponent(id)}`;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // not JSON
  }
  return `${response.status} ${response.statusText}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function readDefinition(
  values: { file?: string; json?: string },
  io: AutomationCliIo,
): Promise<Record<string, unknown>> {
  if (values.file && values.json) throw new Error('give the definition as --file OR --json, not both');
  let raw: string;
  if (values.file) {
    raw = await (io.readFile ?? ((path) => readFile(path, 'utf8')))(values.file);
  } else if (values.json !== undefined) {
    raw = values.json;
  } else {
    raw = await (io.readStdin ?? readStdinText)();
    if (!raw.trim()) throw new Error('no definition given: pass --file <def.json>, --json \'<json>\', or pipe the JSON on stdin');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`the definition is not valid JSON — ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error('the definition must be a JSON object (see cez automation schema)');
  return parsed;
}

async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function shortEvents(events: unknown): string {
  return Array.isArray(events) ? events.map(String).join(',') : '';
}

export async function runAutomationCommand(
  args: string[],
  env: AutomationCliEnv = process.env,
  io: AutomationCliIo = { fetch, log: console.log, error: console.error },
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help') {
    io.log(USAGE);
    return command ? 0 : 2;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    io.log(USAGE);
    return 0;
  }
  // The reference needs no server: an agent reads it before it has anything to send.
  if (command === 'schema') {
    io.log(AUTOMATION_SCHEMA_REFERENCE);
    return 0;
  }
  const api = base(env);
  if (!api) {
    io.error('cez automation: CEZ_API_URL is not set — this command only works inside a task run by a cockpit with automations on (CEZ_AUTOMATIONS=1). Do not substitute a cron job, a GitHub Action or a polling script: stop and report that automations are unavailable.');
    return 2;
  }
  const json = async (url: string, init?: RequestInit): Promise<Response> =>
    io.fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const sleep = io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  try {
    switch (command) {
      case 'create': {
        const { values } = parseArgs({
          args: rest,
          allowPositionals: false,
          options: { file: { type: 'string' }, json: { type: 'string' }, enable: { type: 'boolean', default: false } },
        });
        const definition = await readDefinition(values, io);
        // `enabled` is not a body key of POST — a definition is always created paused and
        // `enable: true` is the one-step "create and baseline". A definition that carries it
        // (copied from `show`) would be refused, so it is lifted into the flag's slot.
        const { enabled, ...body } = definition;
        const enable = values.enable || enabled === true;
        const response = await json(`${api.scope}/automations`, {
          method: 'POST',
          body: JSON.stringify({ ...body, ...(enable ? { enable: true } : {}) }),
        });
        if (!response.ok) throw new Error(`create refused — ${await readError(response)}`);
        const { automation } = (await response.json()) as { automation: { id: string; name: string; enabled: boolean } };
        io.log(`created automation ${automation.id} "${automation.name}" — ${automation.enabled ? 'ENABLED from a current-time baseline' : 'paused'}`);
        io.log(`cockpit: ${pageUrl(api, automation.id)}`);
        if (!automation.enabled) io.log(`Preview its matches with: cez automation check ${automation.id} — then enable it with: cez automation enable ${automation.id}`);
        return 0;
      }
      case 'update': {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { file: { type: 'string' }, json: { type: 'string' } },
        });
        const id = positionals[0];
        if (!id) throw new Error('an automation id is required: cez automation update <id> --file <def.json>');
        const patch = await readDefinition(values, io);
        const current = await json(`${api.scope}/automations/${encodeURIComponent(id)}`);
        if (!current.ok) throw new Error(`could not read automation ${id} — ${await readError(current)}`);
        const { automation } = (await current.json()) as { automation: Record<string, unknown> };
        const body: Record<string, unknown> = {};
        for (const key of EDITABLE_KEYS) {
          const value = key in patch ? patch[key] : automation[key];
          if (value !== undefined) body[key] = value;
        }
        // A PUT restates `enabled` (an edit may not silently pause a running automation) and
        // echoes the revision it read, so a concurrent edit in the cockpit is a 409, not a clobber.
        body.enabled = 'enabled' in patch ? patch.enabled : automation.enabled;
        body.expectedRevision = automation.revision;
        const response = await json(`${api.scope}/automations/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`update refused — ${await readError(response)}`);
        const updated = (await response.json()) as { automation: { id: string; name: string; revision: number; enabled: boolean } };
        io.log(`updated automation ${updated.automation.id} "${updated.automation.name}" (revision ${updated.automation.revision}, ${updated.automation.enabled ? 'enabled' : 'paused'})`);
        io.log(`cockpit: ${pageUrl(api, updated.automation.id)}`);
        return 0;
      }
      case 'check': {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { execute: { type: 'boolean', default: false } },
        });
        const id = positionals[0];
        if (!id) throw new Error('an automation id is required: cez automation check <id>');
        const mode = values.execute ? 'execute' : 'preview';
        const queued = await json(`${api.scope}/automations/${encodeURIComponent(id)}/check`, { method: 'POST', body: JSON.stringify({ mode }) });
        if (!queued.ok) throw new Error(`check refused — ${await readError(queued)}`);
        const { checkId } = (await queued.json()) as { checkId: string };
        // The check runs in the server's background; its record is workspace-level (keyed by the
        // unguessable id the project route handed back), so it is polled off the plain API root.
        const deadline = Date.now() + CHECK_TIMEOUT_MS;
        for (;;) {
          const response = await io.fetch(`${api.url}/api/v1/automation-checks/${encodeURIComponent(checkId)}`);
          if (!response.ok) throw new Error(`could not read check ${checkId} — ${await readError(response)}`);
          const check = (await response.json()) as { status: string; matches?: number; truncated?: boolean; error?: string };
          if (check.status === 'complete') {
            const matches = check.matches ?? 0;
            io.log(
              mode === 'preview'
                ? `preview: ${matches} match${matches === 1 ? '' : 'es'} right now${check.truncated ? ' (truncated at the filter\'s maxRecords)' : ''} — nothing was launched`
                : `execute: ${matches} match${matches === 1 ? '' : 'es'}${check.truncated ? ' (truncated at the filter\'s maxRecords)' : ''} — a task was launched per new match; see the automation's log in the cockpit`,
            );
            io.log(`cockpit: ${pageUrl(api, id)}`);
            return 0;
          }
          if (check.status === 'error') throw new Error(`check failed — ${check.error ?? 'unknown error'}`);
          if (Date.now() > deadline) throw new Error(`check ${checkId} did not finish within ${CHECK_TIMEOUT_MS / 1000}s; it may still be running — read the automation's log in the cockpit`);
          await sleep(CHECK_POLL_MS);
        }
      }
      case 'list': {
        const response = await io.fetch(`${api.scope}/automations`);
        if (!response.ok) throw new Error(`could not list automations — ${await readError(response)}`);
        const data = (await response.json()) as {
          available: boolean;
          reason?: string;
          automations: Array<{
            id: string; name: string; enabled: boolean; events: string[]; intervalSeconds: number;
            counts: { launched: number; duplicates: number; errors: number };
            state?: { nextCheckAt?: string; lastSuccessAt?: string };
          }>;
        };
        if (!data.available) io.log(`GitHub is not available to this cockpit${data.reason ? ` — ${data.reason}` : ''}; automations will not poll until it is.`);
        if (data.automations.length === 0) {
          io.log('no automations in this project');
          return 0;
        }
        for (const item of data.automations) {
          const next = item.enabled && item.state?.nextCheckAt ? `  next ${item.state.nextCheckAt}` : '';
          io.log(`${item.id}  ${item.enabled ? 'enabled' : 'paused '}  every ${item.intervalSeconds}s  ${shortEvents(item.events)}  launched ${item.counts.launched}, duplicates ${item.counts.duplicates}, errors ${item.counts.errors}${next}  ${item.name}`);
        }
        return 0;
      }
      case 'show': {
        const id = rest[0];
        if (!id) throw new Error('an automation id is required: cez automation show <id>');
        const response = await io.fetch(`${api.scope}/automations/${encodeURIComponent(id)}`);
        if (!response.ok) throw new Error(`could not read automation ${id} — ${await readError(response)}`);
        io.log(JSON.stringify(await response.json(), null, 2));
        return 0;
      }
      case 'enable':
      case 'pause': {
        const id = rest[0];
        if (!id) throw new Error(`an automation id is required: cez automation ${command} <id>`);
        const response = await json(`${api.scope}/automations/${encodeURIComponent(id)}/${command}`, { method: 'POST' });
        if (!response.ok) throw new Error(`${command} refused — ${await readError(response)}`);
        const { automation } = (await response.json()) as { automation: { id: string; name: string } };
        io.log(
          command === 'enable'
            ? `enabled automation ${automation.id} "${automation.name}" from a current-time baseline — existing pull requests and issues are not launched`
            : `paused automation ${automation.id} "${automation.name}"`,
        );
        io.log(`cockpit: ${pageUrl(api, automation.id)}`);
        return 0;
      }
      case 'delete': {
        const id = rest[0];
        if (!id) throw new Error('an automation id is required: cez automation delete <id>');
        const response = await io.fetch(`${api.scope}/automations/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!response.ok) throw new Error(`delete refused — ${await readError(response)}`);
        io.log(`deleted automation ${id}`);
        return 0;
      }
      default:
        io.error(`cez automation: unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    io.error(`cez automation: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
