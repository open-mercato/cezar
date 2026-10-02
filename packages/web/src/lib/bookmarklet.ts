/**
 * The bookmarklet generator (spec 011): the `javascript:` URL a user drags to the bookmarks
 * bar. Clicked on a GitHub PR/issue (or, since spec 2026-08-10-forge-provider-adapters Step 4.5,
 * a GitLab merge request/issue) it opens the cockpit's `/new?skill=&auto=&key=&ref=` deep link —
 * the cockpit that GENERATED the bookmarklet, whose origin is baked in at generation.
 *
 * Why no localhost port-scan probe anymore: the legacy program fetched
 * `http://localhost:4321-4330/api/health` from github.com to discover a running cockpit and pick
 * the one serving the page's repo. GitHub's Content-Security-Policy (`default-src 'none'` + a
 * fixed `connect-src` allowlist) BLOCKS any fetch/XHR to localhost from the page context a
 * bookmarklet runs in, so every probe throws "Failed to fetch" and the launcher wrongly reported
 * "cockpit is not running" even with a cockpit up (verified against GitHub's live CSP, 2026-07).
 * A top-level navigation (`window.open`) is NOT subject to `connect-src`, so we open the cockpit
 * directly. Baking the generating origin also makes it exact: the bookmarklet opens the very
 * cockpit you saved it from — no guessing the port, and multi-repo users get the right one for
 * free (each cockpit stamps its own origin).
 *
 * CSP for GitLab: VERIFIED against gitlab.com's live CSP (2026-10-01). Like GitHub's, it blocks a
 * page-context fetch to localhost (`connect-src 'self' https://gitlab.com …`) and has no
 * navigation directive, so the generated program — which only reads `location.href` and calls
 * `open()` — opened the cockpit's composer from a gitlab.com merge request in a subgroup project
 * exactly as it does from a GitHub PR. A self-managed instance sets its own CSP (admin-configurable),
 * so the same reasoning holds unless an admin adds a navigation restriction; that remains
 * untested. The GitHub form itself is unchanged.
 *
 * The `/new?skill=&auto=&key=&ref=` deep-link grammar is a PROTECTED contract
 * (BACKWARD_COMPATIBILITY.md §1) and is unchanged — only the client-side discovery is.
 *
 * Multi-project (spec, step 3.6): a generated launcher now names the project it was generated
 * from — `<origin>/p/<projectId>/new?…` — carrying that project's own launch key (each repo
 * keeps its own `.ai/cezar/launch-key`; the scoped API client already fetches the right one).
 * Only the PATH gained a prefix: the query grammar after `?` is byte-identical, and already
 * saved flat `/new?…` bookmarklets keep landing because the cockpit permanently redirects
 * legacy paths onto the boot project's scoped twin (routes.tsx `LegacyPathRedirect`). Passing
 * no project id yields exactly the legacy path, so an unscoped caller is unchanged.
 *
 * `alert()` in the generated code is deliberate: the program runs on github.com (or a GitLab
 * host), where the cockpit's toaster does not exist (the design guardian carries the matching
 * file allowance).
 *
 * GitLab matcher (spec 2026-08-10-forge-provider-adapters, Step 4.5): the page matcher is built
 * from a list of GitLab hosts the caller passes in (`gitlabHosts` below) — every host the
 * workspace has a registered `forge: 'gitlab'` project on, plus `gitlab.com` once at least one
 * such project exists (`routes/settings/bookmarklets-section.tsx` derives this list from
 * `useProjects()`'s `forge`/`repoUrl` pair, the same registry `BookmarkletPanel` already reads
 * for labels and scoping). An EMPTY list — the default, and what a GitHub-only workspace derives
 * (Step 5.8) — reproduces the pre-GitLab matcher and alert text byte for byte, so every
 * already-saved bookmarklet, every call site that does not pass hosts, and every launcher a
 * workspace with no GitLab project generates, is unaffected. The GitLab URL shape mirrors the server-side one
 * (`runs/store.ts` `GITLAB_PROJECT_URL`, Step 4.4): `http(s)://<host>/<path…>/-/(merge_requests|
 * issues)/N`, path at least two segments so subgroups match. The scheme is optional there and
 * here (Step 5.7): the harvested host keeps whatever scheme and port the project's `repoUrl`
 * carries (Decision D3), and an on-prem instance is routinely plain `http` on a custom port —
 * pinned to `https:` such a host could be collected but never matched. Every regex metacharacter
 * in a host is escaped, so `gitlab.example.com` cannot match `gitlabXexampleXcom` and an IPv6 host
 * (`[2001:db8::1]:8929`) cannot turn into a character class — or, unbalanced, into a `new RegExp`
 * that throws on the page (Step 4.5-review-fix).
 */

/** The cockpit's default origin — the fallback when a caller can't supply `window.location.origin`. */
export const DEFAULT_COCKPIT_ORIGIN = 'http://localhost:4321'

/** The pre-GitLab, GitHub-only page matcher — kept as a named constant so the empty-hosts branch
 *  of `buildMatcher` below is provably the exact string this file always generated. */
const GITHUB_PATTERN = String.raw`^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/(pull|issues)\/\d+`
const GITHUB_ALERT = 'Open a GitHub PR or issue first'
const BOTH_FORGES_ALERT = 'Open a GitHub or GitLab pull/merge request or issue first'

