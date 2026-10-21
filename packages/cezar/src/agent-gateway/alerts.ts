/**
 * Task alerts to external agent gateways — OpenClaw and Hermes Agent
 * (spec `.ai/specs/2026-10-21-agent-gateway-integrations.md`).
 *
 * Opt-in by env (AGENTS.md § Zero config): with no `CEZ_OPENCLAW_*` / `CEZ_HERMES_*` target set
 * nothing is built, listened to or sent. A target gets a short text per status TRANSITION of a run
 * (needs-input, review, done, failed, cancelled — `CEZ_ALERT_EVENTS`). What leaves the machine is
 * the task title, status, project id, branch, PR url and, for needs-input, the agent's question —
 * never the prompt, transcript or secrets. Delivery is fire-and-forget: it can fail, it cannot
 * throw into the run engine.
 */
import { createHmac } from 'node:crypto';
import type { RunRecord } from '../runs/store.ts';

export const ALERT_EVENTS = ['needs-input', 'review', 'done', 'failed', 'cancelled'] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];

/** Quiet by default: `done` follows `review` (the user just acted) and `cancelled` is the user's own act. */
export const DEFAULT_ALERT_EVENTS: readonly AlertEvent[] = ['needs-input', 'review', 'failed'];

export interface OpenClawTarget {
  /** Hooks base, e.g. `http://127.0.0.1:18789/hooks`. */
  url: string;
  token: string;
  agentId?: string;
  /** Both or neither: a concrete channel (telegram, slack, …) and its recipient. */
  delivery?: { channel: string; to: string };
}

export interface HermesTarget {
  /** The full route URL, e.g. `http://127.0.0.1:8644/webhooks/cezar`. */
  url: string;
  secret: string;
}

export interface AlertConfig {
  events: ReadonlySet<AlertEvent>;
  openclaw?: OpenClawTarget;
  hermes?: HermesTarget;
  /** `CEZ_ALERT_COCKPIT_URL`: where the cockpit is reachable by whoever reads the alert. */
  cockpitUrl?: string;
  /** Human-readable config problems; the caller prints them once. */
  warnings: string[];
}

export function alertsConfigured(config: AlertConfig): boolean {
  return Boolean(config.openclaw || config.hermes);
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function httpUrl(value: string, name: string, warnings: string[]): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url;
  } catch {
    // fall through
  }
  warnings.push(`${name} is not an http(s) URL — ignored`);
  return undefined;
}

