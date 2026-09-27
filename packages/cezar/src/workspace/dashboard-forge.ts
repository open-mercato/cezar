import type { DashboardFeedSource, DashboardForgeCreated } from '@open-mercato/cezar-contract';
import { getRepoInfo, isNonRepositoryDirectory } from '../server/git.ts';
import { parseRemote, resolveForge } from '../server/forge/index.ts';
import type { ForgeDriver, ForgeRecentCreatedData } from '../server/forge/types.ts';

const KINDS = ['issue', 'pr'] as const;
type Kind = (typeof KINDS)[number];
const WEEK = 7 * 24 * 60 * 60_000;
const TTL = 60_000;
interface CachedKind {
  attemptedAt: number;
  fetchedAt?: number;
  items: ForgeRecentCreatedData['items'];
  truncated: boolean;
  reason?: string;
}
interface Repository {
  key: string;
  date: string;
  roots: Set<string>;
  kinds: Partial<Record<Kind, CachedKind>>;
}
interface Reader {
  aborted: boolean;
}
interface Job {
  key: string;
  entry: Repository;
  driver: ForgeDriver;
  readers: Set<Reader>;
  now: number;
  done: Promise<void>;
  finish: () => void;
}
// Only demanded work enters this queue. No timer outlives a response, and no periodic fetch.
const cache = new Map<string, Repository>();
const jobs = new Map<string, Job>();
const queue: Job[] = [];
let active = 0;

function pump(): void {
  while (active < 2 && queue.length) {
    const job = queue.shift()!;
    if (![...job.readers].some((reader) => !reader.aborted)) {
      jobs.delete(job.key);
      job.finish();
      continue;
    }
    active++;
    void runJob(job).finally(() => {
      active--;
      jobs.delete(job.key);
      job.finish();
      pump();
    });
  }
}

async function runJob(job: Job): Promise<void> {
  for (const kind of KINDS) {
    if (![...job.readers].some((reader) => !reader.aborted)) break;
    const previous = job.entry.kinds[kind];
    if (previous && job.now - previous.attemptedAt < TTL) continue;
    let result: ForgeRecentCreatedData;
    try {
      result = await job.driver.recentCreated!(kind, job.entry.date);
    } catch {
      result = { available: false, items: [], reason: 'Could not refresh GitHub' };
    }
    const at = Date.now();
    job.entry.kinds[kind] = result.available
      ? {
          attemptedAt: at,
          fetchedAt: at,
          items: result.items,
          truncated: result.truncated ?? false,
        }
      : {
          attemptedAt: at,
          items: previous?.items ?? [],
          truncated: previous?.truncated ?? false,
          ...(previous?.fetchedAt !== undefined ? { fetchedAt: previous.fetchedAt } : {}),
          reason: result.reason ?? 'GitHub unavailable',
        };
  }
}

function demand(
  entry: Repository,
  driver: ForgeDriver,
  reader: Reader,
  now: number,
): Promise<void> {
  if (KINDS.every((kind) => entry.kinds[kind] && now - entry.kinds[kind]!.attemptedAt < TTL))
    return Promise.resolve();
  const key = `${entry.key}:${entry.date}`;
  const pending = jobs.get(key);
  if (pending) {
    pending.readers.add(reader);
    return pending.done;
  }
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const job: Job = { key, entry, driver, readers: new Set([reader]), now, done, finish };
  jobs.set(key, job);
  queue.push(job);
  pump();
  return done;
}

/** Workspace-wide creation feed. The caller supplies the complete visible project registry;
 * removing a project evicts cache entries with no remaining root. A deadline returns partial
 * coverage while already demanded jobs can complete and warm the shared cache. */
