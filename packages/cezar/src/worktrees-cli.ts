/**
 * `cez worktrees …` — list and reclaim task worktrees from a shell, for SSH-only installs
 * (spec `.ai/specs/2026-11-19-worktree-disk-usage.md`, decision 4).
 *
 * When a running cockpit serves the project, every command goes through its API, so its live
 * manager decides what is active. Otherwise the command opens the project's run store directly:
 * index writes merge under the store's own lock, and with no manager, `running`/`queued` and a
 * `waiting` run with a parked session count as live by status.
 */
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { z } from 'zod';
import {
  projectsResponseSchema,
  deleteExpiredArchivedResponseSchema,
  pruneWorktreesResponseSchema,
  type DeleteExpiredArchivedResponse,
  reclaimWorktreesResponseSchema,
  worktreeInfoSchema,
  worktreesResponseSchema,
  type ReclaimWorktreesInput,
  type WorktreeInfo,
  type WorktreesResponse,
} from '@open-mercato/cezar-contract';
import { resolveWorktreeIdleDays, resolveWorktreeRetention } from './config.ts';
import { pruneOrphans, worktreeHasUnpreservedWork, worktreeSizeBytes } from './git-worktree.ts';
import { deleteExpiredArchivedTasks } from './runs/archived-cleanup.ts';
import {
  configuredReclaimCandidates,
  enforceWorktreeRetention,
  isIdleReclaimable,
  reclaimSelectedWorktrees,
  selectManualReclaim,
  storeActivity,
  worktreesInUse,
  type IdleReclaimOptions,
} from './runs/retention.ts';
import { isIdleParked, RunStore, type RunRecord } from './runs/store.ts';
import { cockpitRuntimeRoot, inspectCockpitRuntime } from './runtime/cockpit-runtime.ts';
import { readLifecycleConfigOrDefault } from './worktree-lifecycle/config.ts';
import type { WorktreeHolder } from './worktree-in-use.ts';

const execFileAsync = promisify(execFile);