export function alertConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AlertConfig {
  const warnings: string[] = [];
  const events = new Set<AlertEvent>();
  const rawEvents = clean(env.CEZ_ALERT_EVENTS);
  if (rawEvents) {
    for (const name of rawEvents.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean)) {
      if (name === 'all') ALERT_EVENTS.forEach((event) => events.add(event));
      else if ((ALERT_EVENTS as readonly string[]).includes(name)) events.add(name as AlertEvent);
      else warnings.push(`CEZ_ALERT_EVENTS: unknown event "${name}" (known: ${ALERT_EVENTS.join(', ')}, all)`);
    }
  }
  if (events.size === 0) DEFAULT_ALERT_EVENTS.forEach((event) => events.add(event));

  const config: AlertConfig = { events, warnings };
  const cockpitUrl = clean(env.CEZ_ALERT_COCKPIT_URL);
  if (cockpitUrl && httpUrl(cockpitUrl, 'CEZ_ALERT_COCKPIT_URL', warnings)) config.cockpitUrl = cockpitUrl;

  const openclawUrl = clean(env.CEZ_OPENCLAW_URL);
  if (openclawUrl) {
    const url = httpUrl(openclawUrl, 'CEZ_OPENCLAW_URL', warnings);
    const token = clean(env.CEZ_OPENCLAW_HOOK_TOKEN);
    if (url && !token) warnings.push('CEZ_OPENCLAW_URL is set but CEZ_OPENCLAW_HOOK_TOKEN is not — OpenClaw alerts are off');
    if (url && token) {
      // A bare gateway address means OpenClaw's default `hooks.path`; an explicit path wins.
      const base = url.pathname === '/' ? `${url.origin}/hooks` : `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
      const channel = clean(env.CEZ_OPENCLAW_CHANNEL);
      const to = clean(env.CEZ_OPENCLAW_TO);
      if (Boolean(channel) !== Boolean(to)) {
        warnings.push('CEZ_OPENCLAW_CHANNEL and CEZ_OPENCLAW_TO must be set together — alerts go to /hooks/wake instead');
      }
      config.openclaw = {
        url: base,
        token,
        ...(clean(env.CEZ_OPENCLAW_AGENT_ID) ? { agentId: clean(env.CEZ_OPENCLAW_AGENT_ID) } : {}),
        ...(channel && to ? { delivery: { channel, to } } : {}),
      };
    }
  }

  const hermesUrl = clean(env.CEZ_HERMES_WEBHOOK_URL);
  if (hermesUrl) {
    const url = httpUrl(hermesUrl, 'CEZ_HERMES_WEBHOOK_URL', warnings);
    const secret = clean(env.CEZ_HERMES_WEBHOOK_SECRET);
    if (url && !secret) warnings.push('CEZ_HERMES_WEBHOOK_URL is set but CEZ_HERMES_WEBHOOK_SECRET is not — Hermes alerts are off');
    if (url && secret) config.hermes = { url: url.href, secret };
  }
  return config;
}

// ---- what a transition means ------------------------------------------------------------------

/**
 * The alert a run's move from `previous` to its current status raises, if any. `failed` with
 * `awaitingAnswerSince` is a session that ended on an unanswered question — still the user's turn.
 */
export function alertEventFor(previous: string | undefined, run: Pick<RunRecord, 'status' | 'awaitingAnswerSince'>): AlertEvent | undefined {
  if (run.status === previous) return undefined;
  switch (run.status) {
    case 'waiting':
      return 'needs-input';
    case 'failed':
      return run.awaitingAnswerSince ? 'needs-input' : 'failed';
    case 'review':
    case 'done':
    case 'cancelled':
      return run.status;
    default:
      return undefined;
  }
}

export interface AlertTask {
  id: string;
  title: string;
  status: string;
  project: string;
  branch?: string;
  prUrl?: string;
  url?: string;
  question?: string;
  /** needs-input without an ask: the agent's last message; failed: the run's error. Clipped. */
  detail?: string;
}

export interface Alert {
  event: AlertEvent;
  task: AlertTask;
  /** Unix ms of the transition; part of the idempotency id so a later review->review is not dropped. */
  at: number;
}

const TITLE_MAX = 200;
const QUESTION_MAX = 600;
const DETAIL_MAX = 280;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export interface AskQuestionLike {
  question: string;
  options?: Array<{ label: string }>;
}

export function formatQuestion(questions: readonly AskQuestionLike[]): string {
  return clip(
    questions
      .map((q) => (q.options?.length ? `${q.question} [${q.options.map((o) => o.label).join(' / ')}]` : q.question))
      .join(' | '),
    QUESTION_MAX,
  );
}

export function taskFromRun(run: RunRecord, project: string, cockpitUrl?: string, question?: string, lastMessage?: string): AlertTask {
  const prUrl = run.pullRequestUrl;
  const awaiting = run.status === 'waiting' || Boolean(run.awaitingAnswerSince);
  const detailSource = question ? undefined : awaiting ? lastMessage : run.status === 'failed' ? run.error : undefined;
  const detail = detailSource ? clip(detailSource, DETAIL_MAX) : undefined;
  return {
    id: run.id,
    title: clip(run.titleSummary ?? run.title, TITLE_MAX),
    status: run.status,
    project,
    ...(run.branch ? { branch: run.branch } : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(cockpitUrl ? { url: `${cockpitUrl.replace(/\/+$/, '')}/p/${encodeURIComponent(project)}/tasks/${encodeURIComponent(run.id)}` } : {}),
    ...(question ? { question } : {}),
    ...(detail ? { detail } : {}),
  };
}

const HEADLINES: Record<AlertEvent, string> = {
  'needs-input': 'needs your input',
  review: 'is ready for review',
  done: 'is done',
  failed: 'failed',
  cancelled: 'was cancelled',
};

/** The one-message form both targets render. */
export function alertText(alert: Alert): string {
  const { task, event } = alert;
  const lines = [`cezar: "${task.title}" ${HEADLINES[event]} (project ${task.project}, task ${task.id.slice(0, 8)})`];
  if (task.question) lines.push(`Question: ${task.question}`);
  if (task.detail) lines.push(`${event === 'failed' ? 'Error' : 'Last message'}: ${task.detail}`);
  if (task.branch) lines.push(`Branch: ${task.branch}`);
  if (task.prUrl) lines.push(`PR: ${task.prUrl}`);
  if (task.url) lines.push(`Open: ${task.url}`);
  return lines.join('\n');
}

// ---- requests ---------------------------------------------------------------------------------

export interface AlertRequest {
  target: 'openclaw' | 'hermes';
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Hermes' generic HMAC V2 (gateway/platforms/webhook.py): hex HMAC-SHA256 of `<unix seconds>.<body>`. */
export function hermesSignature(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function alertId(alert: Alert): string {
  return `cezar-${alert.task.id}-${alert.event}-${alert.at}`;
}

export function openclawRequest(target: OpenClawTarget, alert: Alert): AlertRequest {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${target.token}` };
  const text = alertText(alert);
  if (target.delivery) {
    // /hooks/agent runs an isolated agent turn that messages the user and can answer via the cezar MCP tools.
    const hint = alert.event === 'needs-input'
      ? '\nTell the user this question. If they answer, send it with the cezar_send_message tool.'
      : '\nTell the user briefly.';
    return {
      target: 'openclaw',
      url: `${target.url}/agent`,
      headers: { ...headers, 'idempotency-key': alertId(alert) },
      body: JSON.stringify({
        message: `${text}${hint}`,
        name: 'cezar',
        ...(target.agentId ? { agentId: target.agentId } : {}),
        wakeMode: 'now',
        deliver: true,
        channel: target.delivery.channel,
        to: target.delivery.to,
        idempotencyKey: alertId(alert),
      }),
    };
  }
  return {
    target: 'openclaw',
    url: `${target.url}/wake`,
    headers,
    body: JSON.stringify({ text, mode: 'now', ...(target.agentId ? { agentId: target.agentId } : {}) }),
  };
}

