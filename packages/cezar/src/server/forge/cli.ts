import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

/**
 * Forge-neutral CLI plumbing shared by the forge adapters (spec 2026-08-10-forge-provider-adapters
 * § Caching, Phase 1 step 3): the cwd-scoped runner, the ENOENT → install-hint mapping, the bounded
 * page loop and the keyed stale-while-revalidate cache. Extracted from `forge/github.ts` unchanged
 * in behaviour, so a second (glab-backed) adapter reuses the exact semantics rather than a copy.
 */

const exec = promisify(execFile);

export interface RunCliOptions {
  timeoutMs: number;
  maxBuffer: number;
}

/**
 * Run `bin args…` with `cwd = repoRoot` and resolve with its stdout. Rejects with the raw
 * `execFile` error (non-zero exit, timeout, ENOENT) — callers map it to a `reason` themselves.
 * Argument arrays only, never a shell string.
 */
export async function runCli(
  bin: string,
  repoRoot: string,
  args: string[],
  opts: RunCliOptions,
): Promise<string> {
  const { stdout } = await exec(bin, args, {
    cwd: repoRoot,
    timeout: opts.timeoutMs,
    maxBuffer: opts.maxBuffer,
  });
  return stdout;
}

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** True when the binary itself is missing (ENOENT). */
  notFound: boolean;
}

/**
 * A never-throwing sibling of `runCli` for mutations that report stderr to the user (draft-PR
 * push + create): resolves `{ ok, stdout, stderr, notFound }` instead of rejecting.
 */
export function execTool(args: string[], cwd: string, bin: string, timeoutMs = 30_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
        // Nobody can answer a prompt here: git opens /dev/tty directly, so
        // piped stdio is not enough to stop it. Without this a `git push` that
        // cannot authenticate hangs for the whole timeout and surfaces as a
        // blank one-minute stall instead of git's own "could not read Username".
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) =>
        resolve({
          ok: !err,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          notFound: err?.code === 'ENOENT',
        }),
    );
  });
}

/** True when `err` is the CLI binary itself missing (ENOENT) — the one failure no retry or
 *  fallback endpoint can rescue. Matches on the message like the pre-extraction call sites did
 *  (`spawn gh ENOENT`), plus the structured `code` for errors whose message was rewritten. */
export function isNotFound(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /ENOENT/.test(message);
}

/** The install hint a payload's `reason` carries when `tool` is missing. The GitHub wording is
 *  pinned byte-for-byte: ``gh CLI not found — install it and run `gh auth login` ``. */
export function notFoundReason(tool: string): string {
  return `${tool} CLI not found — install it and run \`${tool} auth login\``;
}

/** What the bounded page loop returns. `stoppedShort` means "there may be more rows than we
 *  fetched" and has exactly three causes — the page cap, the budget floor, and a failure on
 *  page ≥ 2. A short page is the one exit that does NOT set it: that is the list genuinely ending. */
export type BoundedPages = { rows: unknown[]; stoppedShort: boolean };

export interface BoundedPagesOptions {
  /** Hard cap on pages walked. */
  maxPages: number;
  /** ONE total budget shared by every page — each page is handed whatever remains. */
  budgetMs: number;
  /** Never spawn a page with less than this left: it could not finish, and its timeout would be
   *  indistinguishable from a real endpoint failure. */
  minPageMs: number;
  /** Rows per full page; a page with fewer rows ends the walk. */
  pageSize: number;
  now?: () => number;
}

/**
 * Walk a paged JSON-array endpoint under one shared time budget. `run(page, timeoutMs)` returns
 * the page's raw stdout. Page 1's failure rethrows (nothing fetched, so the caller decides whether
 * a fallback helps); a later page's failure keeps the pages in hand and flags `stoppedShort`.
 */
export async function fetchBoundedPages(
  run: (page: number, timeoutMs: number) => Promise<string>,
  opts: BoundedPagesOptions,
): Promise<BoundedPages> {
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.budgetMs;
  const rows: unknown[] = [];
  let stoppedShort = false;
  let page = 1;

  for (; page <= opts.maxPages; page++) {
    const remaining = deadline - now();
    if (remaining < opts.minPageMs) {
      stoppedShort = true;
      break;
    }
    let parsed: unknown[];
    try {
      parsed = z.array(z.unknown()).parse(JSON.parse(await run(page, remaining)));
    } catch (err) {
      if (page === 1) throw err;
      stoppedShort = true;
      break;
    }
    rows.push(...parsed);
    if (parsed.length < opts.pageSize) break; // short page — the real end of the list
  }
  if (page > opts.maxPages) stoppedShort = true; // fell out on the page cap

  return { rows, stoppedShort };
}

export interface SwrCache<K, V> {
  /** A fresh value, else joins the in-flight load for `key`, else starts one. */
  get(key: K): Promise<V>;
  /** Never loads on the caller's path: the last-known value (even stale), or `null` only when
   *  cold. A stale or absent entry kicks one background revalidation. */
  peek(key: K): V | null;
  delete(key: K): void;
  clear(): void;
}

/**
 * A keyed, LRU-bounded stale-while-revalidate cache (generalized from GitHub's `detectCache`).
 * One entry per key, so one project's probe never evicts another's; a cold `peek` followed by
 * an awaited `get` shares a single load; `peek` keeps serving the last known value while it
 * revalidates — the #508 anti-flicker guarantee for the sidebar's forge nav item. A rejected
 * load caches nothing.
 */
export function createSwrCache<K, V>(opts: {
  ttlMs: number;
  max: number;
  load: (key: K) => Promise<V>;
  now?: () => number;
}): SwrCache<K, V> {
  // Read `Date.now` per call, not once here: fake clocks (and anything else that swaps `Date`)
  // installed after the cache is created must still be honoured.
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<K, { at: number; value: V }>();
  const inflight = new Map<K, Promise<V>>();

  const store = (key: K, value: V): void => {
    entries.delete(key); // re-insert so this key becomes the newest
    entries.set(key, { at: now(), value });
    while (entries.size > opts.max) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  };

  const get = (key: K): Promise<V> => {
    const hit = entries.get(key);
    if (hit && now() - hit.at < opts.ttlMs) return Promise.resolve(hit.value);
    const running = inflight.get(key);
    if (running) return running;
    const load = opts
      .load(key)
      .then((value) => {
        store(key, value);
        return value;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, load);
    return load;
  };

  return {
    get,
    peek(key) {
      const hit = entries.get(key);
      const fresh = hit && now() - hit.at < opts.ttlMs;
      if (!fresh) void get(key).catch(() => {}); // revalidate off the request path
      return hit ? hit.value : null;
    },
    delete(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
  };
}

/** Drop every `Map` entry whose key starts with `prefix` — the per-root eviction primitive. */
export function deleteKeysWithPrefix(map: Map<string, unknown>, prefix: string): void {
  for (const key of [...map.keys()]) {
    if (key.startsWith(prefix)) map.delete(key);
  }
}

const projectCacheEvictors = new Set<(repoRoot: string) => void>();

/** Each adapter registers the function that drops its own per-root caches, so
 *  `evictForgeProjectCaches` stays forge-neutral and never imports an adapter. */
export function registerProjectCacheEvictor(evict: (repoRoot: string) => void): void {
  projectCacheEvictors.add(evict);
}

/** Drop every cached forge answer for `repoRoot`, across every registered adapter. */
export function evictForgeProjectCaches(repoRoot: string): void {
  for (const evict of projectCacheEvictors) evict(repoRoot);
}
