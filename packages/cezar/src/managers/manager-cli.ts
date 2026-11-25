/**
 * `cez manager …` — the tools a manager's agent calls (spec 2026-10-31-managers). A thin HTTP
 * client over `/workspace/managers`, addressed like `cez task`: `CEZ_API_URL` plus `CEZ_MANAGER_ID`,
 * both set on every manager turn. The `cez-manager` shim on the turn's PATH lands here.
 */
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { cezarHomeDir } from '../paths.ts';
import { parseArgs } from 'node:util';
import type { ManagerCancelTaskResponse, ManagerCreateTaskResponse, ManagerFollowTaskResponse, ManagerForwarded, ManagerMemoryResponse, ManagerMessage, ManagerSnapshot, ManagerSnapshotProject, ManagerTaskMessageResponse } from '@open-mercato/cezar-contract';
import { managerAccessOf, managerMemoryKeySchema, managerMemoryKindSchema, managerTaskEffortSchema, MANAGER_MEMORY_LIMITS, type Manager } from '@open-mercato/cezar-contract';
import { runAutomationCommand } from '../automations/automation-cli.ts';
import { missingCockpitMessage } from '../cockpit-address.ts';
import { parseConnectorTool } from './connectors.ts';
import { MANAGER_COMMANDS, MANAGER_JOB_SUBCOMMANDS, MANAGER_MEMORY_SUBCOMMANDS, MANAGER_TASK_SUBCOMMANDS } from './cli-vocabulary.ts';
import { recentTasks } from './snapshot.ts';
import { sameModel } from '../runs/reported-model.ts';

export interface ManagerCliEnv {
  CEZ_API_URL?: string;
  CEZ_MANAGER_ID?: string;
  CEZ_MANAGER_TURN?: string;
  CEZ_TASK_ID?: string;
  [key: string]: string | undefined;
}

export interface ManagerCliIo {
  fetch: typeof fetch;
  log: (line: string) => void;
  error: (line: string) => void;
  /** `--file`; relative to the agent's cwd, its workdir. */
  readFile?: (path: string) => Promise<string>;
  /** `--stdin`. */
  readStdin?: () => Promise<string>;
}

const USAGE = `cez manager — the tools of a cezar manager's agent (CEZ_MANAGERS=0 on the cockpit turns managers off)

  cez manager status | attention | tasks | prs   what is going on (add --json for data)
  cez manager task <run> [--project <id>]        one task, its model, PR, last message and children
  cez manager task create --project <id> [--title t] [--workflow w] [--runner r] [--account id] [--model m] [--effort e] [--dispatch] "<objective>"
  cez manager task say --project <id> <run> [--model m] [--effort e] "<text>"
                                                 --model/--effort only when it continues a finished task
  cez manager task switch --project <id> <run> [--runner r] [--account id] [--model m] [--effort e]
                                                 change the agent and keep the task's history and worktree
  cez manager task cancel --project <id> <run> [--reason "…"]
                                                 stops it and every task it dispatched; worktree and branch stay
  cez manager task retry --project <id> <run> [--runner r] [--account id] [--model m] [--effort e]
                                                 retry in place with agent flags, or start over without them
  cez manager task follow|unfollow [--project <id>] <run>
                                                 hear when a task you did not start settles or needs the user
      content flags for create and say:
        --attach-last-user-message   copy the user's newest message into the task verbatim, attachments too
        --from-message <id>          the same for a given chat message
        --file <path> | --stdin      append the text of a file, or of stdin
        --allow-placeholder          send text holding a marker such as [transcript here] or PASTE anyway
  cez manager workflows --project <id> [--json]  each workflow and what it can do (push, open a PR, post to GitHub)
  cez manager merge --project <id> <number> [--method merge|squash|rebase] [--title t] [--reason "…"]
                                                 proposes a merge; the user approves it in the chat
  cez manager automation --project <id> <cez automation args>
                                                 always paused, editing one pauses it; enable proposes;
                                                 what it creates posts each run's result to this chat
                                                 (--report-mode failure-only|none, --no-report; change
                                                 it later with: report <id> --mode m | --unlink)
  cez manager job add --name <name> --every <minutes> "<prompt>"
                                                 proposes a job; the user approves it in the chat
  cez manager job list | job remove <id>
  cez manager propose-action --connector <key> --tool <tool> --args '<json>' [--reason "…"]
                                                 proposes one connector call (--tool may also be the full
                                                 mcp__<key>__<tool>); the user approves it in the chat and
                                                 cezar runs exactly that call
  cez manager rename "<role>"                    a short role the user recognizes it by

  Every command and subcommand takes --help.`;

/** All a watch check may run; an allowlist, so a new subcommand is refused until someone decides. */
const READ_ONLY_AUTOMATION = new Set(['list', 'show', 'schema', 'check']);
/** Each of these starts or destroys work no card ever showed the user. */
const REFUSED_AUTOMATION = new Set(['run', 'delete']);

function fail(message: string): never {
  throw new Error(message);
}

const COMMANDS = MANAGER_COMMANDS;
const TASK_SUBCOMMANDS = MANAGER_TASK_SUBCOMMANDS;
const JOB_SUBCOMMANDS = MANAGER_JOB_SUBCOMMANDS;
const MEMORY_SUBCOMMANDS = MANAGER_MEMORY_SUBCOMMANDS;
/** `history` prints at most this much: older chat is a lookup, not a reload. */
const HISTORY_CHARS = 8_000;
const HISTORY_MESSAGE_CHARS = 800;
/** A full run id or its first eight hex digits: anything else after `task` is a mistyped subcommand. */
const RUN_ID_LIKE = /^[0-9a-f]{8}(?:-[0-9a-f-]+)?$/i;
const EFFORTS = managerTaskEffortSchema.options;

const CONTENT_HELP = `
  --attach-last-user-message   copy the user's newest message into the task verbatim, attachments too
  --from-message <id>          the same for a given chat message
  --file <path> | --stdin      append the text of a file, or of stdin
  --allow-placeholder          send text holding a marker such as [transcript here] or PASTE anyway`;

