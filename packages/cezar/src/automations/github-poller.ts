import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { GithubAutomationDefinition, AutomationEvent } from './types.ts';

const execFileAsync = promisify(execFile);
const HARD_CANDIDATE_CAP = 100;
const TIMELINE_PAGE_SIZE = 100;
/** How many of the NEWEST timeline pages one item is read back to — the bound `HARD_CANDIDATE_CAP`
 *  is to items. Page 1 is kept as well when the whole history is within reach of the cap, so an
 *  item just inside it can cost one page more than this. */
const TIMELINE_MAX_PAGES = 5;
const GITHUB_COMMAND_TIMEOUT_MS = 30_000;

const githubItemSchema = z.object({
  id: z.number().int().positive().optional(),
  node_id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string().url(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime().optional(),
  user: z.object({ login: z.string() }),
  assignees: z.array(z.object({ login: z.string() })).default([]),
  labels: z.array(z.object({ name: z.string() })).default([]),
  repository_url: z.string().url(),
  pull_request: z.unknown().optional(),
});

const searchResponseSchema = z.object({ items: z.array(githubItemSchema) });
const labelTimelineEventSchema = z.object({
  id: z.number().int().positive().optional(),
  node_id: z.string().optional(),
  event: z.enum(['labeled', 'unlabeled']),
  created_at: z.string().datetime(),
  label: z.object({ name: z.string() }),
});
const reviewedTimelineEventSchema = z.object({
  id: z.number().int().positive().optional(),
  node_id: z.string().optional(),
  event: z.literal('reviewed'),
  submitted_at: z.string().datetime(),
  user: z.object({ login: z.string() }),
});
const reviewRequestedTimelineEventSchema = z.object({
  id: z.number().int().positive().optional(),
  node_id: z.string().optional(),
  event: z.literal('review_requested'),
  created_at: z.string().datetime(),
  requested_reviewer: z.object({ login: z.string() }).optional(),
});
const timelineEventSchema = z.union([
  labelTimelineEventSchema,
  reviewedTimelineEventSchema,
  reviewRequestedTimelineEventSchema,
  z.object({ event: z.string() }).passthrough(),
]);

export interface GithubCandidate {
  eventId: string;
  event: AutomationEvent;
  timestamp: string;
  tieBreaker: string;
  repo: string;
  nodeId: string;
  number: number;
  title: string;
  url: string;
  author: string;
  assignees: string[];
  labels: string[];
  changedLabel?: string;
  reviewer?: string;
}

export interface GithubPollResult {
  candidates: GithubCandidate[];
  truncated: boolean;
  pages: number;
  cursor?: { timestamp: string; tieBreaker: string };
}

export interface GithubPollerOptions {
  run?: (executable: string, args: readonly string[]) => Promise<string>;
}

export interface GithubPollOptions {
  since?: string;
}

export class GithubPoller {
  private readonly run: NonNullable<GithubPollerOptions['run']>;

  constructor(options: GithubPollerOptions = {}) {
    this.run = options.run ?? (async (executable, args) => (await execFileAsync(executable, [...args], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: GITHUB_COMMAND_TIMEOUT_MS,
    })).stdout);
  }

  async poll(
    owner: string,
    repo: string,
    definition: GithubAutomationDefinition,
    options: GithubPollOptions = {},
  ): Promise<GithubPollResult> {
    const openedEvents = definition.events.filter(
      (event) => event === 'pull_request.opened' || event === 'issue.opened',
    );
    const labelEvents = definition.events.filter(
      (event) => event === 'issue.labeled' || event === 'issue.unlabeled',
    );
    const reviewEvents = definition.events.filter(
      (event) => event === 'pull_request.reviewed'
        || event === 'pull_request.review_requested'
        || event === 'pull_request.rereview_requested',
    );
    const sources: Array<{
      family: 'issues' | 'prs' | 'mixed';
      activity: 'created' | 'updated';
      opened: boolean;
      labels: boolean;
      reviews: boolean;
    }> = [];
    if (openedEvents.length) {
      sources.push({
        family: openedEvents.every((event) => event === 'pull_request.opened')
          ? 'prs'
          : openedEvents.every((event) => event === 'issue.opened') ? 'issues' : 'mixed',
        activity: 'created',
        opened: true,
        labels: false,
        reviews: false,
      });
    }
    if (labelEvents.length) {
      sources.push({ family: 'issues', activity: 'updated', opened: false, labels: true, reviews: false });
    }
    if (reviewEvents.length) {
      sources.push({ family: 'prs', activity: 'updated', opened: false, labels: false, reviews: true });
    }

    const perPage = Math.min(definition.filters.maxRecords, HARD_CANDIDATE_CAP);
    const expectedRepoUrl = `https://api.github.com/repos/${owner}/${repo}`.toLowerCase();
    const observations: Array<{
      timestamp: string;
      tieBreaker: string;
      candidate?: GithubCandidate;
    }> = [];
    let truncated = false;
    for (const source of sources) {
      const query = buildSearchQuery(
        owner,
        repo,
        definition,
        source.family,
        source.activity,
        options.since,
        // A review event on a merged or closed PR asks for work nobody can act on any more.
        source.reviews,
      );
      const args = [
        'api', '--method', 'GET', '/search/issues',
        '-f', `q=${query}`,
        '-f', `per_page=${perPage}`,
        '-f', `sort=${source.activity}`,
        '-f', 'order=asc',
      ];
      const raw = await this.run('gh', args);
      const response = searchResponseSchema.parse(JSON.parse(raw));
      const sourceObservations: typeof observations = [];
      truncated ||= response.items.length >= perPage;
      for (const item of response.items.slice(0, HARD_CANDIDATE_CAP)) {
        if (item.repository_url.toLowerCase() !== expectedRepoUrl) continue;
        if (source.opened && item.pull_request && definition.events.includes('pull_request.opened')) {
          const candidate = normalizeOpened(owner, repo, item, 'pull_request.opened');
          if (atOrAfter(candidate.timestamp, options.since)) {
            sourceObservations.push({
              timestamp: candidate.timestamp,
              tieBreaker: candidate.tieBreaker,
              candidate: matchesFilters(candidate, definition) ? candidate : undefined,
            });
          }
        } else if (source.opened && !item.pull_request && definition.events.includes('issue.opened')) {
          const candidate = normalizeOpened(owner, repo, item, 'issue.opened');
          if (atOrAfter(candidate.timestamp, options.since)) {
            sourceObservations.push({
              timestamp: candidate.timestamp,
              tieBreaker: candidate.tieBreaker,
              candidate: matchesFilters(candidate, definition) ? candidate : undefined,
            });
          }
        }
        if (source.labels && !item.pull_request) {
          const timeline = await this.timeline(owner, repo, item.number);
          const events = reconstructLabelEvents(owner, repo, item, timeline);
          for (const event of events) {
            if (!atOrAfter(event.timestamp, options.since)) continue;
            sourceObservations.push({
              timestamp: event.timestamp,
              tieBreaker: event.tieBreaker,
              candidate: definition.events.includes(event.event) && matchesFilters(event, definition)
                ? event
                : undefined,
            });
            if (sourceObservations.length >= perPage) break;
          }
          const lastEventAt = events.at(-1)?.timestamp;
          if (
            sourceObservations.length < perPage
            && item.updated_at
            && atOrAfter(item.updated_at, options.since)
            && (!lastEventAt || item.updated_at > lastEventAt)
          ) {
            sourceObservations.push({
              timestamp: item.updated_at,
              tieBreaker: `activity:${item.node_id}`,
            });
          }
        }
        if (source.reviews && item.pull_request) {
          const timeline = await this.timeline(owner, repo, item.number);
          const events = reconstructReviewEvents(owner, repo, item, timeline);
          // One re-request selected under BOTH request events launches once, as the narrower one.
          const mergeRereview = definition.events.includes('pull_request.review_requested')
            && definition.events.includes('pull_request.rereview_requested');
          const rereviewed = new Set(events
            .filter((event) => event.event === 'pull_request.rereview_requested')
            .map((event) => event.tieBreaker));
          for (const event of events) {
            if (!atOrAfter(event.timestamp, options.since)) continue;
            const superseded = mergeRereview
              && event.event === 'pull_request.review_requested'
              && rereviewed.has(`${event.tieBreaker}:rereview`);
            sourceObservations.push({
              timestamp: event.timestamp,
              tieBreaker: event.tieBreaker,
              candidate: !superseded && definition.events.includes(event.event) && matchesFilters(event, definition)
                ? event
                : undefined,
            });
            if (sourceObservations.length >= perPage) break;
          }
          const lastEventAt = events.at(-1)?.timestamp;
          if (
            sourceObservations.length < perPage
            && item.updated_at
            && atOrAfter(item.updated_at, options.since)
            && (!lastEventAt || item.updated_at > lastEventAt)
          ) {
            sourceObservations.push({
              timestamp: item.updated_at,
              tieBreaker: `activity:${item.node_id}`,
            });
          }
        }
        if (sourceObservations.length >= perPage) break;
      }
      sourceObservations.sort(compareObservation);
      truncated ||= sourceObservations.length >= perPage;
      observations.push(...sourceObservations.slice(0, perPage));
    }
    observations.sort(compareObservation);
    const evaluated = observations.slice(0, definition.filters.maxRecords);
    const cursor = evaluated.at(-1);
    return {
      candidates: onePerPullRequest(evaluated.flatMap((observation) => observation.candidate ? [observation.candidate] : [])),
      truncated: truncated || observations.length > definition.filters.maxRecords,
      pages: sources.length,
      cursor: cursor ? { timestamp: cursor.timestamp, tieBreaker: cursor.tieBreaker } : undefined,
    };
  }

  /**
   * The timeline of one issue or PR, NEWEST rows guaranteed present.
   *
   * GitHub returns this endpoint ASCENDING, so page 1 is the oldest hundred rows — and a poll
   * only ever cares about what happened since its cursor, i.e. the end. A PR under active review
   * passes a hundred rows easily (a `committed` row per commit, every comment, every label), so
   * reading page 1 alone made the review events silently never fire on exactly the PRs they are
   * for. One page still costs one request: the `Link` header is only consulted when page 1 comes
   * back full, and at most `TIMELINE_MAX_PAGES` pages are read, the newest ones.
   */
  private async timeline(owner: string, repo: string, number: number) {
    const first = await this.timelinePage(owner, repo, number, 1);
    if (first.length < TIMELINE_PAGE_SIZE) return first;
    const last = await this.lastTimelinePage(owner, repo, number);
    const from = Math.max(2, last - TIMELINE_MAX_PAGES + 1);
    // Complete history only while it fits the cap; past it the oldest pages are the ones to drop,
    // which costs `reconstructReviewEvents` the "has this login reviewed before" memory for rows
    // that far back — a re-request then reads as a plain request, never as nothing at all.
    const rows = from === 2 ? [...first] : [];
    for (let page = from; page <= last; page += 1) {
      rows.push(...await this.timelinePage(owner, repo, number, page));
    }
    return rows;
  }

  private async timelinePage(owner: string, repo: string, number: number, page: number) {
    const raw = await this.run('gh', [
      'api', '--method', 'GET', `repos/${owner}/${repo}/issues/${number}/timeline`,
      '-H', 'Accept: application/vnd.github+json', '-f', `per_page=${TIMELINE_PAGE_SIZE}`,
      '-f', `page=${page}`,
    ]);
    return z.array(timelineEventSchema).parse(JSON.parse(raw));
  }

  /** The last page number from the `Link` header of a header-included request; 1 when absent. */
  private async lastTimelinePage(owner: string, repo: string, number: number): Promise<number> {
    const raw = await this.run('gh', [
      'api', '--include', '--method', 'GET', `repos/${owner}/${repo}/issues/${number}/timeline`,
      '-H', 'Accept: application/vnd.github+json', '-f', `per_page=${TIMELINE_PAGE_SIZE}`,
    ]);
    return lastPageOfLinkHeader(raw);
  }
}

