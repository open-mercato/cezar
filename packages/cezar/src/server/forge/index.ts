import type { RepoInfo } from '../git.ts';
import {
  defaultForgeHostCacheFile,
  readForgeHostCache,
  warmForgeDiscovery,
  wellKnownForgeKind,
  type ForgeHostMap,
  type WarmForgeDiscoveryOptions,
} from './discovery.ts';
import { createGithubDriver } from './github.ts';
import { createGitlabDriver } from './gitlab.ts';
import type {
  ForgeChecksData,
  ForgeCommentsData,
  ForgeDriver,
  ForgeKind,
  ForgeListData,
  ForgeListOptions,
  ForgePrDiffResult,
  ForgeRefStatusData,
  ForgeSearchData,
} from './types.ts';

/**
 * Forge resolution (cockpit-ui redesign spec §"Forge-driver seam"): map the
 * repo's origin remote to a driver — a host classified `github` (github.com, or
 * a GitHub Enterprise host `gh auth status` reported) → the GitHub driver, a
 * host classified `gitlab` → the GitLab driver, anything else (unknown hosts, no
 * remote, not a repo) → null. The health route
 * serializes the result as `forge: {kind, available, reason?} | null`; a null
 * forge means plain-git features only (diffs, commit, push, branches).
 */

export interface ParsedRemote {
  host: string;
  owner: string;
  repo: string;
  /** Full project path, `.git` stripped, no leading/trailing slashes (e.g. `group/sub/repo`).
   *  For a two-segment remote this equals `owner/repo`; a subgroup or an on-prem instance path
   *  prefix (cezar cannot tell the two apart) adds the extra segments in front. */
  path: string;
  /** The remote's web origin (spec 2026-08-10-forge-provider-adapters, Decision D3): `http(s)://`
   *  remotes keep their own scheme and port; every non-web transport (`ssh://`, `git://`,
   *  `git+ssh://`, scp-form) maps to `https://<host>` with no port — an SSH port is never a web
   *  port. Never carries credentials. `forgeWebRoot` = `${origin}/${path}`. */
  origin: string;
}

/**
 * Parse a git remote URL into host/owner/repo/path/origin. Handles the scheme forms
 * (`https://`, `ssh://`, `git://`, `git+ssh://`, with optional credentials and port) and the
 * scp-like form (`git@host:owner/repo.git`). Null for local paths and anything else that doesn't
 * look like a forge remote.
 *
 * Mirror rule: `web/src/lib/tasks-table.ts` `forgeRepoBase` is a documented duplicate of this
 * parser (cockpit code can't import server code) — change both in the same commit (spec
 * 2026-08-10-forge-provider-adapters Step 3.9 widened the web copy the same way).
 */
export function parseRemote(remote: string): ParsedRemote | null {
  const r = remote.trim().replace(/\/+$/, '');
  let host: string;
  let rawPath: string;
  let origin: string;
  const url = /^(https?|ssh|git|git\+ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::(\d+))?\/(.+)$/.exec(r);
  if (url) {
    const [, scheme, h, port, p] = url;
    if (!scheme || !h || !p) return null;
    const normalized = normalizeRemoteHost(h);
    if (!normalized) return null;
    host = normalized;
    rawPath = p;
    // http(s) remotes keep their own scheme and port (D3) — an on-prem instance may run on a
    // non-default port, and that is a genuine part of its web origin. Every other transport below
    // maps to the plain https web origin with no port.
    origin = /^https?$/i.test(scheme)
      ? `${scheme.toLowerCase()}://${host}${port ? `:${port}` : ''}`
      : `https://${host}`;
  } else {
    // scp-like: [user@]host:owner/repo(.git) — a leading '/' (local path)
    // can't match the host group, so plain directories fall through to null.
    const scp = /^(?:[^@/:]+@)?([^:/]+):(.+)$/.exec(r);
    if (!scp) return null;
    const [, h, p] = scp;
    if (!h || !p) return null;
    // A scheme URL the pattern above rejected (an IPv6 literal, say) also matches this one, with
    // the scheme as its "host" and `//rest` as its path. That is not an scp remote.
    if (p.startsWith('//')) return null;
    const normalized = normalizeRemoteHost(h);
    if (!normalized) return null;
    host = normalized;
    rawPath = p;
    origin = `https://${host}`;
  }
  const parts = rawPath.replace(/\.git$/i, '').split('/').filter(Boolean);
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];
  if (!owner || !repo) return null;
  return { host, owner, repo, path: parts.join('/'), origin };
}