export interface WorktreesCliIo {
  fetch: typeof fetch;
  log: (line: string) => void;
  error: (line: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Origins of the verified running cockpits, plus why any live one could not be verified.
   *  Defaults to the runtime records under `~/.cezar/runtime/cockpits`; injectable for tests. */
  cockpits?: () => Promise<CockpitScan>;
  now?: () => number;
  /** What runs from which path (offline in-use probe); injectable for tests. */
  holders?: () => Promise<readonly WorktreeHolder[]>;
}

export interface CockpitScan {
  origins: string[];
  unverified: string[];
}

const READ_TIMEOUT_MS = 10_000;
/** A reclaim removes trees one `git worktree remove` at a time; give a big backlog room. */
const WRITE_TIMEOUT_MS = 10 * 60_000;

const USAGE = `cez worktrees — task worktrees on disk (uses the running cockpit when one serves the project)

  cez worktrees list [--json]          every task worktree: run, status, last activity, size, reclaimable
  cez worktrees reclaim [--older-than 7d] [--all-inactive] [--dry-run]
                                       remove inactive trees (branch kept, Continue restores them);
                                       no selector = the configured retention; --older-than takes d or h
  cez worktrees prune [--archived-older-than 90d] [--dry-run]
                                       remove orphan tree directories and run \`git worktree prune\`;
                                       with --archived-older-than, also delete tasks archived that
                                       long (a branch with unmerged or unpushed work, or an open PR, is kept)
  cez worktrees remove <runId>         reclaim one task's tree (id or id prefix); refuses active tasks

  --project <path>                     the project (default: the repository of the current directory)`;

class CliError extends Error {
  constructor(message: string, readonly code = 1) { super(message); }
}

/** One project, reached either through a cockpit or straight off disk. */
interface Backend {
  mode: 'cockpit' | 'offline';
  list(): Promise<WorktreesResponse>;
  reclaim(request: ReclaimWorktreesInput): Promise<string[]>;
  prune(): Promise<string[]>;
  /** Delete archived tasks past `olderThanDays` (or report them, on a dry run). */
  deleteArchived(olderThanDays: number, dryRun: boolean): Promise<DeleteExpiredArchivedResponse>;
  /** Run records for `remove` (id prefix lookup and the refusal reasons). */
  runs(): Promise<RunRecord[]>;
  /** Offline only: liveness by status. A cockpit answers through `reclaimable`. */
  isLive?(run: RunRecord): boolean;
  close(): void;
}

export async function runWorktreesCommand(args: string[], io: WorktreesCliIo): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    io.log(USAGE);
    return command ? 0 : 2;
  }
  if (!['list', 'reclaim', 'prune', 'remove'].includes(command)) {
    io.error(`cez worktrees: unknown command "${command}"\n\n${USAGE}`);
    return 2;
  }
  let backend: Backend | undefined;
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        project: { type: 'string' },
        json: { type: 'boolean', default: false },
        'older-than': { type: 'string' },
        'all-inactive': { type: 'boolean', default: false },
        'archived-older-than': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help) {
      io.log(USAGE);
      return 0;
    }
    if (command !== 'remove' && positionals.length > 0) throw new CliError(`unexpected argument "${positionals[0]}"`, 2);
    const root = await projectRoot(values.project, io.cwd);
    const mutates = command !== 'list' && !((command === 'reclaim' || command === 'prune') && values['dry-run']);
    backend = await openBackend(root, io, mutates, values.project !== undefined);
    switch (command) {
      case 'list':
        return await listCommand(backend, values.json, io);
      case 'reclaim':
        return await reclaimCommand(backend, {
          olderThan: values['older-than'],
          allInactive: values['all-inactive'],
          dryRun: values['dry-run'],
        }, io);
      case 'prune': {
        const archivedDays = values['archived-older-than'] === undefined ? undefined : parseOlderThan(values['archived-older-than'], '--archived-older-than');
        // 0 means "never" in the setting; as a flag it would silently select nothing.
        if (archivedDays !== undefined && archivedDays <= 0) throw new CliError('--archived-older-than must be more than 0 (e.g. 90d)', 2);
        if (values['dry-run']) {
          if (archivedDays === undefined) throw new CliError('--dry-run on prune previews --archived-older-than; orphan removal has no dry run', 2);
          io.log('dry run — orphan worktrees are not checked');
        } else {
          const removed = await backend.prune();
          io.log(removed.length
            ? `removed ${removed.length} orphan worktree${plural(removed.length)}: ${removed.map((id) => id.slice(0, 8)).join(', ')}`
            : 'no orphan worktrees (git worktree prune ran)');
        }
        if (archivedDays !== undefined) reportArchived(await backend.deleteArchived(archivedDays, values['dry-run']), io);
        return 0;
      }
      default:
        if (positionals.length !== 1) throw new CliError('give one task id, e.g. cez worktrees remove 1a2b3c4d', 2);
        return await removeCommand(backend, positionals[0]!, io);
    }
  } catch (error) {
    io.error(`cez worktrees: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof CliError ? error.code : 1;
  } finally {
    backend?.close();
  }
}

// ---- project and backend resolution ----

/** `--project`, else the MAIN checkout of the current directory's repo (a task worktree's own
 *  toplevel is not the project), else the directory itself. Realpath, like the registry's roots. */
async function projectRoot(explicit: string | undefined, cwd: string): Promise<string> {
  const dir = resolve(cwd, explicit ?? '.');
  if (!existsSync(dir)) throw new CliError(`no such directory: ${dir}`, 2);
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir });
    const common = stdout.trim();
    const top = basename(common) === '.git' ? dirname(common) : (await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: dir })).stdout.trim();
    return realpathSync(top);
  } catch {
    return realpathSync(dir);
  }
}

async function openBackend(root: string, io: WorktreesCliIo, mutates: boolean, explicitProject: boolean): Promise<Backend> {
  const scan = await (io.cockpits ?? (() => scanCockpits(io)))();
  const origins = [...new Set([io.env.CEZ_API_URL?.replace(/\/+$/, ''), ...scan.origins].filter((o): o is string => !!o))];
  const unreachable = [...scan.unverified];
  for (const origin of origins) {
    const scope = await servedScope(origin, root, io, explicitProject);
    if (scope && scope !== 'unreachable') return cockpitBackend(scope.url, io);
    // A verified cockpit whose project list failed may well serve this project.
    if (scope === 'unreachable' && scan.origins.includes(origin)) unreachable.push(`${origin}: its project list did not answer`);
  }
  // A cockpit that is alive but did not answer may own this store: writing behind it is unsafe.
  if (mutates && unreachable.length > 0) {
    throw new CliError(`a cezar cockpit is running but could not be reached (${unreachable.join('; ')}), `
      + 'so it may own this project. Retry, or stop it and run the command again.');
  }
  return offlineBackend(root, io);
}

async function scanCockpits(io: WorktreesCliIo): Promise<CockpitScan> {
  const scan: CockpitScan = { origins: [], unverified: [] };
  let slots: string[];
  try {
    slots = await readdir(cockpitRuntimeRoot(io.env));
  } catch {
    return scan;
  }
  for (const slot of slots) {
    const found = await inspectCockpitRuntime(slot, { env: io.env, fetcher: io.fetch }).catch(() => null);
    if (found?.kind === 'verified') scan.origins.push(found.runtime.origin);
    else if (found?.kind === 'unavailable') scan.unverified.push(`${found.runtime ? `pid ${found.runtime.owner.pid}: ` : ''}${found.reason}`);
  }
  return scan;
}

/**
 * `{ url: <origin>/api/v1/p/<id> }` when that cockpit serves `root`, null when it answered and does
 * not, 'unreachable' when its project list failed. `CEZ_PROJECT_ID` wins for its own cockpit,
 * unless `--project` named a repo explicitly.
 */
async function servedScope(origin: string, root: string, io: WorktreesCliIo, explicitProject: boolean): Promise<{ url: string } | 'unreachable' | null> {
  if (!explicitProject && io.env.CEZ_PROJECT_ID && origin === io.env.CEZ_API_URL?.replace(/\/+$/, '')) {
    return { url: `${origin}/api/v1/p/${encodeURIComponent(io.env.CEZ_PROJECT_ID)}` };
  }
  try {
    const response = await io.fetch(`${origin}/api/v1/projects`, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (!response.ok) return 'unreachable';
    const parsed = projectsResponseSchema.safeParse(await response.json());
    if (!parsed.success) return 'unreachable';
    const project = parsed.data.projects.find((p) => p.status !== 'missing' && samePath(p.root, root));
    return project ? { url: `${origin}/api/v1/p/${encodeURIComponent(project.id)}` } : null;
  } catch {
    return 'unreachable';
  }
}

function samePath(a: string, b: string): boolean {
  try { return realpathSync(a) === b; } catch { return a === b; }
}

/** A cockpit older or newer than this CLI still lists: an unknown status passes through, and one
 *  from before age retention has no `lastActivityAt`/`idleDays`. */
const cockpitWorktreesSchema = worktreesResponseSchema.extend({
  worktrees: z.array(worktreeInfoSchema.extend({ status: z.string(), lastActivityAt: z.string().optional() })),
  idleDays: z.number().optional(),
}).transform((data): WorktreesResponse & { legacy: boolean } => ({
  ...data,
  idleDays: data.idleDays ?? 0,
  legacy: data.idleDays === undefined,
  worktrees: data.worktrees.map((w) => ({
    ...w,
    status: w.status as WorktreeInfo['status'],
    lastActivityAt: w.lastActivityAt ?? w.finishedAt ?? '',
  })),
}));

function cockpitBackend(scope: string, io: WorktreesCliIo): Backend {
  async function call<T>(path: string, schema: z.ZodType<T, unknown>, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await io.fetch(`${scope}${path}`, {
        ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(body === undefined ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') throw new Error(`the cockpit did not answer ${path} in time`);
      throw error;
    }
    if (!response.ok) throw new Error(`the cockpit refused ${path} — ${await readError(response)}`);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new Error(`the cockpit answered ${path} in a shape this CLI does not recognize`);
    return parsed.data;
  }
  let legacy: boolean | undefined;
  const list = async () => {
    const { legacy: old, ...data } = await call('/worktrees', cockpitWorktreesSchema);
    legacy = old;
    return data;
  };
  return {
    mode: 'cockpit',
    list,
    async reclaim(request) {
      // A cockpit from before age retention ignores these keys and would run its own retention.
      if (Object.keys(request).length > 0 && (legacy ?? (await list(), legacy))) {
        throw new CliError('the running cockpit is older than this CLI and cannot reclaim selectively or dry-run — update it, or run plain `cez worktrees reclaim`');
      }
      return (await call('/worktrees/reclaim', reclaimWorktreesResponseSchema, request)).reclaimed;
    },
    prune: async () => (await call('/worktrees/prune', pruneWorktreesResponseSchema, {})).removed,
    deleteArchived: (olderThanDays, dryRun) =>
      call('/runs/archived/delete-expired', deleteExpiredArchivedResponseSchema, { olderThanDays, dryRun }),
    runs: async () => (await call('/runs', z.array(z.object({ id: z.string(), status: z.string() }).passthrough()))) as unknown as RunRecord[],
    close: () => undefined,
  };
}

function offlineBackend(root: string, io: WorktreesCliIo): Backend {
  const dataDir = join(root, '.ai', 'cezar');
  const hasIndex = existsSync(join(dataDir, 'runs.json'));
  // keepLive: a one-shot reader must not rewrite another process's live-looking runs as failed.
  const store = hasIndex ? RunStore.open(dataDir, { keepLive: true }) : undefined;
  let dirty = false;
  const now = () => (io.now ?? Date.now)();
  const isLive = (run: RunRecord) =>
    run.status === 'running' || run.status === 'queued' || (run.status === 'waiting' && !isIdleParked(run));
  const liveById = (id: string) => {
    const run = store?.getRun(id);
    return !!run && isLive(run);
  };
  // Lifecycle hooks (beforeRemove/afterCreate) run only inside a cockpit; never bypass them here.
  const hooked = async () => {
    const snapshot = await readLifecycleConfigOrDefault(root).catch(() => null);
    return !snapshot || snapshot.config.afterCreate.length > 0 || snapshot.config.beforeRemove.length > 0;
  };
  const writable = async (): Promise<RunStore> => {
    if (!store) throw new CliError(`${root} has no cezar task index (.ai/cezar/runs.json)`);
    if (await hooked()) {
      throw new CliError('this project has worktree lifecycle hooks, which only a running cockpit can run — start `cez` and retry');
    }
    return store;
  };
  const opts = (): IdleReclaimOptions => ({
    isLive: liveById,
    nowMs: now,
    ...(io.holders ? { holders: io.holders } : {}),
  });

  return {
    mode: 'offline',
    isLive,
    async list() {
      const keep = await resolveWorktreeRetention(root);
      const idleDays = await resolveWorktreeIdleDays(root);
      if (!store) return { worktrees: [], totalBytes: 0, keep, idleDays };
      const activity = storeActivity(store);
      const runs = store.listRuns().filter((r) => r.worktreePath && existsSync(r.worktreePath));
      const inUse = await worktreesInUse(runs, io.holders);
      const worktrees: WorktreeInfo[] = await Promise.all(runs.map(async (r) => ({
        runId: r.id,
        title: r.title ?? r.id,
        status: r.status,
        branch: r.branch ?? null,
        sizeBytes: await worktreeSizeBytes(r.worktreePath!),
        finishedAt: r.finishedAt ?? null,
        lastActivityAt: activity(r),
        reclaimable: isIdleReclaimable(r) && !isLive(r) && !inUse.has(r.id),
        ...(inUse.has(r.id) ? { inUse: inUse.get(r.id)! } : {}),
      })));
      const totalBytes = worktrees.some((w) => w.sizeBytes === null) ? null : worktrees.reduce((sum, w) => sum + (w.sizeBytes ?? 0), 0);
      return { worktrees, totalBytes, keep, idleDays };
    },
    async reclaim(request) {
      if (!store) return [];
      const targets = selectManualReclaim(store.listRuns(), request, liveById, storeActivity(store), now());
      if (request.dryRun) {
        const candidates = targets ?? await configuredReclaimCandidates(root, store, liveById, now());
        const runs = store.listRuns().filter((r) => candidates.includes(r.id));
        const inUse = await worktreesInUse(runs, io.holders);
        // As the server's preview: the real pass keeps a tree with uncommitted work (#2215).
        const dirty = new Set<string>();
        for (const run of runs) if (run.worktreePath && await worktreeHasUnpreservedWork(run.worktreePath)) dirty.add(run.id);
        return candidates.filter((id) => !inUse.has(id) && !dirty.has(id));
      }
      const writeStore = await writable();
      const reclaimed = targets === null
        ? await enforceWorktreeRetention(root, writeStore, opts())
        : await reclaimSelectedWorktrees(root, writeStore, targets, opts());
      dirty ||= reclaimed.length > 0;
      return reclaimed;
    },
    async prune() {
      const writeStore = await writable();
      // An index this build could not read in full would make its unread runs' trees look orphaned.
      const health = writeStore.getIndexReadHealth();
      if (health.state !== 'complete' || health.omittedRuns > 0) {
        throw new CliError('the task index could not be read in full, so orphans cannot be told apart — start `cez` instead');
      }
      return pruneOrphans(root, new Set(writeStore.listRuns().map((r) => r.id)));
    },
    async deleteArchived(olderThanDays, dryRun) {
      const empty = { deleted: [], keptBranches: [], skipped: [], days: olderThanDays, dryRun };
      if (!store) return empty;
      const target = dryRun ? store : await writable();
      const result = await deleteExpiredArchivedTasks(root, target, olderThanDays, {
        isLive: liveById, dryRun, now: now(), activity: storeActivity(store),
      });
      dirty ||= !dryRun && result.deleted.length > 0;
      return { ...result, days: olderThanDays, dryRun };
    },
    async runs() {
      return store?.listRuns() ?? [];
    },
    close() {
      if (dirty) store?.flush();
    },
  };
}

function reportArchived(result: DeleteExpiredArchivedResponse, io: WorktreesCliIo): void {
  const verb = result.dryRun ? 'would delete' : 'deleted';
  io.log(result.deleted.length
    ? `${verb} ${result.deleted.length} task${plural(result.deleted.length)} archived over ${result.days}d: ${result.deleted.map((id) => id.slice(0, 8)).join(', ')}`
    : `no task archived over ${result.days}d`);
  for (const kept of result.keptBranches) io.log(`  branch ${kept.branch} kept — ${kept.reason}`);
  for (const skip of result.skipped) io.log(`  ${skip.runId.slice(0, 8)} left in place — ${skip.reason}`);
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch { /* not JSON */ }
  return `${response.status} ${response.statusText}`;
}

// ---- commands ----

async function listCommand(backend: Backend, json: boolean, io: WorktreesCliIo): Promise<number> {
  const data = await backend.list();
  if (json) {
    io.log(JSON.stringify(data, null, 2));
    return 0;
  }
  const now = (io.now ?? Date.now)();
  const rows = [...data.worktrees].sort((a, b) => a.lastActivityAt.localeCompare(b.lastActivityAt));
  if (rows.length === 0) {
    io.log(`no task worktrees on disk${footerSettings(data)}`);
    return 0;
  }
  const table = [
    ['RUN', 'STATUS', 'LAST ACTIVITY', 'SIZE', 'RECLAIMABLE', 'TITLE'],
    ...rows.map((w) => [
      w.runId.slice(0, 8),
      w.status,
      ago(w.lastActivityAt, now),
      w.sizeBytes === null ? '?' : formatBytes(w.sizeBytes),
      w.inUse ? `no (in use: ${w.inUse})` : w.reclaimable ? 'yes' : 'no',
      truncate(w.title, 60),
    ]),
  ];
  const widths = table[0]!.map((_, col) => Math.max(...table.map((row) => row[col]!.length)));
  for (const row of table) io.log(row.map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col]!))).join('  '));
  const reclaimable = rows.filter((w) => w.reclaimable);
  const reclaimableBytes = reclaimable.some((w) => w.sizeBytes === null) ? null : reclaimable.reduce((s, w) => s + (w.sizeBytes ?? 0), 0);
  io.log('');
  io.log(`${rows.length} worktree${plural(rows.length)}, ${data.totalBytes === null ? 'size unknown' : `${formatBytes(data.totalBytes)} total`}`
    + ` · ${reclaimable.length} reclaimable${reclaimableBytes ? ` (${formatBytes(reclaimableBytes)})` : ''}${footerSettings(data)}`
    + (backend.mode === 'offline' ? ' · no cockpit running (read from disk)' : ''));
  return 0;
}

function footerSettings(data: WorktreesResponse): string {
  return ` · age retention ${data.idleDays ? `${data.idleDays}d` : 'off'} · keep ${data.keep || 'unlimited'} finished`;
}

/** `7d`, `36h`, or a bare number of days → days. */
export function parseOlderThan(value: string, flag = '--older-than'): number {
  const match = /^(\d+(?:\.\d+)?)([dh]?)$/i.exec(value.trim());
  if (!match) throw new CliError(`${flag} wants a duration like 7d or 12h, not "${value}"`, 2);
  const days = Number(match[1]) / (match[2]?.toLowerCase() === 'h' ? 24 : 1);
  if (days > 3650) throw new CliError(`${flag} is capped at 3650d`, 2);
  return days;
}

async function reclaimCommand(
  backend: Backend,
  flags: { olderThan?: string; allInactive: boolean; dryRun: boolean },
  io: WorktreesCliIo,
): Promise<number> {
  if (flags.olderThan !== undefined && flags.allInactive) throw new CliError('use --older-than or --all-inactive, not both', 2);
  const request: ReclaimWorktreesInput = {
    ...(flags.olderThan !== undefined ? { olderThanDays: parseOlderThan(flags.olderThan) } : {}),
    ...(flags.allInactive ? { allInactive: true } : {}),
    ...(flags.dryRun ? { dryRun: true } : {}),
  };
  const before = await backend.list();
  const ids = await backend.reclaim(request);
  const byId = new Map(before.worktrees.map((w) => [w.runId, w]));
  const what = flags.olderThan !== undefined ? `inactive for over ${flags.olderThan}`
    : flags.allInactive ? 'inactive' : 'over the configured retention';
  if (ids.length === 0) {
    io.log(`nothing to reclaim (no worktree ${what})`);
    return 0;
  }
  const bytes = ids.reduce((sum, id) => sum + (byId.get(id)?.sizeBytes ?? 0), 0);
  io.log(`${flags.dryRun ? 'would reclaim' : 'reclaimed'} ${ids.length} worktree${plural(ids.length)} ${what}, ${formatBytes(bytes)}`
    + `${flags.dryRun ? ' (dry run: nothing was removed)' : ''} — branches kept, Continue restores a tree:`);
  for (const id of ids) {
    const w = byId.get(id);
    io.log(`  ${id.slice(0, 8)}  ${w ? `${w.status}  ${w.sizeBytes === null ? '?' : formatBytes(w.sizeBytes)}  ${truncate(w.title, 60)}` : ''}`.trimEnd());
  }
  return 0;
}

async function removeCommand(backend: Backend, prefix: string, io: WorktreesCliIo): Promise<number> {
  const matches = (await backend.runs()).filter((run) => run.id.startsWith(prefix));
  if (matches.length === 0) throw new CliError(`no task matches "${prefix}"`);
  if (matches.length > 1) throw new CliError(`"${prefix}" matches ${matches.length} tasks (${matches.map((r) => r.id.slice(0, 8)).join(', ')}) — give more of the id`);
  const run = matches[0]!;
  const id8 = run.id.slice(0, 8);
  const refusal = removeRefusal(run, backend.isLive);
  if (refusal) throw new CliError(`refusing to remove ${id8}'s worktree: ${refusal}`);
  const row = (await backend.list()).worktrees.find((w) => w.runId === run.id);
  if (!row) {
    io.log(`${id8} has no worktree on disk${run.worktreeReclaimedAt ? ' (already reclaimed)' : ''} — nothing to do`);
    return 0;
  }
  if (!row.reclaimable) {
    throw new CliError(`refusing to remove ${id8}'s worktree: ${row.inUse ? `a running process uses it (${row.inUse})` : 'the cockpit holds it live (an open or parked session)'}`);
  }
  const reclaimed = await backend.reclaim({ runIds: [run.id] });
  if (!reclaimed.includes(run.id)) {
    throw new CliError(`${id8}'s worktree was kept: it has uncommitted changes (commit or discard them first), or a process started using it`);
  }
  io.log(`removed ${id8}'s worktree (${row.sizeBytes === null ? 'size unknown' : formatBytes(row.sizeBytes)}); branch ${row.branch ?? 'kept'} stays, Continue restores it`);
  return 0;
}

/** Why `remove` must not touch this run, or null. Mirrors `isIdleReclaimable`, in words. */
function removeRefusal(run: RunRecord, isLive?: (run: RunRecord) => boolean): string | null {
  if (run.status === 'running' || run.status === 'queued') return `the task is ${run.status} — cancel it first`;
  if (isLive?.(run)) return 'the task is waiting with a parked session — close or finish it first';
  if (run.pinned) return 'the task is pinned — unpin it first';
  if (run.autoResumeAt) return 'the task is scheduled to resume after a usage limit';
  if (run.monitoringWakeAt) return 'the task is monitoring and will wake again';
  return null;
}

// ---- formatting ----

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

function truncate(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function ago(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return '?';
  if (ms < 60 * 60_000) return `${Math.max(0, Math.round(ms / 60_000))}m ago`;
  if (ms < 48 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}
