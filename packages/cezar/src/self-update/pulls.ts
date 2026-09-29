/**
 * cezar's own open pull requests, for the development channel's "PR builds" picker. CI publishes
 * a preview of every green same-repo PR under the npm dist-tag `pr-<N>` (spec
 * 2026-07-18-npm-preview-publish) and drops the tag when the PR closes — but tags older than that
 * cleanup job linger, so the tag list alone is not "open PRs". GitHub says which are open; the
 * registry says which have a build.
 *
 * `gh` first (it carries the user's auth), the public REST API second (`GITHUB_TOKEN` when set).
 * Never throws: no `gh`, offline or rate-limited is an empty list with a reason.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { z } from 'zod';

const exec = promisify(execFile);

/** The repository cezar's own releases and previews are cut from. */
export const CEZAR_REPO = 'open-mercato/cezar';

const TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 2 * 60_000;
const LIMIT = 100;

export interface OpenPull {
  number: number;
  title: string;
  author: string | null;
  branch: string;
  draft: boolean;
  updatedAt: string;
  url: string;
}

export interface OpenPulls {
  available: boolean;
  reason?: string;
  items: OpenPull[];
}

const ghRowSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  author: z.object({ login: z.string() }).nullish(),
  headRefName: z.string(),
  isDraft: z.boolean().catch(false),
  updatedAt: z.string(),
  url: z.string(),
});

const restRowSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  user: z.object({ login: z.string() }).nullish(),
  head: z.object({ ref: z.string() }),
  draft: z.boolean().catch(false),
  updated_at: z.string(),
  html_url: z.string(),
});

async function viaGh(repo: string): Promise<OpenPull[]> {
  const { stdout } = await exec(
    'gh',
    ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(LIMIT), '--json', 'number,title,author,headRefName,isDraft,updatedAt,url'],
    { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
  );
  return z
    .array(ghRowSchema)
    .parse(JSON.parse(stdout))
    .map((row) => ({
      number: row.number,
      title: row.title,
      author: row.author?.login ?? null,
      branch: row.headRefName,
      draft: row.isDraft,
      updatedAt: row.updatedAt,
      url: row.url,
    }));
}

async function viaRest(repo: string, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): Promise<OpenPull[]> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=${LIMIT}&sort=updated&direction=desc`, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return z
    .array(restRowSchema)
    .parse(await res.json())
    .map((row) => ({
      number: row.number,
      title: row.title,
      author: row.user?.login ?? null,
      branch: row.head.ref,
      draft: row.draft,
      updatedAt: row.updated_at,
      url: row.html_url,
    }));
}

export async function fetchOpenPulls(
  repo: string,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; gh?: (repo: string) => Promise<OpenPull[]> } = {},
): Promise<OpenPulls> {
  const env = opts.env ?? process.env;
  if (env.CEZ_DRY_RUN === '1') return { available: false, reason: 'Dry run: GitHub is not asked.', items: [] };
  let ghError: string;
  try {
    return { available: true, items: sortByUpdated(await (opts.gh ?? viaGh)(repo)) };
  } catch (error) {
    ghError = error instanceof Error ? error.message.split('\n')[0]! : String(error);
  }
  try {
    return { available: true, items: sortByUpdated(await viaRest(repo, env, opts.fetchImpl ?? fetch)) };
  } catch (error) {
    const rest = error instanceof Error ? error.message : String(error);
    return { available: false, reason: `Could not list pull requests (gh: ${ghError}; GitHub API: ${rest}).`, items: [] };
  }
}

function sortByUpdated(items: OpenPull[]): OpenPull[] {
  return [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** A short-lived memo, so reopening the dialog does not cost a GitHub round trip each time. */
export class OpenPullsCache {
  private value: OpenPulls | null = null;
  private at = 0;
  private inFlight: Promise<OpenPulls> | null = null;

  constructor(private readonly load: () => Promise<OpenPulls>) {}

  async get(refresh = false): Promise<OpenPulls> {
    if (!refresh && this.value && Date.now() - this.at < CACHE_TTL_MS) return this.value;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.load().then((value) => {
      // Keep the last good list over a failed refresh.
      if (value.available || !this.value) {
        this.value = value;
        this.at = Date.now();
      }
      this.inFlight = null;
      return this.value!;
    });
    return this.inFlight;
  }
}

/** The PR number a preview version was cut for (`0.13.0-pr1169.1234` → 1169), else null. */
export function pullOfVersion(version: string): number | null {
  const match = /-pr(\d+)\./.exec(version);
  return match ? Number(match[1]) : null;
}