const SNAPSHOT_HELP = (command: string, what: string) => `cez manager ${command} [--project <id>] [--all] [--json]

${what}
Compact by default: finished tasks the user has not opened, and all but the 20 newest finished tasks per project, are counted, not listed, and the output stops at 8000 characters.
  --project <id>   only this project
  --all            list everything
  --json           the data, as JSON (always everything)`;

/** `--help` per command; `task create` adds the project's workflow names when it can reach them. */
const HELP: Record<string, string> = {
  status: SNAPSHOT_HELP('status', 'What needs attention, every task and every pull request, and the agent accounts new tasks may use with their usage-limit state.'),
  attention: SNAPSHOT_HELP('attention', 'What needs attention: waiting, failed, finished and stalled tasks, PRs and automations.'),
  tasks: SNAPSHOT_HELP('tasks', "Every connected project's tasks, the user's own included, with their model, effort and PR."),
  prs: SNAPSHOT_HELP('prs', 'Open pull requests and their status.'),
  task: `cez manager task <run> [--project <id>]
cez manager task create|say|switch|cancel|retry|follow|unfollow …   (each takes --help)

One task as JSON: status, startedBy, runner, model, actualModel (what the agent reported running), effort, prNumber/prUrl, its last message and its children.
  --project <id>   the task's project; found from the snapshot when omitted`,
  'task create': `cez manager task create --project <id> [flags] "<objective>"

Starts a task.
  --project <id>     the project (required unless only one is connected)
  --title <t>        its title
  --workflow <w>     a workflow name (default quick-task); see cez manager workflows
  --runner <r>       the agent backend, e.g. claude or codex, from the manager's allowed task accounts
  --account <id>     the agent account id from those accounts
                     Omit both to use the manager's settings: its first allowed account with usage capacity,
                     skipping any that is out of limits (cez manager status lists them). With none free the task
                     queues until the first one resets. A usage limit hit mid-task moves it to another allowed
                     account with capacity. The output names the chosen account and why; an explicit --account
                     that is out of limits prints a warning naming an allowed one with capacity.
  --model <m>        a model id or alias the runner can use, e.g. opus; refused with the valid ones otherwise
  --effort <e>       ${EFFORTS.join(' | ')}; refused when the runner or model has no such level
  --dispatch         start it as the root of a dispatch tree, only for work worth splitting;
                     ignored in a trunk-based project, whose tasks work in its checkout${CONTENT_HELP}`,
  'task say': `cez manager task say --project <id> <run> [flags] "<text>"

Messages a running task, or continues a finished one with the text.
  --project <id>     the task's project
  --model <m>        continue on this model (a finished task only)
  --effort <e>       ${EFFORTS.join(' | ')} (a finished task only)${CONTENT_HELP}`,
  'task switch': `cez manager task switch --project <id> <run> [--runner r] [--account id] [--model m] [--effort e]

Choose at least one agent flag. Switches a queued task before it starts, interrupts a live agent turn,
or continues a settled task with its conversation. Keeps the run id, worktree, branch, and history.
The choice applies to unfinished agent steps that use the replaced runner.
Only a task this manager started, unless the user allowed "Cancel or switch any task" in its settings.`,
  'task cancel': `cez manager task cancel --project <id> <run> [--reason "…"]

Stops the task and every task it dispatched, and marks them cancelled. Their worktree and branch stay.
Only a task this manager started, unless the user allowed "Cancel or switch any task" in its settings.
  --project <id>     the task's project
  --reason "…"       why; kept on the task and shown in the cockpit`,
  'task retry': `cez manager task retry --project <id> <run> [--runner r] [--account id] [--model m] [--effort e]

With any agent flag, retry a failed or cancelled task in place using the switch command's permissions.
With no agent flags, start a new task with the same objective, workflow, runner, model and effort.
  --project <id>     the task's project`,
  'task follow': `cez manager task follow [--project <id>] <run>

Hear when a task you did not start finishes, fails or needs the user: cezar posts its card here, then wakes you.
  --project <id>     the task's project; found from the snapshot when omitted`,
  'task unfollow': `cez manager task unfollow [--project <id>] <run>

Stops following a task.
  --project <id>     the task's project; found from the snapshot when omitted`,
  workflows: `cez manager workflows --project <id> [--json]

The project's workflows, each with what it can do: push, open-pr, posts-to-github, or read-only.
For review-only work pick a read-only one (review-pr when it exists).
  --project <id>   the project
  --json           the raw list`,
  merge: `cez manager merge --project <id> <number> [flags]

Proposes merging a pull request; the user approves it in the chat.
  --project <id>     the project
  --method <m>       merge | squash | rebase
  --title <t>        the merge commit title
  --reason "…"       why, shown on the card`,
  automation: `cez manager automation --project <id> <cez automation args>

Creates and inspects automations, always paused; \`enable <id>\` proposes enabling one.
What it creates posts each run's result to this chat (--report-mode failure-only|none, --no-report;
change it later with: report <id> --mode m | --unlink). See cez automation schema for the definition.`,
  job: `cez manager job add|list|remove   (each takes --help)

Saved prompts this manager runs on a cadence.`,
  'job add': `cez manager job add --name <name> --every <minutes> "<prompt>"

Proposes a saved job; the user approves it in the chat.
  --name <name>        its name
  --every <minutes>    how often it runs (5 to 10080)`,
  'job list': 'cez manager job list\n\nThis manager\'s jobs, as JSON.',
  'job remove': 'cez manager job remove <id>\n\nRemoves a job.',
  'propose-action': `cez manager propose-action --connector <key> --tool <tool> --args '<json>' [--reason "…"]

Proposes one connector call; the user approves it in the chat and cezar runs exactly that call.
  --connector <key>  the connector
  --tool <tool>      the tool, or the full mcp__<key>__<tool>
  --args '<json>'    the tool's input, a JSON object
  --reason "…"       why, shown on the card`,
  rename: 'cez manager rename "<role>"\n\nA short role the user recognizes this manager by, e.g. "Coding Manager".',
  memory: `cez manager memory list | set | remove   (each takes --help)

What you carry into every new session: the user's preferences, feedback on how you work, standing decisions and pointers to ongoing work. Never task output or transcripts. ${MANAGER_MEMORY_LIMITS.entries} entries and ${MANAGER_MEMORY_LIMITS.bytes} bytes at most.`,
  'memory list': 'cez manager memory list [--json]\n\nEvery entry: key, kind, text, why.',
  'memory set': `cez manager memory set <key> --kind preference|feedback|decision|pointer [--why "…"] "<text>"

Saves one entry; the same key replaces it. <key> is lowercase-with-dashes, e.g. full-prs-not-drafts.
Text up to ${MANAGER_MEMORY_LIMITS.text} characters, why up to ${MANAGER_MEMORY_LIMITS.why}. A text another key already says, or a full memory, is refused with what to replace.`,
  'memory remove': 'cez manager memory remove <key>\n\nDrops an entry that no longer holds.',
  history: `cez manager history [--since 2h|1d|<iso>] [--grep <text>] [--limit <n>]

Earlier messages of this chat, oldest first, ${HISTORY_CHARS} characters at most.
  --since    only messages after this: a duration (30m, 2h, 1d) or an ISO time
  --grep     only messages containing this text (case-insensitive)
  --limit    the newest n messages that match (default 20, at most 200)`,
};