/** A plausible remote host: dot-separated DNS labels of letters, digits and hyphens (an IPv4
 *  literal has the same shape). Deliberately the same grammar as `HOST_HEADER_RE` in
 *  `./discovery.ts`, minus its "at least one dot" rule — a bare word there is CLI prose, but a
 *  remote may legitimately name a single-label host (`https://intranet/gitlab/group/repo`).
 *  Neither accepts a bracketed IPv6 literal, and neither does git's own URL grammar here. */
const REMOTE_HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * The host as `ParsedRemote` will carry it, or null when the capture is not a hostname. Both
 * patterns above capture the host as a character class that admits spaces, tabs and newlines, and
 * only `forgeKindOfHost` trims — so without this `https://gitlab.com /group/repo` parsed, kept the
 * raw bytes in `host` and `origin`, passed checkout's 400 gate and put a malformed origin in
 * `repoUrl`. Surrounding whitespace is rejected rather than trimmed away: a remote whose authority
 * holds whitespace is malformed, not untidy, and every caller already handles null.
 */
function normalizeRemoteHost(raw: string): string | null {
  const host = raw.trim().toLowerCase();
  if (host.length !== raw.length || !REMOTE_HOST_RE.test(host)) return null;
  return host;
}

// ---- Host classification (spec 2026-08-10-forge-provider-adapters § Forge discovery) ----------

/** The discovered `host → kind` map (rung 2), or null until first use. Loaded SYNCHRONOUSLY, once,
 *  on the first classification, and replaced wholesale after every warm-up — so the call path
 *  (`forgeKindOfRemote` runs for every project on every registry listing, #698) never does I/O
 *  beyond that single first read. */
let discoveredHosts: ForgeHostMap | null = null;

/** Test seam: the cache file the lazy load and the warm-up use instead of the real one. */
let cacheFileOverride: string | null = null;

/** The cache file to read and warm, or null when there is none to touch. Under vitest the real
 *  `~/.cache/cez` is never read or written — the same `process.env.VITEST` guard
 *  `open-in-terminal.ts` uses for launchers — so a test sees an empty map unless it seeds one. */
function forgeHostCacheFile(): string | null {
  if (cacheFileOverride) return cacheFileOverride;
  return process.env.VITEST ? null : defaultForgeHostCacheFile();
}

function loadDiscoveredHosts(): ForgeHostMap {
  if (!discoveredHosts) {
    const file = forgeHostCacheFile();
    // `readForgeHostCache` never throws: missing, corrupt or unreadable → an empty map.
    discoveredHosts = file ? readForgeHostCache(file) : {};
  }
  return discoveredHosts;
}

/**
 * Remote host → forge kind: the well-known constants first (no I/O), then the in-memory discovery
 * map, else null. A host the cache records as `'none'` is null too. The one host ladder
 * `resolveForge`, `forgeKindOfRemote` and `forgeWebRoot` all read.
 */
export function forgeKindOfHost(host: string): ForgeKind | null {
  const key = host.trim().toLowerCase();
  const known = wellKnownForgeKind(key);
  if (known) return known;
  const discovered = loadDiscoveredHosts()[key];
  return discovered && discovered !== 'none' ? discovered : null;
}

/**
 * Read the discovery cache NOW, off the request path, and keep it (spec
 * 2026-08-10-forge-provider-adapters, Step 2.2). `loadDiscoveredHosts` is otherwise lazy, and in
 * practice its first caller is INSIDE a request — `/api/v1/projects` → per-project probe →
 * `forgeKindOfRemote` — so a synchronous `readFileSync` lands on the event loop, and until it does
 * a GitHub Enterprise project's `/github*` routes answer the in-payload unavailable. `createApp`
 * calls this once at boot; the lazy path stays as the fallback for everything that does not.
 *
 * Idempotent and cheap: a map already in memory (an earlier call, a warm-up, a test seam) is kept,
 * and under vitest there is no file to read unless a test points at one.
 */
export function loadForgeDiscoveryCache(): void {
  loadDiscoveredHosts();
}

