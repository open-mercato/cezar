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
import { trackerAutomationOptionsSchema, SCHEDULE_TYPES, parseCron, scheduleLabel, type AutomationSchedule } from '@open-mercato/cezar-contract';
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

const USAGE = `cez automation — create and manage automations (GitHub/Jira/Linear event polls and schedules) on a running cockpit

  cez automation schema                         print the definition shape, bounds and prompt placeholders
  cez automation create [--file <def.json> | --json '<json>'] [--enable]
                                                create one from a JSON definition (stdin when neither flag is given);
                                                paused unless --enable
  cez automation add --name <name> (--cron "<M H * * *>" | --on <event>[,<event>] --every <5m|1h>)
                     [--prompt <text> | --prompt-file <path>] [--workflow <w>] [--runner claude|codex|opencode]
                     [--model <m>] [--autonomous | --no-autonomous] [--dispatch [--max-subtasks N] [--review-child]]
                     [--label <l>]... [--author <a>]... [--enable]
                                                the same, from flags: --cron takes "M H * * *" (daily), "M H * * 1-5"
                                                (weekdays), "M H * * D" (one weekday, 0 or 7 = Sunday) or "0 */N * * *"
                                                (every N hours, N in 1,2,3,4,6,8,12); anything else needs the JSON form
  cez automation add --kind tracker --name <name> --on issue.status_changed --to-status <status-id>
                     [--changed-label <label-id>] [--require-label <name>]... [--every 30m] --prompt <text> [--enable]
                                                use this project's configured tracker; only advertised events are accepted
  cez automation update <id> [--file | --json]  replace the definition's editable keys (name, description, kind,
                                                events, intervalSeconds, filters, schedule, task); keys you omit keep
                                                their value
  cez automation check <id> [--execute]         event poll: run the filter now — preview counts matches and launches
                                                nothing, --execute launches a task per match exactly as a poll would
  cez automation run <id>                       schedule: launch it once, now, by hand (paused or not)
  cez automation list                           every automation of this project, with state and counts
  cez automation show <id>                      one definition with its runtime state, as JSON
  cez automation enable <id>                    enable it from a current-time baseline (the backlog is never launched)
  cez automation pause <id>                     pause it (the definition and its history stay)
  cez automation delete <id>                    delete it`;

const CHECK_POLL_MS = 500;
const CHECK_TIMEOUT_MS = 120_000;

/** The keys `PUT /automations/:id` accepts besides `enabled` and `expectedRevision`. */
const EDITABLE_KEYS = ['name', 'description', 'kind', 'events', 'intervalSeconds', 'filters', 'schedule', 'trackerTrigger', 'task'] as const;

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

/** `5m`, `1h`, `300s` or a bare number of seconds. */
export function parseEvery(value: string): number {
  const match = /^(\d+)\s*([smh]?)$/.exec(value.trim());
  if (!match) throw new Error(`--every wants a duration like 5m, 1h or 300s, not "${value}"`);
  const n = Number(match[1]);
  const unit = match[2] || 's';
  return unit === 'h' ? n * 3_600 : unit === 'm' ? n * 60 : n;
}