/** The help key for `args`: `task create` when the subcommand is known, else the command. */
function helpKey(command: string, rest: string[]): string {
  const sub = rest[0];
  const subs: readonly string[] = command === 'task' ? TASK_SUBCOMMANDS : command === 'job' ? JOB_SUBCOMMANDS : command === 'memory' ? MEMORY_SUBCOMMANDS : [];
  return sub && subs.includes(sub) ? `${command} ${sub}` : command;
}

/** `--help`/`-h` before a `--`; automation forwards its own flags, so only a bare one counts there. */
function wantsHelp(command: string, rest: string[]): boolean {
  if (command === 'automation') return rest.length === 1 && (rest[0] === '--help' || rest[0] === '-h');
  const end = rest.indexOf('--');
  return (end >= 0 ? rest.slice(0, end) : rest).some((arg) => arg === '--help' || arg === '-h');
}

type Options = Parameters<typeof parseArgs>[0] extends infer C ? C extends { options?: infer O } ? NonNullable<O> : never : never;

/** `parseArgs` in strict mode, its errors turned into what to type instead. */
function parse<O extends Options>(key: string, args: string[], options: O, allowPositionals = false) {
  try {
    return parseArgs({ args, options, allowPositionals, strict: true });
  } catch (error) {
    const flags = Object.keys(options).map((name) => `--${name}`).join(', ');
    const message = error instanceof Error ? error.message : String(error);
    const unknown = /Unknown option '([^']+)'/.exec(message)?.[1];
    if (unknown) fail(`unknown flag '${unknown}' for '${key}'. Flags: ${flags}. See: cez manager ${key} --help`);
    if (/Unexpected argument/.test(message)) fail(`'${key}' takes no arguments besides its flags (${flags}). See: cez manager ${key} --help`);
    fail(`${message.split('. ')[0]}. See: cez manager ${key} --help`);
  }
}

/** A compact listing's size: past it, the rest is counted, not printed. */
const OUTPUT_CHARS = 8_000;

/** Lines up to `limit` characters, then one line counting the rest. */
export function capped(lines: string[], limit: number | undefined): string[] {
  if (limit === undefined) return lines;
  const out: string[] = [];
  let size = 0;
  for (const [index, line] of lines.entries()) {
    if (size + line.length + 1 > limit) {
      out.push(`… ${lines.length - index} more line${lines.length - index === 1 ? '' : 's'}: narrow with --project, or use --all or --json`);
      break;
    }
    out.push(line);
    size += line.length + 1;
  }
  return out;
}

/** `30m`, `2h`, `1d` before `now`, or an ISO time; undefined when it is neither. */
export function sinceOf(value: string, now: number): number | undefined {
  const match = /^(\d+)\s*([mhd])$/.exec(value.trim());
  if (match) return now - Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 'm' | 'h' | 'd'];
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

/** One chat message as `history` prints it; notices and streaming drafts are skipped. */
function historyLine(message: ManagerMessage): string | undefined {
  const clip = (text: string) => (text.length > HISTORY_MESSAGE_CHARS ? `${text.slice(0, HISTORY_MESSAGE_CHARS)}…` : text);
  const at = message.at.slice(0, 16).replace('T', ' ');
  if (message.kind === 'user') return `${at}  user (message id: ${message.id}): ${clip(message.text)}`;
  if (message.kind === 'assistant' && message.text && !message.streaming) return `${at}  you: ${clip(message.text)}`;
  if (message.kind === 'action') return `${at}  card ${message.action.type}: ${message.status}`;
  return undefined;
}

function effortOf(value: string | undefined): (typeof EFFORTS)[number] | undefined {
  if (value === undefined) return undefined;
  const effort = EFFORTS.find((level) => level === value);
  if (!effort) fail(`--effort must be one of ${EFFORTS.join(', ')}, not '${value}'`);
  return effort;
}

/** `task create --help`'s workflow list; help still prints when the cockpit is out of reach. */
async function workflowNames(url: string | undefined, env: ManagerCliEnv, io: ManagerCliIo, rest: string[]): Promise<string> {
  const at = rest.indexOf('--project');
  let project = at >= 0 ? rest[at + 1] : undefined;
  try {
    if (!url || !env.CEZ_MANAGER_ID) throw new Error('run it inside a manager turn to list them');
    if (!project) {
      const response = await io.fetch(`${url}/api/v1/workspace/managers/${encodeURIComponent(env.CEZ_MANAGER_ID)}/snapshot`);
      const projects = response.ok ? ((await response.json()) as ManagerSnapshot).projects : [];
      if (projects.length !== 1) throw new Error('add --project <id> to list them');
      project = projects[0]?.projectId;
    }
    const response = await io.fetch(`${url}/api/v1/p/${encodeURIComponent(project ?? '')}/workflows`);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const workflows = ((await response.json()) as { workflows?: WorkflowRow[] }).workflows ?? [];
    return `\nWorkflows in ${project}:\n${workflows.map((workflow) => `  ${workflowLine(workflow)}`).join('\n') || '  none'}`;
  } catch (error) {
    return `\nWorkflows: unavailable (${error instanceof Error ? error.message : String(error)}); see cez manager workflows --project <id>`;
  }
}

