import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { execTool } from './cli.ts';

/**
 * Forge discovery (spec 2026-08-10-forge-provider-adapters § Forge discovery) — the host ladder
 * cezar climbs to answer "which forge kind, if any, does this remote host serve?" without ever
 * making an HTTP request of its own (rung 1: a well-known-host constant; rungs 2/3: the on-disk
 * cache and the CLI probes that warm it). NOT wired into `forge/index.ts` or boot yet — Step 2.2
 * does that. This Step only adds the module and its tests.
 */

export type ForgeHostKind = 'github' | 'gitlab';

// ---- Rung 1: well-known hosts, no I/O ----------------------------------------------------------

/** Pure string work — keeps `forgeKindOfRemote()` synchronous for the per-project registry probe
 *  (#698) and the zero-config SaaS path exactly as fast as today (spec § Forge discovery, rung 1). */
export const WELL_KNOWN_FORGE_HOSTS: Record<string, ForgeHostKind> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
};

/** The well-known forge kind for `host`, or `null` when it is not one of the constants above. */
export function wellKnownForgeKind(host: string): ForgeHostKind | null {
  return WELL_KNOWN_FORGE_HOSTS[host.trim().toLowerCase()] ?? null;
}

// ---- Rung 2: the on-disk discovery cache -------------------------------------------------------

/** A pathological or hand-edited cache file cannot grow without limit (spec § Forge discovery). */
const MAX_CACHED_HOSTS = 200;

const ForgeHostCacheSchema = z.object({
  version: z.literal(1),
  hosts: z.record(z.string(), z.enum(['github', 'gitlab', 'none'])),
  updatedAt: z.string(),
});

export type ForgeHostMap = Record<string, ForgeHostKind | 'none'>;

/** Same on-disk convention as `skills-remote.ts` `bareDirFor` (`~/.cache/cez/…`) — a global,
 *  per-user cache. Exported as a function (not a constant) so tests never touch the real path. */
export function defaultForgeHostCacheFile(): string {
  return join(homedir(), '.cache', 'cez', 'forge-hosts.json');
}

/** Lowercase every key and cap the map at `MAX_CACHED_HOSTS` entries (insertion order), applied on
 *  both read and write so neither a hand-edited file nor a runaway merge can grow it unbounded. */
function normalizeHostMap(hosts: ForgeHostMap): ForgeHostMap {
  const out: ForgeHostMap = {};
  for (const [host, kind] of Object.entries(hosts)) {
    if (Object.keys(out).length >= MAX_CACHED_HOSTS) break;
    out[host.trim().toLowerCase()] = kind;
  }
  return out;
}

/**
 * Read the discovery cache synchronously — Step 2.2 loads it once at boot on the synchronous
 * `forgeKindOfHost` call path, so this can never be a Promise. Corrupt JSON, the wrong shape, an
 * absent file and an absent directory all answer an empty map, never a throw (AGENTS.md § Zero
 * config: state may be *read*, never *required*).
 */
export function readForgeHostCache(file: string = defaultForgeHostCacheFile()): ForgeHostMap {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const result = ForgeHostCacheSchema.safeParse(parsed);
  if (!result.success) return {};
  return normalizeHostMap(result.data.hosts);
}

/**
 * Write the discovery cache atomically — tmp + rename (CODE_REVIEW.md "writes that must not
 * clobber use `wx` or tmp+rename"), creating the directory if missing. A read-only or otherwise
 * unwritable directory degrades silently: returns `false`, never throws (AGENTS.md § Zero config:
 * a read-only home degrades, never fails boot).
 */
export function writeForgeHostCache(file: string, hosts: ForgeHostMap): boolean {
  const payload = {
    version: 1 as const,
    hosts: normalizeHostMap(hosts),
    updatedAt: new Date().toISOString(),
  };
  // Unique per write (not just per process), matching `agent-config/files.ts`, so two concurrent
  // warms can't rename the same tmp path over each other and tear the bytes.
  const tmp = `${file}.cez-tmp-${process.pid}-${randomUUID()}`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// ---- Rung 3: parsing `gh auth status` / `glab auth status` ------------------------------------

/**
 * A host header line, and the host inside a `Logged in to …` detail line. Both `gh auth status`
 * and `glab auth status` print an unindented host header line per authenticated (or attempted)
 * host, followed by indented detail lines — e.g.:
 *
 * ```
 * github.com
 *   ✓ Logged in to github.com account octocat (keyring)
 *   - Active account: true
 * ```
 *
 * A header line is a bare hostname: no spaces, at least one dot. That is enough to reject the
 * CLIs' prose messages ("You are not logged into any GitHub hosts. Run gh auth login to
 * authenticate.") without needing to special-case them, since prose always contains a space.
 */
const HOST_HEADER_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * Both CLIs exit non-zero (and print to stderr) when any host is logged out, so callers must pass
 * BOTH stdout and stderr here rather than discarding stderr on a non-zero exit.
 *
 * Returns every host BOTH line shapes name — the header, and the `Logged in to <host>` detail
 * under it — lowercased and deduped, in the order it first appears. Reading only the header made
 * the whole rung depend on one line of formatting: a CLI that indents or re-words its header
 * yields nothing at all, and every Enterprise/self-managed project silently degrades. A host is
 * counted whether its status line is a success (`✓`) or a failure (`X`): an invalid/expired token
 * still means this host IS served by that forge kind, so classifying it as one is correct — only
 * *availability* (a live, working credential) is a different question, and that is `detect()`'s
 * job, not discovery's.
 */
function parseAuthHosts(text: string): string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string): void => {
    if (!HOST_HEADER_RE.test(candidate)) return; // blank line or prose message
    const host = candidate.toLowerCase();
    if (seen.has(host)) return;
    seen.add(host);
    hosts.push(host);
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // The header: a bare hostname on a line of its own.
    if (!/^\s/.test(rawLine)) add(line);
    // The detail line both CLIs print under it: `✓ Logged in to <host> account octocat (keyring)`
    // for `gh`, `✓ Logged in to <host> as example-user (keyring)` for `glab`. A trailing sentence
    // dot is not part of the host. "not logged INTO any hosts" is prose and does not match.
    const loggedIn = /logged in to\s+(\S+)/i.exec(line);
    if (loggedIn?.[1]) add(loggedIn[1].replace(/[.,;:]+$/, ''));
  }
  return hosts;
}

