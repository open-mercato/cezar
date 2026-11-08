/**
 * `cez mcp` — an MCP server on stdio for agents that run OUTSIDE cezar (Claude Code, Codex,
 * OpenCode…), so they can list, start, follow and cancel runs of a running cockpit (#1109).
 *
 * It is a client of the cockpit's `/api/v1`, like `cez task`: run state lives only in the cockpit
 * process, so this never opens a store of its own. The cockpit is `--url`, else `CEZ_API_URL`,
 * else found by probing `GET /api/v1/health` on the ports the cockpit picks from (4321–4370).
 * Discovery is lazy and repeated after a connection error: the MCP handshake always succeeds,
 * a missing cockpit is a readable tool error, and a cockpit restarted on another port is found
 * again on the next call.
 *
 * stdout carries JSON-RPC and nothing else; every diagnostic goes to stderr.
 */
import { parseArgs } from 'node:util';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import type { McpServerFactory } from '@modelcontextprotocol/server';
import { createApiClient, hasOwnDeadline, isConnectionError, type CezarFetch } from './api.ts';
import { buildMcpServer, describeProjectChoice, type Cockpit, type ProjectChoice } from './tools.ts';

export const DEFAULT_PORTS = { first: 4321, last: 4370 } as const;
/** Same bound as `cez runs`: a stalled cockpit or proxy must not hang an agent's tool call. */
const REQUEST_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 800;
/** A second, longer chance for a port that accepted the connection but missed the first. */
const PROBE_RETRY_TIMEOUT_MS = 3_000;

