import { z } from 'zod';
import {
  createSwrCache,
  deleteKeysWithPrefix,
  execTool,
  fetchBoundedPages,
  isNotFound,
  registerProjectCacheEvictor,
  runCli,
} from './cli.ts';
import { PUSH_TIMEOUT_MS, preparePublish, tail } from './draft-pr.ts';
import {
  GH_CHECKS_MAX,
  GH_SEARCH_MAX,
  GithubPrNotFoundError,
  TIMELINE_EVENT_CAP,
  THREAD_ENTRY_CAP,
} from './github.ts';
import type { ParsedRemote } from './index.ts';
import {
  FORGE_PR_DIFF_FILE_CAP,
  FORGE_PR_DIFF_JSON_CAP,
  FORGE_PR_PATCH_CAP,
  TIMELINE_BUDGET_MS,
  TIMELINE_MAX_PAGES,
  TIMELINE_MIN_PAGE_MS,
} from './limits.ts';
import type {
  DraftPrInput,
  DraftPrOutcome,
  ForgeAvailability,
  ForgeChecksData,
  ForgeChecksGlyph,
  ForgeComment,
  ForgeCommentsData,
  ForgeDriver,
  ForgeItem,
  ForgeListData,
  ForgeListOptions,
  ForgePrChange,
  ForgePrDiffResult,
  ForgePrStatus,
  ForgeSearchData,
  ForgeTimelineEvent,
  ForgeTimelineEventKind,
} from './types.ts';

/**
 * The GitLab forge driver (spec 2026-08-10-forge-provider-adapters, Phase 3) — every `glab` call
 * runs with `cwd = repoRoot` through `forge/cli.ts`, so `glab` resolves the host and project from
 * the repo's own remote and its own host config; cezar never builds a project id from the path.
 *
 * Step 3.1 built the skeleton: availability (`detect` / `detectCached`) and registration. Step 3.2
 * adds the list tier (`listIssues`/`listPRs`/`listAll`) — both open-only, mirroring `fetchGithub`'s
 * `GET /github` tier. Step 3.3 adds `listComments` — the conversation thread, assembled from the
 * notes + resource-event endpoints since GitLab has no single timeline call like GitHub's. Step 3.4
 * adds `listChecks` (per-MR pipeline glyphs) and `prStatus` (the branch's newest merge request).
 * Step 3.5 adds `prDiff` — bounded file changes, forge-neutral caps (`forge/limits.ts`). Step 3.6
 * adds `searchItems` — the open-only list tier's escape hatch into every state, mirroring GitHub's
 * `searchGithubItems` (#730). Step 3.7 adds `viewUrl` — GitLab's own `/-/` path grammar, based off
 * `gitlabWebBase` (the cached `web_url`, falling back to `origin` + `path`). Step 4.1 adds
 * `createPR` — draft merge requests from the review gate. `refStatus` and the
 * merge-panel capabilities (`prMergeState`, `mergePR`) stay absent for good (spec Non-goals) — the
 * routes already degrade in the payload.
 */

/** The ENOENT hint (spec § Edge Cases — glab not installed). A literal rather than
 *  `notFoundReason('glab')`: the spec pins this wording, which names the product to install. */
export const GLAB_NOT_FOUND_REASON = 'glab CLI not found — install the GitLab CLI and run `glab auth login`';

/** Same TTL as GitHub's availability probe, so both forges' nav items refresh on one rhythm. */
const CACHE_MS = 60_000;
const DETECT_CACHE_MAX = 50;

/** The two fields of `glab repo view --output json` cezar keeps — everything else is stripped. */
const glabProjectSchema = z.object({
  web_url: z.string().url(),
  path_with_namespace: z.string().min(1),
});

export interface GitlabProjectInfo {
  /** The project's own web URL — exact even on an instance served under a path prefix. */
  webUrl: string;
  pathWithNamespace: string;
}

/** Per-root project identity from the last successful probe (feeds `viewUrl`, Step 3.7). Bounded
 *  like the probe cache; a failed probe leaves the last known identity in place. */
const projectInfo = new Map<string, GitlabProjectInfo>();

function rememberProject(repoRoot: string, info: GitlabProjectInfo): void {
  projectInfo.delete(repoRoot); // re-insert so this root becomes the newest
  projectInfo.set(repoRoot, info);
  while (projectInfo.size > DETECT_CACHE_MAX) {
    const oldest = projectInfo.keys().next();
    if (oldest.done) break;
    projectInfo.delete(oldest.value);
  }
}

/** The project's `web_url` as `glab` last reported it for `repoRoot`, or null before a probe. */
export function gitlabProjectWebUrl(repoRoot: string): string | null {
  return projectInfo.get(repoRoot)?.webUrl ?? null;
}

/** The project's `path_with_namespace` as `glab` last reported it for `repoRoot`, or null. */
export function gitlabProjectPath(repoRoot: string): string | null {
  return projectInfo.get(repoRoot)?.pathWithNamespace ?? null;
}

/** The project's web root: the cached `web_url` from a successful probe (exact even on a
 *  non-root instance — Minor 5, spec 2026-08-10-forge-provider-adapters), or `origin + path`
 *  (Step 2.3) when nothing has been probed yet. Null only when neither is known. Shared by
 *  `listComments` (Step 3.3, note/timeline URLs) and `viewUrl` (Step 3.7) so the two paths can
 *  never disagree about where "this project" lives; a trailing slash is stripped either way. */
function gitlabWebBase(repoRoot: string, parsed: ParsedRemote): string | null {
  const cached = gitlabProjectWebUrl(repoRoot);
  const base = cached ?? (parsed.origin && parsed.path ? `${parsed.origin}/${parsed.path}` : null);
  return base ? base.replace(/\/+$/, '') : null;
}

function glab(repoRoot: string, args: string[], timeout = 15_000): Promise<string> {
  return runCli('glab', repoRoot, args, { timeoutMs: timeout, maxBuffer: 50 * 1024 * 1024 });
}

function firstLine(s: string): string {
  return s.split('\n').find((l) => l.trim().length > 0)?.trim() ?? 'glab failed';
}

/** The message of a boxed glab error, re-joined into one line — or null when `stderr` has no box.
 *  glab 1.118's CLI commands (`repo view`, `issue list`, `mr create`, …) print a failure as a
 *  padded banner — a blank line, `ERROR`, a blank line — then the message word-wrapped over several
 *  lines, so a first-line reader saw only "ERROR" and a tail reader saw the wrap's fragments
 *  (verified live against gitlab.com, review of roszekF/cezar#1). `glab api` and older releases
 *  print one plain line and keep their existing handling. */
function glabBoxedError(stderr: string): string | null {
  const lines = stderr.split('\n').map((l) => l.trim());
  const banner = lines.lastIndexOf('ERROR');
  if (banner < 0) return null;
  const message = lines.slice(banner + 1).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return message || null;
}

/** `glab`'s own words for a failure: the boxed message or first stderr line when the error
 *  carries stderr (a non-zero exit), else the error message's first line. `execFile`'s message
 *  starts with "Command failed: glab …", which says nothing the user can act on. */
function glabFailureReason(err: unknown): string {
  const stderr = typeof err === 'object' && err !== null ? (err as { stderr?: unknown }).stderr : undefined;
  if (typeof stderr === 'string' && stderr.trim()) return glabBoxedError(stderr) ?? firstLine(stderr);
  return firstLine(err instanceof Error ? err.message : String(err));
}

/** `glab repo view` as the availability probe — auth and project existence in one call. Never
 *  rejects: a failure is an answer to cache. */
