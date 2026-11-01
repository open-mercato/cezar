/**
 * `cez manager …` — the tools a manager's agent calls (spec 2026-10-31-managers). A thin HTTP
 * client over `/workspace/managers`, addressed like `cez task`: `CEZ_API_URL` plus `CEZ_MANAGER_ID`,
 * both set on every manager turn. The `cez-manager` shim on the turn's PATH lands here.
 */
import { parseArgs } from 'node:util';
import type { ManagerSnapshot, ManagerSnapshotProject } from '@open-mercato/cezar-contract';
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
}

const USAGE = `cez manager — the tools of a cezar manager's agent (CEZ_MANAGERS=0 on the cockpit turns managers off)

  cez manager status | attention | tasks | prs   what is going on (add --json for data)
  cez manager task <run> [--project <id>]        one task, its last message and its children
  cez manager task create --project <id> [--title t] [--workflow w] [--runner r] [--model m] [--dispatch] "<objective>"
  cez manager task say --project <id> <run> "<text>"
  cez manager workflows --project <id>
  cez manager merge --project <id> <number> [--method merge|squash|rebase] [--title t] [--reason "…"]
                                                 proposes a merge; the user approves it in the chat
  cez manager automation --project <id> <cez automation args>
                                                 always paused, editing one pauses it; enable proposes
  cez manager job add --name <name> --every <minutes> "<prompt>"
                                                 proposes a job; the user approves it in the chat
  cez manager job list | job remove <id>
  cez manager rename "<role>"                    a short role the user recognizes it by`;

/** All a watch check may run; an allowlist, so a new subcommand is refused until someone decides. */
const READ_ONLY_AUTOMATION = new Set(['list', 'show', 'schema', 'check']);
/** Each of these starts or destroys work no card ever showed the user. */
const REFUSED_AUTOMATION = new Set(['run', 'delete']);

function fail(message: string): never {
  throw new Error(message);
}

export async function runManagerCommand(
  args: string[],
  env: ManagerCliEnv = process.env,
  io: ManagerCliIo = { fetch, log: console.log, error: console.error },
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help') {
    io.log(USAGE);
    return command ? 0 : 2;
  }
  const url = env.CEZ_API_URL?.replace(/\/+$/, '');
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

  try {
    switch (command) {
      case 'status':
      case 'attention':
      case 'tasks':
      case 'prs': {
        const { values } = parseArgs({ args: rest, options: { json: { type: 'boolean' }, project: { type: 'string' } } });
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
            io.log(`${project.projectId}  ${task.runId}  ${task.status}  ${task.title}${task.childCount > 0 ? `  (${task.childCount} dispatched)` : ''}`);
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
          const { values, positionals } = parseArgs({
            args: taskArgs,
            allowPositionals: true,
            options: {
              project: { type: 'string' }, title: { type: 'string' }, workflow: { type: 'string' },
              runner: { type: 'string' }, model: { type: 'string' }, dispatch: { type: 'boolean' },
            },
          });
          const task = positionals.join(' ').trim();
          if (!task) fail('an objective is required: cez manager task create --project <id> "<objective>"');
          const project = await projectOf(values.project);
          const created = await call<{ projectId: string; runId: string }>('/tasks', {
            method: 'POST',
            body: {
              projectId: project.projectId,
              task,
              ...(values.title ? { title: values.title } : {}),
              ...(values.workflow ? { workflow: values.workflow } : {}),
              ...(values.runner ? { runner: values.runner } : {}),
              ...(values.model ? { model: values.model } : {}),
              ...(values.dispatch ? { dispatch: true } : {}),
            },
          });
          io.log(`[[task:${created.projectId}/${created.runId}]]`);
          return 0;
        }
        if (sub === 'say') {
          const { values, positionals } = parseArgs({ args: taskArgs, allowPositionals: true, options: { project: { type: 'string' } } });
          const [runId, ...words] = positionals;
          if (!runId || words.length === 0) fail('usage: cez manager task say --project <id> <run> "<text>"');
          const project = await projectOf(values.project);
          await call('/task-message', { method: 'POST', body: { projectId: project.projectId, runId, text: words.join(' ') } });
          io.log(`sent to ${runId}`);
          return 0;
        }
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { project: { type: 'string' } } });
        const runId = positionals[0];
        if (!runId) fail('usage: cez manager task <run> [--project <id>]');
        const data = await snapshot();
        const projectId = values.project
          ?? data.projects.find((project) => project.tasks.some((task) => task.runId === runId))?.projectId
          ?? (await projectOf(undefined)).projectId;
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
        const { values } = parseArgs({ args: rest, options: { project: { type: 'string' } } });
        const project = await projectOf(values.project);
        const response = await io.fetch(`${url}/api/v1/p/${encodeURIComponent(project.projectId)}/workflows`);
        if (!response.ok) fail(`${response.status} ${response.statusText}`);
        printJson(await response.json());
        return 0;
      }

      case 'merge': {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { project: { type: 'string' }, method: { type: 'string' }, title: { type: 'string' }, reason: { type: 'string' } },
        });
        const number = Number(positionals[0]);
        if (!Number.isInteger(number) || number <= 0) fail('usage: cez manager merge --project <id> <number>');
        const project = await projectOf(values.project);
        const proposed = await call<{ actionId: string }>('/actions', {
          method: 'POST',
          body: {
            action: {
              type: 'merge-pr',
              projectId: project.projectId,
              number,
              ...(values.title ? { title: values.title } : {}),
              ...(values.method ? { method: values.method } : {}),
            },
            ...(values.reason ? { reason: values.reason } : {}),
          },
        });
        io.log(`proposed ${proposed.actionId}: merging #${number} waits for the user's approval in the chat`);
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
          const proposed = await call<{ actionId: string }>('/actions', {
            method: 'POST',
            body: { action: { type: 'enable-automation', projectId: project.projectId, automationId } },
          });
          io.log(`proposed ${proposed.actionId}: enabling it waits for the user's approval in the chat`);
          return 0;
        }
        if (forwarded.includes('--enable')) fail('a manager creates automations paused: drop --enable, then propose it with `cez manager automation enable <id>`');
        if (forwarded.includes('--execute') || (sub && REFUSED_AUTOMATION.has(sub))) fail('a manager cannot launch or delete automations: ask the user to do it in the cockpit');
        if (env.CEZ_MANAGER_TURN === 'watch' && !(sub && READ_ONLY_AUTOMATION.has(sub))) fail('a watch check is read-only: ask the user instead');
        return runAutomationCommand(forwarded, { ...env, CEZ_PROJECT_ID: project.projectId }, io, { neverEnable: true });
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
          const { values, positionals } = parseArgs({ args: jobArgs, allowPositionals: true, options: { name: { type: 'string' }, every: { type: 'string' } } });
          const prompt = positionals.join(' ').trim();
          const everyMinutes = Number(values.every);
          if (!values.name || !prompt || !Number.isInteger(everyMinutes)) fail('usage: cez manager job add --name <name> --every <minutes> "<prompt>"');
          const proposed = await call<{ actionId: string }>('/actions', {
            method: 'POST',
            body: { action: { type: 'add-job', name: values.name, prompt, everyMinutes } },
          });
          io.log(`proposed ${proposed.actionId}: the job waits for the user's approval in the chat`);
          return 0;
        }
        fail('usage: cez manager job add|list|remove');
      }
      // falls through: `fail` never returns

      default:
        io.error(`unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    io.error(`cez manager: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