/** One workflow's line: name, description and, when the cockpit says, what it can do. */
interface WorkflowRow { name: string; description?: string; capabilities?: { push?: boolean; openPr?: boolean; postToGithub?: boolean } }
function workflowLine(workflow: WorkflowRow): string {
  const caps = workflow.capabilities;
  const can = caps ? [caps.push && 'push', caps.openPr && 'open-pr', caps.postToGithub && 'posts-to-github'].filter(Boolean) : [];
  const tag = caps ? `[${can.length > 0 ? can.join(', ') : 'read-only'}]` : '[capabilities unknown]';
  return `${workflow.name}  ${workflow.description?.replace(/\s+/g, ' ').trim() || '-'}  ${tag}`;
}

/** "opus → claude-opus-5-5", "auto → …" when no model was asked for; one name when the two agree. */
export function taskModelLabel(requested: string | undefined, actual: string | undefined): string {
  const asked = requested || 'auto';
  return actual && !sameModel(asked, actual) ? `${asked} → ${actual}` : asked;
}

/** A long paste never has to fit a shell argument: Claude Code refuses commands over ~10k characters. */
const CONTENT_OPTIONS = {
  'attach-last-user-message': { type: 'boolean' },
  'from-message': { type: 'string' },
  file: { type: 'string' },
  stdin: { type: 'boolean' },
  'allow-placeholder': { type: 'boolean' },
} as const;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

interface ContentValues {
  'attach-last-user-message'?: boolean;
  'from-message'?: string;
  file?: string;
  stdin?: boolean;
  'allow-placeholder'?: boolean;
}

/** The typed words, then the file or stdin; and what the server should copy in on its own. */
/**
 * A manager turn's `--file` reads only the manager's own workdir (where `files/` lives) and its
 * attachments: the vetted shell accepts any `cez-manager` call, so this is not a way past the
 * turn's read roots (`--file ~/.ssh/id_rsa`). Without a manager id there is no turn to confine.
 */
