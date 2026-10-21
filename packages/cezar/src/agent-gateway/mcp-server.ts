/**
 * `cezar mcp` — a stdio MCP server that lets another agent (Hermes, OpenClaw, Claude Desktop, …)
 * drive a RUNNING cockpit (spec `.ai/specs/2026-10-21-agent-gateway-integrations.md`).
 *
 * It is a thin HTTP client over the same `/api/v1` routes the cockpit and `cez runs` use — no
 * state, no server of its own, no new dependency: MCP over stdio is newline-delimited JSON-RPC 2.0
 * and we need five methods. stdout carries protocol frames ONLY; everything human goes to stderr.
 *
 * The cockpit's origin guard (#426) rejects browser cross-origin writes; a client that sends no
 * `Origin` header — like this one — passes, the same as `cez task`.
 */
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { runHistoryPageSchema, runRecordSchema, runStatusSchema } from '@open-mercato/cezar-contract';
import { DEFAULT_COCKPIT_URL } from '../cockpit-address.ts';
import { RUNNER_IDS } from '../core/agent-runner.ts';

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_WORKFLOW = 'quick-task';

export interface McpEnv {
  CEZ_API_URL?: string;
  CEZ_PROJECT_ID?: string;
}

export interface McpDeps {
  fetch: typeof fetch;
  env: McpEnv;
  /** `--url`, ahead of `CEZ_API_URL`. */
  url?: string;
}

/** `--url`, then `CEZ_API_URL`, then the cockpit's default address (the user asked for this server). */
export function cockpitBase(deps: McpDeps): string {
  return (deps.url ?? deps.env.CEZ_API_URL ?? DEFAULT_COCKPIT_URL).replace(/\/+$/, '');
}

class ToolError extends Error {}

async function call(deps: McpDeps, method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `${cockpitBase(deps)}/api/v1${path}`;
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method,
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ToolError(`cezar cockpit not reachable at ${cockpitBase(deps)} (${reason}). Start it with \`cezar\`, or set CEZ_API_URL.`);
  }
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // not JSON — keep the text
  }
  if (!response.ok) {
    const message = parsed && typeof parsed === 'object' && 'error' in parsed ? String((parsed as { error: unknown }).error) : `${response.status} ${response.statusText}`;
    throw new ToolError(`cezar refused: ${message}`);
  }
  return parsed;
}

const scope = (deps: McpDeps, project: string | undefined): string => {
  const id = project ?? deps.env.CEZ_PROJECT_ID;
  return id ? `/p/${encodeURIComponent(id)}` : '';
};

// ---- shapes -----------------------------------------------------------------------------------

/** `status` stays a string: a cockpit newer than this build may add one, and it must still list. */
const taskSummarySchema = runRecordSchema
  .pick({
    id: true,
    title: true,
    titleSummary: true,
    activity: true,
    branch: true,
    pullRequestUrl: true,
    costUsd: true,
    error: true,
    createdAt: true,
    finishedAt: true,
    archived: true,
    awaitingAnswerSince: true,
  })
  .extend({ status: z.string() });

function summarize(record: unknown): Record<string, unknown> | undefined {
  const parsed = taskSummarySchema.safeParse(record);
  if (!parsed.success) return undefined;
  const { titleSummary, ...rest } = parsed.data;
  const entries = Object.entries({ ...rest, title: titleSummary ?? rest.title }).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries);
}