async function probeGitlab(repoRoot: string): Promise<ForgeAvailability> {
  let stdout: string;
  try {
    stdout = await glab(repoRoot, ['repo', 'view', '--output', 'json'], 5_000);
  } catch (err) {
    return { available: false, reason: isNotFound(err) ? GLAB_NOT_FOUND_REASON : glabFailureReason(err) };
  }
  let project: z.infer<typeof glabProjectSchema>;
  try {
    project = glabProjectSchema.parse(JSON.parse(stdout));
  } catch {
    return { available: false, reason: 'glab repo view returned an unexpected response' };
  }
  rememberProject(repoRoot, { webUrl: project.web_url, pathWithNamespace: project.path_with_namespace });
  return { available: true };
}

/** Cached availability probe, one entry per project — GitHub's `detectCache` semantics. */
const detectCache = createSwrCache<string, ForgeAvailability>({
  ttlMs: CACHE_MS,
  max: DETECT_CACHE_MAX,
  load: probeGitlab,
});

function detectGitlab(repoRoot: string): Promise<ForgeAvailability> {
  if (process.env.CEZ_DRY_RUN === '1') return Promise.resolve({ available: true });
  return detectCache.get(repoRoot);
}

/**
 * Non-blocking availability for `GET /api/health`: the last-known probe (even stale, while it
 * revalidates off the request path — the #508 anti-flicker guarantee), or null only when cold.
 * Never shells out on the read.
 */
export function detectGitlabCached(repoRoot: string): ForgeAvailability | null {
  if (process.env.CEZ_DRY_RUN === '1') return { available: true };
  return detectCache.peek(repoRoot);
}

// Everything GitLab caches per root, for `evictForgeProjectCaches` (project removed/re-pointed).
registerProjectCacheEvictor((repoRoot) => {
  detectCache.delete(repoRoot);
  projectInfo.delete(repoRoot);
});

// ---- listIssues / listPRs / listAll (Step 3.2) -----------------------------------------------
// `glab issue list` / `glab mr list` — both OPEN-only by default, matching GitHub's list tier
// (`gh issue/pr list` also defaults to `--state open`). Always the LONG `--output json` spelling:
// `glab`'s short `-F`/`-O` flags mean different things between `issue list` and `mr list` (Drift
// note, spec 2026-08-10-forge-provider-adapters), so the long form is the only one that reads the
// same on both commands.

/** Item body cap — identical to GitHub's (`github.ts` slices `body` the same way). */
const ITEM_BODY_CAP = 8_000;

/** GitLab's own `--per-page` ceiling: the API clamps any larger request server-side, and `glab
 *  issue/mr list` makes exactly one call (no `--all` walk here — Step 3.2 is the open-only list
 *  tier, not the bounded multi-page reader Steps 3.3/3.5 need). A `limit` beyond this is the
 *  documented cap, mirroring GitHub's `GH_MAX_LIMIT` clamp but for GitLab's own ceiling. */
export const GL_MAX_LIMIT = 100;

// `gl…` = GitLab REST fields, straight off `glab issue/mr list --output json` (the same shape as
// the GitLab REST API — glab's JSON output IS the REST response). Extras are stripped by zod.
const glAuthorSchema = z.object({ username: z.string() }).nullish();
const glIssueRowSchema = z.object({
  iid: z.number(),
  title: z.string(),
  author: glAuthorSchema,
  created_at: z.string(),
  labels: z.array(z.string()).default([]),
  description: z.string().nullish(),
  web_url: z.string(),
  user_notes_count: z.number().default(0),
});
// MRs carry both the current `draft` field and the legacy `work_in_progress` one — some GitLab
// versions/API paths still only set the latter (D5, spec Step 3.2).
const glMrRowSchema = glIssueRowSchema.extend({
  draft: z.boolean().default(false),
  work_in_progress: z.boolean().default(false),
});
type GlIssueRow = z.infer<typeof glIssueRowSchema>;
type GlMrRow = z.infer<typeof glMrRowSchema>;

function toForgeItem(kind: 'issue', row: GlIssueRow): ForgeItem;
function toForgeItem(kind: 'pr', row: GlMrRow): ForgeItem;
function toForgeItem(kind: 'issue' | 'pr', row: GlIssueRow | GlMrRow): ForgeItem {
  const base: ForgeItem = {
    kind,
    number: row.iid, // NOT `id` — `iid` is the project-scoped number the cockpit and links use.
    title: row.title,
    author: row.author?.username ?? '?',
    createdAt: row.created_at,
    labels: row.labels,
    body: (row.description ?? '').slice(0, ITEM_BODY_CAP),
    url: row.web_url,
    comments: row.user_notes_count,
  };
  if (kind === 'pr') {
    const mr = row as GlMrRow;
    // `checks: null` per D5 — hydrated lazily via `listChecks` once Step 3.4 lands, exactly like
    // GitHub's list tier has done since #664.
    return { ...base, isDraft: mr.draft || mr.work_in_progress, checks: null };
  }
  return base;
}

const glLabelRowSchema = z.object({ name: z.string(), color: z.string() });

/** Best-effort repo-wide `label name → 6-hex color` map (no `#`, matching the form GitHub's
 *  `labelColors` uses). `:fullpath` is glab's own placeholder — resolved from the repo's remote,
 *  never a path cezar builds (Minor 5, spec 2026-08-10-forge-provider-adapters). Returns `null` on
 *  any failure so the caller can leave `labelColors` off the payload rather than fail the list. */