/** The `add` flags as the `create` body they stand for. Exported so the tests pin the mapping. */
export function bodyFromAddFlags(values: {
  name?: string; cron?: string; on?: string; every?: string; prompt?: string; kind?: string; 'to-status'?: string[]; 'changed-label'?: string[]; 'require-label'?: string[];
  workflow?: string; runner?: string; model?: string; autonomous?: boolean; 'no-autonomous'?: boolean;
  dispatch?: boolean; 'max-subtasks'?: string; 'review-child'?: boolean; label?: string[]; author?: string[]; enable?: boolean;
}, prompt: string): Record<string, unknown> {
  if (!values.name?.trim()) throw new Error('--name is required');
  if (!prompt.trim()) throw new Error('--prompt (or --prompt-file) is required');
  if (values.cron && values.on) throw new Error('give --cron (a schedule) OR --on (a GitHub poll), not both');
  if (!values.cron && !values.on) throw new Error('give --cron "<M H * * *>" for a schedule or --on <event> for a GitHub poll');
  if (values.kind && !['github', 'schedule', 'tracker'].includes(values.kind)) throw new Error('--kind must be github, schedule or tracker');
  if (values.kind === 'tracker' && (values.cron || values.label?.length || values.author?.length)) throw new Error('tracker polls use --on and --to-status/--changed-label, not --cron/--label/--author');
  if (values.kind !== 'tracker' && (values['to-status']?.length || values['changed-label']?.length || values['require-label']?.length)) throw new Error('--to-status/--changed-label/--require-label require --kind tracker');
  if (values.kind === 'schedule' && !values.cron) throw new Error('--kind schedule requires --cron');
  if (values.kind === 'github' && values.cron) throw new Error('--kind github requires --on');
  const task: Record<string, unknown> = { prompt, worktree: true, autonomous: values['no-autonomous'] ? false : true };
  if (values.workflow) task.workflow = values.workflow;
  if (values.runner) task.runner = values.runner;
  if (values.model) task.model = values.model;
  if (values.dispatch || values['max-subtasks'] !== undefined || values['review-child']) {
    const dispatch: Record<string, unknown> = {};
    if (values['max-subtasks'] !== undefined) {
      const n = Number(values['max-subtasks']);
      if (!Number.isInteger(n) || n < 1) throw new Error('--max-subtasks wants a positive integer');
      dispatch.maxSubtasks = n;
    }
    if (values['review-child']) dispatch.reviewChild = true;
    task.dispatch = dispatch;
  }
  const body: Record<string, unknown> = { name: values.name.trim(), task };
  if (values.cron) {
    const schedule: AutomationSchedule | null = parseCron(values.cron);
    if (!schedule) {
      throw new Error(`--cron "${values.cron}" is not one of the shapes a schedule can take (${SCHEDULE_TYPES.join(', ')}): "M H * * *", "M H * * 1-5", "M H * * D" (0 or 7 = Sunday) or "0 */N * * *" (N in 1,2,3,4,6,8,12). For anything else use the JSON form: cez automation schema`);
    }
    body.kind = 'schedule';
    body.schedule = schedule;
  } else if (values.kind === 'tracker') {
    body.kind = 'tracker';
    body.trackerTrigger = { events: values.on!.split(',').map(event => event.trim()).filter(Boolean),
      ...(values['to-status']?.length ? { targetStatusIds: values['to-status'] } : {}),
      ...(values['require-label']?.length ? { requiredLabels: values['require-label'] } : {}),
      ...(values['changed-label']?.length ? { changedLabelIds: values['changed-label'] } : {}),
    };
    body.intervalSeconds = values.every ? parseEvery(values.every) : 1800;
    body.filters = { lookbackDays: 7, maxRecords: 25 };
  } else {
    body.kind = 'github';
    body.events = values.on!.split(',').map((event) => event.trim()).filter(Boolean);
    body.intervalSeconds = values.every ? parseEvery(values.every) : 300;
    const filters: Record<string, unknown> = { lookbackDays: 7, maxRecords: 25 };
    if (values.label?.length) filters.anyLabels = values.label;
    if (values.author?.length) filters.authors = values.author;
    body.filters = filters;
  }
  if (values.enable) body.enable = true;
  return body;
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
    io.error('cez automation: CEZ_API_URL is not set — this command only works inside a task run by a cockpit with automations on. Do not substitute a cron job, a GitHub Action or a polling script: stop and report that automations are unavailable.');
    return 2;
  }
  const json = async (url: string, init?: RequestInit): Promise<Response> =>
    io.fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const sleep = io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  /** `create` and `add` share one POST and one report; the flags only differ in how the body is built. */
  const createFrom = async (body: Record<string, unknown>): Promise<number> => {
    const response = await json(`${api.scope}/automations`, { method: 'POST', body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`create refused — ${await readError(response)}`);
    const { automation } = (await response.json()) as { automation: { id: string; name: string; enabled: boolean; kind?: string; schedule?: AutomationSchedule } };
    const schedule = automation.kind === 'schedule' && automation.schedule ? ` — ${scheduleLabel(automation.schedule)}, in the cockpit's time zone` : '';
    io.log(`created automation ${automation.id} "${automation.name}" — ${automation.enabled ? (automation.kind === 'schedule' ? 'ENABLED, next occurrence armed' : 'ENABLED from a current-time baseline') : 'paused'}${schedule}`);
    io.log(`cockpit: ${pageUrl(api, automation.id)}`);
    if (!automation.enabled) {
      io.log(automation.kind === 'schedule'
        ? `Launch it once now with: cez automation run ${automation.id} — enable it with: cez automation enable ${automation.id}`
        : `Preview its matches with: cez automation check ${automation.id} — then enable it with: cez automation enable ${automation.id}`);
    }
    return 0;
  };

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
        return await createFrom({ ...body, ...(enable ? { enable: true } : {}) });
      }
      case 'add': {
        const { values } = parseArgs({
          args: rest,
          allowPositionals: false,
          options: {
            kind: { type: 'string' }, 'to-status': { type: 'string', multiple: true }, 'changed-label': { type: 'string', multiple: true }, 'require-label': { type: 'string', multiple: true },
            name: { type: 'string' }, cron: { type: 'string' }, on: { type: 'string' }, every: { type: 'string' },
            prompt: { type: 'string' }, 'prompt-file': { type: 'string' },
            workflow: { type: 'string' }, runner: { type: 'string' }, model: { type: 'string' },
            autonomous: { type: 'boolean', default: false }, 'no-autonomous': { type: 'boolean', default: false },
            dispatch: { type: 'boolean', default: false }, 'max-subtasks': { type: 'string' }, 'review-child': { type: 'boolean', default: false },
            label: { type: 'string', multiple: true }, author: { type: 'string', multiple: true },
            enable: { type: 'boolean', default: false },
          },
        });
        if (values.prompt && values['prompt-file']) {
          io.error('cez automation: give the prompt as --prompt OR --prompt-file, not both');
          return 2;
        }
        const prompt = values['prompt-file']
          ? await (io.readFile ?? ((path) => readFile(path, 'utf8')))(values['prompt-file'])
          : (values.prompt ?? '');
        let body: Record<string, unknown>;
        try {
          body = bodyFromAddFlags(values, prompt);
        } catch (error) {
          // A flag the command cannot express is a usage error (exit 2), not a refusal (exit 1):
          // the agent should reach for the JSON form, not stop and report.
          io.error(`cez automation: ${error instanceof Error ? error.message : String(error)}`);
          return 2;
        }
        if (body.kind === 'tracker') {
          const response = await json(`${api.scope}/tracker/automation-options`);
          if (!response.ok) throw new Error(`tracker setup unavailable — ${await readError(response)}`);
          const options = trackerAutomationOptionsSchema.parse(await response.json());
          if (!options.available) throw new Error(`${options.reason} Configure the project's Issue tracker in Settings.`);
          body.trackerTrigger = { ...(body.trackerTrigger as Record<string, unknown>), association: options.association };
        }
        return await createFrom(body);
      }
      case 'run': {
        const id = rest[0];
        if (!id) throw new Error('an automation id is required: cez automation run <id>');
        const response = await json(`${api.scope}/automations/${encodeURIComponent(id)}/run`, { method: 'POST' });
        if (!response.ok) throw new Error(`run refused — ${await readError(response)}`);
        const { runId } = (await response.json()) as { runId: string };
        io.log(`started automation ${id} by hand — task ${runId} is queued; the definition's schedule and enabled state are unchanged`);
        io.log(`cockpit: ${pageUrl(api, id)}`);
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
            id: string; name: string; enabled: boolean; kind?: string; events?: string[]; intervalSeconds?: number; schedule?: AutomationSchedule;
            counts: { launched: number; duplicates: number; errors: number };
            nextRunAt?: string;
            trackerTrigger?: { events: string[]; association: { kind: string } };
            state?: { nextCheckAt?: string; lastSuccessAt?: string };
          }>;
        };
        if (!data.available) io.log(`GitHub is not available to this cockpit${data.reason ? ` — ${data.reason}` : ''}; GitHub polls will not run until it is (schedules still do).`);
        if (data.automations.length === 0) {
          io.log('no automations in this project');
          return 0;
        }
        for (const item of data.automations) {
          const nextAt = item.nextRunAt ?? item.state?.nextCheckAt;
          const next = item.enabled && nextAt ? `  next ${nextAt}` : '';
          const trigger = item.kind === 'schedule' && item.schedule
            ? scheduleLabel(item.schedule)
            : item.kind === 'tracker'
              ? `${item.trackerTrigger?.association.kind ?? 'tracker'} every ${item.intervalSeconds ?? 1800}s  ${item.trackerTrigger ? shortEvents(item.trackerTrigger.events) : 'select an event to complete setup'}`
              : `every ${item.intervalSeconds ?? 300}s  ${shortEvents(item.events)}`;
          io.log(`${item.id}  ${item.enabled ? 'enabled' : 'paused '}  ${trigger}  launched ${item.counts.launched}, duplicates ${item.counts.duplicates}, errors ${item.counts.errors}${next}  ${item.name}`);
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
