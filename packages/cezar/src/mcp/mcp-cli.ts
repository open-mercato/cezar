/**
 * `cez mcp` — an MCP server on stdio for agents that run OUTSIDE cezar (Claude Code, Codex,
 * OpenCode…), so they can list, start, follow and cancel runs of a running cockpit (#1109).
 *
 * It is a client of the cockpit's `/api/v1`, like `cez task`: run state lives only in the cockpit
 * process, so this never opens a store of its own. The cockpit is `--url`, else `CEZ_API_URL`,
 * else the one this user's runtime record names (`runtime/cockpit-runtime.ts`, #1739), else one
 * look at `DEFAULT_COCKPIT_URL` (a cockpit too old to publish a record). Discovery is lazy and
 * repeated after a connection error: the MCP handshake always succeeds, a missing cockpit is a
 * readable tool error, and a cockpit restarted on another port is found again on the next call.
 *
 * stdout carries JSON-RPC and nothing else; every diagnostic goes to stderr.
 */
import { parseArgs } from 'node:util';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_COCKPIT_URL, missingCockpitMessage } from '../cockpit-address.ts';
import { inspectCockpitRuntime, instanceCockpitSlot, type RuntimeInspection } from '../runtime/cockpit-runtime.ts';
import { listServerInstances } from '../server-install/state.ts';
import { createApiClient, hasOwnDeadline, isConnectionError, type CezarFetch } from './api.ts';
import { serveStdio, type McpServer, type StdioStreams } from './jsonrpc.ts';
import { buildMcpServer, describeProjectChoice, type Cockpit, type ProjectChoice } from './tools.ts';

/** Same bound as `cez runs`: a stalled cockpit or proxy must not hang an agent's tool call. */
const REQUEST_TIMEOUT_MS = 10_000;
/** The one look at `DEFAULT_COCKPIT_URL` when no runtime record names a cockpit. */
const PROBE_TIMEOUT_MS = 1_500;

const USAGE = `cez mcp — MCP server (stdio) for a running cezar cockpit

  cez mcp [--url <http://127.0.0.1:4321>] [--project <id>] [--header "Name: value"]… [--read-only]

  --url        cockpit to talk to (default: $CEZ_API_URL, else the running cockpit recorded under
               ~/.cezar/runtime, else http://127.0.0.1:4321)
  --project    default project for tools that take one (default: $CEZ_PROJECT_ID, else the project
               holding the current directory; reads then fall back to the cockpit's boot project,
               start_task asks for a projectId unless the cockpit serves a single project)
  --header     extra HTTP header for a cockpit behind a proxy (Basic auth, Cloudflare Access); repeatable
  --read-only  register only the read tools (no start_task, cancel_task, push_task_branch,
               send_task_message, review_task)

  Claude Code:  claude mcp add cezar -- npx -y cezar-run mcp`;

export interface McpCliEnv {
  CEZ_API_URL?: string;
  CEZ_PROJECT_ID?: string;
  CEZ_TASK_ID?: string;
}

export interface McpCliIo {
  fetch: CezarFetch;
  log: (line: string) => void;
  error: (line: string) => void;
  cwd: string;
  /** Starts the stdio transport — injected so the CLI parsing is testable without a real stdin. */
  serve: (server: McpServer) => Promise<void>;
  /** Reads the cockpit runtime records; default `inspectLocalCockpits`. */
  inspect?: () => Promise<RuntimeInspection[]>;
}

export class NoCockpitError extends Error {
  override name = 'NoCockpitError';
}

/** `"Name: value"` → `[name, value]`; the header name is whatever precedes the first colon. */
export function parseHeader(raw: string): [string, string] {
  const colon = raw.indexOf(':');
  const name = colon < 0 ? '' : raw.slice(0, colon).trim();
  // An HTTP token (RFC 9110 §5.6.2): fetch would throw on anything else, at the first tool call.
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error(`--header must look like "Name: value", got "${raw}"`);
  return [name, raw.slice(colon + 1).trim()];
}