/** Newest `CEZ:ASK` question and the agent's last message out of one history page. */
function digestHistory(raw: unknown, status: string): { question?: unknown; lastAgentMessage?: string } {
  const page = runHistoryPageSchema.safeParse(raw);
  if (!page.success) return {};
  let question: unknown;
  let lastAgentMessage: string | undefined;
  for (const event of page.data.events) {
    if (event.type === 'ask.requested') question = event.questions;
    else if (event.type === 'item.completed' && event.item?.kind === 'message' && event.item.role === 'assistant' && typeof event.item.text === 'string') {
      lastAgentMessage = event.item.text;
    } else if (event.type === 'text' && typeof event.text === 'string') lastAgentMessage = event.text;
  }
  // An ask is live only while the task waits on it; once answered it is history, not a question.
  return {
    ...(question && status === 'waiting' ? { question } : {}),
    ...(lastAgentMessage ? { lastAgentMessage: lastAgentMessage.length > 2_000 ? `…${lastAgentMessage.slice(-2_000)}` : lastAgentMessage } : {}),
  };
}

async function resolveTaskId(deps: McpDeps, project: string | undefined, idOrPrefix: string): Promise<string> {
  const runs = await call(deps, 'GET', `${scope(deps, project)}/runs`);
  const ids = (Array.isArray(runs) ? runs : []).map((run) => (run as { id?: unknown }).id).filter((id): id is string => typeof id === 'string');
  if (ids.includes(idOrPrefix)) return idOrPrefix;
  const matches = ids.filter((id) => id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0]!;
  throw new ToolError(matches.length ? `task id "${idOrPrefix}" is ambiguous — use more characters` : `no task "${idOrPrefix}" in this project`);
}

// ---- tools ------------------------------------------------------------------------------------

const projectField = z.string().optional().describe('Project id (see cezar_list_projects). Defaults to the cockpit\'s own project.');
const taskField = z.string().min(1).describe('Task id, or its first 8+ characters.');

interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run: (args: z.infer<S>, deps: McpDeps) => Promise<unknown>;
}

function tool<S extends z.ZodType>(definition: Tool<S>): Tool {
  return definition as unknown as Tool;
}