export async function getDashboardGithub(
  projects: { id: string; root: string }[],
  now: number,
  signal?: AbortSignal,
): Promise<{ rows: DashboardForgeCreated[]; sources: DashboardFeedSource[] }> {
  const roots = new Set(projects.map((project) => project.root));
  for (const [key, entry] of cache) {
    entry.roots = new Set([...entry.roots].filter((root) => roots.has(root)));
    if (!entry.roots.size) cache.delete(key);
  }
  const reader: Reader = { aborted: signal?.aborted ?? false };
  const date = new Date(now - WEEK).toISOString().slice(0, 10);
  const resolved = new Map<string, { entry: Repository; projectIds: string[]; reason?: string }>();
  const unresolved = new Map(projects.map((project) => [project.id, 'Still loading GitHub']));
  const pendingProjects = new Set(projects.map((project) => project.id));
  const waits: Promise<void>[] = [];
  // Root associations live only in the bounded repository cache. A successful probe
  // replaces its old association; a failed probe may reuse only that last identity.
  function detachRoot(root: string, keepKey?: string): void {
    for (const [key, entry] of cache) {
      if (key === keepKey) continue;
      entry.roots.delete(root);
      if (!entry.roots.size) cache.delete(key);
    }
  }
  function readFailed(
    project: { id: string; root: string },
    reason = 'Could not read GitHub repository',
  ): void {
    const entry = [...cache.values()].find((candidate) => candidate.roots.has(project.root));
    if (!entry) {
      unresolved.set(project.id, reason);
      return;
    }
    const existing = resolved.get(entry.key);
    if (existing) {
      existing.projectIds.push(project.id);
      // Another project sharing this repo may already have confirmed it successfully this
      // round (existing.reason unset). A sibling project's transient failure must not
      // poison that success and hide otherwise-available data.
      if (existing.reason !== undefined) existing.reason = reason;
    } else resolved.set(entry.key, { entry, projectIds: [project.id], reason });
    unresolved.delete(project.id);
  }
  let cursor = 0;
  async function resolveProjects(): Promise<void> {
    while (cursor < projects.length && !reader.aborted) {
      const project = projects[cursor++]!;
      try {
        const info = await getRepoInfo(project.root, { requireRemoteRead: true, allowUnborn: true });
        if (reader.aborted) return;
        if (!info) {
          const noRepository = await isNonRepositoryDirectory(project.root);
          if (reader.aborted) return;
          if (noRepository) {
            detachRoot(project.root);
            unresolved.set(project.id, 'No GitHub remote');
          } else readFailed(project);
          continue;
        }
        const remote = info.remote ? parseRemote(info.remote) : null;
        // Gate on the same host allowlist every other forge call site uses (resolveForge):
        // a remote that merely parses (e.g. a GitLab or self-hosted host) is not GitHub.
        const driver = remote ? resolveForge(info) : null;
        if (!remote || !driver?.recentCreated) {
          detachRoot(project.root);
          unresolved.set(project.id, 'No GitHub remote');
          continue;
        }
        const key = `${remote.host}/${remote.owner}/${remote.repo}`.toLowerCase();
        detachRoot(project.root, key);
        let entry = cache.get(key);
        if (!entry || entry.date !== date) {
          entry = {
            key,
            date,
            roots: new Set(entry?.roots),
            kinds: entry
              ? Object.fromEntries(
                  KINDS.flatMap((kind) =>
                    entry!.kinds[kind]
                      ? [[kind, { ...entry!.kinds[kind], attemptedAt: -Infinity }]]
                      : [],
                  ),
                )
              : {},
          };
        }
        entry.roots.add(project.root);
        cache.delete(key);
        cache.set(key, entry);
        while (cache.size > 100) cache.delete(cache.keys().next().value!);
        const existing = resolved.get(key);
        if (existing) {
          existing.projectIds.push(project.id);
          // A sibling project's earlier transient failure (processed first by the other
          // concurrent worker) must not keep poisoning this entry once this project confirms
          // the repo successfully.
          delete existing.reason;
        } else resolved.set(key, { entry, projectIds: [project.id] });
        unresolved.delete(project.id);
        waits.push(demand(entry, driver, reader, now));
      } catch {
        if (!reader.aborted) readFailed(project);
      } finally {
        pendingProjects.delete(project.id);
      }
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const abort = () => {
    reader.aborted = true;
    stop();
    pump();
  };
  signal?.addEventListener('abort', abort, { once: true });
  const work = Promise.all([resolveProjects(), resolveProjects()]).then(() => Promise.all(waits));
  try {
    if (!reader.aborted)
      await Promise.race([
        work,
        stopped,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5_000);
        }),
      ]);
  } finally {
    if (timer) clearTimeout(timer);
    // Keep cancellation attached only while demand remains; after a normal response deadline
    // outstanding jobs still belong to this reader until completion or actual disconnection.
    void work.finally(() => signal?.removeEventListener('abort', abort));
  }
  // A deadline does not invalidate a previously discovered identity. Reuse it only for
  // pending probes; completed probes may have explicitly detached the old remote.
  if (!reader.aborted)
    for (const project of projects)
      if (pendingProjects.has(project.id)) readFailed(project, 'Still loading GitHub');
  const rows: DashboardForgeCreated[] = [];
  const sources: DashboardFeedSource[] = [];
  for (const { entry, projectIds, reason: probeReason } of resolved.values()) {
    for (const kind of KINDS) {
      const value = entry.kinds[kind];
      const pending = !value || now - value.attemptedAt >= TTL;
      const reason = probeReason ?? (pending ? 'Still loading GitHub' : value.reason);
      sources.push({
        key: `github:${entry.key}:${kind}`,
        state: reason ? (value?.fetchedAt !== undefined ? 'stale' : 'unavailable') : 'ready',
        truncated: value?.truncated ?? false,
        ...(value?.fetchedAt !== undefined
          ? { fetchedAt: new Date(value.fetchedAt).toISOString() }
          : {}),
        ...(reason ? { reason } : {}),
      });
      for (const item of value?.items ?? []) {
        const at = Date.parse(item.createdAt);
        if (at < now - WEEK || at > now) continue;
        rows.push({
          kind: 'github-created',
          key: `github:${entry.key}:${kind}:${item.number}`,
          at: item.createdAt,
          repo: entry.key,
          projectIds: [...new Set(projectIds)].sort(),
          itemKind: kind,
          number: item.number,
          title: item.title,
          url: item.url,
        });
      }
    }
  }
  // An unresolved remote has no canonical repository identity yet. Name its project explicitly
  // rather than hiding a read failure or pretending the workspace has no GitHub sources.
  for (const [id, reason] of unresolved)
    for (const kind of KINDS) {
      sources.push({
        key: `github:project:${id}:${kind}`,
        state: 'unavailable',
        truncated: false,
        reason,
      });
    }
  rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.key.localeCompare(b.key));
  sources.sort((a, b) => a.key.localeCompare(b.key));
  return { rows, sources };
}