/**
 * One launch per PR per poll for the review events: requesting four reviewers at once is four
 * timeline rows but one "this PR wants a review". The latest row of each PR wins — for a request,
 * that is also the narrower `rereview_requested` when both exist. `ProjectAutomationScheduler`
 * repeats the same intent against durable receipts for rows that arrive just after a poll.
 */
export function onePerPullRequest(candidates: GithubCandidate[]): GithubCandidate[] {
  const familyOf = (event: AutomationEvent) =>
    event === 'pull_request.reviewed' ? 'reviewed'
      : event === 'pull_request.review_requested' || event === 'pull_request.rereview_requested' ? 'requested'
        : null;
  const latest = new Map<string, GithubCandidate>();
  for (const candidate of candidates) {
    const family = familyOf(candidate.event);
    if (family) latest.set(`${candidate.number}:${family}`, candidate);
  }
  const kept = new Set(latest.values());
  return candidates.filter((candidate) => familyOf(candidate.event) === null || kept.has(candidate));
}

/**
 * The rows of one timeline kind, narrowed by the SCHEMA rather than by `event` alone.
 *
 * The union's catch-all branch parses any row (it is what keeps a `commented` row from failing
 * the whole page), so a row that merely CLAIMS `event: 'reviewed'` while missing `user` — GitHub
 * does that for some removed accounts — would satisfy an `event`-only predicate and then throw on
 * field access, which the scheduler records as a failure and backs the automation off for hours.
 * A row that does not parse is skipped instead.
 */
