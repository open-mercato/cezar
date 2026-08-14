/**
 * Server capabilities reported by `/api/health` — the UI hides what the server
 * says isn't there, and the matching endpoints refuse as defense in depth.
 *
 * `localHandoff` (cockpit-ui redesign spec §"Deployment modes — local vs
 * hosted"): the default deployment is `npx cezar-cli` on localhost, where
 * handing a session off to a local terminal/editor makes sense. On a VPS/remote
 * box it doesn't: `CEZ_REMOTE=1` (or binding a non-loopback host) switches to
 * hosted mode — the UI hides every local-machine affordance and the open-in-*
 * endpoints 409.
 *
 * `followups` (spec 007, #444, #471): the global follow-up inbox is **opt-in**
 * via `CEZ_FOLLOWUPS=1` and off by default. Off, agents are never told to write
 * `todos.json` (they get `HANDOFF_ONLY_INSTRUCTIONS` and an empty
 * `CEZ_TODOS_FILE`), the Inbox nav item is gone and the inbox endpoints refuse.
 * The per-task handoff journal is independent and runs either way.
 *
 * `singleProject` (spec 2026-07-21-cez-single-project): the workspace is
 * deliberately constrained to the launch project when `CEZ_SINGLE_PROJECT=1`.
 * Like the other opt-in capabilities, activation is strict: no other spelling
 * enables it.
 *
 * `automations` (spec 2026-07-25-github-automations, #801): GitHub automations
 * are **opt-in** via `CEZ_AUTOMATIONS=1` and off by default. Off, the
 * `Automations` nav item is gone everywhere it is rendered, the
 * `/automations*` endpoints refuse, and the workspace scheduler never polls
 * GitHub — the flag removes the behavior, not only the UI. Activation is
 * strict, like the two capabilities above. Nothing on disk is touched:
 * definitions, receipts and high-watermarks survive the flag being off, so
 * unsetting it and restarting restores the feature wholesale.
 *
 * Usage presentation: token counts and monetary cost stay visible by default.
 * `CEZ_HIDE_TOKEN_USAGE=1` and `CEZ_HIDE_COST=1` hide them independently;
 * legacy `CEZ_HIDE_TOKEN_METRICS=1` remains the master hide-all switch. None
 * changes collection, persistence, events, or API run records.
 */

import { followupsEnabled } from '../handoff.ts';
import type { Capabilities } from '@open-mercato/cezar-contract';

/** Every IPv4 address in 127.0.0.0/8, anchored. Anchoring is load-bearing: a
 *  `startsWith('127.')` test also matches attacker-controlled *hostnames* like
 *  `127.0.0.1.evil.com`, which is exactly the DNS-rebinding bypass #426 is
 *  about — see `isLoopbackHostHeader`. */
const LOOPBACK_V4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** The IPv6 loopback in the canonical form `expandIpv6` emits. */
const LOOPBACK_V6 = '0:0:0:0:0:0:0:1';

/** Expand an IPv6 literal to all 8 groups, lowercase and without leading zeros
 *  (`::1` → `0:0:0:0:0:0:0:1`), or `null` when it is not a valid literal.
 *
 *  Canonicalizing rather than merely *recognizing* matters: `Host` carries
 *  whatever spelling the client sent, but `new URL().hostname` compresses
 *  (`[0:0:0:0:0:0:0:1]` → `[::1]`), so the two only compare equal on a common
 *  form. */
function expandIpv6(h: string): string | null {
  const halves = h.split('::');
  if (halves.length > 2) return null;
  let groups: string[];
  if (halves.length === 2) {
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves[1] ? halves[1].split(':') : [];
    if (head.length + tail.length > 7) return null;
    groups = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  } else {
    groups = h.split(':');
  }
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16).toString(16)).join(':');
}

/** Canonical hostname of an authority: port and IPv6 brackets removed, IPv6
 *  expanded, zone id and FQDN trailing dot dropped, lowercased.
 *  `[::1]:4321` → `0:0:0:0:0:0:0:1`, `localhost.:4321` → `localhost`.
 *
 *  Strict by construction: an authority that does not parse as one of the three
 *  legal shapes returns `''`, which no allowlist matches. Being lax here is a
 *  security bug, not a convenience — a parser that merely *finds* a loopback
 *  name inside the header would accept `[::1]@evil.com` or `127.0.0.1:evil.com`. */