const USAGE = `cez mcp — MCP server (stdio) for a running cezar cockpit

  cez mcp [--url <http://127.0.0.1:4321>] [--project <id>] [--header "Name: value"]… [--read-only]

  --url        cockpit to talk to (default: $CEZ_API_URL, else the cockpit found on 127.0.0.1:4321-4370)
  --project    default project for tools that take one (default: $CEZ_PROJECT_ID, else the project
               holding the current directory; reads then fall back to the cockpit's boot project,
               start_run asks for a projectId unless the cockpit serves a single project)
  --header     extra HTTP header for a cockpit behind a proxy (Basic auth, Cloudflare Access); repeatable
  --read-only  register only the read tools (no start_run, cancel_run, push_run_branch,
               send_run_message, review_run)

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
  serve: (factory: McpServerFactory) => Promise<void>;
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
  /** No registered project holds `cwd`: the ones `start_run` must choose from. */
  projects?: ProjectChoice[];
  /** This cockpit's project registry could not be read, and why. */
  registryUnread?: string;
  /** What the choice was made without — a port that stalled, a registry that failed. Such an
   *  answer is used once and not kept. */
  incomplete?: string[];
  /** Ports that accepted a connection but never answered `/health`: one of them may be the
   *  cockpit this cwd belongs to, so a write must not go anywhere else. */
  stalledPorts?: number[];
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
  /** The id and root of the project the cockpit was booted in, when the registry lists it. */
  bootProject?: string;
  bootRoot?: string;
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
    const bootRoot = projects.find((p) => p.id === bootProject)?.root;
    return {
      ...(holding ? { holding } : {}),
      ...(bootProject ? { bootProject } : {}),
      ...(bootRoot ? { bootRoot } : {}),
      projects: projects.map(({ id, name }) => ({ id, ...(name ? { name } : {}) })),
    };
  } catch (error) {
    return { failed: isTimeout(error) ? `no answer within ${timeoutMs} ms` : (error as Error).message };
  }
}

/**
 * Probe every port the cockpit may have picked, in parallel, and keep the ones answering like a
 * cockpit (`version` + `capabilities`). One cockpit is the answer. Cockpits on one machine share
 * the project registry (`~/.cezar`), so every one of them "has" the project holding `cwd`; what
 * tells them apart is where each was BOOTED. The cockpit booted deepest around `cwd` wins; a tie,
 * or several cockpits none of which was booted around `cwd`, is the user's choice (`--url`) —
 * guessing would send writes to whichever cockpit owns the lowest port (#1000).
 */
export async function discoverCockpit(fetchImpl: CezarFetch, cwd: string, headers?: Record<string, string>): Promise<DiscoveredCockpit> {
  type Probe = { url: string; repoRoot?: string } | 'stalled' | null;
  const probe = async (port: number, timeoutMs: number): Promise<Probe> => {
    const url = `http://127.0.0.1:${port}`;
    try {
      const res = await fetchImpl(`${url}/api/v1/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      const body = (await res.json()) as { version?: unknown; capabilities?: unknown; repoRoot?: unknown };
      if (typeof body.version !== 'string' || !body.capabilities || typeof body.capabilities !== 'object') return null;
      // Absolute in local mode only (a hosted cockpit trims it to a basename, #431).
      return { url, ...(typeof body.repoRoot === 'string' && isAbsolute(body.repoRoot) ? { repoRoot: body.repoRoot } : {}) };
    } catch (error) {
      // On loopback a closed port refuses at once; running out of time means something accepted
      // the connection and did not answer — a busy or stopped cockpit.
      return isTimeout(error) ? 'stalled' : null;
    }
  };
  const ports: number[] = [];
  for (let p = DEFAULT_PORTS.first; p <= DEFAULT_PORTS.last; p += 1) ports.push(p);
  const first = await Promise.all(ports.map((port) => probe(port, PROBE_TIMEOUT_MS)));
  // Only a port that stalled is asked again, with more time: the fast path pays nothing.
  const probes = await Promise.all(first.map((p, i) => (p === 'stalled' ? probe(ports[i]!, PROBE_RETRY_TIMEOUT_MS) : p)));
  const stalled = ports.filter((_, i) => probes[i] === 'stalled');
  const incomplete = stalled.map((port) => `127.0.0.1:${port} accepted a connection but did not answer /api/v1/health within ${PROBE_RETRY_TIMEOUT_MS} ms`);
  const live = probes.filter((p): p is { url: string; repoRoot?: string } => p !== null && p !== 'stalled');
  const found = live.map((p) => p.url);
  if (found.length === 0) {
    throw new NoCockpitError(
      stalled.length
        ? `no cezar cockpit answered on 127.0.0.1:${DEFAULT_PORTS.first}-${DEFAULT_PORTS.last}: ${incomplete.join('; ')} — is that cockpit stopped or overloaded? Pass --url / set CEZ_API_URL to name one`
        : `no cezar cockpit found on 127.0.0.1:${DEFAULT_PORTS.first}-${DEFAULT_PORTS.last} — start one with \`npx cezar-run\` in your repo, or pass --url / set CEZ_API_URL`,
    );
  }
  const here = canonical(cwd);
  const cockpits = await Promise.all(
    live.map(async ({ url, repoRoot }) => {
      const registry = await readRegistry(fetchImpl, url, here, PROBE_RETRY_TIMEOUT_MS, headers);
      if (registry.failed) incomplete.push(`${url} did not list its projects (${registry.failed})`);
      // A cockpit booted in an unregistered root (a task worktree) still names it on /health.
      return { url, ...registry, ...(registry.bootRoot || !repoRoot ? {} : { bootRoot: repoRoot }) };
    }),
  );
  const answer = (c: (typeof cockpits)[number]): DiscoveredCockpit => ({
    url: c.url,
    ...(c.holding ? { projectId: c.holding.id } : {}),
    ...(c.bootProject ? { bootProject: c.bootProject } : {}),
    ...(!c.holding && c.projects ? { projects: c.projects } : {}),
    ...(c.failed ? { registryUnread: c.failed } : {}),
    ...(incomplete.length ? { incomplete } : {}),
    ...(stalled.length ? { stalledPorts: stalled } : {}),
  });
  if (cockpits.length === 1) return answer(cockpits[0]!);
  const bootedAround = cockpits
    .filter((c) => c.bootRoot && inside(here, c.bootRoot))
    .sort((a, b) => b.bootRoot!.length - a.bootRoot!.length);
  const [best, next] = bootedAround;
  if (best && (!next || next.bootRoot!.length < best.bootRoot!.length)) return answer(best);
  // Cockpits with separate homes (CEZ_HOME) do not share a registry: then holding the cwd tells.
  const holders = cockpits.filter((c) => c.holding);
  if (!best && holders.length === 1) return answer(holders[0]!);
  const why = best
    ? `${bootedAround.filter((c) => c.bootRoot === best.bootRoot).map((c) => c.url).join(' and ')} were all started in ${best.bootRoot}`
    : `none was started in ${here} or a directory above it`;
  throw new NoCockpitError(`several cezar cockpits are running (${found.join(', ')}) and ${why} — pass --url or set CEZ_API_URL to choose one`);
}

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
  /** Diagnostics (stderr): what a discovery had to do without. */
  warn?: (line: string) => void;
}

