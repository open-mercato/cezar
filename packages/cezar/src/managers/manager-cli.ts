/**
 * `cez manager …` — the tools a manager's agent calls (spec 2026-10-31-managers). A thin HTTP
 * client over `/workspace/managers`, addressed like `cez task`: `CEZ_API_URL` plus `CEZ_MANAGER_ID`,
 * both set on every manager turn. The `cez-manager` shim on the turn's PATH lands here.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { ManagerCancelTaskResponse, ManagerCreateTaskResponse, ManagerForwarded, ManagerSnapshot, ManagerSnapshotProject, ManagerTaskMessageResponse } from '@open-mercato/cezar-contract';
import { managerAccessOf, managerTaskEffortSchema, type Manager } from '@open-mercato/cezar-contract';
import { runAutomationCommand } from '../automations/automation-cli.ts';
import { missingCockpitMessage } from '../cockpit-address.ts';

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
  cez manager task create --project <id> [--title t] [--workflow w] [--runner r] [--model m] [--effort e] [--dispatch] "<objective>"
  cez manager task say --project <id> <run> [--model m] [--effort e] "<text>"
                                                 --model/--effort only when it continues a finished task
  cez manager task cancel --project <id> <run> [--reason "…"]
                                                 stops it and every task it dispatched; worktree and branch stay
  cez manager task retry --project <id> <run>    a failed or cancelled task again, as a new task
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
  cez manager rename "<role>"                    a short role the user recognizes it by

  Every command and subcommand takes --help.`;

/** All a watch check may run; an allowlist, so a new subcommand is refused until someone decides. */
const READ_ONLY_AUTOMATION = new Set(['list', 'show', 'schema', 'check']);
/** Each of these starts or destroys work no card ever showed the user. */
const REFUSED_AUTOMATION = new Set(['run', 'delete']);

function fail(message: string): never {
  throw new Error(message);
}

const COMMANDS = ['status', 'attention', 'tasks', 'prs', 'task', 'workflows', 'merge', 'automation', 'job', 'rename'] as const;
const TASK_SUBCOMMANDS = ['create', 'say', 'cancel', 'retry'] as const;
const JOB_SUBCOMMANDS = ['add', 'list', 'remove'] as const;
/** A full run id or its first eight hex digits: anything else after `task` is a mistyped subcommand. */
const RUN_ID_LIKE = /^[0-9a-f]{8}(?:-[0-9a-f-]+)?$/i;
const EFFORTS = managerTaskEffortSchema.options;

const CONTENT_HELP = `
  --attach-last-user-message   copy the user's newest message into the task verbatim, attachments too
  --from-message <id>          the same for a given chat message
  --file <path> | --stdin      append the text of a file, or of stdin
  --allow-placeholder          send text holding a marker such as [transcript here] or PASTE anyway`;

const SNAPSHOT_HELP = (command: string, what: string) => `cez manager ${command} [--project <id>] [--json]

${what}
  --project <id>   only this project
  --json           the data, as JSON`;

/** `--help` per command; `task create` adds the project's workflow names when it can reach them. */
const HELP: Record<string, string> = {
  status: SNAPSHOT_HELP('status', 'What needs attention, every task and every pull request.'),
  attention: SNAPSHOT_HELP('attention', 'What needs attention: waiting, failed, finished and stalled tasks, PRs and automations.'),
  tasks: SNAPSHOT_HELP('tasks', "Every connected project's tasks, the user's own included, with their model, effort and PR."),
  prs: SNAPSHOT_HELP('prs', 'Open pull requests and their status.'),
  task: `cez manager task <run> [--project <id>]
cez manager task create|say|cancel|retry …   (each takes --help)

One task as JSON: status, startedBy, runner, model, effort, prNumber/prUrl, its last message and its children.
  --project <id>   the task's project; found from the snapshot when omitted`,
  'task create': `cez manager task create --project <id> [flags] "<objective>"

Starts a task.
  --project <id>     the project (required unless only one is connected)
  --title <t>        its title
  --workflow <w>     a workflow name (default quick-task); see cez manager workflows
  --runner <r>       the agent backend, e.g. claude or codex
  --model <m>        a model id or alias the runner can use, e.g. opus; refused with the valid ones otherwise
  --effort <e>       ${EFFORTS.join(' | ')}; refused when the runner or model has no such level
  --dispatch         start it as the root of a dispatch tree${CONTENT_HELP}`,
  'task say': `cez manager task say --project <id> <run> [flags] "<text>"

Messages a running task, or continues a finished one with the text.
  --project <id>     the task's project
  --model <m>        continue on this model (a finished task only)
  --effort <e>       ${EFFORTS.join(' | ')} (a finished task only)${CONTENT_HELP}`,
  'task cancel': `cez manager task cancel --project <id> <run> [--reason "…"]

Stops the task and every task it dispatched, and marks them cancelled. Their worktree and branch stay.
Only a task this manager started, unless the user allowed "Cancel any task" in its settings.
  --project <id>     the task's project
  --reason "…"       why; kept on the task and shown in the cockpit`,
  'task retry': `cez manager task retry --project <id> <run>

Starts a failed or cancelled task again as a new task: the same objective, workflow, runner, model and effort.
  --project <id>     the task's project`,
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
  rename: 'cez manager rename "<role>"\n\nA short role the user recognizes this manager by, e.g. "Coding Manager".',
};

