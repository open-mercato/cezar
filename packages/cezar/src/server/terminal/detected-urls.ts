import { connect } from 'node:net';

/**
 * Addresses a task's terminals printed (spec `.ai/specs/2026-10-07-task-workspace.md` §7:
 * "Cezar may detect URLs printed in terminal output and list them above the terminal,
 * deduplicated by address. Show whether each detected server is running.").
 *
 * Detection is the whole of cezar's automation here. Nothing is opened, fetched, or probed for
 * content — the spec is explicit that a detected address opens only when the user clicks
 * `Otwórz w Przeglądarce`, and the liveness check below is a TCP connect and nothing more.
 */

/**
 * `http(s)://host[:port][/path]` as a dev server prints it.
 *
 * Deliberately narrow. A terminal carries documentation links, package registry URLs and git
 * remotes, and listing those as "servers this task started" would be noise — so only loopback
 * and bare hostnames with an explicit port qualify, which is what a dev server announces and
 * what the Browser view can actually reach.
 */
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[a-z0-9-]+\.local)(?::\d{2,5})?(?:\/[^\s'"<>()[\]]*)?/gi;

/** How much of the previous chunk is re-scanned, so an address split across two PTY writes is
 *  still found whole. Longer than any address this pattern can match. */
export const SCAN_OVERLAP = 256;

export interface DetectedUrl {
  url: string;
  /** ISO timestamp of the most recent sighting. A re-print updates the existing row rather than
   *  adding one (spec §7). */
  lastSeenAt: string;
  /** Whether something is listening there right now. `null` until first probed. */
  running: boolean | null;
}

/**
 * Every address in a chunk of terminal output, normalized and in order of appearance.
 *
 * `0.0.0.0` becomes `localhost`: servers announce the interface they BOUND to, but that address
 * is not one a browser can usefully open, and the user means "the thing on my machine". A
 * trailing slash is dropped so `http://localhost:3000` and `http://localhost:3000/` are one row.
 */
export function findUrls(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = normalizeUrl(match[0]);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

export function normalizeUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.hostname === '0.0.0.0' || parsed.hostname === '[::1]' || parsed.hostname === '::1') {
    parsed.hostname = 'localhost';
  }
  const path = parsed.pathname === '/' ? '' : parsed.pathname;
  return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
}

/** The port a detected address answers on, with the protocol's default filled in. */
export function portOf(url: string): { host: string; port: number } | null {
  try {
    const parsed = new URL(url);
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
    return { host: parsed.hostname, port };
  } catch {
    return null;
  }
}

/** Addresses kept per task. A dev stack announces a handful; a log of request URLs (an e2e run,
 *  a proxy) announces thousands, and each one was a row, a chip and a socket per read. */
export const MAX_URLS_PER_RUN = 50;

/** Liveness probes open at once, across every reader. */
export const PROBE_CONCURRENCY = 8;

/** How long one host:port answer is reused. Shorter than the cockpit's 3 s poll, so a stopped
 *  server is still seen to stop; long enough that two readers cost one connection. */
export const PROBE_REUSE_MS = 1_000;

/** The row to evict: oldest sighting, and on a tie the one that was added first. */
function leastRecentlySeen(table: Map<string, DetectedUrl>): string {
  let oldest: DetectedUrl | undefined;
  for (const row of table.values()) if (!oldest || row.lastSeenAt < oldest.lastSeenAt) oldest = row;
  return oldest!.url;
}

/** How long a liveness probe waits before calling an address dead. Loopback answers in under a
 *  millisecond; anything slower is not a dev server the user is waiting on. */
const PROBE_TIMEOUT_MS = 400;

/**
 * Is anything listening there?
 *
 * A TCP connect, deliberately — not an HTTP request. cezar must not send a request to a server
 * a task started: that server is worktree code, the request could have side effects, and the
 * question being asked is only "is the port open". The socket is destroyed the instant it
 * connects.
 */
export function isListening(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  const target = portOf(url);
  if (!target) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const done = (answer: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(answer);
    };
    const socket = connect({ host: target.host, port: target.port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * The addresses one task's terminals have printed.
 *
 * Per run rather than per session, because the spec lists them for the TASK — a server started
 * in one tab is the same server whichever tab you are looking at — and deduplicated by address,
 * so restarting a dev server updates its row instead of growing the list. Bounded both ways: at
 * most `MAX_URLS_PER_RUN` rows a task, and one probe per host:port however many paths it printed.
 */
export class DetectedUrls {
  private byRun = new Map<string, Map<string, DetectedUrl>>();
  /** Recent answers by `host:port`, shared by every run and reader. */
  private probed = new Map<string, { at: number; answer: Promise<boolean> }>();
  private probing = 0;
  private waiting: Array<() => void> = [];

  /** Record every address in a chunk of this run's output. Returns true when anything changed,
   *  so a caller can skip publishing when nothing did. */
  record(runId: string, text: string, now = new Date()): boolean {
    const urls = findUrls(text);
    if (urls.length === 0) return false;
    let table = this.byRun.get(runId);
    if (!table) {
      table = new Map();
      this.byRun.set(runId, table);
    }
    const at = now.toISOString();
    for (const url of urls) {
      const existing = table.get(url);
      // A re-print updates the existing row (spec §7) — and clears a stale `running: false`, so a
      // restarted server is not left looking dead until the next probe.
      if (existing) {
        existing.lastSeenAt = at;
        existing.running = null;
      } else {
        while (table.size >= MAX_URLS_PER_RUN) table.delete(leastRecentlySeen(table));
        table.set(url, { url, lastSeenAt: at, running: null });
      }
    }
    return true;
  }

  list(runId: string): DetectedUrl[] {
    return [...(this.byRun.get(runId)?.values() ?? [])];
  }

  /** Probe every address of a run and fold the answers back in. */
  async refresh(
    runId: string,
    probe: (url: string) => Promise<boolean> = isListening,
    now = Date.now(),
  ): Promise<DetectedUrl[]> {
    const table = this.byRun.get(runId);
    if (!table) return [];
    for (const [key, entry] of this.probed) if (now - entry.at >= PROBE_REUSE_MS) this.probed.delete(key);
    const rows = [...table.values()];
    const answers = await Promise.all(rows.map((row) => this.probeOnce(row.url, probe, now)));
    rows.forEach((row, index) => {
      row.running = answers[index] ?? false;
    });
    return rows;
  }

  /** One probe per host:port — liveness is a property of the port, not of the path printed. */
  private probeOnce(url: string, probe: (url: string) => Promise<boolean>, now: number): Promise<boolean> {
    const target = portOf(url);
    const key = target ? `${target.host}:${target.port}` : url;
    const recent = this.probed.get(key);
    if (recent) return recent.answer;
    const answer = this.limited(() => probe(url));
    this.probed.set(key, { at: now, answer });
    return answer;
  }

  /** At most `PROBE_CONCURRENCY` probes open at once; a probe that throws is "not running". */
  private async limited(run: () => Promise<boolean>): Promise<boolean> {
    if (this.probing >= PROBE_CONCURRENCY) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.probing += 1;
    try {
      return await run();
    } catch {
      return false;
    } finally {
      // Hand the slot straight to the next waiter, so the count never dips and over-admits.
      const next = this.waiting.shift();
      if (next) next();
      else this.probing -= 1;
    }
  }

  /** Forget a task's addresses. For a deleted task, and for one whose terminals were all closed
   *  with the task archived. */
  forget(runId: string): void {
    this.byRun.delete(runId);
  }
}