export function normalizeHostname(host: string): string {
  // 1. Bracketed IPv6, optionally with a port: `[::1]`, `[::1%25eth0]:4321`.
  //    The end anchor is load-bearing — without it `[::1]@evil.com` → `::1`.
  const bracketed = host.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return expandIpv6(stripZone(bracketed[1]!.toLowerCase())) ?? '';

  // 2. A bare IPv6 literal cannot carry a port (no brackets ⇒ every colon
  //    belongs to the address), so anything with >1 colon is taken whole.
  if (host.split(':').length > 2) return expandIpv6(stripZone(host.toLowerCase())) ?? '';

  // 3. `name` or `name:port`, where the port must actually be digits.
  const plain = host.match(/^([^:[\]]*)(?::(\d+))?$/);
  if (plain) return plain[1]!.toLowerCase().replace(/\.$/, '');

  return ''; // unparseable ⇒ matches no allowlist
}

/** Drop an IPv6 zone id (`fe80::1%eth0`), anchored to the end so a `%` inside a
 *  registrable hostname can never truncate it down to a loopback name. */
function stripZone(h: string): string {
  return h.replace(/%[a-z0-9._~-]+$/, '');
}

/** True when the hostname names this machine and nothing else. Expects the
 *  canonical output of `normalizeHostname`. */
function isLoopbackName(hostname: string): boolean {
  return hostname === 'localhost' || LOOPBACK_V4.test(hostname) || hostname === LOOPBACK_V6;
}

/** True for bind hosts that only the local machine can reach. Undefined = the
 *  default bind (127.0.0.1), hence trusted — this is a *configuration* value we
 *  chose, not a request header. Do NOT use this on attacker-controlled input;
 *  use `isLoopbackHostHeader`, which fails closed on a missing host. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true;
  return isLoopbackName(normalizeHostname(host));
}

/** True for a request's `Host`/`Origin` hostname when it names this machine.
 *  The untrusted-input twin of `isLoopbackHost`: a missing or unparseable host
 *  is **untrusted** (false), because absent is not the same as "we defaulted to
 *  loopback" once the value arrives over the wire (#426). */
export function isLoopbackHostHeader(host: string | null | undefined): boolean {
  if (!host) return false;
  return isLoopbackName(normalizeHostname(host));
}

/** `CEZ_REMOTE=1` or a non-loopback bind host ⇒ hosted mode (no local handoff).
 *  `CEZ_FOLLOWUPS=1` ⇒ the follow-up inbox exists (#471).
 *  `CEZ_AUTOMATIONS=1` ⇒ GitHub automations exist (#801).
 *
 *  Read per request — cheap, and tests/ops can flip `CEZ_REMOTE` live. `followups` is honest
 *  per request too, but flipping it ON at runtime is only half a switch: the per-dataDir
 *  todos watch (step 2.3) is created by an SSE subscription, so connections opened while the
 *  flag was off never subscribed and get no live inbox updates until they reconnect. Hence
 *  the UI's "set CEZ_FOLLOWUPS=1 and restart cezar" wording — treat it as a boot-time flag.
 *
 *  `automations` carries the same caveat and for the same reason: the workspace scheduler is
 *  started once, on the server's `listening` event, so flipping the flag on afterwards gates
 *  the routes open without ever starting the poller. Boot-time flag, same wording. */
export function resolveCapabilities(env: NodeJS.ProcessEnv = process.env, bindHost?: string): Capabilities {
  const hideAllUsage = env.CEZ_HIDE_TOKEN_METRICS === '1';
  const tokenUsageMetrics = !hideAllUsage && env.CEZ_HIDE_TOKEN_USAGE !== '1';
  const costMetrics = !hideAllUsage && env.CEZ_HIDE_COST !== '1';
  return {
    localHandoff: env.CEZ_REMOTE !== '1' && isLoopbackHost(bindHost),
    // Deliberately not re-derived here: RunManager enforces the same predicate,
    // and two spellings of "is the inbox on" would eventually disagree.
    followups: followupsEnabled(env),
    singleProject: env.CEZ_SINGLE_PROJECT === '1',
    automations: env.CEZ_AUTOMATIONS === '1',
    tokenMetrics: tokenUsageMetrics && costMetrics,
    tokenUsageMetrics,
    costMetrics,
  };
}