export const TOOLS: Tool[] = [
  tool({
    name: 'cezar_list_projects',
    description: 'List the projects (repositories) the cezar cockpit knows. Use an id as the `project` argument of other tools.',
    schema: z.object({}),
    run: async (_args, deps) => {
      const body = (await call(deps, 'GET', '/projects')) as { projects?: Array<{ id: string; name: string; root: string }>; bootProject?: string };
      return {
        bootProject: body.bootProject,
        projects: (body.projects ?? []).map(({ id, name, root }) => ({ id, name, root })),
      };
    },
  }),
  tool({
    name: 'cezar_list_workflows',
    description: `List the workflows a new task can run. "${DEFAULT_WORKFLOW}" is the default single-agent one.`,
    schema: z.object({ project: projectField }),
    run: async ({ project }, deps) => {
      const body = (await call(deps, 'GET', `${scope(deps, project)}/workflows`)) as { workflows?: Array<{ name: string; description?: string }> };
      return (body.workflows ?? []).map(({ name, description }) => ({ name, ...(description ? { description } : {}) }));
    },
  }),
  tool({
    name: 'cezar_list_tasks',
    description: 'List tasks (agent runs) of a project, newest first. Statuses: queued, running, waiting (needs the user), review (changes ready), done, failed, cancelled.',
    schema: z.object({
      project: projectField,
      status: z.array(runStatusSchema).optional().describe('Keep only these statuses.'),
      include_archived: z.boolean().optional(),
    }),
    run: async ({ project, status, include_archived }, deps) => {
      const runs = await call(deps, 'GET', `${scope(deps, project)}/runs`);
      const summaries = (Array.isArray(runs) ? runs : []).map(summarize).filter((run): run is Record<string, unknown> => run !== undefined);
      return summaries
        .filter((run) => (include_archived || !run.archived) && (!status || status.includes(run.status as never)))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map(({ archived: _archived, ...run }) => run);
    },
  }),
  tool({
    name: 'cezar_get_task',
    description: 'Status of one task: branch, PR url, error, and — when it waits for the user — the question it asked, plus the agent\'s last message.',
    schema: z.object({ project: projectField, id: taskField }),
    run: async ({ project, id }, deps) => {
      const taskId = await resolveTaskId(deps, project, id);
      const base = `${scope(deps, project)}/runs/${encodeURIComponent(taskId)}`;
      const record = await call(deps, 'GET', base);
      const summary = summarize(record) ?? { id: taskId };
      // History is context, not the answer: a failure there must not hide the status.
      const status = String((summary as { status?: unknown }).status ?? '');
      const digest = await call(deps, 'GET', `${base}/history`).then((page) => digestHistory(page, status), () => ({}));
      return { ...summary, ...digest };
    },
  }),
  tool({
    name: 'cezar_create_task',
    description: 'Start a new coding-agent task in a git worktree of the project. It ends at a review gate; nothing is merged. Poll with cezar_get_task or wait for the cezar alert.',
    schema: z.object({
      task: z.string().min(1).max(100_000).describe('What the agent should do.'),
      project: projectField,
      workflow: z.string().optional().describe(`Workflow name (default "${DEFAULT_WORKFLOW}").`),
      runner: z.enum(RUNNER_IDS).optional().describe('Agent backend.'),
      model: z.string().optional(),
      autonomous: z.boolean().optional().describe('Never pause to ask the user; run until the agent says it is done.'),
    }),
    run: async ({ task, project, workflow, runner, model, autonomous }, deps) => {
      const run = await call(deps, 'POST', `${scope(deps, project)}/runs`, {
        task,
        workflow: workflow ?? DEFAULT_WORKFLOW,
        ...(runner ? { runner } : {}),
        ...(model ? { model } : {}),
        ...(autonomous !== undefined ? { autonomous } : {}),
      });
      return summarize(run) ?? run;
    },
  }),
  tool({
    name: 'cezar_send_message',
    description: 'Send text to a task: answer the question it asked (status waiting), steer a running task, or send review feedback back.',
    schema: z.object({ project: projectField, id: taskField, text: z.string().min(1).max(100_000) }),
    run: async ({ project, id, text }, deps) => {
      const taskId = await resolveTaskId(deps, project, id);
      await call(deps, 'POST', `${scope(deps, project)}/runs/${encodeURIComponent(taskId)}/messages`, { text });
      return { sent: true, id: taskId };
    },
  }),
  tool({
    name: 'cezar_cancel_task',
    description: 'Cancel a queued or running task.',
    schema: z.object({ project: projectField, id: taskField }),
    run: async ({ project, id }, deps) => {
      const taskId = await resolveTaskId(deps, project, id);
      return { id: taskId, ...((await call(deps, 'POST', `${scope(deps, project)}/runs/${encodeURIComponent(taskId)}/cancel`)) as object) };
    },
  }),
  tool({
    name: 'cezar_accept_review',
    description: 'Accept a task\'s changes without opening a PR (review -> done), or close its open session. Only after the user agreed. Completion is asynchronous: check cezar_get_task afterwards.',
    schema: z.object({ project: projectField, id: taskField }),
    run: async ({ project, id }, deps) => {
      const taskId = await resolveTaskId(deps, project, id);
      await call(deps, 'POST', `${scope(deps, project)}/runs/${encodeURIComponent(taskId)}/finish`);
      return { id: taskId, accepted: true };
    },
  }),
  tool({
    name: 'cezar_open_pr',
    description: 'Push a task\'s branch and open a pull request (draft by default) through gh. Only after the user agreed. Check cezar_get_task afterwards for the PR url.',
    schema: z.object({ project: projectField, id: taskField, draft: z.boolean().optional().describe('Default true.') }),
    run: async ({ project, id, draft }, deps) => {
      const taskId = await resolveTaskId(deps, project, id);
      return call(deps, 'POST', `${scope(deps, project)}/runs/${encodeURIComponent(taskId)}/pr`, { draft: draft ?? true });
    },
  }),
];

// ---- JSON-RPC ---------------------------------------------------------------------------------

