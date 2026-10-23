import { parseRemote } from '../../git-remotes.ts';
import { isGithubHost } from '../../github-hosts.ts';
import { isGitlabHost } from '../../gitlab-hosts.ts';
import type { RepoInfo } from '../git.ts';
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
 * repo's origin remote to a driver — a GitHub host (github.com, `*.ghe.com`, or one `gh` is
 * signed in to — `github-hosts.ts`) → the GitHub driver, a GitLab host (gitlab.com, or one `glab`
 * is configured for — `gitlab-hosts.ts`) → the GitLab driver, anything else (unknown hosts, no
 * remote, not a repo) → null. The health route
 * serializes the result as `forge: {kind, available, reason?} | null`; a null
 * forge means plain-git features only (diffs, commit, push, branches).
 */

export { parseRemote, type ParsedRemote } from '../../git-remotes.ts';

/**
 * Remote host → forge kind: the one lookup `resolveForge`, `forgeKindOfRemote` and `forgeWebRoot`
 * all read. Both halves are the same mechanism — a synchronous, TTL-cached read of the forge
 * CLI's own config file (`gh`'s `hosts.yml`, `glab`'s `config.yml`) plus its env vars — so a GHE
 * host and a self-managed GitLab host are classified the same way, with no subprocess and no
 * cold-start window. GitHub is asked first.
 */
export function forgeKindOfHost(host: string): ForgeKind | null {
  const key = host.trim().toLowerCase();
  const pinned = pinnedHosts?.[key];
  if (pinned) return pinned;
  if (isGithubHost(key)) return 'github';
  if (isGitlabHost(key)) return 'gitlab';
  return null;
}

let pinnedHosts: Record<string, ForgeKind> | null = null;

/** Test seam: classify these hosts as given, ahead of the CLI host lists (`null` clears). */
export function __setForgeHostsForTests(map: Record<string, ForgeKind> | null): void {
  pinnedHosts = map ? Object.fromEntries(Object.entries(map).map(([h, k]) => [h.toLowerCase(), k])) : null;
}

/**
 * Which forge a remote URL belongs to, without building a driver (#698): the
 * registry's per-project probe classifies each root from its remote alone —
 * plain string parsing plus the cached CLI host lists, no `gh` shell-out — so the
 * sidebar can gate each project's forge tab on the project's own remote.
 */
export function forgeKindOfRemote(remote: string | undefined): ForgeKind | null {
  const parsed = remote ? parseRemote(remote) : null;
  return parsed ? forgeKindOfHost(parsed.host) : null;
}

/**
 * A remote's web root — `https://github.com/owner/repo` — or null for anything not on a known
 * forge host.
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
    return createGithubDriver(repoInfo.root, { host: parsed.host, owner: parsed.owner, repo: parsed.repo, origin: parsed.origin });
  }
  // A `gitlab` host (gitlab.com or a self-managed instance `glab` knows) gets the GitLab driver —
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