async function fetchGitlabLabelColors(repoRoot: string): Promise<Record<string, string> | null> {
  try {
    const out = await glab(repoRoot, ['api', 'projects/:fullpath/labels?per_page=100'], 10_000);
    const rows = z.array(glLabelRowSchema).parse(JSON.parse(out));
    const colors: Record<string, string> = {};
    for (const row of rows) {
      const hex = row.color.replace(/^#/, '').toLowerCase();
      if (hex && !colors[row.name]) colors[row.name] = hex;
    }
    return colors;
  } catch {
    return null;
  }
}

/** Same TTL/bound as the detect cache, keyed by `repoRoot` — one cached listing per project, a
 *  cached fetch with a bigger `limit` than asked serves fine (superset), mirroring `fetchGithub`'s
 *  `listCache`. */
const listCache = new Map<string, { at: number; limit: number; data: ForgeListData }>();
const LIST_CACHE_MAX = 50;

registerProjectCacheEvictor((repoRoot) => listCache.delete(repoRoot));

/** CEZ_DRY_RUN=1 — a small fixed catalog on a demo gitlab.com project, mirroring GitHub's
 *  `mockGithub` so the tab is demoable offline for either forge. */
function mockGitlabList(): ForgeListData {
  const now = Date.now();
  return {
    available: true,
    repo: 'demo/demo',
    syncedAt: new Date(now).toISOString(),
    issues: [
      {
        kind: 'issue',
        number: 1,
        title: 'Pipeline fails on forked merge requests',
        author: 'demo',
        createdAt: new Date(now - 3_600_000).toISOString(),
        labels: ['bug'],
        body: 'CI jobs that need protected variables are skipped on a forked MR, so the pipeline reports failed rather than skipped.',
        url: 'https://gitlab.com/demo/demo/-/issues/1',
        comments: 2,
      },
    ],
    prs: [
      {
        kind: 'pr',
        number: 1,
        title: 'Draft: wire up the release pipeline',
        author: 'demo',
        createdAt: new Date(now - 7_200_000).toISOString(),
        labels: ['ci'],
        body: 'Adds the `.gitlab-ci.yml` release stage. Still needs the tag-protection rule before review.',
        url: 'https://gitlab.com/demo/demo/-/merge_requests/1',
        comments: 1,
        isDraft: true,
        checks: null,
      },
    ],
    labelColors: { bug: 'd73a4a', ci: '6699cc' },
  };
}

/** The `GET /api/github` listing for a GitLab remote — both open sets, repo handle and best-effort
 *  label colors, cached and refreshable exactly like `fetchGithub`. Never throws: a CLI failure,
 *  missing binary or malformed payload all land on `{available: false, reason}`. */
async function fetchGitlabList(repoRoot: string, parsed: ParsedRemote, opts?: ForgeListOptions): Promise<ForgeListData> {
  if (process.env.CEZ_DRY_RUN === '1') return mockGitlabList();
  const capped = Math.min(Math.max(opts?.limit ?? 30, 1), GL_MAX_LIMIT);
  const refresh = !!opts?.refresh;
  const hit = listCache.get(repoRoot);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS && hit.limit >= capped) return hit.data;
  try {
    const [issuesOut, prsOut] = await Promise.all([
      glab(repoRoot, ['issue', 'list', '--output', 'json', '--per-page', String(capped)], 15_000),
      glab(repoRoot, ['mr', 'list', '--output', 'json', '--per-page', String(capped)], 15_000),
    ]);
    let issueRows: GlIssueRow[];
    try {
      issueRows = z.array(glIssueRowSchema).parse(JSON.parse(issuesOut));
    } catch {
      return { available: false, reason: 'glab issue list returned an unexpected response', issues: [], prs: [] };
    }
    let mrRows: GlMrRow[];
    try {
      mrRows = z.array(glMrRowSchema).parse(JSON.parse(prsOut));
    } catch {
      return { available: false, reason: 'glab mr list returned an unexpected response', issues: [], prs: [] };
    }
    const labelColors = await fetchGitlabLabelColors(repoRoot);
    const data: ForgeListData = {
      available: true,
      repo: parsed.path,
      syncedAt: new Date().toISOString(),
      issues: issueRows.map((row) => toForgeItem('issue', row)),
      prs: mrRows.map((row) => toForgeItem('pr', row)),
      ...(labelColors ? { labelColors } : {}),
    };
    listCache.delete(repoRoot); // re-insert so this key becomes the newest
    listCache.set(repoRoot, { at: Date.now(), limit: capped, data });
    while (listCache.size > LIST_CACHE_MAX) {
      const oldest = listCache.keys().next();
      if (oldest.done) break;
      listCache.delete(oldest.value);
    }
    return data;
  } catch (err) {
    const reason = isNotFound(err) ? GLAB_NOT_FOUND_REASON : glabFailureReason(err);
    return { available: false, reason, issues: [], prs: [] };
  }
}

// ---- listComments with timeline events (Step 3.3) --------------------------------------------
// GitLab has no single "timeline" endpoint like GitHub's — the conversation thread is assembled
// from THREE `glab api` calls: the notes (user comments + system notes in one stream), the label
// events and the state-change events. Every one of them runs through the shared bounded-page loop
// on GitHub's own budget constants (spec 2026-08-10-forge-provider-adapters, Step 3.3: "page
// through fetchBoundedPages with GitHub's budget constants"), so a huge thread degrades the same
// way on either forge rather than hanging the request. MR approvals are GitLab's own resource, not
// a note or an event `glab api` exposes here, and are deliberately NOT synthesized as
// `kind:'review'` — GitHub's `reviewed` timeline rows are the one thing this thread does not mirror.

const COMMENT_BODY_CAP = 8_000;
const NOTES_PAGE_SIZE = 100;

const glNoteAuthorSchema = z.object({ username: z.string(), avatar_url: z.string().nullish() }).nullish();
const glNoteSchema = z.object({
  id: z.number(),
  body: z.string().nullish(),
  author: glNoteAuthorSchema,
  created_at: z.string(),
  system: z.boolean(),
});
type GlNoteRow = z.infer<typeof glNoteSchema>;

const glLabelEventSchema = z.object({
  id: z.number(),
  user: z.object({ username: z.string(), avatar_url: z.string().nullish() }).nullish(),
  created_at: z.string(),
  action: z.string(), // 'add' | 'remove' — a third value (none exists today) simply drops the row
  label: z.object({ name: z.string(), color: z.string().nullish() }).nullish(),
});
type GlLabelEventRow = z.infer<typeof glLabelEventSchema>;

const glStateEventSchema = z.object({
  id: z.number(),
  user: z.object({ username: z.string(), avatar_url: z.string().nullish() }).nullish(),
  created_at: z.string(),
  state: z.string(),
});
type GlStateEventRow = z.infer<typeof glStateEventSchema>;

/** `state` values `glab api …/resource_state_events` reports that this thread renders — an
 *  allowlist over `ForgeTimelineEventKind`, never widened (types.ts). GitLab also emits other
 *  transitions (locked-adjacent housekeeping) this endpoint doesn't return today; if it ever does,
 *  an unmapped `state` is dropped exactly like an unmapped system note. */
const STATE_EVENT_KIND: Record<string, ForgeTimelineEventKind> = {
  closed: 'closed',
  reopened: 'reopened',
  merged: 'merged',
};

/** `created_at` normalized to a sortable ISO string, or null when it doesn't parse — dropped
 *  rather than merged at an arbitrary spot in the thread (mirrors `normalizeEvents` in github.ts). */
