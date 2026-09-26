/**
 * `CEZ_TRUSTED_HOSTS` — an explicit, default-off allowlist of extra `Host`
 * authorities that the two admission checks (`/api/*` in `server.ts` and
 * `verifyWsUpgrade`) accept in addition to loopback. Nothing else changes: the
 * loopback-only fallbacks in those checks stay loopback-only, the bind is
 * unchanged, and CORS is unchanged.
 *
 * Why: the loopback allowlist (#426) is the DNS-rebinding guard, and as a side
 * effect it refuses every legitimate reverse-proxied request while the cockpit
 * runs in local mode. A private network that already authenticates devices (a
 * tailnet, a WireGuard mesh, a proxy on the host in front of an SSH tunnel) is
 * the case where an operator deliberately wants the cockpit reachable under a
 * name this code cannot enumerate — without paying for hosted mode
 * (`CEZ_REMOTE=1` disables local handoff, home-file browsing and agent-config
 * editing).
 *
 * The risk this opens is deliberate and must be named: a trusted authority
 * keeps `capabilities.localHandoff` true, so anything that can reach that
 * authority also reaches the local-only surfaces — agent-config editing,
 * home-wide `fs/browse`, the launch key, Origin-less writes. Restrict the
 * authority to a private, device-authenticating network; never expose it
 * publicly (see docs/server-install/tailnet.md).
 *
 * The guard's reasoning survives: a rebound `evil.com` still sends
 * `Host: evil.com`, which is not in the list, so it is refused exactly as
 * before; the same-origin write guard still requires `Origin` to match the
 * served `Host`.
 *
 * Matching is by authority (`host[:port]`, lowercased), the same unit
 * `authorityOfHost` compares: a port-less entry matches only a port-less
 * `Host`. There is deliberately no wildcard and no "trust everything" value.
 */

/** Parses the comma-separated value; tolerates a pasted URL per entry. */
export function parseTrustedHosts(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (raw ?? '').split(',')) {
    let value = part.trim().toLowerCase();
    if (!value) continue;
    if (value.includes('://')) {
      try {
        value = new URL(value).host.toLowerCase();
      } catch {
        continue; // an unparseable URL is not an authority anyone can match
      }
    }
    value = value.replace(/\/+$/, '');
    if (value) out.add(value);
  }
  return out;
}

/** Memoized per raw value, so tests and ops can flip `CEZ_TRUSTED_HOSTS` live. */
const memo = new Map<string, Set<string>>();

export function trustedHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.CEZ_TRUSTED_HOSTS ?? '';
  const hit = memo.get(raw);
  if (hit) return hit;
  const parsed = parseTrustedHosts(raw);
  memo.set(raw, parsed);
  return parsed;
}

/** True when a request's `Host` header names one of the trusted authorities. */
export function isTrustedHostHeader(host: string | null | undefined, trusted: Set<string>): boolean {
  if (!host || trusted.size === 0) return false;
  return trusted.has(host.trim().toLowerCase());
}