type Id = string | number | null;
export interface RpcMessage {
  jsonrpc?: string;
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
}

const rpcError = (id: Id, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcResult = (id: Id, result: unknown) => ({ jsonrpc: '2.0', id, result });

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

/** One inbound frame -> the reply frame, or `undefined` for a notification (nothing to say). */
export async function handleMessage(message: RpcMessage | RpcMessage[], deps: McpDeps): Promise<object | undefined> {
  // MCP 2025-06-18 removed JSON-RPC batching; a silent drop would leave the caller waiting forever.
  if (Array.isArray(message)) return rpcError(null, -32600, 'invalid request: batch requests are not supported');
  const { id, method } = message;
  if (typeof method !== 'string') return id === undefined ? undefined : rpcError(id, -32600, 'invalid request');
  // No id = notification (notifications/initialized, notifications/cancelled, …): never answered.
  if (id === undefined) return undefined;
  switch (method) {
    case 'initialize': {
      const wanted = typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '';
      const protocolVersion = (SUPPORTED_PROTOCOLS as readonly string[]).includes(wanted) ? wanted : SUPPORTED_PROTOCOLS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'cezar', version: packageVersion() },
        instructions: 'Drive the local cezar cockpit: start coding-agent tasks, read their status, answer their questions, cancel, accept or open a PR.',
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.schema, { io: 'input' }) })),
      });
    case 'tools/call': {
      const name = message.params?.name;
      const found = TOOLS.find((t) => t.name === name);
      if (!found) return rpcError(id, -32602, `unknown tool: ${String(name)}`);
      const args = found.schema.safeParse(message.params?.arguments ?? {});
      // A bad argument is the model's to correct, so it is a tool result it can read, not a protocol error.
      if (!args.success) return rpcResult(id, toolResult(`invalid arguments: ${args.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ')}`, true));
      try {
        return rpcResult(id, toolResult(JSON.stringify(await found.run(args.data, deps), null, 2), false));
      } catch (error) {
        return rpcResult(id, toolResult(error instanceof ToolError ? error.message : `cezar_mcp: ${error instanceof Error ? error.message : String(error)}`, true));
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

const toolResult = (text: string, isError: boolean) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

export interface McpIo {
  input: NodeJS.ReadableStream;
  write: (line: string) => void;
  error: (line: string) => void;
}

/** Serve until stdin closes. Frames are handled concurrently; replies carry their request id. */
export async function serveMcp(deps: McpDeps, io: McpIo = { input: process.stdin, write: (line) => process.stdout.write(`${line}\n`), error: (line) => console.error(line) }): Promise<void> {
  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input: io.input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: RpcMessage | RpcMessage[];
    try {
      message = JSON.parse(line) as RpcMessage | RpcMessage[];
    } catch {
      io.write(JSON.stringify(rpcError(null, -32700, 'parse error')));
      continue;
    }
    const work = handleMessage(message, deps)
      .then((reply) => {
        if (reply) io.write(JSON.stringify(reply));
      })
      .catch((error) => io.error(`cezar mcp: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => pending.delete(work));
    pending.add(work);
  }
  await Promise.all(pending);
}

const USAGE = `cezar mcp — MCP server (stdio) that lets another agent drive a running cezar cockpit

  cezar mcp [--url <cockpit url>]

Reads CEZ_API_URL (default ${DEFAULT_COCKPIT_URL}) and optionally CEZ_PROJECT_ID.
Remote agent host:  ssh <host> cezar mcp
Config snippets for Hermes / OpenClaw:  cezar integrations print <hermes|openclaw>`;

export async function runMcpCommand(args: string[], env: McpEnv = process.env): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const at = args.indexOf('--url');
  const url = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0 && !url) {
    console.error(USAGE);
    return 2;
  }
  await serveMcp({ fetch: (input, init) => fetch(input, init), env, url });
  return 0;
}