function narrow<T extends z.ZodTypeAny>(
  timeline: z.infer<typeof timelineEventSchema>[],
  schema: T,
): z.infer<T>[] {
  return timeline.flatMap((entry) => {
    const parsed = schema.safeParse(entry);
    return parsed.success ? [parsed.data as z.infer<T>] : [];
  });
}

/** `<…page=7>; rel="last"` out of a `gh api --include` response; 1 when there is no such link. */
export function lastPageOfLinkHeader(raw: string): number {
  const header = raw.split(/\r?\n\r?\n/, 1)[0] ?? '';
  const link = header.split(/\r?\n/).find((line) => line.toLowerCase().startsWith('link:')) ?? '';
  for (const part of link.split(',')) {
    if (!/rel="?last"?/.test(part)) continue;
    const page = Number(part.match(/[?&]page=(\d+)/)?.[1]);
    if (Number.isInteger(page) && page > 0) return page;
  }
  return 1;
}

export function buildSearchQuery(
  owner: string,
  repo: string,
  definition: GithubAutomationDefinition,
  family: 'issues' | 'prs' | 'mixed' = 'mixed',
  activity: 'created' | 'updated' = 'created',
  since?: string,
  openOnly = false,
): string {
  const start = since
    ?? new Date(Date.now() - definition.filters.lookbackDays * 86_400_000).toISOString().slice(0, 10);
  const terms = [
    `repo:${owner}/${repo}`,
    family === 'prs' ? 'is:pr' : family === 'issues' ? 'is:issue' : '',
    openOnly ? 'is:open' : '',
    `${activity}:>=${start}`,
  ];
  for (const author of definition.filters.authors ?? []) terms.push(`author:${safeQualifier(author)}`);
  for (const assignee of definition.filters.assignees ?? []) terms.push(`assignee:${safeQualifier(assignee)}`);
  for (const label of definition.filters.allLabels ?? []) terms.push(`label:${JSON.stringify(label)}`);
  return terms.filter(Boolean).join(' ');
}

function safeQualifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '');
}

function normalizeOpened(owner: string, repo: string, item: z.infer<typeof githubItemSchema>, event: 'pull_request.opened' | 'issue.opened'): GithubCandidate {
  const eventId = `${owner}/${repo}:${item.node_id}:${event}:${item.created_at}`;
  return {
    eventId,
    event,
    timestamp: item.created_at,
    tieBreaker: item.node_id,
    repo: `${owner}/${repo}`,
    nodeId: item.node_id,
    number: item.number,
    title: sanitize(item.title, 500),
    url: item.html_url,
    author: item.user.login,
    assignees: item.assignees.map((assignee) => assignee.login),
    labels: item.labels.map((label) => label.name),
  };
}

export function reconstructLabelEvents(
  owner: string,
  repo: string,
  item: z.infer<typeof githubItemSchema>,
  timeline: z.infer<typeof timelineEventSchema>[],
): GithubCandidate[] {
  const labelEntries = narrow(timeline, labelTimelineEventSchema);
  const current = new Set(item.labels.map((label) => label.name));
  const ordered = [...labelEntries].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const rows: GithubCandidate[] = [];
  for (const entry of ordered) {
    const postLabels = [...current];
    if (entry.event === 'labeled') current.delete(entry.label.name);
    else current.add(entry.label.name);
    const labels = entry.event === 'labeled' ? postLabels : [...current];
    const kind = entry.event === 'labeled' ? 'issue.labeled' : 'issue.unlabeled';
    const stable = entry.node_id ?? String(entry.id ?? `${entry.created_at}:${entry.label.name.toLowerCase()}`);
    rows.push({
      ...normalizeOpened(owner, repo, item, 'issue.opened'),
      event: kind,
      eventId: `${owner}/${repo}:${item.node_id}:${kind}:${stable}`,
      timestamp: entry.created_at,
      tieBreaker: stable,
      labels,
      changedLabel: entry.label.name,
    });
  }
  return rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.tieBreaker.localeCompare(b.tieBreaker));
}

