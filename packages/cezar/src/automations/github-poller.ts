import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { AutomationDefinition, AutomationEvent } from './types.js';

const execFileAsync = promisify(execFile);
const HARD_CANDIDATE_CAP = 100;
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
const timelineEventSchema = z.object({
  id: z.number().int().positive().optional(),
  node_id: z.string().optional(),
  event: z.enum(['labeled', 'unlabeled']),
  created_at: z.string().datetime(),
  label: z.object({ name: z.string() }),
});

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
    definition: AutomationDefinition,
    options: GithubPollOptions = {},
  ): Promise<GithubPollResult> {
    const openedEvents = definition.events.filter(
      (event) => event === 'pull_request.opened' || event === 'issue.opened',
    );
    const labelEvents = definition.events.filter(
      (event) => event === 'issue.labeled' || event === 'issue.unlabeled',
    );
    const sources: Array<{
      family: 'issues' | 'prs' | 'mixed';
      activity: 'created' | 'updated';
      opened: boolean;
      labels: boolean;
    }> = [];
    if (openedEvents.length) {
      sources.push({
        family: openedEvents.every((event) => event === 'pull_request.opened')
          ? 'prs'
          : openedEvents.every((event) => event === 'issue.opened') ? 'issues' : 'mixed',
        activity: 'created',
        opened: true,
        labels: false,
      });
    }
    if (labelEvents.length) {
      sources.push({ family: 'issues', activity: 'updated', opened: false, labels: true });
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
      candidates: evaluated.flatMap((observation) => observation.candidate ? [observation.candidate] : []),
      truncated: truncated || observations.length > definition.filters.maxRecords,
      pages: sources.length,
      cursor: cursor ? { timestamp: cursor.timestamp, tieBreaker: cursor.tieBreaker } : undefined,
    };
  }

  private async timeline(owner: string, repo: string, number: number) {
    const raw = await this.run('gh', [
      'api', '--method', 'GET', `repos/${owner}/${repo}/issues/${number}/timeline`,
      '-H', 'Accept: application/vnd.github+json', '-f', 'per_page=100',
    ]);
    return z.array(timelineEventSchema).parse(JSON.parse(raw));
  }
}

export function buildSearchQuery(
  owner: string,
  repo: string,
  definition: AutomationDefinition,
  family: 'issues' | 'prs' | 'mixed' = 'mixed',
  activity: 'created' | 'updated' = 'created',
  since?: string,
): string {
  const start = since
    ?? new Date(Date.now() - definition.filters.lookbackDays * 86_400_000).toISOString().slice(0, 10);
  const terms = [
    `repo:${owner}/${repo}`,
    family === 'prs' ? 'is:pr' : family === 'issues' ? 'is:issue' : '',
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
  const current = new Set(item.labels.map((label) => label.name));
  const ordered = [...timeline].sort((a, b) => b.created_at.localeCompare(a.created_at));
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

export function matchesFilters(candidate: GithubCandidate, definition: AutomationDefinition): boolean {
  const lower = (values: readonly string[]) => new Set(values.map((value) => value.toLowerCase()));
  const labels = lower(candidate.labels);
  const filters = definition.filters;
  if (filters.authors?.length && !lower(filters.authors).has(candidate.author.toLowerCase())) return false;
  if (filters.assignees?.length && !candidate.assignees.some((value) => lower(filters.assignees!).has(value.toLowerCase()))) return false;
  if (filters.allLabels?.some((value) => !labels.has(value.toLowerCase()))) return false;
  if (filters.anyLabels?.length && !filters.anyLabels.some((value) => labels.has(value.toLowerCase()))) return false;
  if (filters.excludeLabels?.some((value) => labels.has(value.toLowerCase()))) return false;
  if (candidate.changedLabel && filters.changedLabels?.length && !lower(filters.changedLabels).has(candidate.changedLabel.toLowerCase())) return false;
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