function isoOrNull(raw: string): string | null {
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** GitLab renders some system notes (title changes) with an HTML diff of the old/new value baked
 *  into `body`. Stripping tags recovers the plain "changed title from X to Y" text regardless of
 *  how much of X and Y the diff highlighted, without parsing the diff markup itself. */
function stripHtml(body: string): string {
  // Repeated to a fixpoint (CodeQL js/incomplete-multi-character-sanitization). With this regex one
  // pass already is one — every `<` that has a later `>` is consumed — so the loop costs a single
  // extra comparison; it keeps that guarantee explicit rather than resting on the regex's shape.
  // The result is only ever matched against `SYSTEM_NOTE_RULES` and rendered as React text.
  let plain = body;
  let previous: string;
  do {
    previous = plain;
    plain = plain.replace(/<[^>]+>/g, '');
  } while (plain !== previous);
  return plain;
}

/** Table-driven, conservative system-note → event mapping (spec Step 3.3): a note whose stripped
 *  text matches none of these is dropped, exactly like an unrecognized GitHub timeline kind. Order
 *  matters only in that `assigned`/`unassigned` are distinct prefixes — never ambiguous. */
const SYSTEM_NOTE_RULES: ReadonlyArray<{ kind: ForgeTimelineEventKind; subject: (plain: string) => string | undefined }> = [
  { kind: 'assigned', subject: (plain) => /^assigned to @([\w.-]+)/.exec(plain)?.[1] },
  { kind: 'unassigned', subject: (plain) => /^unassigned @([\w.-]+)/.exec(plain)?.[1] },
  { kind: 'renamed', subject: (plain) => /^changed title from .+ to (.+)$/s.exec(plain)?.[1]?.trim() },
];

function toForgeComment(row: GlNoteRow, urlBase: string, kind: 'issue' | 'pr', number: number): ForgeComment {
  const segment = kind === 'issue' ? 'issues' : 'merge_requests';
  return {
    id: row.id,
    author: row.author?.username ?? '?',
    avatarUrl: row.author?.avatar_url ?? undefined,
    createdAt: isoOrNull(row.created_at) ?? row.created_at,
    body: (row.body ?? '').slice(0, COMMENT_BODY_CAP),
    kind: 'comment',
    url: `${urlBase}/-/${segment}/${number}#note_${row.id}`,
  };
}

function toLabelEvent(row: GlLabelEventRow): ForgeTimelineEvent | null {
  const kind: ForgeTimelineEventKind | null = row.action === 'add' ? 'labeled' : row.action === 'remove' ? 'unlabeled' : null;
  if (!kind) return null; // an unmapped action → dropped, never rendered
  const createdAt = isoOrNull(row.created_at);
  if (!createdAt) return null;
  const event: ForgeTimelineEvent = { id: `evt-${row.id}`, kind, actor: row.user?.username ?? '?', createdAt };
  if (row.user?.avatar_url) event.avatarUrl = row.user.avatar_url;
  if (row.label) {
    event.label = { name: row.label.name };
    // Normalized to 6-hex, no `#` — the same form `fetchGitlabLabelColors` produces.
    if (row.label.color) event.label.color = row.label.color.replace(/^#/, '').toLowerCase();
  }
  return event;
}

function toStateEvent(row: GlStateEventRow): ForgeTimelineEvent | null {
  const kind = STATE_EVENT_KIND[row.state];
  if (!kind) return null; // an unknown state → dropped, never rendered
  const createdAt = isoOrNull(row.created_at);
  if (!createdAt) return null;
  const event: ForgeTimelineEvent = { id: `evt-${row.id}`, kind, actor: row.user?.username ?? '?', createdAt };
  if (row.user?.avatar_url) event.avatarUrl = row.user.avatar_url;
  return event;
}

function toSystemNoteEvent(row: GlNoteRow): ForgeTimelineEvent | null {
  const plain = stripHtml(row.body ?? '').trim();
  for (const rule of SYSTEM_NOTE_RULES) {
    const subject = rule.subject(plain);
    if (!subject) continue;
    const createdAt = isoOrNull(row.created_at);
    if (!createdAt) return null;
    const event: ForgeTimelineEvent = { id: `evt-${row.id}`, kind: rule.kind, actor: row.author?.username ?? '?', createdAt, subject };
    if (row.author?.avatar_url) event.avatarUrl = row.author.avatar_url;
    return event;
  }
  return null; // e.g. "added N commit(s)", "requested review from @x" — conservative, dropped
}

/** One `glab api` endpoint under the notes call's page loop and budget — used for both
 *  `resource_label_events` and `resource_state_events`, which share the same paging shape. */
async function fetchGitlabResourceEvents<T>(
  repoRoot: string,
  endpointBase: string,
  resource: string,
  schema: z.ZodType<T>,
): Promise<{ rows: T[]; stoppedShort: boolean }> {
  const pages = await fetchBoundedPages(
    (page, timeoutMs) => glab(repoRoot, ['api', `${endpointBase}/${resource}?per_page=${NOTES_PAGE_SIZE}&page=${page}`], timeoutMs),
    { maxPages: TIMELINE_MAX_PAGES, budgetMs: TIMELINE_BUDGET_MS, minPageMs: TIMELINE_MIN_PAGE_MS, pageSize: NOTES_PAGE_SIZE },
  );
  return { rows: z.array(schema).parse(pages.rows), stoppedShort: pages.stoppedShort };
}

/** Per-thread cache, same shape and TTL as the list cache — keyed `repoRoot\0kind#number` so two
 *  projects' issue/MR #42 can never collide (the bug the Drift note found in the GitHub prefix
 *  eviction: `evictForgeProjectCaches` here uses `deleteKeysWithPrefix` from the start). */
const commentsCache = new Map<string, { at: number; data: ForgeCommentsData }>();
const COMMENTS_CACHE_MAX = 50;

function cacheComments(key: string, data: ForgeCommentsData): void {
  commentsCache.delete(key); // re-insert so this key becomes the newest
  commentsCache.set(key, { at: Date.now(), data });
  while (commentsCache.size > COMMENTS_CACHE_MAX) {
    const oldest = commentsCache.keys().next();
    if (oldest.done) break;
    commentsCache.delete(oldest.value);
  }
}

registerProjectCacheEvictor((repoRoot) => deleteKeysWithPrefix(commentsCache, `${repoRoot}\0`));

/** CEZ_DRY_RUN=1 — a small fixed thread (one comment, one labeled event), mirroring GitHub's
 *  `mockGithubComments` closely enough to demo the feature offline for either forge. */
function mockGitlabComments(kind: 'issue' | 'pr'): ForgeCommentsData {
  const base = Date.now() - 3_600_000;
  const at = (offset: number) => new Date(base + offset).toISOString();
  const segment = kind === 'issue' ? 'issues' : 'merge_requests';
  return {
    available: true,
    comments: [
      {
        id: 1,
        author: 'demo',
        avatarUrl: 'https://gitlab.com/uploads/-/system/user/avatar/1/avatar.png',
        createdAt: at(0),
        body: 'Thanks for the report — I can reproduce it on a forked pipeline.',
        kind: 'comment',
        url: `https://gitlab.com/demo/demo/-/${segment}/1#note_1`,
      },
    ],
    events: [
      {
        id: 'evt-100',
        kind: 'labeled',
        actor: 'demo',
        createdAt: at(600_000),
        label: { name: 'bug', color: 'd73a4a' },
      },
    ],
  };
}

/** The `GET /api/github/comments/:kind/:number` payload for a GitLab remote (Step 3.3). Never
 *  throws: a CLI failure, missing binary or malformed payload on the notes call (page 1) all land
 *  on `{available: false, reason, comments: []}`; a failure on the label/state event endpoints
 *  degrades to comments-only — same "timeline degraded to comments-only" shape GitHub's driver
 *  answers on its own endpoint failures. */
async function fetchGitlabComments(
  repoRoot: string,
  parsed: ParsedRemote,
  kind: 'issue' | 'pr',
  number: number,
  refresh = false,
): Promise<ForgeCommentsData> {
  if (process.env.CEZ_DRY_RUN === '1') return mockGitlabComments(kind);
  const key = `${repoRoot}\0${kind}#${number}`;
  const hit = commentsCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const endpointBase = `projects/:fullpath/${kind === 'issue' ? 'issues' : 'merge_requests'}/${number}`;

  let notesRows: unknown[];
  let notesStoppedShort: boolean;
  try {
    const pages = await fetchBoundedPages(
      (page, timeoutMs) =>
        glab(
          repoRoot,
          ['api', `${endpointBase}/notes?per_page=${NOTES_PAGE_SIZE}&sort=asc&order_by=created_at&page=${page}`],
          timeoutMs,
        ),
      { maxPages: TIMELINE_MAX_PAGES, budgetMs: TIMELINE_BUDGET_MS, minPageMs: TIMELINE_MIN_PAGE_MS, pageSize: NOTES_PAGE_SIZE },
    );
    notesRows = pages.rows;
    notesStoppedShort = pages.stoppedShort;
  } catch (err) {
    const reason = isNotFound(err) ? GLAB_NOT_FOUND_REASON : glabFailureReason(err);
    return { available: false, reason, comments: [] };
  }

  let notes: GlNoteRow[];
  try {
    notes = z.array(glNoteSchema).parse(notesRows);
  } catch {
    return { available: false, reason: 'glab api notes returned an unexpected response', comments: [] };
  }

  // Step 3.7 factors this out into `gitlabWebBase`, shared with `viewUrl` — same fallback chain,
  // no behaviour change here (the shared helper always resolves for a real parsed remote).
  const urlBase = gitlabWebBase(repoRoot, parsed) ?? `${parsed.origin}/${parsed.path}`;
  const commentRows = notes.filter((n) => !n.system);
  const systemNoteRows = notes.filter((n) => n.system);

  const sortedComments = commentRows
    .map((row) => toForgeComment(row, urlBase, kind, number))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const commentsTruncated = sortedComments.length > THREAD_ENTRY_CAP;
  const comments = commentsTruncated ? sortedComments.slice(0, THREAD_ENTRY_CAP) : sortedComments;

  let events: ForgeTimelineEvent[] | undefined;
  let eventsTruncated = false;
  let eventsStoppedShort = false;
  try {
    const [labelEvents, stateEvents] = await Promise.all([
      fetchGitlabResourceEvents(repoRoot, endpointBase, 'resource_label_events', glLabelEventSchema),
      fetchGitlabResourceEvents(repoRoot, endpointBase, 'resource_state_events', glStateEventSchema),
    ]);
    const merged = [
      ...labelEvents.rows.map(toLabelEvent),
      ...stateEvents.rows.map(toStateEvent),
      ...systemNoteRows.map(toSystemNoteEvent),
    ]
      .filter((e): e is ForgeTimelineEvent => e !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    eventsTruncated = merged.length > TIMELINE_EVENT_CAP;
    // slice(-cap), not slice(0, cap) — keep the NEWEST events, same rationale as normalizeEvents.
    events = eventsTruncated ? merged.slice(-TIMELINE_EVENT_CAP) : merged;
    eventsStoppedShort = labelEvents.stoppedShort || stateEvents.stoppedShort;
  } catch {
    // Resource-event endpoints failing degrades to comments-only — `events` stays absent, exactly
    // like GitHub's timeline-fetch failure substituting the legacy comments-only call.
    events = undefined;
  }

  const data: ForgeCommentsData = {
    available: true,
    comments,
    truncated: commentsTruncated || eventsTruncated || notesStoppedShort || eventsStoppedShort || undefined,
  };
  if (events) data.events = events;
  cacheComments(key, data);
  return data;
}

// ---- listChecks / prStatus (Step 3.4) ---------------------------------------------------------
// GitLab has no batched-checks endpoint like GitHub's one aliased GraphQL query — the pipeline
// rollup lives on each MR's own detail (`head_pipeline.status`), so `listChecks` fans out with
// BOUNDED CONCURRENCY instead. `glab mr/issue list` payloads never carry it (Drift note, spec
// 2026-08-10-forge-provider-adapters), hence the per-MR `glab api` call either capability needs.

/** `glab api projects/:fullpath/merge_requests/:iid` — only the two fields either caller here
 *  needs: the pipeline rollup (`listChecks`/`prStatus`) and the head SHA (`prDiff`, Step 3.5). */
const glMrDetailSchema = z.object({
  sha: z.string().optional(),
  head_pipeline: z.object({ status: z.string() }).nullish(),
});
type GlMrDetail = z.infer<typeof glMrDetailSchema>;

/** One MR detail call's own ceiling. `listChecks` hands it whatever is left of the fan-out's
 *  shared budget instead, whichever is smaller. */
const MR_DETAIL_TIMEOUT_MS = 10_000;

async function fetchGitlabMrDetail(repoRoot: string, iid: number, timeoutMs = MR_DETAIL_TIMEOUT_MS): Promise<GlMrDetail> {
  const out = await glab(repoRoot, ['api', `projects/:fullpath/merge_requests/${iid}`], timeoutMs);
  return glMrDetailSchema.parse(JSON.parse(out));
}

/** GitLab pipeline `status` → the checks glyph (spec Step 3.4). `canceled`/`canceling`/`skipped`/
 *  `manual` and "no pipeline at all" both render no glyph — kept as two branches (map miss vs.
 *  absent `head_pipeline`) only because `pipelineGlyph` folds them the same way. */
const GL_PIPELINE_GLYPH: Record<string, ForgeChecksGlyph> = {
  success: 'passing',
  failed: 'failing',
  running: 'pending',
  pending: 'pending',
  created: 'pending',
  waiting_for_resource: 'pending',
  preparing: 'pending',
  scheduled: 'pending',
  canceled: null,
  canceling: null,
  skipped: null,
  manual: null,
};

function pipelineGlyph(status: string | undefined | null): ForgeChecksGlyph {
  if (!status) return null; // no `head_pipeline` at all — never ran
  return GL_PIPELINE_GLYPH[status] ?? null;
}

/** Runs `fn` over `items` with at most `limit` in flight at once. GitLab's per-MR checks probe has
 *  no batched endpoint to alias (unlike GitHub's single GraphQL query, `fetchPrChecks`), so this
 *  bounds the fan-out instead of either serializing every call or firing them all at once. */
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      // In range by the line above; the check is how the checker sees that, and it also covers a
      // `T` that genuinely holds `undefined` (this path's `T` is `number`).
      if (item === undefined) continue;
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const CHECKS_CONCURRENCY = 5;

/** ONE deadline for the WHOLE checks fan-out — the same budget every other multi-call GitLab path
 *  runs under (`fetchBoundedPages`). Without it, `GH_CHECKS_MAX` (100) per-MR calls each carried
 *  their own ~10 s timeout and nothing shared, so a slow instance could hold `GET /github/checks`
 *  open for minutes and spawn 100 `glab` processes. */
const CHECKS_BUDGET_MS = TIMELINE_BUDGET_MS;
/** Never spawn a detail call that cannot finish — the same reasoning as `TIMELINE_MIN_PAGE_MS`:
 *  a 300 ms timeout throws and is indistinguishable from a real endpoint failure. */
const CHECKS_MIN_CALL_MS = TIMELINE_MIN_PAGE_MS;

/** Per-MR checks cache: keyed `repoRoot\0iid`, same TTL as GitHub's checks cache (`CACHE_MS`) —
 *  its own `Map`, since `github.ts`'s `checksCache` is module-private. */
const checksCache = new Map<string, { at: number; glyph: ForgeChecksGlyph }>();
const CHECKS_CACHE_MAX = 500;

registerProjectCacheEvictor((repoRoot) => deleteKeysWithPrefix(checksCache, `${repoRoot}\0`));

/** CEZ_DRY_RUN=1 — the demo MR (#1, `mockGitlabList`) reads passing; anything else null (unknown
 *  or no CI), mirroring `mockGithubChecks`. */
function mockGitlabChecks(numbers: number[]): ForgeChecksData {
  const checks: Record<number, ForgeChecksGlyph> = {};
  for (const n of numbers) checks[n] = n === 1 ? 'passing' : null;
  return { available: true, checks };
}

/**
 * Lazy CI glyphs for on-screen MR rows (Step 3.4, mirrors `fetchGithubChecks`). Numbers are
 * de-duplicated, validated and capped at `GH_CHECKS_MAX` — GitHub's own cap, reused as-is so the
 * route enforces one ceiling for either forge. A failure on any MR AFTER the first costs only that
 * MR's glyph (mirrors `fetchPrChecks`'s per-chunk degrade: the rest still resolve); a failure on
 * the FIRST uncached MR is treated as `glab` itself being unusable (missing, unauthenticated,
 * offline) rather than one MR being unreadable, and answers `{available:false, reason}` instead of
 * a checks map with one silently missing entry.
 *
 * The whole fan-out runs under ONE deadline (`CHECKS_BUDGET_MS`), like every other multi-call
 * GitLab path: once it passes, no further detail call is issued and the glyphs resolved so far are
 * returned. That is not a lie by omission — `ForgeChecksData`'s contract is that a number the
 * forge did not answer for is simply ABSENT, which the rows already render as "nothing is known".
 */
async function fetchGitlabChecks(repoRoot: string, numbers: number[]): Promise<ForgeChecksData> {
  if (process.env.CEZ_DRY_RUN === '1') return mockGitlabChecks(numbers);
  const wanted = [...new Set(numbers)].filter((n) => Number.isInteger(n) && n > 0).slice(0, GH_CHECKS_MAX);
  if (wanted.length === 0) return { available: true, checks: {} };

  const checks: Record<number, ForgeChecksGlyph> = {};
  const misses: number[] = [];
  const now = Date.now();
  for (const n of wanted) {
    const hit = checksCache.get(`${repoRoot}\0${n}`);
    if (hit && now - hit.at < CACHE_MS) checks[n] = hit.glyph;
    else misses.push(n);
  }
  if (misses.length === 0) return { available: true, checks };

  const remember = (n: number, glyph: ForgeChecksGlyph): void => {
    checks[n] = glyph;
    checksCache.set(`${repoRoot}\0${n}`, { at: now, glyph });
  };

  // One deadline for every call below, counted from the same `now` the cache lookup used.
  const deadline = now + CHECKS_BUDGET_MS;
  const remaining = (): number => deadline - Date.now();

  const [first, ...rest] = misses;
  // `misses` is non-empty (checked above), so this is the checker's view of the destructuring
  // rather than a case that can happen — and an empty miss list means the cached glyphs stand.
  if (first === undefined) return { available: true, checks };
  try {
    remember(first, pipelineGlyph((await fetchGitlabMrDetail(repoRoot, first, Math.min(MR_DETAIL_TIMEOUT_MS, remaining()))).head_pipeline?.status));
  } catch (err) {
    return { available: false, reason: isNotFound(err) ? GLAB_NOT_FOUND_REASON : glabFailureReason(err) };
  }

  await mapWithConcurrency(rest, CHECKS_CONCURRENCY, async (n) => {
    // Past the shared deadline the remaining MRs are dropped rather than queued: their glyphs stay
    // absent, which is exactly what "nothing is known" looks like in this payload.
    const left = remaining();
    if (left < CHECKS_MIN_CALL_MS) return;
    try {
      remember(n, pipelineGlyph((await fetchGitlabMrDetail(repoRoot, n, Math.min(MR_DETAIL_TIMEOUT_MS, left))).head_pipeline?.status));
    } catch {
      // A single MR failing costs only its own glyph — mirrors `fetchPrChecks`'s per-chunk degrade.
    }
  });

  while (checksCache.size > CHECKS_CACHE_MAX) {
    const oldest = checksCache.keys().next();
    if (oldest.done) break;
    checksCache.delete(oldest.value);
  }
  return { available: true, checks };
}

// ---- prStatus (Step 3.4) -----------------------------------------------------------------------

const glMrBranchRowSchema = z.object({
  iid: z.number(),
  web_url: z.string(),
  state: z.string(),
  draft: z.boolean().default(false),
  work_in_progress: z.boolean().default(false),
});

const GL_MR_STATES: Record<string, ForgePrStatus['state']> = {
  merged: 'merged',
  closed: 'closed',
  locked: 'closed',
};

/**
 * The branch's newest merge request (Step 3.4, mirrors GitHub's `prStatus`): `glab mr list
 * --source-branch <branch> --all --output json` — `--all` because a merged/closed MR must still
 * flip Create PR → View PR — then the HIGHEST `iid` (GitLab's own creation order) wins over an
 * older MR on the same branch. `null` for no MR, and for ANY `glab` failure (the method's contract:
 * "null when none or the forge is down") — never a throw. The pipeline glyph costs one extra `glab
 * api` call on the chosen MR (reusing the Step 3.4 mapper); its own failure leaves `checks: null`
 * rather than failing the whole probe — the MR itself is the point, the glyph is a bonus.
 */
async function fetchGitlabPrStatus(repoRoot: string, branch: string): Promise<ForgePrStatus | null> {
  if (process.env.CEZ_DRY_RUN === '1') return null;
  try {
    const out = await glab(repoRoot, ['mr', 'list', '--source-branch', branch, '--all', '--output', 'json'], 15_000);
    const rows = z.array(glMrBranchRowSchema).parse(JSON.parse(out));
    if (rows.length === 0) return null;
    const newest = rows.reduce((best, row) => (row.iid > best.iid ? row : best));
    let checks: ForgeChecksGlyph = null;
    try {
      checks = pipelineGlyph((await fetchGitlabMrDetail(repoRoot, newest.iid)).head_pipeline?.status);
    } catch {
      // The glyph is a bonus, not the point of this probe — its failure isn't the MR's.
    }
    return {
      number: newest.iid,
      url: newest.web_url,
      state: GL_MR_STATES[newest.state] ?? 'open',
      isDraft: newest.draft || newest.work_in_progress,
      checks,
    };
  } catch {
    return null;
  }
}

// ---- prDiff (Step 3.5) -------------------------------------------------------------------------
// `…/merge_requests/:iid/changes` is deprecated upstream (Drift note, spec
// 2026-08-10-forge-provider-adapters) — the paged `…/diffs` endpoint is the replacement, walked
// through the shared bounded-page loop like the comments/events endpoints (Step 3.3). The caps are
// forge-neutral (`forge/limits.ts`, D4): the same numbers GitHub's `fetchGithubPrDiff` enforces.

const DIFFS_PAGE_SIZE = 100;

const glDiffRowSchema = z.object({
  old_path: z.string(),
  new_path: z.string(),
  new_file: z.boolean().default(false),
  deleted_file: z.boolean().default(false),
  renamed_file: z.boolean().default(false),
  diff: z.string().default(''),
  too_large: z.boolean().optional(),
});
type GlDiffRow = z.infer<typeof glDiffRowSchema>;

/** Renamed wins over added/removed (a rename can also modify content); `modified` is the default —
 *  mirrors `ghPrFileSchema`'s status enum, minus `copied`/`changed`, which `glab`'s diff endpoint
 *  never reports. */
function diffStatus(row: GlDiffRow): 'added' | 'removed' | 'renamed' | 'modified' {
  if (row.renamed_file) return 'renamed';
  if (row.new_file) return 'added';
  if (row.deleted_file) return 'removed';
  return 'modified';
}

/** `+`/`-` line counts from one row's diff (spec Step 3.5) — `glab`'s diffs endpoint reports no
 *  separate stat, unlike GitHub's `additions`/`deletions` fields, so the numbers come from the
 *  diff text itself.
 *
 *  Every `+`/`-` line counts, including one spelling `+++` or `---`. The `.../diffs` payload
 *  carries hunks only: each row's `diff` opens at `@@`, with the file names in the row's own
 *  `old_path`/`new_path` instead of a `---`/`+++` header (verified against captured gitlab.com
 *  responses). Skipping those prefixes therefore dropped real content — the `---` fence a deleted
 *  YAML front matter block opens with, an added `+++` line — and under-reported the diff. */
function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

/** glab's own wording for "this merge request doesn't exist" (`glab api` prints `glab: 404 Not
 *  Found (HTTP 404)` to stderr for a bad `:iid`) — distinct from every other CLI failure, which
 *  degrades in the payload instead of 404ing. */
function isGitlabNotFound(err: unknown): boolean {
  const stderr = typeof err === 'object' && err !== null ? (err as { stderr?: unknown }).stderr : undefined;
  const text = typeof stderr === 'string' && stderr ? stderr : err instanceof Error ? err.message : String(err);
  return /404 Not Found|HTTP 404/i.test(text);
}

const prDiffCache = new Map<string, { at: number; data: ForgePrDiffResult }>();
const PR_DIFF_CACHE_MAX = 50;

registerProjectCacheEvictor((repoRoot) => deleteKeysWithPrefix(prDiffCache, `${repoRoot}\0`));

/** CEZ_DRY_RUN=1 — mirrors `mockGithubPrDiff`'s shape and every degrade case it demos (renamed,
 *  binary, too-large) so the offline demo shows the same file-changes view for either forge. */
function mockGitlabPrDiff(number: number): ForgePrDiffResult {
  return {
    available: true,
    number,
    headSha: '0123456789abcdef0123456789abcdef01234567',
    additions: 15,
    deletions: 4,
    truncated: true,
    reason: 'One or more patches were not provided by GitLab.',
    files: [
      { path: 'src/session.ts', status: 'modified', additions: 8, deletions: 3, patch: '@@ -1,3 +1,4 @@\n-old\n+new\n context' },
      { path: 'src/new-name.ts', previousPath: 'src/old-name.ts', status: 'renamed', additions: 7, deletions: 1, patch: '@@ -1 +1 @@\n-old name\n+new name' },
      { path: 'assets/logo.png', status: 'modified', additions: 0, deletions: 0, patchUnavailableReason: 'binary' },
      { path: 'generated/output.txt', status: 'modified', additions: 0, deletions: 0, patchUnavailableReason: 'too-large', truncated: true },
    ],
  };
}

/**
 * Bounded, read-only file changes for a merge request (Step 3.5, mirrors `fetchGithubPrDiff`): the
 * MR detail supplies `sha` (the head commit — GitLab's `sha` field IS the head, verified against a
 * real gitlab.com capture), then `…/merge_requests/:iid/diffs` pages through the bounded loop.
 * Never throws for an ordinary degrade (CLI missing, offline, malformed payload) — `{available:
 * false, reason}` — but a 404 (the MR itself doesn't exist) throws `GithubPrNotFoundError` so the
 * route's existing `instanceof` 404 mapping keeps working unchanged for either forge.
 */
async function fetchGitlabPrDiff(repoRoot: string, number: number, refresh = false): Promise<ForgePrDiffResult> {
  if (process.env.CEZ_DRY_RUN === '1') return mockGitlabPrDiff(number);

  let detail: GlMrDetail;
  try {
    detail = await fetchGitlabMrDetail(repoRoot, number);
  } catch (err) {
    if (isGitlabNotFound(err)) throw new GithubPrNotFoundError(`Merge request #${number} was not found`);
    return { available: false, reason: isNotFound(err) ? GLAB_NOT_FOUND_REASON : glabFailureReason(err) };
  }
  const head = detail.sha;
  if (!head) return { available: false, reason: 'glab merge request detail returned an unexpected response' };

  const key = `${repoRoot}\0${number}\0${head}`;
  const hit = prDiffCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  let rows: GlDiffRow[];
  let stoppedShort: boolean;
  try {
    const pages = await fetchBoundedPages(
      (page, timeoutMs) =>
        glab(repoRoot, ['api', `projects/:fullpath/merge_requests/${number}/diffs?per_page=${DIFFS_PAGE_SIZE}&page=${page}`], timeoutMs),
      { maxPages: TIMELINE_MAX_PAGES, budgetMs: TIMELINE_BUDGET_MS, minPageMs: TIMELINE_MIN_PAGE_MS, pageSize: DIFFS_PAGE_SIZE },
    );
    rows = z.array(glDiffRowSchema).parse(pages.rows);
    stoppedShort = pages.stoppedShort;
  } catch (err) {
    if (isGitlabNotFound(err)) throw new GithubPrNotFoundError(`Merge request #${number} was not found`);
    return { available: false, reason: isNotFound(err) ? GLAB_NOT_FOUND_REASON : glabFailureReason(err) };
  }

  // Counted once, carried with the row: the file cap below slices this list, so pairing by index
  // afterwards would only be a lookup the checker cannot see is in range.
  const counted = rows.map((row) => ({ row, ...countDiffLines(row.diff) }));
  const totalAdditions = counted.reduce((sum, c) => sum + c.additions, 0);
  const totalDeletions = counted.reduce((sum, c) => sum + c.deletions, 0);

  const limited = counted.slice(0, FORGE_PR_DIFF_FILE_CAP);
  const fileCapped = rows.length >= FORGE_PR_DIFF_FILE_CAP;
  let responseTruncated = fileCapped || (stoppedShort && !fileCapped);
  const reasons: string[] = [];
  if (fileCapped) reasons.push(`Only the first ${FORGE_PR_DIFF_FILE_CAP} files are shown.`);
  else if (stoppedShort) reasons.push('Only some files could be fetched before the time budget ran out.');

  const files: ForgePrChange[] = limited.map(({ row, additions, deletions }) => {
    const status = diffStatus(row);
    let patch: string | undefined = row.diff.length > 0 ? row.diff : undefined;
    let truncated = false;
    let patchUnavailableReason: 'binary' | 'too-large' | 'not-provided' | undefined;
    if (patch !== undefined && Buffer.byteLength(patch, 'utf8') > FORGE_PR_PATCH_CAP) {
      patch = undefined;
      truncated = true;
      patchUnavailableReason = 'too-large';
      responseTruncated = true;
    } else if (row.too_large || patch === undefined) {
      patch = undefined;
      patchUnavailableReason = additions === 0 && deletions === 0 ? 'binary' : 'not-provided';
    }
    return {
      path: row.new_path,
      ...(status === 'renamed' ? { previousPath: row.old_path } : {}),
      status,
      additions,
      deletions,
      ...(patch !== undefined ? { patch } : {}),
      ...(patchUnavailableReason ? { patchUnavailableReason } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  });

  let kept = files;
  while (
    kept.length > 0 &&
    Buffer.byteLength(JSON.stringify({ available: true, number, headSha: head, files: kept }), 'utf8') > FORGE_PR_DIFF_JSON_CAP
  ) {
    kept = kept.slice(0, -1);
    responseTruncated = true;
  }
  if (kept.length < files.length) reasons.push('The response size limit omitted some files.');
  if (files.some((file) => file.truncated)) reasons.push('One or more patches exceeded the per-file limit.');

  const data: ForgePrDiffResult = {
    available: true,
    number,
    headSha: head,
    files: kept,
    additions: totalAdditions,
    deletions: totalDeletions,
    truncated: responseTruncated,
    ...(reasons.length ? { reason: reasons.join(' ') } : {}),
  };
  prDiffCache.delete(key); // re-insert so this key becomes the newest
  prDiffCache.set(key, { at: Date.now(), data });
  while (prDiffCache.size > PR_DIFF_CACHE_MAX) {
    const oldest = prDiffCache.keys().next();
    if (oldest.done) break;
    prDiffCache.delete(oldest.value);
  }
  return data;
}

// ---- searchItems (Step 3.6) --------------------------------------------------------------------
// The open-only list tier's escape hatch into every state (mirrors GitHub's `searchGithubItems`,
// #730): `glab issue/mr list --search <q> --all --output json --per-page N`. The query is passed
// as its OWN argv element — never interpolated into a shell string. No cache: GitHub's own search
// isn't cached either (a search is inherently a one-off, unlike the tab's steady list view).

/** CEZ_DRY_RUN=1 — filters the demo catalog by the query, mirroring `searchGithubItems`'s own
 *  dry-run rule (#838): `truncated` follows the live path's own cap rule so the offline demo still
 *  exercises it. */
function mockGitlabSearch(kind: 'issue' | 'pr', query: string, limit: number): ForgeSearchData {
  const mock = mockGitlabList();
  const pool = kind === 'issue' ? mock.issues : mock.prs;
  const needle = query.replace(/^#/, '').toLowerCase();
  const items = pool.filter((i) => String(i.number).includes(needle) || i.title.toLowerCase().includes(needle)).slice(0, limit);
  return { available: true, items, truncated: items.length >= limit };
}

/**
 * Search issues/MRs in ANY state (Step 3.6, mirrors `searchGithubItems`). Unlike GitHub's driver,
 * `glab issue/mr list --search` already covers every state with one call and no separate
 * exact-number lookup is needed — `--search` matches a bare number against the title/description
 * too. `checks: null` on every hit (`toForgeItem`'s `pr` branch, D5) — the search tier does not pay
 * for CI rollups, same rationale as the list tier since #664. Never throws.
 */
async function searchGitlabItems(
  repoRoot: string,
  kind: 'issue' | 'pr',
  query: string,
  limit = GH_SEARCH_MAX,
): Promise<ForgeSearchData> {
  const trimmed = query.trim();
  if (trimmed === '') return { available: true, items: [] };
  const capped = Math.min(Math.max(limit, 1), GH_SEARCH_MAX);
  if (process.env.CEZ_DRY_RUN === '1') return mockGitlabSearch(kind, trimmed, capped);
  const command = kind === 'pr' ? 'mr' : 'issue';
  try {
    const out = await glab(
      repoRoot,
      [command, 'list', '--search', trimmed, '--all', '--output', 'json', '--per-page', String(capped)],
      15_000,
    );
    let items: ForgeItem[];
    try {
      items =
        kind === 'pr'
          ? z.array(glMrRowSchema).parse(JSON.parse(out)).map((row) => toForgeItem('pr', row))
          : z.array(glIssueRowSchema).parse(JSON.parse(out)).map((row) => toForgeItem('issue', row));
    } catch {
      return { available: false, reason: `glab ${command} list returned an unexpected response`, items: [] };
    }
    const labelColors = await fetchGitlabLabelColors(repoRoot);
    return {
      available: true,
      items,
      truncated: items.length >= capped,
      ...(labelColors ? { labelColors } : {}),
    };
  } catch (err) {
    const reason = isNotFound(err) ? GLAB_NOT_FOUND_REASON : glabFailureReason(err);
    return { available: false, reason, items: [] };
  }
}

// ---- draft merge request creation (review gate, Step 4.1) --------------------
// Mirrors GitHub's `createDraftPr` step for step: the shared prelude (`./draft-pr.ts` — final
// autosave, conflicted-worktree refusal, dry run, remote check, push, base branch, body), then
// `glab mr create --draft` in the task worktree (glab picks the project up from the worktree's
// remote). Every failure maps to a one-line human error. Never throws.
//
// No `--no-editor`: in glab 1.118 it means "prompt instead of opening an editor", i.e. it adds a
// prompt; `--description` + `--yes` already leave nothing to ask.

/** The MR URL glab prints, anchored to THIS instance's host (a self-managed instance may carry a
 *  port and serve projects under subgroups or a path prefix). */
function mrUrlRe(host: string): RegExp {
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`https?://${escaped}(?::\\d+)?/\\S+?/-/merge_requests/\\d+`);
}

/** The instance's web host (with port when it has one): from the project web root, else the
 *  remote's host. */
function gitlabWebHost(repoRoot: string, parsed: ParsedRemote): string {
  const base = gitlabWebBase(repoRoot, parsed);
  if (base) {
    try {
      return new URL(base).host;
    } catch {
      // fall through to the remote's host
    }
  }
  return parsed.host;
}

async function createGitlabDraftMr(repoRoot: string, parsed: ParsedRemote, input: DraftPrInput): Promise<DraftPrOutcome> {
  const prelude = await preparePublish(input);
  if (prelude.kind === 'error') return { ok: false, error: prelude.error };
  if (prelude.kind === 'dryRun') {
    const base = gitlabWebBase(repoRoot, parsed) ?? 'https://gitlab.com/demo/demo';
    return { ok: true, url: `${base}/-/merge_requests/777`, dryRun: true };
  }
  const { worktree, branch, base, title, body } = prelude;

  const targetArgs = base ? ['--target-branch', base] : [];
  const mr = await execTool(
    ['mr', 'create', '--draft', '--source-branch', branch, ...targetArgs, '--title', title, '--description', body, '--yes'],
    worktree,
    'glab',
    PUSH_TIMEOUT_MS,
  );
  if (!mr.ok) {
    if (mr.notFound) {
      return { ok: false, error: 'glab not found — install the GitLab CLI and run `glab auth login`, or merge the branch locally' };
    }
    if (/\b40[13]\b|not logged in|authentication/i.test(mr.stderr)) {
      const host = parsed.host;
      return {
        ok: false,
        error: `glab is not authenticated for ${host} — run \`glab auth login --hostname ${host}\`, or merge the branch locally`,
      };
    }
    return { ok: false, error: `glab mr create failed — ${glabBoxedError(mr.stderr) ?? (tail(mr.stderr) || 'unknown error')}` };
  }

  // glab prints the MR URL on stdout; accept stderr too, as the GitHub path does.
  const match = mrUrlRe(gitlabWebHost(repoRoot, parsed)).exec(`${mr.stdout}\n${mr.stderr}`);
  if (!match) {
    return { ok: false, error: 'glab mr create finished but printed no merge request URL — check the GitLab project' };
  }
  return { ok: true, url: match[0], dryRun: false };
}

/** `parsed` feeds `listAll`'s `repo` field and `viewUrl`'s origin + path fallback (Step 3.7). */
export function createGitlabDriver(repoRoot: string, parsed: ParsedRemote): ForgeDriver {
  return {
    kind: 'gitlab',

    detect: () => detectGitlab(repoRoot),
    detectCached: () => detectGitlabCached(repoRoot),

    listIssues: async (opts) => (await fetchGitlabList(repoRoot, parsed, opts)).issues,
    listPRs: async (opts) => (await fetchGitlabList(repoRoot, parsed, opts)).prs,

    // The tab's whole payload in one call — repo handle, both open sets, label colors.
    listAll: (opts) => fetchGitlabList(repoRoot, parsed, opts),

    listComments: (kind, number, opts) => fetchGitlabComments(repoRoot, parsed, kind, number, !!opts?.refresh),

    // Lazy CI glyphs for on-screen MR rows (#664 parity) — byte-identical shape to GitHub's.
    listChecks: (numbers) => fetchGitlabChecks(repoRoot, numbers),

    // Bounded, read-only file changes for a merge request — forge-neutral caps (Step 3.5).
    prDiff: (number, opts) => fetchGitlabPrDiff(repoRoot, number, opts?.refresh),

    // The open-only list tier's escape hatch into every state (Step 3.6).
    searchItems: (kind, query, opts) => searchGitlabItems(repoRoot, kind, query, opts?.limit),

    // Draft merge request from the review gate (Step 4.1) — mirrors GitHub's `createDraftPr`.
    createPR: (input) => createGitlabDraftMr(repoRoot, parsed, input),

    // The branch's open/merged/closed merge request, or null when none (or glab is down).
    prStatus: (branch) => fetchGitlabPrStatus(repoRoot, branch),

    // GitLab's own `/-/` path grammar (Step 3.7): base is the cached `web_url` (exact on a
    // non-root instance), falling back to origin + path — mirrors the GitHub driver's viewUrl.
    viewUrl: (kind, ref) => {
      const base = gitlabWebBase(repoRoot, parsed);
      if (!base) return null;
      // Branch names may contain '/' — encode per segment, keep the slashes.
      const path = String(ref).split('/').map(encodeURIComponent).join('/');
      switch (kind) {
        case 'repo':
          return base;
        case 'issue':
          return `${base}/-/issues/${path}`;
        case 'pr':
          return `${base}/-/merge_requests/${path}`;
        case 'branch':
          return `${base}/-/tree/${path}`;
        case 'commit':
          return `${base}/-/commit/${path}`;
      }
    },
  };
}