/** Escapes every regex metacharacter in a host for splicing into the regex source below — a host
 *  must match itself literally, whatever it contains.
 *
 *  Dots were the obvious case (`gitlab.com` must not match `gitlabXcom`), but the host comes from
 *  `new URL(project.repoUrl).host`, which for an IPv6 instance is `[2001:db8::1]:8929`: spliced
 *  raw, its brackets become a character class that matches the wrong pages, and the unbalanced
 *  `[` of a bracket-carrying alternation makes the in-page `new RegExp` THROW — the bookmarklet
 *  then does nothing at all (Step 4.5-review-fix). */
function escapeHostForRegex(host: string): string {
  return host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Builds the page matcher (a regex source string, no delimiters) and its alert copy from a list
 * of known GitLab hosts (spec 2026-08-10-forge-provider-adapters, Step 4.5). An empty list
 * reproduces today's GitHub-only matcher and alert text byte for byte.
 */
function buildMatcher(gitlabHosts: readonly string[]): { pattern: string; alert: string } {
  if (gitlabHosts.length === 0) return { pattern: GITHUB_PATTERN, alert: GITHUB_ALERT }
  const hostAlternation = gitlabHosts.map(escapeHostForRegex).join('|')
  // Same shape as `runs/store.ts`'s server-side `GITLAB_PROJECT_URL` (Step 4.4): the scheme is
  // `https?`, and everything before `/-/` is the project path, at least two segments so a
  // subgroup (`group/sub/repo`) matches too. Unlike the server-side pattern the host is a fixed
  // whitelist here (this code runs on an arbitrary page, not against a known project's remote),
  // so no host exclusion is needed.
  // `http` is accepted (Step 5.7) because the hosts come from `gitlabHostsFromProjects`, which
  // harvests `new URL(repoUrl).host` — and `repoUrl` preserves the remote's own scheme and port
  // for a self-managed instance (Decision D3). A host like `gitlab.acme.internal:8929`, served
  // over plain `http` on the corporate network, was collected and could never match.
  // `work_items` too: gitlab.com redirects `/-/issues/N` to `/-/work_items/N`, so that is the URL an
  // issue page actually shows when the bookmarklet runs (verified live, 2026-10-01).
  const gitlabPattern = String.raw`^https?:\/\/(?:${hostAlternation})\/(?:[^\/]+\/){1,}[^\/]+\/-\/(?:merge_requests|issues|work_items)\/\d+`
  return { pattern: `${GITHUB_PATTERN}|${gitlabPattern}`, alert: BOTH_FORGES_ALERT }
}

export function bookmarkletUrl(
  skillName: string,
  auto: boolean,
  key: string,
  origin: string = DEFAULT_COCKPIT_ORIGIN,
  projectId: string | null = null,
  gitlabHosts: readonly string[] = [],
): string {
  // `'` survives encodeURIComponent — it would break the single-quoted JS strings below.
  const enc = (s: string) => encodeURIComponent(s).replaceAll("'", '%27')
  const query = `${skillName ? `skill=${enc(skillName)}&` : ''}auto=${auto ? '1' : '0'}&key=${enc(key)}&ref=`
  // Keep the origin's `://` intact (do NOT URI-encode it — it goes straight into `open()`); only
  // neutralize a stray apostrophe so it can't break the embedded string.
  const base = origin.replaceAll("'", '%27')
  // The composer's path for the named project. Null (no scope) keeps the legacy flat `/new`,
  // which the cockpit redirects to the boot project anyway — so both spellings still land.
  const path = projectId === null || projectId === '' ? '/new' : `/p/${enc(projectId)}/new`
  const { pattern, alert } = buildMatcher(gitlabHosts)
  const code =
    `(()=>{const m=location.href.match(/${pattern}/);` +
    `if(!m){alert('${alert}');return;}` +
    `const q='${query}'+encodeURIComponent(location.href);` +
    `open('${base}${path}?'+q,'_blank');})();`
  return `javascript:${encodeURIComponent(code)}`
}

/**
 * Derives the GitLab hosts a caller should pass to `bookmarkletUrl` from the project registry
 * (`GET /api/v1/projects`): every registered `forge: 'gitlab'` project's `repoUrl` origin — a
 * self-managed instance the workspace already knows about — plus `gitlab.com`, the well-known
 * default (mirroring the server's `forge/discovery.ts` well-known host map).
 *
 * `gitlab.com` is seeded only when the workspace HAS at least one GitLab project (Step 5.8).
 * Seeding it unconditionally meant every real launcher carried the GitLab alternation and the
 * wider alert copy, so the byte-identical GitHub output above was true only of a default no
 * caller used. A GitHub-only workspace now derives an empty list and regenerates exactly the
 * program it always generated. A workspace whose only GitLab project is self-managed still gets
 * `gitlab.com` as well: it is a GitLab workspace, its users do open gitlab.com merge requests
 * (the upstream of a mirrored project, a vendor's repo), and the matcher is a page filter, not
 * an authorization boundary — the cockpit still resolves the `ref` against its own projects.
 */
export function gitlabHostsFromProjects(
  projects: readonly { forge?: string; repoUrl?: string }[] | undefined,
): string[] {
  const gitlabProjects = (projects ?? []).filter((project) => project.forge === 'gitlab')
  if (gitlabProjects.length === 0) return []
  const hosts = new Set<string>(['gitlab.com'])
  for (const project of gitlabProjects) {
    if (!project.repoUrl) continue
    try {
      hosts.add(new URL(project.repoUrl).host)
    } catch {
      // Malformed repoUrl (should not happen — server-built) — skip it, the known hosts stand.
    }
  }
  return Array.from(hosts)
}