export function hermesRequest(target: HermesTarget, alert: Alert): AlertRequest {
  // `message` is what a `deliver_only` route templates as `{message}`; `event_type` is what Hermes
  // reads as the event name (its `events:` filter), `task` is for routes that run an agent.
  const body = JSON.stringify({ event_type: `cezar.task.${alert.event}`, message: alertText(alert), task: alert.task });
  const timestamp = String(Math.floor(alert.at / 1000));
  return {
    target: 'hermes',
    url: target.url,
    headers: {
      'content-type': 'application/json',
      'x-webhook-timestamp': timestamp,
      'x-webhook-signature-v2': hermesSignature(target.secret, timestamp, body),
      'x-request-id': alertId(alert),
    },
    body,
  };
}

export function alertRequests(config: AlertConfig, alert: Alert): AlertRequest[] {
  return [
    ...(config.openclaw ? [openclawRequest(config.openclaw, alert)] : []),
    ...(config.hermes ? [hermesRequest(config.hermes, alert)] : []),
  ];
}

// ---- delivery ---------------------------------------------------------------------------------

export interface AlertDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  dryRun: boolean;
  log: (line: string) => void;
}

export const ALERT_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 1_000;

export function defaultAlertDeps(env: NodeJS.ProcessEnv = process.env): AlertDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    dryRun: env.CEZ_DRY_RUN === '1',
    log: (line) => console.warn(line),
  };
}

export interface DeliveryResult {
  target: AlertRequest['target'];
  ok: boolean;
  /** `dry-run`, an HTTP status, or the failure reason. */
  detail: string;
}

