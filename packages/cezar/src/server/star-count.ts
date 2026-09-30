import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';

/**
 * cezar's own GitHub star count, for the cockpit's ⭐ ask (sidebar chip + first-run toast).
 *
 * The count is read HERE and not in the browser, deliberately. The cockpit has never made a
 * third-party request and should not start: one cezar process asking once per TTL is strictly
 * less exposure than every open tab asking, it keeps working in remote mode where the browser
 * may not reach the internet at all, and it lets the whole promo sit behind one off switch the
 * server already owns.
 *
 * Failure is not exceptional here, it is the common case — offline, rate-limited (60/h per IP
 * unauthenticated), behind a proxy, `CEZ_NO_BANNER=1`. Every one of them answers
 * `{ available: false }` the way `server/github.ts` does, never an error and never a throw: a
 * promo that can break a cockpit is worse than a promo nobody sees.
 *
 * Two caches, both cheap: in memory for the life of the process, and a single small JSON file
 * under `~/.cache/cez/` so a restart (the desktop shell restarts often) paints the count
 * immediately and does not spend another request. A stale disk entry is still served while the
 * refresh is in flight — the number is decoration, and a slightly old one is better than a
 * flicker.
 */

const REPO = 'open-mercato/cezar';
export const CEZAR_REPO_URL = `https://github.com/${REPO}`;
const API_URL = `https://api.github.com/repos/${REPO}`;
const TIMEOUT_MS = 5_000;
/** Six hours. A star count moves slowly and nothing here depends on it being exact. */
export const STAR_CACHE_TTL_MS = 6 * 60 * 60_000;

export interface StarCount {
  /** `false` whenever there is no number to show — offline, rate-limited, or promos silenced.
   *  The cockpit renders no chip at all in that case; it never renders an empty one. */
  available: boolean;
  /** Only present when `available`. */
  count?: number;
  /** Where the ⭐ button points. Always sent, so the link never depends on the count. */
  url: string;
}

const UNAVAILABLE: StarCount = { available: false, url: CEZAR_REPO_URL };

/** The one field we want, validated at the boundary like every other `--json`/API read. */
const repoSchema = z
  .object({ stargazers_count: z.number().int().nonnegative() })
  .passthrough();

interface DiskEntry {
  count: number;
  fetchedAtMs: number;
}

const diskEntrySchema = z.object({
  count: z.number().int().nonnegative(),
  fetchedAtMs: z.number().int().nonnegative(),
});

export function starCachePath(home: string = homedir()): string {
  return join(home, '.cache', 'cez', 'star-count.json');
}

/**
 * The promo's single off switch (AGENTS.md § Zero config: a network widening needs one, and a
 * second spelling of an existing switch is a knob rather than a feature). `CEZ_NO_BANNER=1`
 * already means "no `open-mercato` promo in my terminal"; it now means no star ask anywhere —
 * no terminal line, no sidebar chip, no toast, and no request to github.com.
 */
export function starAskSilenced(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_NO_BANNER === '1';
}

/** One request, zod-validated, silent on every failure. `null` means "nothing known". */
export async function fetchStarCount(fetchImpl: typeof fetch = fetch): Promise<number | null> {
  try {
    const res = await fetchImpl(API_URL, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    const parsed = repoSchema.safeParse(await res.json());
    return parsed.success ? parsed.data.stargazers_count : null;
  } catch {
    return null;
  }
}

async function readDisk(path: string): Promise<DiskEntry | null> {
  try {
    const parsed = diskEntrySchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeDisk(path: string, entry: DiskEntry): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(entry), 'utf8');
  } catch {
    // A read-only home is not a reason to lose the count — the memory cache still holds it.
  }
}

export interface StarCountReaderOptions {
  fetchImpl?: typeof fetch;
  /** Injectable so tests never touch a real home. */
  cachePath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/**
 * Memoized reader behind `GET /api/v1/star-count`. Mirrors `self-update/registry.ts`'s
 * `RegistryCache` on purpose — same shape, same guarantees — with a disk tier added because this
 * value survives a restart usefully and a version document does not.
 */
export class StarCountReader {
  private count: number | null = null;
  private fetchedAtMs = 0;
  private inFlight: Promise<number | null> | null = null;
  private diskRead = false;

  private readonly fetchImpl: typeof fetch;
  private readonly cachePath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;

  constructor(options: StarCountReaderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cachePath = options.cachePath ?? starCachePath();
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
  }

  async read(): Promise<StarCount> {
    if (starAskSilenced(this.env)) return UNAVAILABLE;
    await this.seedFromDisk();
    if (this.count !== null && this.now() - this.fetchedAtMs < STAR_CACHE_TTL_MS) {
      return { available: true, count: this.count, url: CEZAR_REPO_URL };
    }
    const fresh = await this.refresh();
    // A failed refresh falls back to whatever is still held: a stale number beats no number,
    // and "no number" here would make the chip disappear on the first flaky minute.
    const count = fresh ?? this.count;
    return count === null ? UNAVAILABLE : { available: true, count, url: CEZAR_REPO_URL };
  }

  /** Once per process: fold a previous run's answer in before deciding to spend a request. */
  private async seedFromDisk(): Promise<void> {
    if (this.diskRead) return;
    this.diskRead = true;
    const entry = await readDisk(this.cachePath);
    if (!entry) return;
    this.count = entry.count;
    this.fetchedAtMs = entry.fetchedAtMs;
  }

  /** Always goes to GitHub, and never twice at once — a burst of cockpit tabs is one request. */
  private async refresh(): Promise<number | null> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = fetchStarCount(this.fetchImpl).then(async (count) => {
      if (count !== null) {
        this.count = count;
        this.fetchedAtMs = this.now();
        await writeDisk(this.cachePath, { count, fetchedAtMs: this.fetchedAtMs });
      }
      this.inFlight = null;
      return count;
    });
    return this.inFlight;
  }
}