/** The help key for `args`: `task create` when the subcommand is known, else the command. */
function helpKey(command: string, rest: string[]): string {
  const sub = rest[0];
  const subs: readonly string[] = command === 'task' ? TASK_SUBCOMMANDS : command === 'job' ? JOB_SUBCOMMANDS : [];
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
async function contentOf(words: string[], values: ContentValues, io: ManagerCliIo): Promise<{ text: string; fromMessage?: string; allowPlaceholder?: true }> {
  if (values['attach-last-user-message'] && values['from-message']) fail('use --attach-last-user-message or --from-message, not both');
  if (values.file !== undefined && values.stdin) fail('use --file or --stdin, not both');
  let extra = '';
  if (values.file !== undefined) {
    try {
      extra = await (io.readFile ?? ((path: string) => readFile(path, 'utf8')))(values.file);
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
    const proposed = await call<{ actionId: string }>('/actions', { method: 'POST', body });
    const waiting = before.messages.find((message) => message.id === proposed.actionId);
    io.log(waiting
      ? `already pending ${proposed.actionId} (proposed ${waiting.at}): ${what} still waits for the user's approval on that card, earlier in the chat. No new card was added; point the user to it instead of asking again.`
      : `proposed ${proposed.actionId}: ${what} waits for the user's approval in the chat`);
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
        const { values } = parse(command, rest, { json: { type: 'boolean' }, project: { type: 'string' } });
        const data = await snapshot();
        const projects = data.projects.filter((project) => !values.project || project.projectId === values.project);
        if (values.json) {
          if (command === 'status') printJson(data);
          else if (command === 'attention') printJson(data.attention);
          else if (command === 'tasks') printJson(projects.flatMap((project) => project.tasks.map((task) => ({ projectId: project.projectId, ...task }))));
          else printJson(projects.flatMap((project) => project.prs.map((pr) => ({ projectId: project.projectId, ...pr }))));
          return 0;
        }
        if (command === 'status' || command === 'attention') {
          if (data.attention.length === 0) io.log('Nothing needs attention.');
          for (const item of data.attention) io.log(`${item.kind}  ${item.projectId}  ${item.runId ?? (item.number !== undefined ? `#${item.number}` : '')}  ${item.title}${item.detail ? ` — ${item.detail}` : ''}`);
        }
        if (command === 'status' || command === 'tasks') {
          for (const project of projects) for (const task of project.tasks) {
            const facts = [
              task.startedBy === 'manager' ? `by ${task.startedByManager ?? 'a manager'}` : 'by the user',
              task.model && `${task.model}${task.effort ? `/${task.effort}` : ''}`,
              task.prNumber !== undefined && `PR #${task.prNumber}`,
              task.childCount > 0 && `${task.childCount} dispatched`,
            ].filter(Boolean).join(', ');
            io.log(`${project.projectId}  ${task.runId}  ${task.status}  ${task.title}  (${facts})`);
          }
        }
        if (command === 'status' || command === 'prs') {
          for (const project of projects) {
            if (project.prsUnavailable) io.log(`${project.projectId}: pull requests unavailable — ${project.prsUnavailable}`);
            for (const pr of project.prs) io.log(`${project.projectId}  #${pr.number}  ${pr.draft ? 'draft' : (pr.status ?? 'open')}  ${pr.title}`);
          }
        }
        return 0;
      }

      case 'task': {
        const [sub, ...taskArgs] = rest;
        if (sub === 'create') {
          const { values, positionals } = parse('task create', taskArgs, {
            project: { type: 'string' }, title: { type: 'string' }, workflow: { type: 'string' },
            runner: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, dispatch: { type: 'boolean' },
            ...CONTENT_OPTIONS,
          }, true);
          const effort = effortOf(values.effort);
          const { text: task, ...content } = await contentOf(positionals, values, io);
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
              ...(values.model ? { model: values.model } : {}),
              ...(effort ? { effort } : {}),
              ...(values.dispatch ? { dispatch: true } : {}),
            },
          });
          io.log(`[[task:${created.projectId}/${created.runId}]]`);
          if (created.forwarded) io.log(forwardedLine(created.forwarded));
          return 0;
        }
        if (sub === 'say') {
          const { values, positionals } = parse('task say', taskArgs, { project: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, ...CONTENT_OPTIONS }, true);
          const effort = effortOf(values.effort);
          const [runId, ...words] = positionals;
          const { text, ...content } = runId ? await contentOf(words, values, io) : { text: '' };
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
        if (sub === 'retry') {
          const { values, positionals } = parse('task retry', taskArgs, { project: { type: 'string' } }, true);
          const [runId, ...extra] = positionals;
          if (!runId || extra.length > 0) fail('usage: cez manager task retry --project <id> <run>');
          const projectId = await projectForRun(values.project, runId);
          const created = await call<ManagerCreateTaskResponse>('/task-retry', { method: 'POST', body: { projectId, runId } });
          io.log(`[[task:${created.projectId}/${created.runId}]]`);
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

      default:
        io.error(`cez manager: unknown command '${command}'. Valid: ${COMMANDS.join(', ')}\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    io.error(`cez manager: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