/** One request, one retry on a network error or 5xx/429. Never throws. */
export async function deliver(request: AlertRequest, deps: AlertDeps): Promise<DeliveryResult> {
  if (deps.dryRun) {
    deps.log(`[alerts] dry run — ${request.target} ${request.url} not sent: ${request.body}`);
    return { target: request.target, ok: true, detail: 'dry-run' };
  }
  let detail = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await deps.sleep(RETRY_DELAY_MS);
    try {
      const response = await deps.fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
      });
      // Drain so the socket is released; the body is the gateway's, not ours to log.
      await response.arrayBuffer().catch(() => undefined);
      if (response.ok) return { target: request.target, ok: true, detail: String(response.status) };
      detail = `HTTP ${response.status}`;
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
  }
  return { target: request.target, ok: false, detail };
}

export async function sendAlert(config: AlertConfig, alert: Alert, deps: AlertDeps): Promise<DeliveryResult[]> {
  const results = await Promise.all(alertRequests(config, alert).map((request) => deliver(request, deps)));
  for (const result of results) {
    if (!result.ok) deps.log(`[alerts] ${result.target} alert for task ${alert.task.id.slice(0, 8)} not delivered — ${result.detail}`);
  }
  return results;
}

// ---- the watcher ------------------------------------------------------------------------------

/** The slice of `RunStore` the watcher needs, so tests drive it with a plain EventEmitter. */
export interface AlertSource {
  listRuns(): RunRecord[];
  on(event: 'run', listener: (run: RunRecord) => void): unknown;
  on(event: 'event', listener: (frame: { runId: string; event: { type: string; [key: string]: unknown } }) => void): unknown;
}

export class RunAlerts {
  constructor(
    private readonly config: AlertConfig,
    private readonly deps: AlertDeps = defaultAlertDeps(),
    /** Fallback link base (the address this cockpit listens on) when `CEZ_ALERT_COCKPIT_URL` is unset. */
    private readonly defaultCockpitUrl?: string,
  ) {}

  get enabled(): boolean {
    return alertsConfigured(this.config);
  }

  /**
   * Listen to one project's store. Statuses already on record are the baseline, so a restart or a
   * lazy project load never replays old transitions. The store drops its listeners when the
   * project context is torn down, so there is nothing to dispose here.
   */
  watch(store: AlertSource, project: string): void {
    if (!this.enabled) return;
    const last = new Map<string, string>(store.listRuns().map((run) => [run.id, run.status]));
    const questions = new Map<string, string>();
    const lastMessages = new Map<string, string>();
    store.on('event', ({ runId, event }) => {
      if (event.type === 'ask.requested' && Array.isArray(event.questions)) {
        const text = formatQuestion(event.questions as AskQuestionLike[]);
        if (text) questions.set(runId, text);
        return;
      }
      // The agent's last words, for a needs-input that carries no structured question.
      const item = event.item as { kind?: string; role?: string; text?: unknown } | undefined;
      if (event.type === 'item.completed' && item?.kind === 'message' && item.role === 'assistant' && typeof item.text === 'string') lastMessages.set(runId, item.text);
      else if (event.type === 'text' && typeof event.text === 'string') lastMessages.set(runId, event.text);
    });
    store.on('run', (run) => {
      const previous = last.get(run.id);
      last.set(run.id, run.status);
      const event = alertEventFor(previous, run);
      const question = event === 'needs-input' ? questions.get(run.id) : undefined;
      if (run.status !== 'waiting' && run.status !== 'failed') {
        questions.delete(run.id);
        lastMessages.delete(run.id);
      }
      if (!event || !this.config.events.has(event)) return;
      const alert: Alert = { event, at: this.deps.now(), task: taskFromRun(run, project, this.config.cockpitUrl ?? this.defaultCockpitUrl, question, lastMessages.get(run.id)) };
      // Detached on purpose: the run engine must never wait on, or hear about, a gateway.
      void sendAlert(this.config, alert, this.deps).catch(() => undefined);
    });
  }
}