/**
 * `reviewed` and `review_requested` entries, walked chronologically (the opposite direction from
 * `reconstructLabelEvents`, which reconstructs a past label SET and so must walk backward — a
 * review request needs no such reconstruction, only "has this login reviewed yet"). A request
 * aimed at a login already in that set is BOTH a `pull_request.review_requested` (any request)
 * and a `pull_request.rereview_requested` (this one specifically already reviewed) candidate.
 */
export function reconstructReviewEvents(
  owner: string,
  repo: string,
  item: z.infer<typeof githubItemSchema>,
  timeline: z.infer<typeof timelineEventSchema>[],
): GithubCandidate[] {
  const reviewEntries = [
    ...narrow(timeline, reviewedTimelineEventSchema),
    ...narrow(timeline, reviewRequestedTimelineEventSchema),
  ];
  const ordered = [...reviewEntries].sort((a, b) => {
    const at = a.event === 'reviewed' ? a.submitted_at : a.created_at;
    const bt = b.event === 'reviewed' ? b.submitted_at : b.created_at;
    return at.localeCompare(bt);
  });
  const hasReviewed = new Set<string>();
  const rows: GithubCandidate[] = [];
  const base = () => normalizeOpened(owner, repo, item, 'pull_request.opened');
  for (const entry of ordered) {
    const stable = entry.node_id ?? String(entry.id ?? entry.event);
    if (entry.event === 'reviewed') {
      rows.push({
        ...base(),
        event: 'pull_request.reviewed',
        eventId: `${owner}/${repo}:${item.node_id}:pull_request.reviewed:${stable}`,
        timestamp: entry.submitted_at,
        tieBreaker: stable,
        reviewer: entry.user.login,
      });
      hasReviewed.add(entry.user.login.toLowerCase());
      continue;
    }
    const reviewer = entry.requested_reviewer?.login;
    if (!reviewer) continue;
    rows.push({
      ...base(),
      event: 'pull_request.review_requested',
      eventId: `${owner}/${repo}:${item.node_id}:pull_request.review_requested:${stable}`,
      timestamp: entry.created_at,
      tieBreaker: stable,
      reviewer,
    });
    if (hasReviewed.has(reviewer.toLowerCase())) {
      rows.push({
        ...base(),
        event: 'pull_request.rereview_requested',
        eventId: `${owner}/${repo}:${item.node_id}:pull_request.rereview_requested:${stable}`,
        timestamp: entry.created_at,
        tieBreaker: `${stable}:rereview`,
        reviewer,
      });
    }
  }
  return rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.tieBreaker.localeCompare(b.tieBreaker));
}

export function matchesFilters(candidate: GithubCandidate, definition: GithubAutomationDefinition): boolean {
  const lower = (values: readonly string[]) => new Set(values.map((value) => value.toLowerCase()));
  const labels = lower(candidate.labels);
  const filters = definition.filters;
  if (filters.authors?.length && !lower(filters.authors).has(candidate.author.toLowerCase())) return false;
  if (filters.assignees?.length && !candidate.assignees.some((value) => lower(filters.assignees!).has(value.toLowerCase()))) return false;
  if (filters.allLabels?.some((value) => !labels.has(value.toLowerCase()))) return false;
  if (filters.anyLabels?.length && !filters.anyLabels.some((value) => labels.has(value.toLowerCase()))) return false;
  if (filters.excludeLabels?.some((value) => labels.has(value.toLowerCase()))) return false;
  if (candidate.changedLabel && filters.changedLabels?.length && !lower(filters.changedLabels).has(candidate.changedLabel.toLowerCase())) return false;
  if (candidate.reviewer && filters.reviewers?.length && !lower(filters.reviewers).has(candidate.reviewer.toLowerCase())) return false;
  return true;
}

function sanitize(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}

function compareObservation(
  a: { timestamp: string; tieBreaker: string },
  b: { timestamp: string; tieBreaker: string },
): number {
  return a.timestamp.localeCompare(b.timestamp) || a.tieBreaker.localeCompare(b.tieBreaker);
}

function atOrAfter(timestamp: string, since: string | undefined): boolean {
  return !since || timestamp >= since;
}