/** Hosts `gh auth status` reports (stdout+stderr combined — see `parseAuthHosts`). */
export function parseGhAuthHosts(text: string): string[] {
  return parseAuthHosts(text);
}

/** Hosts `glab auth status` reports (stdout+stderr combined — see `parseAuthHosts`). */
export function parseGlabAuthHosts(text: string): string[] {
  return parseAuthHosts(text);
}

// ---- warmForgeDiscovery: runs both CLIs, merges, writes ----------------------------------------

const AUTH_STATUS_TIMEOUT_MS = 5_000;

/** What an injected runner resolves with — mirrors `ExecResult` from `cli.ts` minus the fields
 *  `warmForgeDiscovery` does not need. */
export interface ForgeDiscoveryRunResult {
  stdout: string;
  stderr: string;
  /** True when the binary itself is missing (ENOENT) — that rung simply contributes nothing. */
  notFound?: boolean;
}

export type ForgeDiscoveryRunner = (bin: string, args: string[]) => Promise<ForgeDiscoveryRunResult>;

/** Default runner: `forge/cli.ts`'s never-throwing `execTool`. `gh auth status` exits non-zero on
 *  a logged-out host, so `execTool` (which reports stderr regardless of exit code) is used here
 *  instead of `runCli` (which would reject and lose the very text this module needs to parse). */
function defaultRunner(bin: string, args: string[]): Promise<ForgeDiscoveryRunResult> {
  // Not repo-scoped, so cwd is irrelevant to the command itself — `homedir()` just avoids running
  // from a cwd that might not exist.
  return execTool(args, homedir(), bin, AUTH_STATUS_TIMEOUT_MS);
}

export interface WarmForgeDiscoveryOptions {
  /** Defaults to `defaultForgeHostCacheFile()`. */
  cacheFile?: string;
  /** Defaults to a runner built on `execTool`. Tests inject a fake so nothing touches the network
   *  or a real CLI. */
  run?: ForgeDiscoveryRunner;
  /** Where the "this CLI named no host" diagnostic goes. Defaults to `console.warn`, as every
   *  other degradation in the codebase reports itself (`[cez] …`). */
  warn?: (message: string) => void;
}

/** Bins whose "ran, named no host" line has already been said. The warm-up repeats every ten
 *  minutes and a logged-out CLI stays logged out, so this is worth saying once per process rather
 *  than on every tick. */
const warnedEmptyProbes = new Set<string>();

/** Test seam: forget which diagnostics were already said, so each case starts from silence. */
export function __resetForgeDiscoveryWarningsForTests(): void {
  warnedEmptyProbes.clear();
}

interface ForgeProbe {
  bin: string;
  kind: ForgeHostKind;
  parse: (text: string) => string[];
}

const FORGE_PROBES: ForgeProbe[] = [
  { bin: 'gh', kind: 'github', parse: parseGhAuthHosts },
  { bin: 'glab', kind: 'gitlab', parse: parseGlabAuthHosts },
];

/**
 * Rung 3: ask each installed forge CLI which hosts it is authenticated against, merge `host →
 * kind` into the existing cache, and persist it. Runs off the request path (boot + a bounded
 * interval — Step 2.2), never throws, and a missing CLI (ENOENT) is simply skipped. Returns the
 * merged map so a caller (or a test) can use it directly without a second read.
 */
export async function warmForgeDiscovery(
  opts: WarmForgeDiscoveryOptions = {},
): Promise<ForgeHostMap> {
  const cacheFile = opts.cacheFile ?? defaultForgeHostCacheFile();
  const run = opts.run ?? defaultRunner;
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  const merged: ForgeHostMap = { ...readForgeHostCache(cacheFile) };

  const outcomes = await Promise.all(
    FORGE_PROBES.map(async (probe): Promise<{ kind: ForgeHostKind; hosts: string[] } | null> => {
      try {
        const result = await run(probe.bin, ['auth', 'status']);
        if (result.notFound) return null; // CLI not installed — this rung contributes nothing
        const hosts = probe.parse(`${result.stdout}\n${result.stderr}`);
        // An installed CLI that names no host is either logged out or printing a shape this
        // parser does not know. Both leave every non-SaaS host of that kind unclassified, and
        // silence is what made the second of the two indistinguishable from a working install.
        if (hosts.length === 0 && !warnedEmptyProbes.has(probe.bin)) {
          warnedEmptyProbes.add(probe.bin);
          warn(
            `[cez] \`${probe.bin} auth status\` named no host — ${probe.kind} hosts other than the well-known one stay unrecognized until \`${probe.bin} auth login\` reports one.`,
          );
        }
        return { kind: probe.kind, hosts };
      } catch {
        // A throwing runner (or a parser surprise) must never take discovery down with it.
        return null;
      }
    }),
  );

  for (const outcome of outcomes) {
    if (!outcome) continue;
    for (const host of outcome.hosts) merged[host] = outcome.kind;
  }

  writeForgeHostCache(cacheFile, merged);
  return merged;
}