/**
 * Re-run discovery (the CLI probes) and swap the in-memory map for the merged result. Called at
 * boot and on a bounded interval by the server — never from a request handler. Never throws.
 * Under vitest it is a no-op unless the caller injects a runner, so no test ever spawns `gh`/`glab`
 * or writes the real cache.
 */
export async function refreshForgeDiscovery(opts: WarmForgeDiscoveryOptions = {}): Promise<void> {
  const cacheFile = opts.cacheFile ?? forgeHostCacheFile();
  if (!cacheFile || (process.env.VITEST && !opts.run)) return;
  try {
    discoveredHosts = await warmForgeDiscovery({ ...opts, cacheFile });
  } catch {
    // warmForgeDiscovery never throws; a surprise leaves the previous map in place.
  }
}

/** Test seam: pin the discovery map (`null` resets to the lazy load). */
export function __setForgeHostsForTests(map: ForgeHostMap | null): void {
  discoveredHosts = map;
}

/** Test seam: point the lazy load and the warm-up at `file` (`null` restores the default), and
 *  reset the map so the next classification reads it. */
export function __setForgeHostCacheFileForTests(file: string | null): void {
  cacheFileOverride = file;
  discoveredHosts = null;
}

/**
 * Which forge a remote URL belongs to, without building a driver (#698): the
 * registry's per-project probe classifies each root from its remote alone —
 * plain string parsing plus the in-memory host map, no `gh` shell-out — so the
 * sidebar can gate each project's forge tab on the project's own remote.
 */
export function forgeKindOfRemote(remote: string | undefined): ForgeKind | null {
  const parsed = remote ? parseRemote(remote) : null;
  return parsed ? forgeKindOfHost(parsed.host) : null;
}

/**
 * A remote's web root — `https://github.com/owner/repo` — or null for anything not on a known
 * or discovered forge host.
 *
 * Built from the PARSED remote, never by string-editing the raw one, and that is the point: a
 * remote may carry credentials (`https://user:token@github.com/o/r.git`), and this is a value the
 * cockpit renders and links to. Rebuilding it from `{host, owner, repo}` leaves nothing to leak.
 */
export function forgeWebRoot(remote: string | undefined): string | null {
  const parsed = remote ? parseRemote(remote) : null;
  if (!parsed || !forgeKindOfHost(parsed.host)) return null;
  return `${parsed.origin}/${parsed.path}`;
}

/** Remote host → driver | null. Any `github` host (github.com or a GitHub Enterprise host) gets the
 *  GitHub driver — `gh` itself resolves the host from the repo's remote — and any `gitlab` host
 *  the GitLab driver. */
export function resolveForge(repoInfo: RepoInfo | null): ForgeDriver | null {
  if (!repoInfo?.remote) return null;
  const parsed = parseRemote(repoInfo.remote);
  if (!parsed) return null;
  const kind = forgeKindOfHost(parsed.host);
  if (kind === 'github') {
    return createGithubDriver(repoInfo.root, { owner: parsed.owner, repo: parsed.repo, origin: parsed.origin });
  }
  // A `gitlab` host (gitlab.com or a discovered self-managed instance) gets the GitLab driver —
  // `glab` likewise resolves the host and project from the repo's remote (spec
  // 2026-08-10-forge-provider-adapters, Step 3.1).
  if (kind === 'gitlab') return createGitlabDriver(repoInfo.root, parsed);
  return null;
}

/** Why a forge read answers `available: false` when the project resolves to no driver at all (no
 *  remote, a local-path remote, or a host no driver claims). Before the routes went through
 *  `resolveForge` this text came from `gh`'s own stderr, so there was no literal to keep. */
export const NO_FORGE_REASON = 'No supported forge remote detected';

/**
 * The `GET /api/github` listing through the driver seam (spec 2026-08-10-forge-provider-adapters).
 * `listAll` serves the whole payload; a driver without it is listed through `listIssues` +
 * `listPRs`, which cannot know the repo handle or label colors and so leave them out. A null forge
 * and a failing fallback both land on the tab's quiet degrade — never a throw.
 */
export async function listForgeItems(forge: ForgeDriver | null, opts: ForgeListOptions): Promise<ForgeListData> {
  if (!forge) return { available: false, reason: NO_FORGE_REASON, issues: [], prs: [] };
  if (forge.listAll) return forge.listAll(opts);
  try {
    const [issues, prs] = await Promise.all([forge.listIssues(opts), forge.listPRs(opts)]);
    return { available: true, syncedAt: new Date().toISOString(), issues, prs };
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).split('\n')[0]?.trim();
    return { available: false, reason: reason || `${forge.kind} listing failed`, issues: [], prs: [] };
  }
}