export interface DiscoveredCockpit {
  url: string;
  /** The registered project holding `cwd`, when the cockpit has one. */
  projectId?: string;
  /** The id of the project the cockpit was booted in, when its registry was read. */
  bootProject?: string;
  /** No registered project holds `cwd`: the ones `start_task` must choose from. */
  projects?: ProjectChoice[];
  /** This cockpit's project registry could not be read, and why. Such an answer is used once
   *  and not kept. */
  registryUnread?: string;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const inside = (cwd: string, root: string) => cwd === root || cwd.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

interface Registry {
  /** The registered project holding `cwd` — the deepest root wins, so a repo nested in another does. */
  holding?: { id: string; root: string };
  /** The id of the project the cockpit was booted in. */
  bootProject?: string;
  /** Every registered project, for a choice the cwd cannot make. */
  projects?: ProjectChoice[];
  /** The registry could not be read, and why: which project holds `cwd` is then unknown. */
  failed?: string;
}

const isTimeout = (error: unknown) => error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

async function readRegistry(fetchImpl: CezarFetch, url: string, cwd: string, timeoutMs: number, headers?: Record<string, string>): Promise<Registry> {
  try {
    const res = await fetchImpl(`${url}/api/v1/projects`, { signal: AbortSignal.timeout(timeoutMs), ...(headers ? { headers } : {}) });
    if (!res.ok) return { failed: `${res.status} ${res.statusText}`.trim() };
    const body = (await res.json()) as { bootProject?: unknown; projects?: unknown };
    if (!Array.isArray(body.projects)) return { failed: 'not a project list' };
    const projects = (body.projects as Array<{ id?: unknown; name?: unknown; root?: unknown }>).flatMap((p) =>
      typeof p.id === 'string' && typeof p.root === 'string'
        ? [{ id: p.id, root: p.root, ...(typeof p.name === 'string' ? { name: p.name } : {}) }]
        : [],
    );
    const holding = projects.filter((p) => inside(cwd, p.root)).sort((a, b) => b.root.length - a.root.length)[0];
    const bootProject = typeof body.bootProject === 'string' ? body.bootProject : undefined;
    return {
      ...(holding ? { holding: { id: holding.id, root: holding.root } } : {}),
      ...(bootProject ? { bootProject } : {}),
      projects: projects.map(({ id, name }) => ({ id, ...(name ? { name } : {}) })),
    };
  } catch (error) {
    return { failed: isTimeout(error) ? `no answer within ${timeoutMs} ms` : (error as Error).message };
  }
}

/** The runtime records a running cockpit of this user may have published, in the order `serve`
 *  itself prefers them (index.ts): the named instance, else the default installed service, else
 *  the interactive cockpit. */
export async function inspectLocalCockpits(env: NodeJS.ProcessEnv = process.env): Promise<RuntimeInspection[]> {
  const slots: string[] = [];
  if (env.CEZ_INSTANCE_ID) slots.push(instanceCockpitSlot(env.CEZ_INSTANCE_ID));
  else {
    const service = listServerInstances().find((e) => e.instance === 'default' && e.state.installed && e.state.instanceId);
    if (service?.state.instanceId) slots.push(instanceCockpitSlot(service.state.instanceId));
    slots.push('interactive');
  }
  return Promise.all(slots.map((slot) => inspectCockpitRuntime(slot, { env }).catch((error: unknown) => ({ kind: 'unavailable' as const, reason: (error as Error).message }))));
}

/** Answers `/api/v1/health` like a cockpit (`version` + `capabilities`). */
async function looksLikeCockpit(fetchImpl: CezarFetch, url: string): Promise<boolean> {
  try {
    const res = await fetchImpl(`${url}/api/v1/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return false;
    const body = (await res.json()) as { version?: unknown; capabilities?: unknown };
    return typeof body.version === 'string' && Boolean(body.capabilities) && typeof body.capabilities === 'object';
  } catch {
    return false;
  }
}

/**
 * The cockpit's address with none given: the one its runtime record names and `/health` confirms
 * (one cockpit per user, #1739), else one look at `DEFAULT_COCKPIT_URL` for a cockpit too old to
 * publish a record. A live owner that cannot be verified is an error, never a reason to guess.
 */
export async function findCockpitUrl(fetchImpl: CezarFetch, inspect: () => Promise<RuntimeInspection[]>): Promise<string> {
  const records = await inspect();
  const verified = records.find((r) => r.kind === 'verified');
  if (verified?.kind === 'verified') return verified.runtime.origin.replace(/\/+$/, '');
  const stuck = records.find((r) => r.kind === 'unavailable');
  if (stuck?.kind === 'unavailable') {
    throw new NoCockpitError(
      `a cezar cockpit is running${stuck.runtime ? ` at ${stuck.runtime.origin}` : ''} but could not be verified (${stuck.reason}) — ` +
        'nothing was sent; pass --url (or set CEZ_API_URL) to name it, or try again once it answers',
    );
  }
  if (await looksLikeCockpit(fetchImpl, DEFAULT_COCKPIT_URL)) return DEFAULT_COCKPIT_URL;
  throw new NoCockpitError(
    `no running cezar cockpit found (no runtime record, nothing answering on ${DEFAULT_COCKPIT_URL}) — start one with \`npx cezar-run\` in your repo.\n` +
      missingCockpitMessage(MISSING, {}),
  );
}

const MISSING = {
  command: 'cez mcp',
  example: 'cez mcp --read-only',
  insideTask: 'the cockpit withheld its address from this task; pass --url only if you were told to, otherwise stop and report',
};

export interface CockpitResolverOptions {
  fetch: CezarFetch;
  cwd: string;
  explicitUrl?: string;
  projectId?: string;
  headers?: Record<string, string>;
  /** Inside a cezar task an absent `CEZ_API_URL` means the cockpit withheld it (cockpit-address.ts). */
  insideTask?: boolean;
  /** Per-request deadline; tests shorten it. */
  requestTimeoutMs?: number;
  /** Reads this user's cockpit runtime records (`inspectLocalCockpits`); tests inject it. */
  inspect?: () => Promise<RuntimeInspection[]>;
  /** Diagnostics (stderr): what a discovery had to do without. */
  warn?: (line: string) => void;
}

/**
 * The address, found once and kept until a request cannot reach it — then dropped, so the next
 * call discovers again instead of talking to a dead port forever. Concurrent first calls share one
 * discovery. An answer made without part of the picture (an unread registry) is used for that
 * call only, so a passing hiccup cannot pin the session to a guess.
 */
export function createCockpitResolver(options: CockpitResolverOptions): () => Promise<Cockpit> {
  let current: Promise<Cockpit> | undefined;
  const deadlineMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const fetchWithDeadline: CezarFetch = async (input, init) => {
    // The caller's signal (a wait's abort, a client cancel) never lifts the default deadline,
    // unless it is a deadline of its own (`longDeadline`).
    const caller = init?.signal;
    const signal = caller && hasOwnDeadline(caller) ? caller : AbortSignal.any([AbortSignal.timeout(deadlineMs), ...(caller ? [caller] : [])]);
    try {
      return await options.fetch(input, { ...init, signal });
    } catch (error) {
      if (isConnectionError(error)) current = undefined;
      throw error;
    }
  };
  const resolveOnce = async (): Promise<{ cockpit: Cockpit; keep: boolean }> => {
    let url = options.explicitUrl;
    if (!url && options.insideTask) throw new NoCockpitError(missingCockpitMessage(MISSING, { CEZ_TASK_ID: '1' }));
    url ??= await findCockpitUrl(options.fetch, options.inspect ?? (() => inspectLocalCockpits()));
    // The project holding the cwd, from the cockpit's registry — with --url too.
    const registry: Registry = options.projectId ? {} : await readRegistry(options.fetch, url, canonical(options.cwd), deadlineMs, options.headers);
    const target: DiscoveredCockpit = {
      url,
      ...(registry.holding ? { projectId: registry.holding.id } : {}),
      ...(registry.bootProject ? { bootProject: registry.bootProject } : {}),
      ...(!registry.holding && registry.projects ? { projects: registry.projects } : {}),
      ...(registry.failed ? { registryUnread: registry.failed } : {}),
    };
    const incomplete = registry.failed ? [`${url} did not list its projects (${registry.failed})`] : [];
    for (const line of incomplete) options.warn?.(`${line} — used ${url} for this call only, will look again on the next`);
    // Without the registry the project holding the cwd is unknown; with it, none may hold the cwd
    // (a cockpit on another machine, --url). Reads fall back to the boot project, start_task must
    // not guess — unless the cockpit serves that one project (as over HTTP).
    const unknown = !options.projectId && target.registryUnread;
    const only = target.projects?.length === 1 && target.projects[0]!.id === target.bootProject;
    const unheld = !options.projectId && !unknown && !target.projectId && !only;
    return {
      cockpit: {
        api: createApiClient({ baseUrl: url, fetch: fetchWithDeadline, ...(options.headers ? { headers: options.headers } : {}) }),
        // No project holds the cwd: reads use the boot project (start_task, see projectUnknown).
        defaultProjectId: options.projectId ?? target.projectId ?? target.bootProject ?? 'default',
        ...(unknown
          ? {
              projectUnknown: `could not read the project list of ${url} (${target.registryUnread}), so which project holds ${options.cwd} is unknown — pass projectId (list_projects), or try again`,
            }
          : unheld
            ? {
                projectUnknown: `no project of ${url} holds ${options.cwd}, and it serves ${describeProjectChoice(target.projects ?? [])} — pass projectId to say which one the task belongs to, or start cez mcp with --project <id> (or CEZ_PROJECT_ID)`,
              }
            : {}),
        ...(incomplete.length ? { warnings: incomplete.map((line) => `${line} — answered from ${url}`) } : {}),
      },
      keep: incomplete.length === 0,
    };
  };
  return () => {
    if (!current) {
      const pending = resolveOnce();
      const cockpit = pending.then((r) => r.cockpit);
      current = cockpit;
      // A failed or partial discovery is not cached: the next call tries again.
      const forget = () => {
        if (current === cockpit) current = undefined;
      };
      pending.then((r) => (r.keep ? undefined : forget()), forget);
    }
    return current;
  };
}

function readOwnVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Serve on this process's stdio (or the given streams), and leave once the client closes stdin —
 *  so a keep-alive socket to the cockpit can't hold an orphaned process open. */
export async function serveOnStdio(server: McpServer, streams?: StdioStreams): Promise<void> {
  const stop = serveStdio(server, streams ?? { stdin: process.stdin, stdout: process.stdout, onClose: () => process.exit(0) });
  if (!streams) {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
}

export async function runMcpCommand(
  args: string[],
  env: McpCliEnv = process.env,
  io: McpCliIo = { fetch, log: console.error, error: console.error, cwd: process.cwd(), serve: (server) => serveOnStdio(server) },
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        url: { type: 'string' },
        project: { type: 'string' },
        header: { type: 'string', multiple: true },
        'read-only': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (error) {
    io.error(`cez mcp: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    io.log(USAGE);
    return 0;
  }
  let headers: Record<string, string> | undefined;
  try {
    headers = values.header?.length ? Object.fromEntries(values.header.map(parseHeader)) : undefined;
  } catch (error) {
    io.error(`cez mcp: ${(error as Error).message}`);
    return 2;
  }
  if (values.url !== undefined && values.url.trim() === '') {
    io.error('cez mcp: --url is empty — pass a cockpit address, or leave --url out to find one');
    return 2;
  }
  // An empty CEZ_API_URL reads as unset, as everywhere else in cezar.
  const explicitUrl = (values.url ?? env.CEZ_API_URL)?.trim().replace(/\/+$/, '') || undefined;
  if (explicitUrl && !/^https?:\/\//.test(explicitUrl)) {
    io.error(`cez mcp: --url / CEZ_API_URL must be an http(s) URL, got "${explicitUrl}"`);
    return 2;
  }
  const projectId = values.project ?? env.CEZ_PROJECT_ID;
  const cockpit = createCockpitResolver({
    fetch: io.fetch,
    cwd: io.cwd,
    ...(explicitUrl ? { explicitUrl } : {}),
    ...(projectId ? { projectId } : {}),
    ...(headers ? { headers } : {}),
    insideTask: Boolean(env.CEZ_TASK_ID),
    ...(io.inspect ? { inspect: io.inspect } : {}),
    warn: (line) => io.error(`cez mcp: ${line}`),
  });
  const options = { cockpit, version: readOwnVersion(), readOnly: values['read-only'] };
  await io.serve(buildMcpServer(options));
  return 0;
}