/**
 * The address, found once and kept until a request cannot reach it — then dropped, so the next
 * call discovers again instead of talking to a dead port forever. Concurrent first calls share one
 * discovery. An answer made without part of the picture (a stalled port, an unread registry) is
 * used for that call only, so a passing hiccup cannot pin the session to a guess.
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
    let target: DiscoveredCockpit;
    if (options.explicitUrl) {
      // An explicit address still serves the project holding the cwd, like a discovered one.
      const registry: Registry = options.projectId
        ? {}
        : await readRegistry(options.fetch, options.explicitUrl, canonical(options.cwd), deadlineMs, options.headers);
      target = {
        url: options.explicitUrl,
        ...(registry.holding ? { projectId: registry.holding.id } : {}),
        ...(registry.bootProject ? { bootProject: registry.bootProject } : {}),
        ...(!registry.holding && registry.projects ? { projects: registry.projects } : {}),
        ...(registry.failed ? { registryUnread: registry.failed, incomplete: [`${options.explicitUrl} did not list its projects (${registry.failed})`] } : {}),
      };
    } else if (options.insideTask) {
      throw new NoCockpitError(
        'CEZ_API_URL is not set inside this cezar task, so the cockpit withheld its address — pass --url only if you were told to; otherwise stop and report',
      );
    } else target = await discoverCockpit(options.fetch, options.cwd, options.headers);
    const incomplete = target.incomplete ?? [];
    for (const line of incomplete) options.warn?.(`${line} — used ${target.url} for this call only, will look again on the next`);
    // Without the registry the project holding the cwd is unknown; with it, none may hold the cwd
    // (a cockpit on another machine, --url). Reads fall back to the boot project, start_run must
    // not guess — unless the cockpit serves that one project (as over HTTP).
    const unknown = !options.projectId && target.registryUnread;
    const only = target.projects?.length === 1 && target.projects[0]!.id === target.bootProject;
    const unheld = !options.projectId && !unknown && !target.projectId && !only;
    const stalled = target.stalledPorts ?? [];
    return {
      cockpit: {
        api: createApiClient({ baseUrl: target.url, fetch: fetchWithDeadline, ...(options.headers ? { headers: options.headers } : {}) }),
        // No project holds the cwd: reads use the boot project (start_run, see projectUnknown).
        defaultProjectId: options.projectId ?? target.projectId ?? target.bootProject ?? 'default',
        ...(unknown
          ? {
              projectUnknown: `could not read the project list of ${target.url} (${target.registryUnread}), so which project holds ${options.cwd} is unknown — pass projectId (list_projects), or try again`,
            }
          : unheld
            ? {
                projectUnknown: `no project of ${target.url} holds ${options.cwd}, and it serves ${describeProjectChoice(target.projects ?? [])} — pass projectId to say which one the run belongs to, or start cez mcp with --project <id> (or CEZ_PROJECT_ID)`,
              }
            : {}),
        ...(incomplete.length ? { warnings: incomplete.map((line) => `${line} — answered from ${target.url}`) } : {}),
        // A silent port may be the right cockpit: reads still answer from the one found, a write
        // would land in the wrong one.
        ...(stalled.length
          ? {
              writeRefused: `${stalled.map((p) => `127.0.0.1:${p}`).join(', ')} accepted a connection but did not answer /api/v1/health, so it is not certain ${target.url} is the cockpit for ${options.cwd} — nothing was sent; pass --url (or set CEZ_API_URL) to name the cockpit, or try again once ${stalled.length > 1 ? 'they answer' : 'it answers'}`,
            }
          : {}),
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

export interface StdioStreams {
  stdin: Readable;
  stdout: Writable;
  /** Called once the client has closed stdin (or on SIGINT/SIGTERM). Default: exit 0. */
  onClose: () => void;
}

/** Serve over stdio with the SDK's defaults, which answer both protocol eras: a 2025 client's
 *  `initialize` and a 2026-07-28 client's stateless opening. Never `legacy: 'reject'`. */
export async function serveOnStdio(factory: McpServerFactory, streams?: StdioStreams): Promise<void> {
  const { serveStdio, StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');
  const stdin = streams?.stdin ?? process.stdin;
  const onClose = streams?.onClose ?? (() => process.exit(0));
  const handle = serveStdio(factory, {
    ...(streams ? { transport: new StdioServerTransport(streams.stdin, streams.stdout) } : {}),
    onerror: (error) => console.error(`cez mcp: ${error.message}`),
  });
  // The transport closes itself when the client closes our stdin; leave then, so a keep-alive
  // socket to the cockpit can't hold an orphaned process open.
  let left = false;
  const leave = () => {
    if (left) return;
    left = true;
    void handle.close().finally(onClose);
  };
  stdin.once('end', leave);
  stdin.once('close', leave);
  if (!streams) {
    process.once('SIGINT', leave);
    process.once('SIGTERM', leave);
  }
}

export async function runMcpCommand(
  args: string[],
  env: McpCliEnv = process.env,
  io: McpCliIo = { fetch, log: console.error, error: console.error, cwd: process.cwd(), serve: (factory) => serveOnStdio(factory) },
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
    warn: (line) => io.error(`cez mcp: ${line}`),
  });
  const options = { cockpit, version: readOwnVersion(), readOnly: values['read-only'] };
  await io.serve(() => buildMcpServer(options));
  return 0;
}