/**
 * The `GET /api/github/search` hits through the driver seam (#730, spec
 * 2026-08-10-forge-provider-adapters). A null forge, or one without `searchItems`, degrades in the
 * payload — the route never 5xxs over a missing capability.
 */
export async function searchForgeItems(
  forge: ForgeDriver | null,
  kind: 'issue' | 'pr',
  query: string,
  opts: { limit?: number },
): Promise<ForgeSearchData> {
  if (!forge) return { available: false, reason: NO_FORGE_REASON, items: [] };
  if (!forge.searchItems) return { available: false, reason: `Search is not supported for this ${forge.kind} remote`, items: [] };
  return forge.searchItems(kind, query, opts);
}

/**
 * The `GET /api/github/comments/:kind/:number` thread through the driver seam (#499, #525, spec
 * 2026-08-10-forge-provider-adapters). A null forge, or one without `listComments`, degrades in the
 * payload — the route never 5xxs over a missing capability.
 */
export async function listForgeComments(
  forge: ForgeDriver | null,
  kind: 'issue' | 'pr',
  number: number,
  opts: { refresh?: boolean },
): Promise<ForgeCommentsData> {
  if (!forge) return { available: false, reason: NO_FORGE_REASON, comments: [] };
  if (!forge.listComments) return { available: false, reason: `Comments are not supported for this ${forge.kind} remote`, comments: [] };
  return forge.listComments(kind, number, opts);
}

/**
 * The `GET /api/github/checks` lazy CI glyphs through the driver seam (#664, spec
 * 2026-08-10-forge-provider-adapters). A null forge, or one without `listChecks`, degrades in the
 * payload — the route never 5xxs over a missing capability. Unlike the other degrade payloads this
 * one has no list field to empty (`ForgeChecksData`'s unavailable branch carries only `reason`).
 */
export async function listForgeChecks(forge: ForgeDriver | null, numbers: number[]): Promise<ForgeChecksData> {
  if (!forge) return { available: false, reason: NO_FORGE_REASON };
  if (!forge.listChecks) return { available: false, reason: `CI checks are not supported for this ${forge.kind} remote` };
  return forge.listChecks(numbers);
}

/**
 * The `GET /api/github/ref-status` batched chip status through the driver seam (spec
 * 2026-08-10-forge-provider-adapters, Step 1.7). A null forge, or one without `refStatus`,
 * degrades in the payload — the route never 5xxs over a missing capability. `recheckAfterMs: null`
 * here means exactly what it means everywhere else in `ForgeRefStatusData`: nothing in this
 * answer can change, so a forge that cannot answer at all has nothing worth asking again for.
 */
export async function forgeRefStatus(forge: ForgeDriver | null, prs: number[], issues: number[]): Promise<ForgeRefStatusData> {
  if (!forge) return { available: false, reason: NO_FORGE_REASON, recheckAfterMs: null };
  if (!forge.refStatus) {
    return { available: false, reason: `Reference status is not supported for this ${forge.kind} remote`, recheckAfterMs: null };
  }
  return forge.refStatus(prs, issues);
}

/**
 * The `GET /api/github/prs/:number/changes` bounded diff view through the driver seam (spec
 * 2026-08-10-forge-provider-adapters, Step 1.8). A null forge, or one without `prDiff`, degrades
 * in the payload — but unlike every other helper here this one does NOT catch everything the
 * driver throws: `GithubPrNotFoundError` propagates on purpose, so the route can still map a
 * missing pull request to 404 exactly as it did calling `fetchGithubPrDiff` directly.
 */
export async function forgePrDiff(
  forge: ForgeDriver | null,
  number: number,
  opts: { refresh?: boolean },
): Promise<ForgePrDiffResult> {
  if (!forge) return { available: false, reason: NO_FORGE_REASON };
  if (!forge.prDiff) return { available: false, reason: `Pull request changes are not supported for this ${forge.kind} remote` };
  return forge.prDiff(number, opts);
}

export type { ForgeDriver, ForgeAvailability, ForgeItem, ForgeKind, ForgePrStatus, ForgeRefKind } from './types.ts';