export async function readManagerFile(path: string, env: ManagerCliEnv): Promise<string> {
  const real = await realpath(resolve(path));
  const id = env.CEZ_MANAGER_ID;
  if (id) {
    const base = join(cezarHomeDir(env), 'managers', id);
    const roots = (await Promise.all(['workdir', 'attachments'].map((dir) => realpath(join(base, dir)).catch(() => undefined))))
      .filter((root): root is string => root !== undefined);
    const inside = (root: string) => { const rel = relative(root, real); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${'/'}`) && !rel.startsWith('..\\')); };
    if (!roots.some(inside)) throw new Error('only files in the manager\'s workdir (files/) or its attachments can be read');
  }
  return readFile(real, 'utf8');
}

async function contentOf(words: string[], values: ContentValues, io: ManagerCliIo, env: ManagerCliEnv): Promise<{ text: string; fromMessage?: string; allowPlaceholder?: true }> {
  if (values['attach-last-user-message'] && values['from-message']) fail('use --attach-last-user-message or --from-message, not both');
  if (values.file !== undefined && values.stdin) fail('use --file or --stdin, not both');
  let extra = '';
  if (values.file !== undefined) {
    try {
      extra = await (io.readFile ?? ((path: string) => readManagerFile(path, env)))(values.file);
    } catch (error) {
      fail(`cannot read ${values.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (values.stdin) {
    extra = await (io.readStdin ?? readStdin)();
  }
  const fromMessage = values['attach-last-user-message'] ? 'last' : values['from-message'];
  return {
    text: [words.join(' ').trim(), extra.trim()].filter(Boolean).join('\n\n'),
    ...(fromMessage ? { fromMessage } : {}),
    ...(values['allow-placeholder'] ? { allowPlaceholder: true as const } : {}),
  };
}

const forwardedLine = (forwarded: ManagerForwarded): string =>
  `forwarded the user's message ${forwarded.messageId} verbatim: ${forwarded.chars} characters, ${forwarded.attachments} attachment${forwarded.attachments === 1 ? '' : 's'}`
  + (forwarded.skipped?.length ? `. Too large to forward, tell the user: ${forwarded.skipped.join(', ')}` : '');

export async function runManagerCommand(
  args: string[],
  env: ManagerCliEnv = process.env,
  io: ManagerCliIo = { fetch, log: console.log, error: console.error },
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    const [topic, ...more] = rest;
    if (command === 'help' && topic && HELP[topic]) {
      io.log(HELP[helpKey(topic, more)] ?? USAGE);
      return 0;
    }
    io.log(USAGE);
    return command ? 0 : 2;
  }
  if (!(COMMANDS as readonly string[]).includes(command)) {
    io.error(`cez manager: unknown command '${command}'. Valid: ${COMMANDS.join(', ')}\n\n${USAGE}`);
    return 2;
  }
  const url = env.CEZ_API_URL?.replace(/\/+$/, '');
  if (wantsHelp(command, rest)) {
    const key = helpKey(command, rest);
    io.log(HELP[key] ?? USAGE);
    if (key === 'task create') io.log(await workflowNames(url, env, io, rest));
    return 0;
  }
  if (!url) {
    io.error(missingCockpitMessage({
      command: 'cez manager',
      example: 'CEZ_MANAGER_ID=<id> cez manager status',
      insideTask: 'this command only works inside a manager turn.',
    }, env));
    return 2;
  }
  if (!env.CEZ_MANAGER_ID) {
    io.error('cez manager: CEZ_MANAGER_ID is not set — every manager turn sets it.');
    return 2;
  }
  const base = `${url}/api/v1/workspace/managers/${encodeURIComponent(env.CEZ_MANAGER_ID)}`;

  const call = async <T>(path: string, init?: { method: string; body?: unknown }): Promise<T> => {
    const response = await io.fetch(`${base}${path}`, {
      method: init?.method ?? 'GET',
      ...(init?.body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) } : {}),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      throw new Error(typeof body.error === 'string' ? body.error : `${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  };
  const snapshot = () => call<ManagerSnapshot>('/snapshot');

  /**
   * The engine answers a repeat proposal with the card already waiting, not a new one. Said so,
   * or the agent tells the user to approve a card that sits far up the chat.
   */
  const propose = async (body: { action: Record<string, unknown>; reason?: string }, what: string) => {
    const before = await call<{ messages: Array<{ id: string; at: string }> }>('/messages?pending=1&limit=500');
    const proposed = await call<{ actionId: string; replaced?: string[]; alsoWaitingIn?: string[] }>('/actions', { method: 'POST', body });
    const waiting = before.messages.find((message) => message.id === proposed.actionId);
    io.log(waiting
      ? `already pending ${proposed.actionId} (proposed ${waiting.at}): ${what} still waits for the user's approval on that card, earlier in the chat. No new card was added; point the user to it instead of asking again.`
      : `proposed ${proposed.actionId}: ${what} waits for the user's approval in the chat`);
    if (proposed.replaced?.length) io.log(`replaced ${proposed.replaced.join(', ')}: the older card for the same target was closed, only the new one waits.`);
    if (proposed.alsoWaitingIn?.length) io.log(`also waiting in ${proposed.alsoWaitingIn.join(', ')}: another manager's chat has a card for the same target. Either approval does it; say so to the user.`);
  };
  const printJson = (value: unknown) => io.log(JSON.stringify(value, null, 2));

  /** The named project, or the only connected one. */
  const projectOf = async (named: string | undefined): Promise<ManagerSnapshotProject> => {
    const { projects } = await snapshot();
    const found = named ? projects.find((project) => project.projectId === named) : projects.length === 1 ? projects[0] : undefined;
    if (found) return found;
    fail(named
      ? `this manager is not connected to project ${named}. Connected: ${projects.map((project) => project.projectId).join(', ') || 'none'}`
      : `name a project with --project. Connected: ${projects.map((project) => project.projectId).join(', ') || 'none'}`);
  };

  /** The named project, else the one whose snapshot holds the task, else the only connected one. */
  const projectForRun = async (named: string | undefined, runId: string): Promise<string> => {
    if (named) return (await projectOf(named)).projectId;
    const data = await snapshot();
    return data.projects.find((project) => project.tasks.some((task) => task.runId === runId || task.runId.startsWith(runId)))?.projectId
      ?? (await projectOf(undefined)).projectId;
  };

  try {
    switch (command) {
      case 'status':
      case 'attention':
      case 'tasks':
      case 'prs': {
        const { values } = parse(command, rest, { json: { type: 'boolean' }, project: { type: 'string' }, all: { type: 'boolean' } });
        const data = await snapshot();
        const projects = data.projects.filter((project) => !values.project || project.projectId === values.project);
        if (values.json) {
          if (command === 'status') printJson(data);
          else if (command === 'attention') printJson(data.attention);
          else if (command === 'tasks') printJson(projects.flatMap((project) => project.tasks.map((task) => ({ projectId: project.projectId, ...task }))));
          else printJson(projects.flatMap((project) => project.prs.map((pr) => ({ projectId: project.projectId, ...pr }))));
          return 0;
        }
        // Compact by default (spec 2026-11-21 § 2.4): finished work is history, read on demand.
        const lines: string[] = [];
        if (command === 'status' || command === 'attention') {
          const attention = values.all ? data.attention : data.attention.filter((item) => item.kind !== 'task-finished');
          const hidden = data.attention.length - attention.length;
          if (attention.length === 0) lines.push(hidden > 0 ? 'Nothing needs attention besides finished tasks.' : 'Nothing needs attention.');
          for (const item of attention) lines.push(`${item.kind}  ${item.projectId}  ${item.runId ?? (item.number !== undefined ? `#${item.number}` : '')}  ${item.title}${item.detail ? ` — ${item.detail}` : ''}`);
          if (hidden > 0) lines.push(`(${hidden} finished task${hidden === 1 ? '' : 's'} the user has not opened yet: --all lists them)`);
        }
        if (command === 'status' || command === 'tasks') {
          for (const project of projects) {
            const { shown, hidden } = values.all ? { shown: project.tasks, hidden: 0 } : recentTasks(project.tasks);
            for (const task of shown) {
              const facts = [
                task.startedBy === 'manager' ? `by ${task.startedByManager ?? 'a manager'}` : 'by the user',
                (task.model || task.actualModel) && `${taskModelLabel(task.model, task.actualModel)}${task.effort ? `/${task.effort}` : ''}`,
                task.prNumber !== undefined && `PR #${task.prNumber}`,
                task.childCount > 0 && `${task.childCount} dispatched`,
                task.agentSwitch,
              ].filter(Boolean).join(', ');
              lines.push(`${project.projectId}  ${task.runId}  ${task.status}  ${task.title}  (${facts})`);
            }
            if (hidden > 0) lines.push(`${project.projectId}: ${hidden} older finished task${hidden === 1 ? '' : 's'} not shown (--all lists them)`);
          }
        }
        if (command === 'status' && data.accounts?.length) {
          for (const account of data.accounts) {
            const flags = `--runner ${account.runner}${account.agentProfile ? ` --account ${account.agentProfile}` : ' (automatic account)'}`;
            lines.push(`account  ${flags}  ${account.label}  ${account.outOfLimitsUntil ? `out of usage limits until ${account.outOfLimitsUntil}` : 'has capacity'}`);
          }
        }
        if (command === 'status' || command === 'prs') {
          for (const project of projects) {
            if (project.prsUnavailable) lines.push(`${project.projectId}: pull requests unavailable — ${project.prsUnavailable}`);
            for (const pr of project.prs) lines.push(`${project.projectId}  #${pr.number}  ${pr.draft ? 'draft' : (pr.status ?? 'open')}  ${pr.title}`);
          }
        }
        for (const line of capped(lines, values.all ? undefined : OUTPUT_CHARS)) io.log(line);
        return 0;
      }

      case 'task': {
        const [sub, ...taskArgs] = rest;
        if (sub === 'create') {
          const { values, positionals } = parse('task create', taskArgs, {
            project: { type: 'string' }, title: { type: 'string' }, workflow: { type: 'string' },
            runner: { type: 'string' }, account: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, dispatch: { type: 'boolean' },
            ...CONTENT_OPTIONS,
          }, true);
          const effort = effortOf(values.effort);
          const { text: task, ...content } = await contentOf(positionals, values, io, env);
          if (!task && !content.fromMessage) fail('an objective is required: cez manager task create --project <id> "<objective>" (or --attach-last-user-message)');
          const project = await projectOf(values.project);
          const created = await call<ManagerCreateTaskResponse>('/tasks', {
            method: 'POST',
            body: {
              projectId: project.projectId,
              ...(task ? { task } : {}),
              ...content,
              ...(values.title ? { title: values.title } : {}),
              ...(values.workflow ? { workflow: values.workflow } : {}),
              ...(values.runner ? { runner: values.runner } : {}),
              ...(values.account ? { agentProfile: values.account } : {}),
              ...(values.model ? { model: values.model } : {}),
              ...(effort ? { effort } : {}),
              ...(values.dispatch ? { dispatch: true } : {}),
            },
          });
          io.log(`[[task:${created.projectId}/${created.runId}]]`);
          if (created.forwarded) io.log(forwardedLine(created.forwarded));
          if (created.notice) io.log(created.notice);
          if (created.agent) {
            const { agent } = created;
            io.log(`agent: --runner ${agent.runner}${agent.agentProfile ? ` --account ${agent.agentProfile}` : ' (automatic account)'} — ${agent.label}; ${agent.reason}`);
            // A warning means another allowed account is free: only this explicit one is waiting.
            if (agent.queuedUntil) {
              io.log(created.warning
                ? `queued: ${agent.label} is out of usage limits; the task starts when it resets at ${agent.queuedUntil}`
                : `queued: no allowed account has capacity; the task starts when ${agent.label} resets at ${agent.queuedUntil}`);
            }
          }
          if (created.warning) io.log(`warning: ${created.warning}`);
          return 0;
        }
        if (sub === 'say') {
          const { values, positionals } = parse('task say', taskArgs, { project: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, ...CONTENT_OPTIONS }, true);
          const effort = effortOf(values.effort);
          const [runId, ...words] = positionals;
          const { text, ...content } = runId ? await contentOf(words, values, io, env) : { text: '' };
          if (!runId || (!text && !content.fromMessage)) fail('usage: cez manager task say --project <id> <run> "<text>" (or --attach-last-user-message)');
          const project = await projectOf(values.project);
          const sent = await call<ManagerTaskMessageResponse>('/task-message', {
            method: 'POST',
            body: { projectId: project.projectId, runId, ...(text ? { text } : {}), ...content, ...(values.model ? { model: values.model } : {}), ...(effort ? { effort } : {}) },
          });
          io.log(`sent to ${runId}`);
          if (sent.forwarded) io.log(forwardedLine(sent.forwarded));
          return 0;
        }
        if (sub === 'cancel') {
          const { values, positionals } = parse('task cancel', taskArgs, { project: { type: 'string' }, reason: { type: 'string' } }, true);
          const [runId, ...extra] = positionals;
          if (!runId || extra.length > 0) fail('usage: cez manager task cancel --project <id> <run> [--reason "…"]');
          if (env.CEZ_MANAGER_TURN === 'watch') fail('a watch check is read-only: ask the user instead');
          const projectId = await projectForRun(values.project, runId);
          const result = await call<ManagerCancelTaskResponse>('/task-cancel', { method: 'POST', body: { projectId, runId, ...(values.reason ? { reason: values.reason } : {}) } });
          const children = result.children.length > 0 ? `, and ${result.children.length} dispatched task${result.children.length === 1 ? '' : 's'}: ${result.children.join(', ')}` : '';
          io.log(result.cancelled
            ? `cancelled ${result.runId}${children}. Its worktree and branch are kept.`
            : `${result.runId} is ${result.status}, so there was nothing to stop${children ? `; cancelled${children.slice(1)}` : ''}.`);
          return 0;
        }
        if (sub === 'switch' || sub === 'retry') {
          const { values, positionals } = parse(`task ${sub}`, taskArgs, {
            project: { type: 'string' }, runner: { type: 'string' }, account: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
          }, true);
          const [runId, ...extra] = positionals;
          if (!runId || extra.length > 0) fail(`usage: cez manager task ${sub} --project <id> <run> [--runner r] [--account id] [--model m] [--effort e]`);
          const effort = effortOf(values.effort);
          const { runner, account, model } = values;
          if (sub === 'switch' && !(runner || account || model || effort)) fail('choose at least one of --runner, --account, --model or --effort');
          if (env.CEZ_MANAGER_TURN === 'watch') fail('a watch check is read-only: ask the user instead');
          const projectId = await projectForRun(values.project, runId);
          const created = await call<ManagerCreateTaskResponse>(`/task-${sub}`, {
            method: 'POST', body: { projectId, runId, runner, agentProfile: account, model, effort },
          });
          io.log(`[[task:${created.projectId}/${created.runId}]]`);
          if (created.notice) io.log(created.notice);
          return 0;
        }
        if (sub === 'follow' || sub === 'unfollow') {
          const { values, positionals } = parse(`task ${sub}`, taskArgs, { project: { type: 'string' } }, true);
          const [runId, ...extra] = positionals;
          if (!runId || extra.length > 0) fail(`usage: cez manager task ${sub} [--project <id>] <run>`);
          const projectId = await projectForRun(values.project, runId);
          await call<ManagerFollowTaskResponse>('/follows', { method: 'POST', body: { projectId, runId, follow: sub === 'follow' } });
          io.log(sub === 'follow'
            ? `following ${runId}: cezar posts its card here when it finishes, fails or needs the user, then wakes you`
            : `no longer following ${runId}`);
          return 0;
        }
        // `task cancel` on an older cockpit, or a typo, must not be read as a run id.
        if (sub !== undefined && !sub.startsWith('-') && !RUN_ID_LIKE.test(sub)) {
          fail(`unknown subcommand '${sub}' for 'task'. Valid: ${TASK_SUBCOMMANDS.join(', ')}, or a run id. See: cez manager task --help`);
        }
        const { values, positionals } = parse('task', rest, { project: { type: 'string' } }, true);
        const runId = positionals[0];
        if (!runId || positionals.length > 1) fail('usage: cez manager task <run> [--project <id>]');
        const projectId = await projectForRun(values.project, runId);
        printJson(await call(`/task?${new URLSearchParams({ projectId, runId })}`));
        return 0;
      }

      case 'rename': {
        const name = rest.join(' ').trim();
        if (!name) fail('usage: cez manager rename "<role>"');
        if (env.CEZ_MANAGER_TURN === 'watch') fail('a watch check is read-only: ask the user instead');
        await call('', { method: 'PATCH', body: { name } });
        io.log(`renamed to ${name}`);
        return 0;
      }

      case 'workflows': {
        const { values } = parse('workflows', rest, { project: { type: 'string' }, json: { type: 'boolean' } });
        const project = await projectOf(values.project);
        const response = await io.fetch(`${url}/api/v1/p/${encodeURIComponent(project.projectId)}/workflows`);
        if (!response.ok) fail(`${response.status} ${response.statusText}`);
        const data = (await response.json()) as { workflows?: WorkflowRow[] };
        const workflows = data.workflows ?? [];
        // A cockpit that does not report capabilities yet gets its raw list, as before.
        if (values.json || !workflows.some((workflow) => workflow.capabilities)) {
          printJson(data);
          return 0;
        }
        for (const workflow of workflows) io.log(workflowLine(workflow));
        return 0;
      }

      case 'merge': {
        const { values, positionals } = parse('merge', rest, { project: { type: 'string' }, method: { type: 'string' }, title: { type: 'string' }, reason: { type: 'string' } }, true);
        const number = Number(positionals[0]);
        if (!Number.isInteger(number) || number <= 0) fail('usage: cez manager merge --project <id> <number>');
        const project = await projectOf(values.project);
        await propose({
          action: {
            type: 'merge-pr',
            projectId: project.projectId,
            number,
            ...(values.title ? { title: values.title } : {}),
            ...(values.method ? { method: values.method } : {}),
          },
          ...(values.reason ? { reason: values.reason } : {}),
        }, `merging #${number}`);
        return 0;
      }

      case 'automation': {
        const projectAt = rest.indexOf('--project');
        const named = projectAt >= 0 ? rest[projectAt + 1] : undefined;
        const forwarded = projectAt >= 0 ? rest.filter((_, index) => index !== projectAt && index !== projectAt + 1) : rest;
        const project = await projectOf(named);
        const [sub, ...subArgs] = forwarded;
        if (sub === 'enable') {
          const automationId = subArgs[0];
          if (!automationId) fail('usage: cez manager automation --project <id> enable <automation id>');
          await propose({ action: { type: 'enable-automation', projectId: project.projectId, automationId } }, `enabling ${automationId}`);
          return 0;
        }
        if (forwarded.includes('--enable')) fail('a manager creates automations paused: drop --enable, then propose it with `cez manager automation enable <id>`');
        if (forwarded.includes('--execute') || (sub && REFUSED_AUTOMATION.has(sub))) fail('a manager cannot launch or delete automations: ask the user to do it in the cockpit');
        if (env.CEZ_MANAGER_TURN === 'watch' && !(sub && READ_ONLY_AUTOMATION.has(sub))) fail('a watch check is read-only: ask the user instead');
        if (!(sub && READ_ONLY_AUTOMATION.has(sub)) && managerAccessOf(await call<Manager>(''), project.projectId) === 'read') {
          fail(`${project.projectId} is read-only for this manager: it cannot set up automations there`);
        }
        // What it creates reports its results to this chat unless it passes --no-report.
        return runAutomationCommand(forwarded, { ...env, CEZ_PROJECT_ID: project.projectId }, io, { neverEnable: true, reportTo: env.CEZ_MANAGER_ID });
      }

      case 'job': {
        const [sub, ...jobArgs] = rest;
        if (sub === 'list') {
          const summary = await call<{ jobs: unknown[] }>('');
          printJson(summary.jobs);
          return 0;
        }
        if (sub === 'remove') {
          if (!jobArgs[0]) fail('usage: cez manager job remove <id>');
          await call(`/jobs/${encodeURIComponent(jobArgs[0])}`, { method: 'DELETE' });
          io.log(`removed job ${jobArgs[0]}`);
          return 0;
        }
        if (sub === 'add') {
          const { values, positionals } = parse('job add', jobArgs, { name: { type: 'string' }, every: { type: 'string' } }, true);
          const prompt = positionals.join(' ').trim();
          const everyMinutes = Number(values.every);
          if (!values.name || !prompt || !Number.isInteger(everyMinutes)) fail('usage: cez manager job add --name <name> --every <minutes> "<prompt>"');
          await propose({ action: { type: 'add-job', name: values.name, prompt, everyMinutes } }, `the job ${values.name}`);
          return 0;
        }
        fail(sub === undefined
          ? `usage: cez manager job ${JOB_SUBCOMMANDS.join('|')}`
          : `unknown subcommand '${sub}' for 'job'. Valid: ${JOB_SUBCOMMANDS.join(', ')}. See: cez manager job --help`);
      }
      // falls through: `fail` never returns

      case 'memory': {
        const [sub, ...memoryArgs] = rest;
        if (sub === 'list') {
          const { values } = parse('memory list', memoryArgs, { json: { type: 'boolean' } });
          const memory = await call<ManagerMemoryResponse>('/memory');
          if (values.json) printJson(memory);
          else if (memory.entries.length === 0) io.log('Memory is empty.');
          else for (const entry of memory.entries) io.log(`${entry.key}  [${entry.kind}]  ${entry.text}${entry.why ? `  (why: ${entry.why})` : ''}`);
          return 0;
        }
        if (sub === 'set' || sub === 'remove') {
          if (env.CEZ_MANAGER_TURN === 'watch') fail('a watch check is read-only: ask the user instead');
        }
        if (sub === 'set') {
          const { values, positionals } = parse('memory set', memoryArgs, { kind: { type: 'string' }, why: { type: 'string' } }, true);
          const [key, ...words] = positionals;
          const text = words.join(' ').trim();
          const kind = managerMemoryKindSchema.safeParse(values.kind);
          if (!key || !text || !kind.success) fail('usage: cez manager memory set <key> --kind preference|feedback|decision|pointer [--why "…"] "<text>"');
          if (!managerMemoryKeySchema.safeParse(key).success) fail(`'${key}' is not a key: use lowercase letters, digits and dashes, e.g. full-prs-not-drafts`);
          const memory = await call<ManagerMemoryResponse>(`/memory/${encodeURIComponent(key)}`, {
            method: 'PUT',
            body: { kind: kind.data, text, ...(values.why ? { why: values.why } : {}), source: 'manager' },
          });
          io.log(`remembered ${key} (${memory.entries.length}/${memory.limits.entries} entries, ${memory.usedBytes}/${memory.limits.bytes} bytes)`);
          return 0;
        }
        if (sub === 'remove') {
          if (!memoryArgs[0]) fail('usage: cez manager memory remove <key>');
          await call(`/memory/${encodeURIComponent(memoryArgs[0])}`, { method: 'DELETE' });
          io.log(`forgot ${memoryArgs[0]}`);
          return 0;
        }
        fail(sub === undefined
          ? `usage: cez manager memory ${MEMORY_SUBCOMMANDS.join('|')}`
          : `unknown subcommand '${sub}' for 'memory'. Valid: ${MEMORY_SUBCOMMANDS.join(', ')}. See: cez manager memory --help`);
      }
      // falls through: `fail` never returns

      case 'history': {
        const { values } = parse('history', rest, { since: { type: 'string' }, grep: { type: 'string' }, limit: { type: 'string' } });
        const limit = values.limit === undefined ? 20 : Number(values.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('--limit must be a whole number from 1 to 200');
        const since = values.since === undefined ? undefined : sinceOf(values.since, Date.now());
        if (values.since !== undefined && since === undefined) fail(`--since takes a duration such as 30m, 2h or 1d, or an ISO time, not '${values.since}'`);
        const needle = values.grep?.toLowerCase();
        const lines: string[] = [];
        let before: number | undefined;
        // Newest pages first, until enough matches or the start of the chat.
        for (let page = 0; page < 20 && lines.length < limit; page++) {
          const query = new URLSearchParams({ limit: '200', ...(before !== undefined ? { before: String(before) } : {}) });
          const { messages } = await call<{ messages: ManagerMessage[] }>(`/messages?${query}`);
          if (messages.length === 0) break;
          before = Math.min(...messages.map((message) => message.seq));
          for (const message of [...messages].reverse()) {
            if (lines.length >= limit) break;
            if (since !== undefined && Date.parse(message.at) < since) continue;
            const line = historyLine(message);
            if (!line || (needle && !line.toLowerCase().includes(needle))) continue;
            lines.push(line);
          }
          if (since !== undefined && messages.every((message) => Date.parse(message.at) < since)) break;
        }
        if (lines.length === 0) {
          io.log('No messages match.');
          return 0;
        }
        let out = lines.reverse().join('\n\n');
        if (out.length > HISTORY_CHARS) out = `… (older matches cut; narrow with --since or --grep)\n${out.slice(-HISTORY_CHARS)}`;
        io.log(out);
        return 0;
      }

      case 'propose-action': {
        const { values } = parseArgs({
          args: rest,
          options: { connector: { type: 'string' }, tool: { type: 'string' }, args: { type: 'string' }, reason: { type: 'string' } },
        });
        const usage = 'usage: cez manager propose-action --connector <key> --tool <tool> --args \'<json>\' [--reason "…"]';
        if (!values.tool) fail(usage);
        const full = values.tool.startsWith('mcp__') ? parseConnectorTool(values.tool) : undefined;
        if (values.tool.startsWith('mcp__') && !full) fail(`${values.tool} is not a connector tool name (mcp__<connector>__<tool>)`);
        if (full && values.connector && values.connector !== full.key) fail(`--connector ${values.connector} does not match the tool's connector ${full.key}`);
        const connector = full?.key ?? values.connector;
        const tool = full?.tool ?? values.tool;
        if (!connector) fail(usage);
        let args: unknown = {};
        if (values.args !== undefined) {
          try {
            args = JSON.parse(values.args);
          } catch (error) {
            fail(`--args is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (args === null || typeof args !== 'object' || Array.isArray(args)) fail('--args must be a JSON object, the tool\'s input');
        await propose({ action: { type: 'connector-call', connector, tool, args }, ...(values.reason ? { reason: values.reason } : {}) }, `calling ${tool} on ${connector}`);
        return 0;
      }

      default:
        io.error(`cez manager: unknown command '${command}'. Valid: ${COMMANDS.join(', ')}\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    io.error(`cez manager: ${error instanceof Error ? error.message : String(error)}${sandboxBlocked(error) ? `\n${SANDBOX_BLOCKED_HINT}` : ''}`);
    return 1;
  }
}

/** Claude Code's Bash sandbox refuses the loopback connect outright (#2258); a stopped cockpit
 *  answers ECONNREFUSED instead. */
function sandboxBlocked(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  return error instanceof TypeError && cause?.code === 'EPERM';
}

export const SANDBOX_BLOCKED_HINT =
  'The Bash sandbox blocked this call. cez-manager leaves the sandbox only as one plain command: no heredoc, no line breaks and no ? * [ ~ anywhere in it. Write any text to files/<name>.md with Write, pass --file files/<name>.md, keep titles and reasons to plain words, and run it again.';
