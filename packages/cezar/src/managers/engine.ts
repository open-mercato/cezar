import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import {
  isImageMediaType,
  managerAccessOf,
  managerConnectorToolMode,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENTS_TOTAL_BASE64,
  runnerSupportsReasoningEffort,
  MANAGER_DEFAULT_CRON_MINUTES,
  MODEL_DISCOVERY_RUNNERS,
  QUESTIONS_OLDER_DEFAULT_DAYS,
  type CreateManagerInput,
  type Manager,
  type AttachmentInput,
  type ManagerActionRequest,
  type ManagerAsk,
  type ManagerActionStatus,
  type ManagerActivityNotice,
  type ManagerCancelTaskInput,
  type ManagerCancelTaskResponse,
  type ManagerCommand,
  type ManagerConnectorsResponse,
  type ManagerCreateTaskInput,
  type ManagerCreateTaskResponse,
  type ManagerForwarded,
  type ManagerJob,
  type ManagerMessage,
  type ManagerTaskSource,
  type ManagerMessagesResponse,
  type ManagerProposeActionInput,
  type ManagerRetryTaskInput,
  type ManagerSwitchTaskInput,
  type ManagerSnapshot,
  type ManagerSummary,
  type ManagerTaskDetail,
  type ManagerTaskAgent,
  type ManagerAccountState,
  type ManagerTaskMessageInput,
  type ManagerTaskMessageResponse,
  type ManagerTurnKind,
  type SwitchRunAgentResponse,
  type QuestionClosed,
  type QuestionStale,
  type UpdateManagerInput,
  type ManagerMemoryResponse,
  type PutManagerMemoryInput,
  MANAGER_MEMORY_LIMITS,
  supersededAskIds,
  questionCardPartlyReasked,
  questionCardSharedHeaders,
} from '@open-mercato/cezar-contract';
import type { AttentionKind, AutomationDefinition, AutomationReportMode, ManagerBashDenial } from '@open-mercato/cezar-contract';
import { DEFAULT_AGENT_ACCOUNT_ID } from '../workspace/agent-accounts.ts';
import { taskAgentSelection } from '../runs/agent-selection.ts';
import { loadConfig } from '../config.ts';
import { agentModelsLocked } from '../core/agent-model-policy.ts';
import { parseAskCloseMarkers, parseAskMarker, stripAskCloseMarkers, stripAskMarker, type AskCloseMarker } from '../core/ask.ts';
import type { RunRecord } from '../runs/store.ts';
import { isIdleParked } from '../runs/store.ts';
import { chooseTaskAgent, type AccountOption, type TaskAgentChoice } from './task-agent-choice.ts';
import { isRunnerId, type AgentEvent, type AgentRunner, type AgentRunSpec, type AgentSession, type ContentBlock, type RunnerId } from '../core/agent-runner.ts';
import { supportsProfiles } from '../core/agent-profiles.ts';
import { readOnlyEnv } from '../core/read-only-env.ts';
import { canEnforceReadOnly, createRunner } from '../core/runner-factory.ts';
import { parseUsageLimit } from '../core/usage-limit.ts';
import type { UiEvent } from '../core/ui-events.ts';
import { assertCezarHomeWriteIsSandboxed, managersDir } from '../paths.ts';
import { resolveProfileEnvForRoot } from '../workspace/agent-profiles.ts';
import {
  changedSettingFields,
  managerActionLabel,
  managerAgeLabel,
  managerCreatedLabel,
  MANAGER_TURN_TRIGGER,
  managerWorkflowLabel,
  type ManagerTelemetry,
  type ManagerTelemetryContext,
} from './telemetry.ts';
import {
  isManagerBashAllowed,
  MANAGER_BASH_ALLOW_ENV,
  MANAGER_BASH_ALLOWLIST,
  managerBashHookCommand,
  managerBashPatternIssue,
  managerBashSuggestion,
  managerShellPlan,
  MANAGER_SHELL_DESCRIPTION,
  MANAGER_BASH_FILTERS,
} from './bash-policy.ts';
import { classifyManagerFailure, failureCause, managerFailureMessage, retryPlan, type ManagerFailureKind } from './failure.ts';
import { placeholderIn, placeholderRefusal, withForwarded } from './forward.ts';
import {
  canonicalJson,
  CONNECTOR_UNAVAILABLE,
  connectorAllowRules,
  connectorCallFence,
  connectorCallPrompt,
  connectorDisplayName,
  connectorInfos,
  connectorPromptSection,
  connectorToolName,
  hasConnectorGrant,
  observeConnectors,
  type ObservedConnectors,
} from './connectors.ts';
import { taskModelIssue, type TaskModelCatalog } from './task-model.ts';
import { TurnStatsCollector } from './turn-stats.ts';
import { chatPrompt, followupPrompt, jobPrompt, MANAGER_IMPORTANT, managerSystemPrompt, MANAGER_QUIET, sessionPreamble, watchPrompt } from './prompts.ts';
import { claudeAutoMemory, memoryBytes, readMemory, removeMemoryEntry, renderMemory, setMemoryEntry, writeMemory, type MemoryFile } from './memory.ts';
import { buildSnapshot, findRun, gateAttention, openTaskAskId, prTie, taskDetailRows, taskEventOf, type ManagerGithubFacts, type ManagerProjectSource, type TaskEvent } from './snapshot.ts';
import {
  ageLabel,
  cardHeaders,
  closeMarkerMatches,
  isOlder,
  namedWork,
  namesWork,
  openAsk,
  openCardsBlock,
  openCardsDigest,
  openCardsUnchanged,
  aboutPrProjects,
  prRefs,
  replaces,
  taskSources,
  type AskMessage,
  type AssistantMessage,
  type ManagerAskCard,
  type ManagerAskChange,
  type ManagerAskResult,
  type PrRef,
} from './questions.ts';
import { finalAssistantText, resumeLabel } from './automation-reports.ts';
import type { ManagerState, ManagerStore } from './store.ts';
import { outsideRelayScope } from '../relay/scope.ts';
import { PlanUsageTracker, recordUsageObservation, type LedgerAccountRef } from '../usage-ledger/recorder.ts';
import { ledgerAccountRef } from '../usage-ledger/identity.ts';
import { managerConsumerId } from '../usage-ledger/report.ts';

/**
 * The manager turn engine (spec 2026-10-31-managers § Turns, § Watching, § Safety). One turn per
 * manager at a time, each a single resumed agent session, so a manager costs nothing while idle.
 */

export type ManagerRefusal = { error: string; status: 400 | 403 | 404 | 409 | 502 };

type LoopbackRequest = (path: string, init?: RequestInit) => Response | Promise<Response>;

export interface ManagerEngineDeps {
  store: ManagerStore;
  emit: (event: 'manager-change' | 'manager-message' | 'manager-delta', data: unknown) => void;
  /** Every project this cockpit can see, read without building contexts. */
  projects: () => Promise<ManagerProjectSource[]>;
  github: ManagerGithubFacts;
  defaultRunner: () => Promise<RunnerId>;
  /** Why this account cannot be picked, as `POST /runs` would say it. */
  accountError: (runner: RunnerId, agentProfile: string) => Promise<string | null>;
  /** An account's resolved id, label and usage-limit reset (epoch ms) from the workspace holds.
   *  Absent: every account has capacity. */
  accountLimit?: (runner: RunnerId, agentProfile: string | undefined, repoRoot?: string) => Promise<{ account: string; label: string; until?: number }>;
  /** The cockpit's own routes, in process: POST /runs, merge, enable have exactly one implementation. */
  request: LoopbackRequest;
  costVisible: () => boolean;
  /** Settings → Resources' auto-resume switch; off keeps a usage limit a plain failure. Absent = on. */
  autoResume?: () => boolean;
  /** Raises the OS notification; absent where there is nobody at the machine. */
  notifySystem?: (title: string, body: string) => void;
  /** Wakes a sleeping phone (spec relay R5). The manager's id and the kind, which each phone's
   *  settings filter on (spec 2026-11-20-phone-notifications-inbox); no text reaches a push. */
  pushSignal?: (managerId: string, kind: AttentionKind) => void;
  runnerFor?: (runner: RunnerId) => AgentRunner;
  /** Usage telemetry (docs/telemetry.md); absent sends nothing. Consent is the sender's to check. */
  telemetry?: ManagerTelemetry;
  now?: () => number;
  /** Workspace ui-state `questions.olderAfterDays`: an open card older than this stops counting
   *  (Questions inbox spec). Absent, or `undefined` from it, is `QUESTIONS_OLDER_DEFAULT_DAYS`; 0 is off. */
  olderAfterDays?: () => number | undefined | Promise<number | undefined>;
  /** Test seam for `TURN_LIMIT_MS`. */
  turnLimitMs?: number;
  /** Test seam for `RETRY_BACKOFF_MS`. */
  retryDelayMs?: number;
  /** A manager was deactivated or reactivated: the Questions count leaves its cards out while inactive. */
  onActivityChange?: (managerId: string) => void;
}

/** What `check`, a connector probe and the chat routes answer for a deactivated manager (spec 2026-11-19-manager-deactivate). */
export const MANAGER_INACTIVE = 'manager inactive';

/** One finished run of an automation linked to a manager (`reportAutomationRun`). */
export interface AutomationRunReport {
  managerId: string;
  mode: AutomationReportMode;
  projectId: string;
  automationId: string;
  automationName: string;
  runId: string;
  outcome: 'success' | 'failure';
  /** The run's last assistant message, posted verbatim on success. */
  text?: string;
  /** Why it failed: the run's own error. */
  reason?: string;
  /** A usage limit's automatic resume, already formatted for the user. */
  resumesAt?: string;
  /** The watch's keys for this run, marked reported. */
  attentionKeys: string[];
}

const REPORT_REASON_LIMIT = 300;
/** A task's final message rides its card whole up to this; `cez-manager task` reads the rest. */
const TASK_REPORT_TEXT_LIMIT = 8_000;
/** Events closer than this share one follow-up turn: a tree settling, a burst of finishes. */
const FOLLOWUP_COALESCE_MS = 2_000;
/** The oldest follow goes first past this; a manager rarely follows more than a handful. */
const FOLLOW_LIMIT = 200;
/** Its history of created tasks; only the oldest goes past this. */
const CREATED_LIMIT = 2_000;
const PENDING_FOLLOWUP_LIMIT = 20;
/** Enough for a task's questions and its summary; the card keeps the whole message. */
const FOLLOWUP_EXCERPT_LIMIT = 4_000;
const FINAL_MESSAGE_MARK = '\nIts final message:\n';
const followupHeadline = (entry: string): string => entry.split(FINAL_MESSAGE_MARK)[0] ?? entry;
/** At most this many events owed a follow-up turn per followed task per window; past it, cards and notes only. */
const FOLLOWUP_TURNS_PER_TASK = 5;
const FOLLOWUP_TURN_WINDOW_MS = 60 * 60_000;
/** A follow-up another cockpit's long turn kept waiting tries again this much later. */
const FOLLOWUP_LEASE_RETRY_MS = 60_000;

/** A message straight from the server, no model turn: automation reports and task cards. */
interface DirectPost {
  messageId: string;
  turn: ManagerTurnKind;
  text: string;
  /** Set = important: the unread badge, and the OS notification unless `notify` is off. */
  headline?: string;
  fields: Partial<Extract<ManagerMessage, { kind: 'assistant' }>>;
  /** The watch's keys for what this message reports, marked reported. */
  attentionKeys: string[];
}

const TASK_STATE_LINE: Record<TaskEvent['state'], string> = {
  done: 'Finished',
  review: 'Finished, ready for review',
  failed: 'Failed',
  'needs-you': 'Needs you',
  cancelled: 'Cancelled',
};

const firstLine = (text: string | undefined, limit: number): string | undefined =>
  text?.split('\n').find((line) => line.trim())?.trim().slice(0, limit);

type PendingFollowup = ManagerState['followups'][number];

/** By event identity, never text: the same task waiting again mid-turn reads the same and is still news. */
const withoutHeard = (pending: PendingFollowup[], heard: PendingFollowup[]): PendingFollowup[] => {
  const ledgers = new Set(heard.map((entry) => entry.ledger));
  return pending.filter((entry) => !ledgers.has(entry.ledger));
};

const followKey = (projectId: string, runId: string): string => `${projectId}/${runId}`;

function withCreated(created: ManagerState['created'], key: string, at: string): ManagerState['created'] {
  const kept = Object.entries(created).filter(([other]) => other !== key)
    .sort(([, a], [, b]) => msOf(a) - msOf(b)).slice(-(CREATED_LIMIT - 1));
  return Object.fromEntries([...kept, [key, created[key] ?? at]]);
}

/** Every task it created (followed or not) or follows, newest first. */
function followedTasks(state: ManagerState): string[] {
  const at = new Map(Object.entries(state.created));
  for (const [key, follow] of Object.entries(state.follows)) if (!at.has(key)) at.set(key, follow.at);
  return [...at].sort(([, a], [, b]) => msOf(b) - msOf(a)).map(([key]) => key);
}

const connectedTo = (manager: Manager, projectId: string): boolean =>
  manager.projects === 'all' || manager.projects.includes(projectId);

/** Due times count from the last reactivation at the earliest, so nothing overdue fires at once. */
const floorAt = (manager: Manager, iso: string | undefined): number =>
  Math.max(msOf(iso ?? manager.createdAt), manager.activeSince ? msOf(manager.activeSince) : 0);

const jobDueAt = (manager: Manager, job: ManagerJob): number => floorAt(manager, job.lastRunAt) + job.everyMinutes * 60_000;

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

type QueueItem =
  | { kind: 'chat'; text: string; images: ContentBlock[]; paths: string[]; messageIds: string[] }
  | { kind: 'watch'; forced: boolean }
  | { kind: 'job'; jobId: string }
  /** Acts on followed-task events; reads them from state under the lease, so they coalesce. */
  | { kind: 'followup' }
  /** The chat a usage limit cut off; read from state under the lease, so only one cockpit replays it. */
  | { kind: 'resume' };

interface ActiveTurn {
  sourceTasks?: ReturnType<typeof taskSources>;
  kind: ManagerTurnKind;
  /** Screenshots the user sent with this message, for the model to see. */
  images?: ContentBlock[];
  /** The user messages this chat turn answers, oldest first: `fromMessage: 'last'` is the newest. */
  messageIds?: string[];
  /** False while a watch check is still deciding whether a model call is needed at all. */
  started: boolean;
  stopped: boolean;
  session?: AgentSession;
  stopTimer?: NodeJS.Timeout;
  limit?: NodeJS.Timeout;
  /** Interrupted by `TURN_LIMIT_MS`, not by the user. */
  timedOut?: boolean;
  /** The whole turn, gate and setup included: a delete waits for it before removing the files. */
  settled?: Promise<unknown>;
  /** Plan-usage ledger: the reply this turn writes and the account it runs on (design rev 3). */
  ledgerMessageId?: string;
  planAccount?: LedgerAccountRef & { provider: 'claude' | 'codex' };
  /** The open cards this chat turn shows (`openCards`): `ids` stands in for `full` only in a resumed session. */
  cards?: { digest: string; full: string; ids?: string };
}

interface Runtime {
  queue: QueueItem[];
  active?: ActiveTurn;
  retry?: NodeJS.Timeout;
  retries: number;
  deleted?: boolean;
}

type Progress = () => { text: string; commands: ManagerCommand[] };

interface DriveResult {
  text: string;
  commands: ManagerCommand[];
  costUsd: number;
  error?: string;
  /** Absent when the turn failed before a runner was picked. */
  runner?: RunnerId;
}

const STREAM_THROTTLE_MS = 100;
/** A full frame whenever the reply doubles past this, so the wire stays linear and a lost delta heals. */
const KEYFRAME_FLOOR = 4_096;
const STOP_GRACE_MS = 5_000;
/** A hung agent must not hold a manager forever: watch and job turns have nobody to press Stop. */
const TURN_LIMIT_MS = 30 * 60_000;
const TURN_LIMIT_ERROR = 'Stopped: this turn ran for 30 minutes without finishing.';
const LEASE_STALE_MS = 30_000;
const LEASE_RETRY_MS = 5_000;
const LEASE_RETRY_LIMIT = 24;
const TICK_FLOOR_MS = 5_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_WATCH_BACKOFF = 4;
/** The pause before the one retry a passing failure (network, busy servers) earns. */
const RETRY_BACKOFF_MS = 5_000;
/** A chat resumes its transcript only while the prompt cache is warm (1 h), the context is small and
 *  the session young; otherwise it starts over from memory and live state (spec 2026-11-21 § 2.2). */
export const SESSION_IDLE_MS = 55 * 60_000;
export const SESSION_CONTEXT_MAX = 100_000;
export const SESSION_AGE_MS = 12 * 60 * 60_000;
/** Followed tasks a new session is told about. */
const PREAMBLE_TASKS = 15;
/** Failed watch checks in a row before the chat hears about them; fewer are logged quietly. */
const WATCH_NOTICE_AFTER = 3;
const OUTPUT_LIMIT = 4_000;
const DENIAL_COMMAND_LIMIT = 300;
const DENIALS_KEPT = 20;
/** The hook's deny, and Claude's own `dontAsk` refusal of a command no rule allows. */
const BASH_DENIED = /cezar manager policy:|Permission to use Bash has been denied/;

/** Denials a pattern the user since allowed now covers are gone; each carries its suggestion. */
function denialsOf(manager: Manager, denials: ManagerState['bashDenials']): { bashDenials?: ManagerBashDenial[] } {
  const shown = denials.flatMap((denial): ManagerBashDenial[] => {
    const suggestion = managerBashSuggestion(denial.command);
    if (suggestion && manager.bashAllow?.includes(suggestion)) return [];
    return [{ ...denial, ...(suggestion ? { suggestion } : {}) }];
  });
  return shown.length > 0 ? { bashDenials: shown } : {};
}
const TAIL_BYTES = 256 * 1024;
const PREVIEW_LIMIT = 120;

export const MANAGER_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'];
/** Claude's wildcard spelling: `cez-manager` alone or with arguments, nothing else. */
export const MANAGER_SANDBOX_EXCLUDED = ['cez-manager *'] as const;
/** Claude's absolute-path rule spelling: `//abs/path`, a Windows drive as `//c/…`. */
const claudeAbsolutePath = (path: string): string =>
  `/${path.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)}`;

/** Write and Edit inside `files/` only: the workdir itself holds `.claude/`, which would widen the fence. */
export function managerWriteRules(filesDir: string): string[] {
  const scope = `${claudeAbsolutePath(filesDir)}/**`;
  return [`Write(${scope})`, `Edit(${scope})`];
}

export { MANAGER_BASH_ALLOWLIST } from './bash-policy.ts';

/** Backends that keep the manager to `MANAGER_BASH_ALLOWLIST` (Pi drops `Bash` instead). */
// Claude fences Bash with its hook, Codex through cezar's broker
// running `managerShellPlan` in an isolated session (#2330).
const ALLOWLIST_FENCED: ReadonlySet<RunnerId> = new Set<RunnerId>(['claude', 'pi']).add('codex');

/** `attachmentInputSchema`'s per-file bound, and the task text bound of `POST /runs`. */
const ATTACHMENT_BASE64_LIMIT = 7_000_000;
const FORWARD_TEXT_LIMIT = 100_000;

interface Forward {
  text: string;
  images: AttachmentInput[];
  forwarded: ManagerForwarded;
}

/** Where a user turn starts, shared by its retries (spec 2026-11-21 § 2.3). */
interface TurnOrigin {
  startedAt: number;
  /** The session record before this turn, when it resumes one. */
  prior?: NonNullable<ManagerState['sessions']['chat']>;
}

const SESSION_FIELD = { chat: 'sessionId', watch: 'watchSessionId', job: 'jobSessionId' } as const;

const CONNECTORS_CLAUDE_ONLY = 'Only a Claude Code manager can use connectors: Codex, OpenCode and the others keep their own MCP configuration.';
/** A probe needs only Claude's `system/init`; an approved call gets one tool call's worth of time. */
const CONNECTOR_PROBE_LIMIT_MS = 60_000;
const CONNECTOR_CALL_LIMIT_MS = 5 * 60_000;

type ConnectorCall = Extract<ManagerActionRequest, { type: 'connector-call' }>;

const MEMORY_DURING_WATCH = 'Memory cannot change while a background check runs (it is read-only). Try again in a moment.';
const WATCH_REFUSAL = 'A watch check is read-only: it may ask the user to act, it may not act. Say what you would do and let the user ask for it.';

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * A Codex manager's Bash: the policy Claude's hook applies, run by cezar's broker. Unlike a Claude
 * manager's `gh`, which stays inside the user's Claude Bash sandbox (only `cez-manager` is excluded),
 * these commands run directly on the host with the engine's environment, so a sandbox network
 * allowlist does not apply to them. They are still only the vetted read-only set.
 */
function codexManagerShell(bashAllow: readonly string[] | undefined, env: Record<string, string | undefined>): NonNullable<AgentRunSpec['brokeredShell']> {
  return {
    verify: (command) => managerShellPlan(command, bashAllow ?? []), env, describe: MANAGER_SHELL_DESCRIPTION,
    // The cockpit is loopback and the filters read only their pipe; every `gh`, user patterns included, is network.
    offlinePrograms: ['cez-manager', ...MANAGER_BASH_FILTERS],
  };
}

/** `cez-manager` on the turn's PATH, so `bashAllowlist` can name one word. */
export function ensureManagerShim(): string {
  const dir = join(managersDir(), 'bin');
  assertCezarHomeWriteIsSandboxed(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A dev cockpit runs under tsx: the shim needs the same loader flags to run a .ts entrypoint.
  const flags = process.execArgv.filter((arg) => !arg.startsWith('--inspect'));
  const write = (name: string, body: string) => {
    const path = join(dir, name);
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      // first turn
    }
    if (current !== body) writeFileSync(path, body, { mode: 0o755 });
    chmodSync(path, 0o755);
  };
  write('cez-manager', `#!/bin/sh\nexec ${[process.execPath, ...flags].map(shellQuote).join(' ')} "$CEZ_BIN" manager "$@"\n`);
  if (process.platform === 'win32') write('cez-manager.cmd', `@"${process.execPath}" "%CEZ_BIN%" manager %*\r\n`);
  return dir;
}

function commandSummary(input: unknown): string {
  if (typeof input === 'object' && input !== null) {
    for (const key of ['command', 'pattern', 'file_path', 'path', 'query']) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === 'string' && value) return value.slice(0, 300);
    }
  }
  return '';
}

const onePlainLine = (text: string): string =>
  text.replace(/\[\[task:[^\]]*\]\]/g, 'a task').replace(/\[\[pr:[^\]]*\/(\d+)\]\]/g, 'PR $1')
    .replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LIMIT);

const QUIET_LINE = new RegExp(`(^|\\n)\\s*${MANAGER_QUIET}\\s*$`);
const IMPORTANT_LINE = new RegExp(`^\\s*${MANAGER_IMPORTANT}\\b[ \\t:]*(.*)(?:\\n|$)`, 'm');
const HEADLINE_LIMIT = 140;
/** Long enough for an open tab to mark the message read, so nobody is told what they are reading. */
const SYSTEM_NOTIFY_DELAY_MS = 3_000;
const READ_STREAMING_LIMIT = 20;

/** Not opened yet. A reply read mid-stream keeps its seq (its place) and stays new until read settled. */
const unseen = (state: ManagerState, message: { id: string; seq: number }): boolean =>
  message.seq > state.readSeq || state.readStreaming.includes(message.id);

/** A hand-edited date reads as long past: one early check, then a real stamp. Never `NaN`. */
const msOf = (iso: string): number => Date.parse(iso) || 0;

/** Claude prints its limit as the reply and exits 1: only a short, tool-free reply is read as one. */
const LIMIT_REPLY_MAX = 500;

type TurnOutcome = 'heard' | 'failed' | 'limited';

const turnFailure = (cause: unknown): DriveResult => ({ text: '', commands: [], costUsd: 0, error: cause instanceof Error ? cause.message : String(cause) });

/** A half-streamed `CEZ:ASK` line is not text yet: parsing it waits for the final frame. */
const STREAMING_ASK = /^[ \t]*CEZ:ASK\b[\s\S]*$/m;

interface Judged {
  text: string;
  important: boolean;
  headline?: string;
  ask?: ManagerAsk;
  /** `CEZ:ASK-CLOSE` lines, stripped from `text` (Questions inbox spec). */
  closes: AskCloseMarker[];
}

function judged(raw: string): Judged {
  const closes = parseAskCloseMarkers(raw);
  // Before the ask parse: a close line after `CEZ:ASK` would end up in its JSON.
  const plain = closes.length > 0 ? stripAskCloseMarkers(raw) : raw;
  const ask = parseAskMarker(plain) ?? undefined;
  const body = ask ? stripAskMarker(plain) : plain;
  const match = IMPORTANT_LINE.exec(body);
  const headline = (match?.[1] ?? '').trim().slice(0, HEADLINE_LIMIT);
  return {
    text: (match ? body.replace(IMPORTANT_LINE, '') : body).trim(),
    important: match !== null,
    ...(headline ? { headline } : {}),
    ...(ask ? { ask } : {}),
    closes,
  };
}

const judgedFields = ({ important, headline, ask }: Judged) => ({
  ...(important ? { important } : {}),
  ...(headline ? { headline } : {}),
  ...(ask ? { ask } : {}),
});

/** A task report's push kind; any other headline is an important message. */
const reportKind = (fields: unknown): AttentionKind => {
  const state = (fields as { taskReport?: { state?: string } } | undefined)?.taskReport?.state;
  return state === 'failed' ? 'failed' : state === 'needs-you' ? 'task' : 'message';
};

/** A question always waits on the user, so it interrupts like an approval does. */
const alertBody = ({ important, headline, ask, text }: Judged): string | undefined =>
  important ? headline ?? onePlainLine(text) : ask ? 'Has a question for you' : undefined;

/** The end of a task's assistant text, off its event file. Best effort: a task may have none. */
function lastAssistantText(root: string, runId: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(join(root, '.ai', 'cezar', 'runs', `${runId}.ndjson`), 'r');
  } catch {
    return undefined;
  }
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line?.includes('"type":"text"')) continue;
      try {
        const event = JSON.parse(line) as { type?: unknown; text?: unknown };
        if (event.type === 'text' && typeof event.text === 'string') return event.text.slice(-2_000);
      } catch {
        // a torn first line of the window
      }
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

export class ManagerEngine {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly leases = new Map<string, () => void>();
  private readonly settling = new Set<Promise<unknown>>();
  private timer?: NodeJS.Timeout;
  private recoveryTimer?: NodeJS.Timeout;
  /** Managers `recover` could not lease: swept by whichever lease this process takes first. */
  private readonly unrecovered = new Set<string>();
  private started = false;
  private disposed = false;

  private readonly alerts = new Set<NodeJS.Timeout>();
  /** Per manager, the pending follow-up's coalescing window. */
  private readonly followupTimers = new Map<string, NodeJS.Timeout>();
  /** Per manager, the newest `manager-change` asked for: summaries resolve out of order. */
  private readonly changes = new Map<string, number>();
  /** Attention keys already pushed, so a watch that keeps failing does not push the same task again. */
  private readonly pushedAttention = new Map<string, Set<string>>();
  /** The Questions inbox provider's listeners: every card opened, closed or flagged. */
  private readonly askListeners = new Set<(change: ManagerAskChange) => void>();

  constructor(private readonly deps: ManagerEngineDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private runtime(id: string): Runtime {
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      runtime = { queue: [], retries: 0 };
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  /** Arms nothing when no manager exists. Recovery first: a turn cannot survive its process. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    // A SIGKILL leaves the lease until it goes stale, so a quick restart has to look again.
    if (!this.recover()) {
      this.recoveryTimer = setTimeout(() => this.recover(), LEASE_STALE_MS + 5_000);
      this.recoveryTimer.unref?.();
    }
    this.reschedule();
    // Events that happened while cezar was down: their cards, then the turns still owed.
    void this.reconcileFollows().catch((error) => console.warn(`[cezar] manager follows: ${error instanceof Error ? error.message : String(error)}`));
    for (const manager of this.deps.store.list()) {
      if (!manager.inactive && this.deps.store.state(manager.id).followups.length > 0) this.scheduleFollowup(manager.id);
    }
  }

  private inactive(id: string): boolean {
    return this.deps.store.get(id)?.inactive !== undefined;
  }

  /** A `streaming` message at boot is a turn that died with its process — unless a second cockpit
   *  still holds that manager's lease, in which case the turn is alive over there. False when a
   *  lease kept it from looking at every manager. */
  recover(): boolean {
    let complete = true;
    for (const manager of this.deps.store.list()) {
      // Our own lease is a turn alive in this process, not one to recover.
      if (this.leases.has(manager.id)) continue;
      // Swept by the first turn after it is reactivated.
      if (manager.inactive) {
        this.unrecovered.add(manager.id);
        continue;
      }
      const release = this.tryLease(manager.id);
      if (!release) {
        this.unrecovered.add(manager.id);
        complete = false;
        continue;
      }
      try {
        this.sweep(manager.id, false);
      } finally {
        release();
      }
    }
    return complete;
  }

  /** Under the lease. `answering`: the last user message is the one this turn takes up. */
  private sweep(id: string, answering: boolean): void {
    this.unrecovered.delete(id);
    const messages = this.deps.store.messages(id);
    for (const message of messages) {
      if (message.kind === 'assistant' && message.streaming) {
        this.publish(id, { ...message, streaming: false, stopped: true }, true);
        this.addNotice(id, 'cezar restarted during this reply.');
      } else if (message.kind === 'action' && message.status === 'running') {
        this.publish(id, { ...message, status: 'failed', result: 'cezar restarted before this finished. Check it before trying again.' }, true);
      }
    }
    if (!answering && messages.at(-1)?.kind === 'user') this.addNotice(id, 'cezar restarted before answering this. Send it again if you still need it.');
    this.collapseDuplicateCards(id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    for (const timer of this.alerts) clearTimeout(timer);
    this.alerts.clear();
    for (const timer of this.followupTimers.values()) clearTimeout(timer);
    this.followupTimers.clear();
    this.timer = undefined;
    for (const runtime of this.runtimes.values()) {
      if (runtime.retry) clearTimeout(runtime.retry);
      runtime.queue = [];
      this.interrupt(runtime);
    }
  }

  /** `dispose`, then wait for the in-flight turns to write their final message. */
  async shutdown(): Promise<void> {
    this.dispose();
    await Promise.allSettled([...this.settling]);
  }

  /** Turns and checks in flight, the silent gate phase included. */
  inFlight(): number {
    return this.settling.size;
  }

  private interrupt(runtime: Runtime): void {
    const turn = runtime.active;
    if (!turn || turn.stopped) return;
    turn.stopped = true;
    if (!turn.session) return;
    try {
      turn.session.interrupt();
    } catch {
      // already tearing down
    }
    const session = turn.session;
    turn.stopTimer = setTimeout(() => (session.hardStop ? session.hardStop() : session.end()), STOP_GRACE_MS);
    turn.stopTimer.unref?.();
  }

  // ---- lease -------------------------------------------------------------------------------

  /** Two cockpits on one home must not both run a manager (spec § Watching). */
  private tryLease(id: string): (() => void) | undefined {
    const held = this.leases.get(id);
    if (held) return undefined;
    const dir = this.deps.store.dir(id);
    assertCezarHomeWriteIsSandboxed(dir);
    try {
      // Inside the try: a timer and the boot path call this, and a read-only home must not throw.
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const release = lockfile.lockSync(join(dir, 'lease'), {
        realpath: false,
        stale: LEASE_STALE_MS,
        update: 10_000,
        // A compromised lease only risks a duplicate reply; it must not throw from a timer.
        onCompromised: () => this.leases.delete(id),
      });
      const free = () => {
        if (this.leases.get(id) !== free) return;
        this.leases.delete(id);
        try {
          release();
        } catch {
          // already gone with the directory
        }
      };
      this.leases.set(id, free);
      return free;
    } catch {
      return undefined;
    }
  }

  // ---- reads -------------------------------------------------------------------------------

  private async sources(manager: Manager, known?: ManagerProjectSource[]): Promise<ManagerProjectSource[]> {
    const all = known ?? await this.deps.projects();
    return manager.projects === 'all' ? all : all.filter((source) => (manager.projects as string[]).includes(source.id));
  }

  private checkDueAt(manager: Manager, state: { lastCheckAt?: string; watchFailures: number }): number {
    return floorAt(manager, state.lastCheckAt) + manager.cronMinutes * 60_000 * 2 ** Math.min(state.watchFailures, MAX_WATCH_BACKOFF);
  }

  private async summarize(manager: Manager, projects?: ManagerProjectSource[]): Promise<ManagerSummary> {
    const runtime = this.runtimes.get(manager.id);
    const state = this.deps.store.state(manager.id);
    const messages = this.deps.store.messages(manager.id);
    const last = messages.at(-1);
    const newestFirst = [...messages].reverse();
    const lastTalk = newestFirst.find((message) => message.kind !== 'action' && (message.kind !== 'assistant' || message.text));
    const lastAssistant = newestFirst.find((message) => message.kind === 'assistant');
    const working = runtime?.active?.started === true || (runtime?.queue.length ?? 0) > 0;
    const preview = lastTalk && 'text' in lastTalk
      ? onePlainLine(lastTalk.text) || (lastTalk.kind === 'user' ? 'Sent attachments' : '')
      : '';
    const dueAt = this.checkDueAt(manager, state);
    const olderDays = await this.olderAfterDays();
    const important = messages.flatMap((message) =>
      message.kind === 'assistant' && message.important && !message.streaming && unseen(state, message) ? [message] : []);
    const superseded = supersededAskIds(messages);
    return {
      ...manager,
      status: working ? 'working' : lastAssistant?.kind === 'assistant' && lastAssistant.error ? 'error' : 'idle',
      connectedProjectIds: (await this.sources(manager, projects)).map((source) => source.id),
      ...(last ? { lastActivityAt: last.at } : {}),
      ...(preview ? { preview } : {}),
      unread: messages.filter((message) => unseen(state, message) && message.kind !== 'user' && !(message.kind === 'assistant' && message.streaming)).length,
      important: important.length,
      ...(important.at(-1)?.headline ? { headline: important.at(-1)!.headline } : {}),
      pendingActions: messages.filter(pendingAction).length,
      pendingQuestions: messages.filter((message) => openAsk(message) && !superseded.has(message.id) && !isOlder(message.at, this.now(), olderDays)).length,
      ...(state.lastCheckAt ? { lastCheckAt: state.lastCheckAt } : {}),
      ...(manager.cronMinutes > 0 && !manager.inactive ? { nextCheckAt: new Date(Math.max(dueAt, this.now())).toISOString() } : {}),
      costUsd: this.deps.costVisible() ? state.costUsd : 0,
      followedTasks: followedTasks(state),
      ...denialsOf(manager, state.bashDenials),
    };
  }

  private async olderAfterDays(): Promise<number> {
    try {
      return (await this.deps.olderAfterDays?.()) ?? QUESTIONS_OLDER_DEFAULT_DAYS;
    } catch {
      return QUESTIONS_OLDER_DEFAULT_DAYS;
    }
  }

  async list(): Promise<ManagerSummary[]> {
    const managers = this.deps.store.list();
    // One registry read for the whole list, not one per manager.
    const projects = managers.length > 0 ? await this.deps.projects() : [];
    const summaries = await Promise.all(managers.map((manager) => this.summarize(manager, projects)));
    // A delete that finished while this read was in flight already told the client: don't undo it.
    const alive = new Set(this.deps.store.list().map((manager) => manager.id));
    return summaries.filter((summary) => alive.has(summary.id)).sort((a, b) => (b.lastActivityAt ?? b.createdAt).localeCompare(a.lastActivityAt ?? a.createdAt));
  }

  async summary(id: string): Promise<ManagerSummary | undefined> {
    const manager = this.deps.store.get(id);
    return manager ? this.summarize(manager) : undefined;
  }

  messages(id: string, query: { before?: number; limit?: number; pending?: '1'; kind?: 'user' }): ManagerMessagesResponse {
    const limit = query.limit ?? 100;
    const all = this.deps.store.messages(id).filter((message) =>
      (query.before === undefined || message.seq < query.before) && (query.pending === undefined || pendingAction(message))
      && (query.kind === undefined || message.kind === query.kind));
    return { messages: all.slice(-limit), hasMore: all.length > limit };
  }

  async snapshot(id: string): Promise<ManagerSnapshot | undefined> {
    const manager = this.deps.store.get(id);
    if (!manager) return undefined;
    const sources = await this.sources(manager);
    const snapshot = await buildSnapshot(sources, this.deps.github, this.now());
    return { ...snapshot, accounts: await this.accountStates(manager, sources) };
  }

  private nextChange(id: string): number {
    const generation = (this.changes.get(id) ?? 0) + 1;
    this.changes.set(id, generation);
    return generation;
  }

  /** Only the newest summary is sent: an older one landing last would undo it (a row stuck working). */
  private emitSummary(id: string, generation: number, manager: ManagerSummary | undefined): void {
    if (manager && this.changes.get(id) === generation) this.deps.emit('manager-change', { id, manager });
  }

  private emitChange(id: string): void {
    const generation = this.nextChange(id);
    void this.summary(id).then((manager) => this.emitSummary(id, generation, manager), () => undefined);
  }

  private publish(id: string, message: ManagerMessage, persist: boolean): ManagerMessage {
    const written = persist ? this.deps.store.persistMessage(id, message) : this.deps.store.setLiveMessage(id, message);
    this.deps.emit('manager-message', { managerId: id, message: written });
    return written;
  }

  private addNotice(id: string, text: string): void {
    this.publish(id, { id: randomUUID(), seq: this.deps.store.nextSeq(id), at: this.iso(), kind: 'notice', text }, true);
    this.emitChange(id);
  }

  // ---- definitions -------------------------------------------------------------------------

  private async accountIssue(runner: string | undefined, agentProfile: string | undefined): Promise<ManagerRefusal | undefined> {
    if (runner !== undefined && !isRunnerId(runner)) return { error: `unknown runner: ${runner}`, status: 400 };
    if (agentProfile === undefined) return undefined;
    const provider = runner !== undefined && isRunnerId(runner) ? runner : await this.deps.defaultRunner();
    const error = await this.deps.accountError(provider, agentProfile);
    return error ? { error, status: 400 } : undefined;
  }

  private async taskAccountsIssue(agents: ManagerTaskAgent[] | null | undefined): Promise<ManagerRefusal | undefined> {
    for (const agent of agents ?? []) {
      const issue = await this.accountIssue(agent.runner, agent.agentProfile);
      if (issue) return issue;
    }
    return undefined;
  }

  async create(input: CreateManagerInput, ctx: ManagerTelemetryContext = {}): Promise<ManagerSummary | ManagerRefusal> {
    const issue = await this.accountIssue(input.runner, input.agentProfile) ?? await this.taskAccountsIssue(input.taskAgents);
    if (issue) return issue;
    const first = this.deps.store.list().length === 0;
    const id = randomUUID();
    const at = this.iso();
    const manager: Manager = {
      id,
      name: input.name ?? 'Manager',
      instructions: input.instructions,
      // The first character nobody wears: two managers must never look alike by accident.
      avatar: input.avatar ?? firstFreeAvatar(this.deps.store.list()),
      mascot: input.mascot ?? 'base',
      projects: input.projects,
      ...(input.access !== undefined ? { access: input.access } : {}),
      ...(input.projectAccess !== undefined ? { projectAccess: input.projectAccess } : {}),
      ...(input.runner !== undefined ? { runner: input.runner } : {}),
      ...(input.taskRunner !== undefined ? { taskRunner: input.taskRunner } : {}),
      ...(input.taskAgents !== undefined ? { taskAgents: input.taskAgents } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.agentProfile !== undefined ? { agentProfile: input.agentProfile } : {}),
      ...(input.connectors !== undefined ? { connectors: input.connectors } : {}),
      cronMinutes: input.cronMinutes ?? MANAGER_DEFAULT_CRON_MINUTES,
      jobs: [],
      createdAt: at,
      updatedAt: at,
    };
    this.deps.store.mutate((managers) => [...managers, manager]);
    this.deps.telemetry?.track('manager_created', managerCreatedLabel(manager, first), ctx);
    this.reschedule();
    const generation = this.nextChange(id);
    const summary = await this.summarize(manager);
    this.emitSummary(id, generation, summary);
    return summary;
  }

  async update(id: string, input: UpdateManagerInput, ctx: ManagerTelemetryContext = {}): Promise<ManagerSummary | ManagerRefusal> {
    const current = this.deps.store.get(id);
    if (!current) return { error: 'manager not found', status: 404 };
    // A toggle alone writes nothing else, and one already in that state is a no-op.
    if (Object.keys(input).every((key) => key === 'active' || key === 'catchUp')) {
      if (input.active !== undefined) this.applyActivity(id, input.active, input.catchUp === true);
      const generation = this.nextChange(id);
      const summary = await this.summarize(this.deps.store.get(id) ?? current);
      this.emitSummary(id, generation, summary);
      return summary;
    }
    const issue = await this.accountIssue(
      input.runner === null ? undefined : (input.runner ?? current.runner),
      input.agentProfile === null ? undefined : input.agentProfile,
    ) ?? await this.taskAccountsIssue(input.taskAgents);
    if (issue) return issue;
    const badPattern = input.bashAllow?.map(managerBashPatternIssue).find(Boolean);
    if (badPattern) return { error: badPattern, status: 400 };
    const optional = <K extends 'runner' | 'taskRunner' | 'taskAgents' | 'model' | 'effort' | 'agentProfile'>(key: K): Partial<Pick<Manager, K>> => {
      const value = input[key];
      if (value === null) return {};
      const kept = value ?? current[key];
      return kept === undefined ? {} : ({ [key]: kept } as Partial<Pick<Manager, K>>);
    };
    const { runner: _runner, taskRunner: _taskRunner, taskAgents: _taskAgents, model: _model, effort: _effort, agentProfile: _agentProfile, quickPrompts: _quickPrompts, bashAllow: _bashAllow, ...base } = current;
    const bashAllow = input.bashAllow ? [...new Set(input.bashAllow)] : current.bashAllow;
    // An emptied list is stored as no list.
    const quickPrompts = input.quickPrompts ?? current.quickPrompts;
    const previousJobs = new Map(current.jobs.map((job) => [job.id, job]));
    const next: Manager = {
      ...base,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      ...(input.projects !== undefined ? { projects: input.projects } : {}),
      ...(input.access !== undefined ? { access: input.access } : {}),
      ...(input.projectAccess !== undefined ? { projectAccess: input.projectAccess } : {}),
      ...(input.cronMinutes !== undefined ? { cronMinutes: input.cronMinutes } : {}),
      ...(input.avatar !== undefined ? { avatar: input.avatar } : {}),
      ...(input.mascot !== undefined ? { mascot: input.mascot } : {}),
      ...(input.notify !== undefined ? { notify: input.notify } : {}),
      ...(input.followUp !== undefined ? { followUp: input.followUp } : {}),
      ...(input.connectors !== undefined ? { connectors: input.connectors } : {}),
      ...(input.confirm !== undefined ? { confirm: input.confirm } : {}),
      ...(quickPrompts?.length ? { quickPrompts } : {}),
      ...(input.cancelAnyTask !== undefined ? { cancelAnyTask: input.cancelAnyTask } : {}),
      ...(bashAllow?.length ? { bashAllow } : {}),
      ...(input.jobs
        ? {
            jobs: input.jobs.map((job): ManagerJob => {
              const jobId = job.id ?? randomUUID();
              // Counted from the save, as an approved job is: a new one must not fire on the next tick.
              return { ...job, id: jobId, lastRunAt: previousJobs.get(jobId)?.lastRunAt ?? this.iso() };
            }),
          }
        : {}),
      ...optional('runner'),
      ...optional('taskRunner'),
      ...optional('taskAgents'),
      ...optional('model'),
      ...optional('effort'),
      ...optional('agentProfile'),
      updatedAt: this.iso(),
    };
    let updated = this.deps.store.update(id, () => next);
    if (!updated) return { error: 'manager not found', status: 404 };
    if (input.clearBashDenials) this.deps.store.updateState(id, (state) => ({ ...state, bashDenials: [] }));
    if (input.active !== undefined && this.applyActivity(id, input.active, input.catchUp === true)) updated = this.deps.store.get(id) ?? updated;
    // "Use another account" (spec 2026-11-18-inline-account-reconnect): the chat turn the old login
    // failed re-runs on the new one, in a fresh session (the session key follows the account).
    if ((current.agentProfile !== updated.agentProfile || current.runner !== updated.runner) && !updated.inactive) this.retryAuthFailedChat(id);
    for (const field of changedSettingFields(current, updated)) this.deps.telemetry?.track('manager_settings_changed', field, ctx);
    if (JSON.stringify(current.projects) !== JSON.stringify(updated.projects)) {
      const names = (await this.sources(updated)).map((source) => source.name);
      this.addNotice(id, names.length > 0 ? `Connected to ${names.join(', ')}` : 'No projects connected');
    }
    this.reschedule();
    const generation = this.nextChange(id);
    const summary = await this.summarize(updated);
    this.emitSummary(id, generation, summary);
    return summary;
  }

  /** The bulk action: every manager not already in that state. Returns the ids that changed. */
  async setActivity(active: boolean): Promise<string[]> {
    const changed: string[] = [];
    for (const manager of this.deps.store.list()) {
      if ((manager.inactive === undefined) === active) continue;
      const updated = await this.update(manager.id, { active });
      if (!('error' in updated)) changed.push(manager.id);
    }
    return changed;
  }

  /**
   * Deactivate or reactivate (spec 2026-11-19-manager-deactivate); false when already in that state.
   * Deactivating stops the turn in flight and drops everything owed a turn; reactivating floors every
   * due time at now and posts what happened meanwhile. Only `catchUp` buys a model call.
   */
  private applyActivity(id: string, active: boolean, catchUp = false): boolean {
    const { store } = this.deps;
    const current = store.get(id);
    if (!current || (current.inactive === undefined) === active) return false;
    const at = this.iso();
    if (!active) {
      store.update(id, (manager) => ({ ...manager, inactive: { since: at }, updatedAt: at }));
      const runtime = this.runtime(id);
      runtime.queue = [];
      if (runtime.retry) clearTimeout(runtime.retry);
      runtime.retry = undefined;
      runtime.retries = 0;
      const followup = this.followupTimers.get(id);
      if (followup) clearTimeout(followup);
      this.followupTimers.delete(id);
      this.interrupt(runtime);
      this.clearResume(id, false);
      // Not queued: a queue would burst into N turns on reactivation. The next chat hears them as notes.
      store.updateState(id, (state) => (state.followups.length === 0 ? state : {
        ...state,
        notes: [...state.notes, ...state.followups.map((entry) => followupHeadline(entry.line))].slice(-20),
        followups: [],
      }));
      this.pushedAttention.delete(id);
      this.addActivityNotice(id, 'Deactivated by you', { change: 'deactivated' });
    } else {
      const since = current.inactive!.since;
      store.update(id, ({ inactive: _inactive, ...manager }) => ({ ...manager, activeSince: at, updatedAt: at }));
      const after = msOf(since);
      const missed = store.messages(id).filter((message) => message.kind === 'assistant' && msOf(message.at) >= after);
      const taskUpdates = missed.filter((message) => message.kind === 'assistant' && message.taskReport).length;
      const automationReports = missed.filter((message) => message.kind === 'assistant' && message.automationReport).length;
      const span = Math.max(0, this.now() - after);
      const checksSkipped = current.cronMinutes > 0 ? Math.floor(span / (current.cronMinutes * 60_000)) : 0;
      const jobRunsSkipped = current.jobs.filter((job) => job.enabled).reduce((sum, job) => sum + Math.floor(span / (job.everyMinutes * 60_000)), 0);
      const heard = [taskUpdates > 0 ? plural(taskUpdates, 'task update') : '', automationReports > 0 ? plural(automationReports, 'automation report') : ''].filter(Boolean);
      const skipped = [checksSkipped > 0 ? plural(checksSkipped, 'check') : '', jobRunsSkipped > 0 ? plural(jobRunsSkipped, 'job run') : ''].filter(Boolean);
      const meanwhile = [heard.join(', '), skipped.length > 0 ? `${skipped.join(' and ')} skipped` : ''].filter(Boolean).join('; ');
      this.addActivityNotice(id, `Reactivated by you.${meanwhile ? ` While inactive: ${meanwhile}.` : ''}${catchUp ? ' Catching up now.' : ''}`, {
        change: 'reactivated', since, taskUpdates, automationReports, checksSkipped, jobRunsSkipped, catchUp,
      });
      if (catchUp) this.enqueue(id, { kind: 'watch', forced: true });
    }
    this.reschedule();
    this.deps.onActivityChange?.(id);
    return true;
  }

  private addActivityNotice(id: string, text: string, activity: ManagerActivityNotice): void {
    this.publish(id, { id: randomUUID(), seq: this.deps.store.nextSeq(id), at: this.iso(), kind: 'notice', text, activity }, true);
    this.emitChange(id);
  }

  async remove(id: string, ctx: ManagerTelemetryContext = {}): Promise<boolean> {
    const existing = this.deps.store.get(id);
    if (!existing) return false;
    const runtime = this.runtime(id);
    runtime.deleted = true;
    runtime.queue = [];
    if (runtime.retry) clearTimeout(runtime.retry);
    const followup = this.followupTimers.get(id);
    if (followup) clearTimeout(followup);
    this.followupTimers.delete(id);
    this.interrupt(runtime);
    this.deps.store.mutate((managers) => managers.filter((manager) => manager.id !== id));
    this.unrecovered.delete(id);
    // The whole turn, not just its session: one still in its watch gate or setup writes state after.
    const pending = runtime.active?.settled;
    if (pending) await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS * 2).unref?.())]);
    this.leases.get(id)?.();
    this.deps.store.removeFiles(id);
    this.runtimes.delete(id);
    // A summary still in flight must not bring the row back.
    this.changes.delete(id);
    this.pushedAttention.delete(id);
    this.deps.emit('manager-change', { id, deleted: true });
    this.deps.telemetry?.track('manager_deleted', managerAgeLabel(existing.createdAt, this.now()), ctx);
    this.reschedule();
    return true;
  }

  // ---- chat --------------------------------------------------------------------------------

  send(id: string, text: string, attachments: AttachmentInput[] = [], askId?: string): boolean {
    if (!this.deps.store.get(id)) return false;
    const messages = this.deps.store.messages(id);
    // A second answer to one card is a double submit: the first already woke the manager (#2293).
    const target = askId === undefined ? undefined : messages.find((message) => message.id === askId);
    if (target?.kind === 'assistant' && target.ask && target.askAnswer !== undefined) return true;
    // A card answers itself alone, superseded or not. A composer reply answers nothing cezar can
    // name, so it only flags the open cards no newer card re-asked (Questions inbox spec § Relevance).
    const superseded = supersededAskIds(messages);
    const open = messages.filter(openAsk);
    const answered = askId === undefined ? [] : open.filter((message) => message.id === askId);
    for (const message of answered) {
      const written = this.publish(id, { ...message, askAnswer: text || 'Sent attachments' }, true);
      // Asked from a session the chat never saw: `Header: choice` alone answers nothing.
      if (message.turn !== 'chat') this.addNote(id, askNote(message));
      // The inbox hands this answer to the task question it copies (`about.ask`); a relay would send it twice.
      const relayed = (message.ask.about ?? []).flatMap((ref) => ('task' in ref && ref.ask ? [`[[task:${ref.task}]]`] : []));
      if (relayed.length > 0) this.addNote(id, `cezar already delivers the user's answer to «${cardHeaders(message.ask)}» to ${relayed.join(', ')}: do not pass it on with \`cez-manager task say\`.`.slice(0, 2_000));
      if (written.kind === 'assistant') this.askChanged(id, written, true);
    }
    const replied = askId === undefined ? open.filter((message) => !superseded.has(message.id)) : [];
    for (const message of replied) {
      this.flagAsk(id, message, { why: 'replied-in-chat', detail: `you replied in the chat ${ageLabel(this.now() - msOf(message.at))} after it was asked`, since: this.iso() });
    }
    const seq = this.deps.store.nextSeq(id);
    const files = attachments.map((attachment) => this.deps.store.saveAttachment(id, attachment, seq));
    const messageId = randomUUID();
    this.publish(id, {
      id: messageId,
      seq,
      at: this.iso(),
      kind: 'user',
      sourceTasks: [...answered, ...replied].flatMap((message) => message.sourceTasks ?? taskSources(message.text)),
      text,
      ...(files.length > 0 ? { attachments: files.map((file) => file.saved) } : {}),
    }, true);
    const images: ContentBlock[] = attachments.flatMap((attachment) => (isImageMediaType(attachment.mediaType)
      ? [{ type: 'image' as const, source: { type: 'base64' as const, media_type: attachment.mediaType, data: attachment.data } }]
      : []));
    const item: QueueItem = { kind: 'chat', text, images, paths: files.map((file) => file.path), messageIds: [messageId] };
    // A message typed while a limit holds carries the one waiting for it, and runs now.
    const pending = this.deps.store.state(id).resume?.chat;
    if (pending) {
      this.clearResume(id, true);
      item.text = [pending.text, text].filter(Boolean).join('\n\n');
      item.paths = [...pending.paths, ...item.paths];
      item.messageIds = [...pending.messageIds, ...item.messageIds];
    }
    this.enqueue(id, item);
    return true;
  }

  /** Interrupts the running turn. A message queued behind it still runs: it was never stopped. */
  stop(id: string): boolean {
    if (!this.deps.store.get(id)) return false;
    const runtime = this.runtime(id);
    this.interrupt(runtime);
    // Also "Don't resume": the limit still holds, but nothing replays when it lifts.
    this.clearResume(id, true);
    return true;
  }

  /**
   * An agent account is signed in again (spec 2026-11-18-inline-account-reconnect): every manager
   * whose latest chat turn failed on that login re-runs it, once. Watch and job turns wait for
   * their next tick.
   */
  /** Does any manager's latest chat turn wait on this login? */
  hasAuthFailed(provider: string, profileId: string): boolean {
    return this.deps.store.list().some((manager) => {
      if (manager.inactive) return false;
      const failure = this.latestAuthFailedChat(manager.id)?.authFailure;
      return failure?.provider === provider && failure.profileId === profileId;
    });
  }

  resumeAuthFailed(provider: string, profileId: string): Array<{ managerId: string; title: string }> {
    const resumed: Array<{ managerId: string; title: string }> = [];
    for (const manager of this.deps.store.list()) {
      // A replay is a model call: an inactive manager keeps its reconnect card instead.
      if (manager.inactive) continue;
      const failed = this.latestAuthFailedChat(manager.id);
      if (!failed?.authFailure || failed.authFailure.provider !== provider || failed.authFailure.profileId !== profileId) continue;
      if (this.retryAuthFailedChat(manager.id)) resumed.push({ managerId: manager.id, title: manager.name });
    }
    return resumed;
  }

  private latestAuthFailedChat(id: string): Extract<ManagerMessage, { kind: 'assistant' }> | undefined {
    const latest = [...this.deps.store.messages(id)].reverse().find((message) => message.kind === 'assistant' && message.turn === 'chat');
    return latest?.kind === 'assistant' && latest.authFailure && !latest.streaming ? latest : undefined;
  }

  /** Drops the card and replays the cut-off chat. Cleared before the enqueue, so a repeat finds nothing. */
  private retryAuthFailedChat(id: string): boolean {
    const { store } = this.deps;
    const failed = this.latestAuthFailedChat(id);
    if (!failed || this.runtime(id).deleted) return false;
    const { authFailure, ...rest } = failed;
    this.publish(id, { ...rest, reconnectedAt: this.iso(), ...(authFailure ? { reconnectedFrom: authFailure } : {}) }, true);
    const retry = store.state(id).authRetry;
    store.updateState(id, (state) => ({ ...state, authRetry: undefined }));
    // A follow-up's events already moved to the notes: the next chat hears them.
    if (retry?.messageId !== failed.id) return true;
    this.enqueue(id, { kind: 'chat', ...retry.chat, images: [] });
    return true;
  }

  /** Drops the hints; `keepWindow` keeps watches and jobs waiting out the limit. */
  private clearResume(id: string, keepWindow: boolean): void {
    const { store } = this.deps;
    const resume = store.state(id).resume;
    if (!resume) return;
    store.updateState(id, (state) => ({ ...state, resume: keepWindow ? { at: resume.at, messageIds: [] } : undefined }));
    for (const message of store.messages(id)) {
      if (message.kind !== 'assistant' || !resume.messageIds.includes(message.id) || !message.resumeAt) continue;
      const { resumeAt: _resumeAt, ...rest } = message;
      this.publish(id, rest, true);
    }
  }

  /** The reset of a usage limit that ended this turn, when the provider named one (spec 2026-08-03-auto-resume-after-usage-limit). */
  private usageLimit(result: DriveResult, turn: ActiveTurn): Date | undefined {
    if (!result.error || turn.stopped || turn.timedOut || this.deps.autoResume?.() === false) return undefined;
    const now = this.now();
    const quiet = result.commands.length === 0 && result.text.length <= LIMIT_REPLY_MAX;
    return (parseUsageLimit(result.error, now) ?? (quiet ? parseUsageLimit(result.text, now) : null))?.resetAt;
  }

  /** Holds every turn until `resetAt`, then replays the chat the limit cut off. */
  private armResume(id: string, resetAt: Date, messageId: string, chat?: Extract<QueueItem, { kind: 'chat' }>): void {
    this.deps.store.updateState(id, (state) => {
      const prior = state.resume;
      const at = prior && msOf(prior.at) > resetAt.getTime() ? prior.at : resetAt.toISOString();
      const merged = chat
        ? {
            text: [prior?.chat?.text, chat.text].filter(Boolean).join('\n\n'),
            paths: [...(prior?.chat?.paths ?? []), ...chat.paths],
            messageIds: [...(prior?.chat?.messageIds ?? []), ...chat.messageIds],
          }
        : prior?.chat;
      return { ...state, resume: { at, messageIds: [...new Set([...(prior?.messageIds ?? []), messageId])], ...(merged ? { chat: merged } : {}) } };
    });
  }

  read(id: string): boolean {
    if (!this.deps.store.get(id)) return false;
    const messages = this.deps.store.messages(id);
    const top = messages.at(-1)?.seq ?? -1;
    const streaming = messages.flatMap((message) => (message.kind === 'assistant' && message.streaming ? [message.id] : [])).slice(-READ_STREAMING_LIMIT);
    const state = this.deps.store.state(id);
    if (state.readSeq !== top || state.readStreaming.join() !== streaming.join()) {
      this.deps.store.updateState(id, (current) => ({ ...current, readSeq: top, readStreaming: streaming }));
    }
    this.emitChange(id);
    return true;
  }

  /** `Check now`: ignores the key gate, and queues behind a running turn rather than being lost. */
  check(id: string): { ok: true } | ManagerRefusal {
    const manager = this.deps.store.get(id);
    if (!manager) return { error: 'manager not found', status: 404 };
    if (manager.inactive) return { error: MANAGER_INACTIVE, status: 409 };
    const runtime = this.runtime(id);
    if (!runtime.queue.some((item) => item.kind === 'watch' && item.forced)) this.enqueue(id, { kind: 'watch', forced: true });
    return { ok: true };
  }

  /**
   * A turn outlives the request that asked for it, so it reads the unscoped value. THE gate of
   * spec 2026-11-19-manager-deactivate: an inactive manager takes no turn, so it makes no model call.
   */
  private enqueue(id: string, item: QueueItem): void {
    if (this.inactive(id)) return;
    const runtime = this.runtime(id);
    runtime.queue.push(item);
    this.emitChange(id);
    outsideRelayScope(() => this.pump(id));
  }

  /** Chat outranks timers, and everything the user typed meanwhile folds into one turn. */
  private takeNext(runtime: Runtime): QueueItem | undefined {
    const chats = runtime.queue.filter((item): item is Extract<QueueItem, { kind: 'chat' }> => item.kind === 'chat');
    if (chats.length > 0) {
      runtime.queue = runtime.queue.filter((item) => item.kind !== 'chat');
      return {
        kind: 'chat',
        text: chats.map((item) => item.text).filter(Boolean).join('\n\n'),
        images: chats.flatMap((item) => item.images),
        paths: chats.flatMap((item) => item.paths),
        messageIds: chats.flatMap((item) => item.messageIds),
      };
    }
    return runtime.queue.shift();
  }

  private pump(id: string): void {
    const runtime = this.runtime(id);
    if (this.disposed || runtime.deleted || runtime.active || runtime.queue.length === 0) return;
    // Queued before it was deactivated, by a path that skipped the gate's sweep (a lease retry).
    if (this.inactive(id)) {
      runtime.queue = [];
      return;
    }
    const release = this.tryLease(id);
    if (!release) {
      // A timed watch is the other cockpit's to fire; a message or a Check now the user asked for here waits.
      // So does a follow-up: its events wait in state, and only a process holding the lease takes them.
      runtime.queue = runtime.queue.filter((item) => item.kind === 'chat' || item.kind === 'followup' || (item.kind === 'watch' && item.forced));
      if (runtime.retry || runtime.queue.length === 0) return;
      if (runtime.retries >= LEASE_RETRY_LIMIT) {
        const sent = runtime.queue.some((item) => item.kind === 'chat');
        const asked = sent || runtime.queue.some((item) => item.kind === 'watch');
        const followup = runtime.queue.some((item) => item.kind === 'followup');
        runtime.queue = [];
        runtime.retries = 0;
        // The user asked for nothing here: its events wait in state, and it tries again later.
        if (followup) this.scheduleFollowup(id, FOLLOWUP_LEASE_RETRY_MS);
        if (asked) this.addNotice(id, `Another cezar on this machine kept this manager busy. ${sent ? 'Send that again.' : 'Check again later.'}`);
        return;
      }
      runtime.retries += 1;
      runtime.retry = setTimeout(() => {
        runtime.retry = undefined;
        this.pump(id);
      }, LEASE_RETRY_MS);
      runtime.retry.unref?.();
      return;
    }
    runtime.retries = 0;
    const item = this.takeNext(runtime);
    if (!item) {
      release();
      return;
    }
    // A turn that died with its process holds no lease: a fresh one here finds its reply still streaming.
    if (this.unrecovered.has(id)) this.sweep(id, item.kind === 'chat' || item.kind === 'resume');
    const turn: ActiveTurn = {
      // A follow-up acts like a chat turn, in the chat's session: it may start and steer tasks.
      kind: item.kind === 'resume' || item.kind === 'followup' ? 'chat' : item.kind,
      started: false,
      stopped: false,
      ...(item.kind === 'chat' && item.images.length > 0 ? { images: item.images } : {}),
      ...(item.kind === 'chat' ? { messageIds: item.messageIds } : {}),
    };
    runtime.active = turn;
    turn.limit = setTimeout(() => {
      turn.timedOut = true;
      if (runtime.active === turn) this.interrupt(runtime);
    }, this.deps.turnLimitMs ?? TURN_LIMIT_MS);
    turn.limit.unref?.();
    const running = this.runTurn(id, item, turn)
      .catch((error) => console.warn(`[cezar] manager ${id}: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        if (turn.stopTimer) clearTimeout(turn.stopTimer);
        clearTimeout(turn.limit);
        release();
        if (runtime.active === turn) runtime.active = undefined;
        this.settling.delete(running);
        if (runtime.deleted) return;
        this.emitChange(id);
        this.pump(id);
        this.reschedule();
      });
    turn.settled = running;
    this.settling.add(running);
  }

  // ---- one turn ----------------------------------------------------------------------------

  private async runTurn(id: string, item: QueueItem, turn: ActiveTurn): Promise<void> {
    const manager = this.deps.store.get(id);
    if (!manager) return;
    const { store } = this.deps;
    if (item.kind === 'resume') {
      const resume = store.state(id).resume;
      if (!resume || msOf(resume.at) > this.now()) return;
      this.clearResume(id, false);
      if (!resume.chat) return;
      // Pasted images are not kept as blocks; their saved paths still reach the prompt.
      item = { kind: 'chat', ...resume.chat, images: [] };
      turn.messageIds = item.messageIds;
    }
    if (item.kind === 'watch') {
      // Stamped first: a snapshot that throws must wait for the next tick, not retry in a loop.
      store.updateState(id, (state) => ({ ...state, lastCheckAt: this.iso() }));
      const snapshot = await this.snapshot(id);
      // Deleted meanwhile: writing the gate's state would bring the directory back.
      if (!snapshot || !store.get(id)) return;
      this.collapseDuplicateCards(id);
      await this.dismissStaleMerges(id, snapshot);
      await this.dismissStaleEnables(id, snapshot);
      const { fresh, kept } = gateAttention(snapshot, store.state(id).reported);
      this.pushWaitingTasks(id, fresh);
      // Keys a failed turn could not report stay fresh, so none left means the failure is over.
      store.updateState(id, (state) => ({ ...state, reported: kept, ...(fresh.length === 0 ? { watchFailures: 0 } : {}) }));
      // The brake that makes a 15-minute default affordable: a quiet repository costs nothing.
      if (fresh.length === 0 && !item.forced) {
        this.emitChange(id);
        return;
      }
      await this.watchTurn(id, manager, snapshot, fresh, item.forced, turn);
      return;
    }
    if (item.kind === 'chat') {
      // Only the session the user talks to needs them, and only a turn that landed has heard them.
      // Task events still owed a follow-up ride along: the user asking first answers them too.
      const { notes, followups } = store.state(id);
      turn.sourceTasks = [...item.messageIds.flatMap((messageId) => store.message(id, messageId)?.sourceTasks ?? []), ...taskSources([item.text, ...notes, ...followups.map((entry) => entry.line)].join('\n'))];
      const heard = (await this.visibleTurn(id, manager, chatPrompt(item.text, notes, item.paths, item.messageIds, followups.map((entry) => entry.line), this.openCards(id, turn)), 'chat', turn, undefined, item)) === 'heard';
      if (heard) this.consumeNotes(id, notes, followups);
      return;
    }
    if (item.kind === 'followup') {
      const { notes, followups, resume } = store.state(id);
      // Nothing left (a chat took them up), or a usage limit holds: `tick` brings it back after.
      if (followups.length === 0 || (resume && msOf(resume.at) > this.now())) return;
      turn.sourceTasks = taskSources(followups.map((entry) => entry.line).join('\n'));
      const outcome = await this.visibleTurn(id, manager, followupPrompt(followups.map((entry) => entry.line), notes, this.openCards(id, turn)), 'chat', turn);
      if (outcome === 'heard') this.consumeNotes(id, notes, followups);
      // Failed: no retry that could bill in a loop; the next chat hears them instead.
      else if (outcome === 'failed' && store.get(id)) {
        store.updateState(id, (state) => ({
          ...state,
          // Only the status line: notes reach every later prompt unfenced, the task's words must not.
          notes: [...state.notes, ...followups.map((entry) => followupHeadline(entry.line))].slice(-20),
          followups: withoutHeard(state.followups, followups),
        }));
      }
      return;
    }
    const job = manager.jobs.find((candidate) => candidate.id === item.jobId);
    if (!job) return;
    // Stamped here, under the lease: a cockpit that lost the race must not eat the interval.
    const lastRunAt = this.iso();
    store.update(id, (current) => ({
      ...current,
      jobs: current.jobs.map((candidate) => (candidate.id === job.id ? { ...candidate, lastRunAt } : candidate)),
    }));
    turn.sourceTasks = taskSources(job.prompt);
    const outcome = await this.visibleTurn(id, manager, jobPrompt(job.name, job.prompt, this.openCards(id)), 'job', turn, job.name);
    // Due again, so it runs as soon as the limit lifts.
    if (outcome === 'limited') {
      store.update(id, (current) => ({
        ...current,
        jobs: current.jobs.map((candidate) => (candidate.id === job.id ? { ...candidate, lastRunAt: job.lastRunAt } : candidate)),
      }));
    }
  }

  /** Drops exactly what a turn heard: anything that arrived during it stays for the next. */
  private consumeNotes(id: string, notes: string[], followups: PendingFollowup[]): void {
    if (notes.length === 0 && followups.length === 0) return;
    this.deps.store.updateState(id, (state) => ({
      ...state,
      notes: state.notes.slice(notes.length),
      followups: withoutHeard(state.followups, followups),
    }));
  }

  private addNote(id: string, note: string): void {
    this.deps.store.updateState(id, (state) => ({ ...state, notes: [...state.notes, note].slice(-20) }));
  }

  /** `heard` when the agent really took the turn. */
  private async visibleTurn(
    id: string,
    manager: Manager,
    prompt: string,
    kind: ManagerTurnKind,
    turn: ActiveTurn,
    jobName?: string,
    chat?: Extract<QueueItem, { kind: 'chat' }>,
  ): Promise<TurnOutcome> {
    const { store } = this.deps;
    const base = { sourceTasks: turn.sourceTasks ?? [], id: randomUUID(), seq: store.nextSeq(id), at: this.iso(), kind: 'assistant' as const, turn: kind, ...(jobName ? { jobName } : {}) };
    let sent = this.publish(id, { ...base, text: '', streaming: true, commands: [] }, true);
    let keyframe = 0;
    let throttle: NodeJS.Timeout | undefined;
    let read: Progress = () => ({ text: '', commands: [] });
    const flush = () => {
      throttle = undefined;
      const latest = read();
      // Output stays for the final frame: every open tab parses these ten times a second. A task
      // start keeps its line, so the card appears while the turn is still running.
      const commands = latest.commands.map((command) => {
        if (/\btask create\b/.test(command.summary)) return command;
        const { output: _output, ...rest } = command;
        return rest;
      });
      const text = judged(latest.text).text.replace(STREAMING_ASK, '').trim();
      // Diffed after redaction: a secret completing mid-stream rewrites the prefix, a full frame.
      const live = store.setLiveMessage(id, { ...base, text, commands, streaming: true });
      if (live.kind !== 'assistant' || sent.kind !== 'assistant') return;
      const before = sent;
      sent = live;
      if (!live.text.startsWith(before.text) || live.text.length >= Math.max(keyframe * 2, KEYFRAME_FLOOR)) {
        keyframe = live.text.length;
        this.deps.emit('manager-message', { managerId: id, message: live });
        return;
      }
      const sameCommands = JSON.stringify(before.commands) === JSON.stringify(live.commands);
      if (sameCommands && live.text.length === before.text.length) return;
      this.deps.emit('manager-delta', {
        managerId: id,
        messageId: base.id,
        offset: before.text.length,
        append: live.text.slice(before.text.length),
        ...(sameCommands ? {} : { commands: live.commands }),
      });
    };
    const startedAt = this.now();
    turn.ledgerMessageId = base.id;
    const result = await this.drive(id, manager, prompt, turn, (progress) => {
      read = progress;
      if (!throttle) {
        throttle = setTimeout(flush, STREAM_THROTTLE_MS);
        throttle.unref?.();
      }
    }).catch(turnFailure);
    this.reportTurn(manager, turn, startedAt, result);
    if (throttle) clearTimeout(throttle);
    if (!store.get(id)) return 'failed';
    this.addCost(id, result.costUsd);
    const resetAt = this.usageLimit(result, turn);
    const cause = result.error ? failureCause(result.error, result.text) : undefined;
    const failed = cause && !turn.stopped && !resetAt ? this.recordFailure(id, kind, cause, result.runner) : undefined;
    // A rejected login renders the reconnect card, and a reconnect of that account re-runs the chat.
    const authFailure = failed && !turn.timedOut && classifyManagerFailure(cause!) === 'auth'
      ? { provider: result.runner ?? await this.runnerOf(manager), profileId: manager.agentProfile ?? DEFAULT_AGENT_ACCOUNT_ID }
      : undefined;
    if (kind === 'chat' && chat) {
      store.updateState(id, (state) => ({
        ...state,
        authRetry: authFailure ? { messageId: base.id, chat: { text: chat.text, paths: chat.paths, messageIds: chat.messageIds } } : undefined,
      }));
    }
    // The CLI's own error line, echoed as the reply, is the cause the human line replaces.
    const reply = failed && result.text.trim() === cause?.trim() ? '' : result.text;
    const judgement = judged(reply.replace(QUIET_LINE, '').trim());
    const final = this.publish(id, {
      ...base,
      text: judgement.text,
      sourceTasks: taskSources(judgement.text).length ? taskSources(judgement.text) : turn.sourceTasks,
      ...judgedFields(judgement),
      streaming: false,
      commands: result.commands,
      ...(turn.timedOut ? { error: TURN_LIMIT_ERROR } : turn.stopped ? { stopped: true } : {}),
      ...(resetAt ? { resumeAt: resetAt.toISOString() } : failed ? { error: failed } : {}),
      ...(authFailure ? { authFailure } : {}),
      ...(this.deps.costVisible() && result.costUsd > 0 ? { costUsd: result.costUsd } : {}),
    }, true);
    this.settleAsks(id, final, judgement.closes);
    if (resetAt) {
      this.armResume(id, resetAt, base.id, chat);
      return 'limited';
    }
    const body = alertBody(judgement);
    if (body) this.alert(id, base, body, judgement.important ? 'message' : 'question');
    const heard = !result.error && !turn.stopped;
    // A turn that got through proves the limit lifted (or the account changed).
    if (heard && kind === 'chat') this.clearResume(id, false);
    return heard ? 'heard' : 'failed';
  }

  /**
   * A linked automation's finished run, posted straight into the chat with no model turn (spec
   * § Automation reports). The message id is derived from the run, and the chat file is the
   * ledger: a restart, a second cockpit or a repeated terminal event finds it and posts nothing.
   */
  reportAutomationRun(input: AutomationRunReport): 'posted' | 'duplicate' | 'skipped' | 'gone' {
    const { store } = this.deps;
    const manager = store.get(input.managerId);
    if (!manager) return 'gone';
    if (input.mode === 'none' || (input.mode === 'notify-on-failure' && input.outcome === 'success')) return 'skipped';
    const id = manager.id;
    const messageId = `automation-report:${input.projectId}/${input.runId}:${input.outcome}`;
    if (store.message(id, messageId)) return 'duplicate';
    const card = `[[task:${input.projectId}/${input.runId}]]`;
    const reason = input.reason?.split('\n').find((line) => line.trim())?.trim().slice(0, REPORT_REASON_LIMIT);
    const failure = `**${input.automationName}** failed${reason ? `: ${reason}` : '.'}${input.resumesAt ? `\nIt resumes on its own at ${input.resumesAt}.` : ''}`;
    const text = input.outcome === 'success'
      ? `${input.text?.trim() || `**${input.automationName}** finished without a final message.`}\n\n${card}`
      : `${failure}\n\n${card}`;
    const headline = input.outcome === 'failure' ? `${input.automationName} failed${reason ? `: ${reason}` : ''}`.slice(0, HEADLINE_LIMIT) : undefined;
    this.postDirect(id, {
      messageId,
      turn: 'job',
      text,
      ...(headline ? { headline } : {}),
      fields: { jobName: input.automationName, automationReport: { projectId: input.projectId, automationId: input.automationId, runId: input.runId, outcome: input.outcome } },
      attentionKeys: input.attentionKeys,
    });
    this.addNote(id, `Automation "${input.automationName}" ${input.outcome === 'success' ? 'finished' : 'failed'}; cezar posted it to the chat for you: ${card}${input.outcome === 'failure' && reason ? ` (${reason})` : ''}`);
    return 'posted';
  }

  /**
   * The one path a server-side message takes into a chat (automation reports, task cards): no
   * model turn, the watch's keys marked reported, the unread dot, and for an important one the
   * OS notification. The caller's derived id makes the chat file its ledger.
   */
  private postDirect(id: string, post: DirectPost): ManagerMessage {
    const { store } = this.deps;
    const written = this.publish(id, {
      ...post.fields,
      id: post.messageId,
      seq: store.nextSeq(id),
      at: this.iso(),
      kind: 'assistant',
      turn: post.turn,
      text: post.text,
      streaming: false,
      commands: [],
      ...(post.headline ? { important: true, headline: post.headline } : {}),
    }, true);
    if (post.attentionKeys.length > 0) {
      const reportedAt = this.iso();
      // The watch already has its answer for this: its keys must not buy a second turn.
      store.updateState(id, (state) => ({
        ...state,
        reported: { ...state.reported, ...Object.fromEntries(post.attentionKeys.map((key) => [key, reportedAt])) },
      }));
    }
    this.emitChange(id);
    if (post.headline) this.alert(id, written, post.headline, reportKind(post.fields));
    return written;
  }

  // ---- questions (spec 2026-11-17-questions-inbox) -----------------------------------------

  clock(): number {
    return this.now();
  }

  /** The Questions inbox provider's subscription: every card opened, closed or flagged. */
  onAskChange(listener: (change: ManagerAskChange) => void): () => void {
    this.askListeners.add(listener);
    return () => this.askListeners.delete(listener);
  }

  private askChanged(id: string, message: AssistantMessage, closed: boolean): void {
    if (!message.ask || this.askListeners.size === 0) return;
    const manager = this.deps.store.get(id);
    if (!manager) return;
    const card: ManagerAskCard = { managerId: id, managerName: manager.name, message: message as AskMessage, ...(message.askAnswer !== undefined ? { answeredAt: this.iso() } : {}) };
    for (const listener of this.askListeners) {
      try {
        listener({ card, closed });
      } catch (error) {
        console.warn(`[cezar] manager questions: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Every manager's cards, open or closed since `closedSince` (ms); a card answered on itself carries the
   * reply's time. A card a newer one re-asked before `askClosed: replaced` was persisted reads as replaced (#2307).
   */
  askCards(closedSince = 0): ManagerAskCard[] {
    return this.deps.store.list().flatMap((manager) => {
      const messages = this.deps.store.messages(manager.id);
      const cards = messages.filter((message): message is AskMessage => message.kind === 'assistant' && message.ask !== undefined)
        .sort((a, b) => a.seq - b.seq);
      const superseded = supersededAskIds(cards);
      // Indexed by text once: a per-card scan of the whole chat is O(cards × messages).
      const replies = new Map<string, ManagerMessage[]>();
      for (const other of messages) {
        if (other.kind !== 'user') continue;
        const text = other.text || 'Sent attachments';
        replies.set(text, [...(replies.get(text) ?? []), other]);
      }
      return cards.flatMap((message, index): ManagerAskCard[] => {
        const card = { managerId: manager.id, managerName: manager.name };
        if (message.askClosed) return msOf(message.askClosed.at) >= closedSince ? [{ ...card, message }] : [];
        if (message.askAnswer !== undefined) {
          const reply = replies.get(message.askAnswer)?.find((other) => other.seq > message.seq);
          return msOf(reply?.at ?? message.at) >= closedSince ? [{ ...card, message, ...(reply ? { answeredAt: reply.at } : {}) }] : [];
        }
        if (superseded.has(message.id)) {
          const newer = cards.slice(index + 1).find((other) => replaces(other.ask, message.ask))!;
          if (msOf(newer.at) < closedSince) return [];
          return [{ ...card, message: { ...message, askClosed: { reason: 'replaced', at: newer.at, replacedBy: newer.id } } }];
        }
        return [{ ...card, message }];
      });
    });
  }

  private askCard(id: string, messageId: string): { card: ManagerAskCard } | ManagerAskResult {
    const manager = this.deps.store.get(id);
    const message = manager ? this.deps.store.message(id, messageId) : undefined;
    if (!manager || message?.kind !== 'assistant' || !message.ask) return { ok: false, status: 404, error: 'question not found' };
    return { card: { managerId: id, managerName: manager.name, message: message as AskMessage } };
  }

  private refreshed(id: string, messageId: string): ManagerAskResult {
    const found = this.askCard(id, messageId);
    return 'card' in found ? { ok: true, card: found.card } : found;
  }

  /** The inbox's Answer: the same as answering on the card. A card closed meanwhile is a 409. */
  answerAsk(id: string, messageId: string, text: string, reactivate = false): ManagerAskResult {
    const found = this.askCard(id, messageId);
    if (!('card' in found)) return found;
    if (!openAsk(found.card.message)) return { ok: false, status: 409, error: 'question already closed' };
    // An answer is a chat turn: an inactive manager takes one only when the user confirmed reactivating it.
    if (this.inactive(id)) {
      if (!reactivate) return { ok: false, status: 409, error: MANAGER_INACTIVE };
      this.applyActivity(id, true);
    }
    this.send(id, text, [], messageId);
    return this.refreshed(id, messageId);
  }

  /** Dismissed: the agent hears it on its next turn, which this starts no sooner. */
  dismissAsk(id: string, messageId: string): ManagerAskResult {
    const found = this.askCard(id, messageId);
    if (!('card' in found)) return found;
    const { message } = found.card;
    if (!openAsk(message)) return { ok: false, status: 409, error: 'question already closed' };
    const headers = cardHeaders(message.ask);
    this.closeCard(id, message, { reason: 'dismissed', at: this.iso(), detail: `You skipped «${headers}»`.slice(0, 300) });
    this.addNote(id, `The user skipped your question «${headers}». Don't wait for an answer; decide yourself, or ask again later only if it still blocks you.`);
    return this.refreshed(id, messageId);
  }

  /** Closed from outside (its linked task copy closed). No-op on a card already closed. */
  closeAsk(id: string, messageId: string, closed: QuestionClosed): ManagerAskResult {
    const found = this.askCard(id, messageId);
    if (!('card' in found)) return found;
    const { message } = found.card;
    if (!openAsk(message)) return { ok: true, card: found.card };
    this.closeCard(id, message, closed);
    if (closed.reason === 'answered' && closed.answeredIn) {
      const where = closed.answeredIn.replace(/^task:/, '');
      this.addNote(id, `The user answered your question «${cardHeaders(message.ask)}» in the task ${closed.answeredIn.startsWith('task:') ? `[[task:${where}]]` : where}: ${closed.answer ?? ''}`.slice(0, 2_000));
    }
    return this.refreshed(id, messageId);
  }

  private closeCard(id: string, message: AskMessage, closed: QuestionClosed): void {
    const current = this.deps.store.message(id, message.id);
    if (!current || !openAsk(current)) return;
    // The schema caps `detail` at 300: a longer one fails it, and the store drops the whole message on reload.
    const written = this.publish(id, { ...current, askClosed: closed.detail === undefined ? closed : { ...closed, detail: closed.detail.slice(0, 300) } }, true);
    this.emitChange(id);
    if (written.kind === 'assistant') this.askChanged(id, written, true);
  }

  /** Suspected out of date: the card stays open and counted; the first reason stays. */
  private flagAsk(id: string, message: AskMessage, stale: QuestionStale): void {
    const current = this.deps.store.message(id, message.id);
    // The first flag stays, except that a partial re-ask names what changed more precisely than any other.
    if (!current || !openAsk(current) || (current.askStale && stale.why !== 'partly-reasked')) return;
    const written = this.publish(id, { ...current, askStale: { ...stale, detail: stale.detail.slice(0, 300) } }, true);
    if (written.kind === 'assistant') this.askChanged(id, written, false);
  }

  /** A chat resuming a session that already saw these cards gets their ids; `drive` restores the list for a fresh one. */
  private openCards(id: string, turn?: ActiveTurn): string {
    const { store } = this.deps;
    const cards = store.messages(id).filter(openAsk);
    const full = openCardsBlock(cards, this.now());
    if (turn?.kind !== 'chat') return full;
    const meta = store.state(id).sessions.chat;
    const digest = openCardsDigest(cards);
    const ids = this.resumes('chat', meta) && meta?.cardsDigest === digest ? openCardsUnchanged(cards) : '';
    turn.cards = { digest, full, ...(ids ? { ids } : {}) };
    return ids || full;
  }

  /** Waiting tasks' open questions, so a relayed card can name the one it copies (`about.ask`). */
  private async taskQuestions(manager: Manager): Promise<Array<{ task: string; ask: string }>> {
    return (await this.sources(manager)).filter((source) => source.available).flatMap((source) => source.runs()
      .filter((run) => !run.archived && (run.status === 'waiting' || run.awaitingAnswerSince !== undefined))
      .flatMap((run) => {
        const ask = openTaskAskId(run);
        return ask ? [{ task: `${source.id}/${run.id}`, ask }] : [];
      }));
  }

  /** A turn's reply: its `CEZ:ASK-CLOSE` lines first, then a new card replaces the ones it re-asks. */
  private settleAsks(id: string, written: ManagerMessage, closes: AskCloseMarker[]): void {
    this.closeMarked(id, closes, written.id);
    if (written.kind !== 'assistant' || !written.ask) return;
    const ask = written.ask;
    for (const older of this.deps.store.messages(id).filter(openAsk)) {
      if (older.id === written.id || older.seq > written.seq) continue;
      if (replaces(ask, older.ask)) {
        this.closeCard(id, older, { reason: 'replaced', at: this.iso(), replacedBy: written.id });
      } else if (questionCardPartlyReasked(ask, older.ask)) {
        // Partly re-asked: its other questions still need an answer, so it stays open, flagged.
        const headers = questionCardSharedHeaders(ask, older.ask).map((header) => `«${header}»`).join(', ');
        this.flagAsk(id, older, { why: 'partly-reasked', detail: `a newer question asked ${headers} again`.slice(0, 300), since: this.iso() });
      }
    }
    this.askChanged(id, written, false);
  }

  private closeMarked(id: string, closes: AskCloseMarker[], except?: string): void {
    for (const marker of closes) {
      const matches = this.deps.store.messages(id).filter(openAsk)
        .filter((message) => message.id !== except && closeMarkerMatches(message.ask, marker.id));
      if (matches.length === 0) {
        this.addNote(id, `CEZ:ASK-CLOSE ${marker.id}: none of your open questions has that id, so nothing closed.`);
        continue;
      }
      for (const message of matches) {
        this.closeCard(id, message, { reason: 'retracted', at: this.iso(), ...(marker.reason ? { detail: marker.reason } : {}) });
      }
    }
  }

  /** The manager acted on a task or PR an open card names, since asking: the card may be moot. */
  private managerActed(id: string, work: { tasks?: string[]; prs?: PrRef[] }, detail: string): void {
    if ((work.tasks?.length ?? 0) === 0 && (work.prs?.length ?? 0) === 0) return;
    for (const message of this.deps.store.messages(id).filter(openAsk)) {
      if (namesWork(message, work)) this.flagAsk(id, message, { why: 'manager-acted', detail, since: this.iso() });
    }
  }

  /**
   * A run reached an end the inbox counts (done, review, cancelled, archived, deleted; never
   * `failed`, #2286): a card declaring it in `about` expires, one only mentioning it is flagged.
   */
  taskEnded(projectId: string, runId: string, run: RunRecord | undefined): void {
    this.endAsks(projectId, runId, run, false);
  }

  /** `replayed`: read from the run list, not seen live; a card asked after that end is about the ended run. */
  private endAsks(projectId: string, runId: string, run: RunRecord | undefined, replayed: boolean): void {
    if (this.disposed) return;
    const end = !run ? 'was deleted' : run.archived ? 'was archived'
      : run.status === 'done' ? 'finished' : run.status === 'review' ? 'finished, ready for review'
        : run.status === 'cancelled' ? 'was cancelled' : undefined;
    if (!end) return;
    // Deleted, or an end without a stamp: unknown, so it counts as after the card.
    const endedAt = run?.archived ? run.archivedAt : run?.finishedAt;
    const key = `${projectId}/${runId}`;
    for (const manager of this.deps.store.list()) {
      if (!connectedTo(manager, projectId)) continue;
      for (const message of this.deps.store.messages(manager.id).filter(openAsk)) {
        if (replayed && endedAt !== undefined && msOf(endedAt) <= msOf(message.at)) continue;
        const named = namedWork(message);
        if (named.aboutTasks.has(key)) this.closeCard(manager.id, message, { reason: 'expired', at: this.iso(), detail: `Task ${end}` });
        else if (named.mentionedTasks.has(key)) this.flagAsk(manager.id, message, { why: 'mentioned-work-ended', detail: `a task it mentions ${end}`, since: this.iso() });
      }
    }
  }

  /** A project's whole list: a card naming a run that ended (or is gone) while nobody listened. */
  private reconcileAsks(projectId: string, runs: RunRecord[]): void {
    const byId = new Map(runs.map((run) => [run.id, run]));
    const named = new Set<string>();
    for (const manager of this.deps.store.list()) {
      if (!connectedTo(manager, projectId)) continue;
      for (const message of this.deps.store.messages(manager.id).filter(openAsk)) {
        const work = namedWork(message);
        for (const key of [...work.aboutTasks, ...work.mentionedTasks]) if (key.startsWith(`${projectId}/`)) named.add(key.slice(projectId.length + 1));
      }
    }
    for (const runId of named) this.endAsks(projectId, runId, byId.get(runId), true);
  }

  /** `pullRequestClosed`'s half for cards: `about: [{pr}]` expires, a `[[pr:…]]` mention is flagged. */
  private async expireAsksForPr(root: string, number: number, state: 'merged' | 'closed', verify: boolean): Promise<void> {
    const candidates = this.deps.store.list().flatMap((manager) => this.deps.store.messages(manager.id).filter(openAsk)
      .filter((message) => namesWork(message, { prs: [{ number }] }))
      .map((message) => ({ manager, message })));
    if (candidates.length === 0) return;
    const target = resolve(root);
    const all = await this.deps.projects();
    const projects = all.filter((project) => resolve(project.root) === target).map((project) => project.id);
    const confirmed = new Map<string, boolean>();
    // An automation poll reads `origin`: in a fork clone that is another repo's number, so ask the card's own route.
    const closedIn = async (projectId: string): Promise<boolean> => {
      if (!verify) return true;
      if (!confirmed.has(projectId)) confirmed.set(projectId, (await this.prStateOf(projectId, number)) !== undefined);
      return confirmed.get(projectId)!;
    };
    for (const { manager, message } of candidates) {
      const reached = projects.filter((projectId) => connectedTo(manager, projectId));
      if (reached.length === 0) continue;
      const named = namedWork(message);
      if (named.aboutPrs.has(number)) {
        // `{pr}` names no project: pin it from the card's own [[pr:…]] or its tasks, else a reach of one.
        const pinned = aboutPrProjects(message, number);
        if (!await someAsync(pinned.size > 0 ? reached.filter((projectId) => pinned.has(projectId)) : reached, closedIn)) continue;
        if (pinned.size > 0 || all.filter((project) => connectedTo(manager, project.id)).length <= 1) {
          this.closeCard(manager.id, message, { reason: 'expired', at: this.iso(), detail: `PR #${number} ${state}` });
        } else {
          this.flagAsk(manager.id, message, { why: 'mentioned-work-ended', detail: `a PR #${number} was ${state} in ${reached.join(', ')}`, since: this.iso() });
        }
        continue;
      }
      const mentioned = named.mentionedPrs.filter((ref) => ref.number === number && ref.projectId !== undefined && reached.includes(ref.projectId));
      if (mentioned.length > 0 && await someAsync(mentioned.map((ref) => ref.projectId!), closedIn)) {
        this.flagAsk(manager.id, message, { why: 'mentioned-work-ended', detail: `PR #${number} it mentions was ${state}`, since: this.iso() });
      }
    }
  }

  // ---- followed tasks (spec § Followed tasks) --------------------------------------------

  /** `cez-manager task follow|unfollow`; `task create` follows on its own. */
  async followTask(id: string, input: { projectId: string; runId: string; follow?: boolean }): Promise<{ projectId: string; runId: string; following: boolean } | ManagerRefusal> {
    const scope = await this.toolScope(id, input.projectId, true);
    if ('error' in scope) return scope;
    const following = input.follow !== false;
    if (following && !scope.source?.runs().some((run) => run.id === input.runId)) return { error: 'task not found', status: 404 };
    if (following) this.recordFollow(id, input.projectId, input.runId, this.iso(), false);
    else {
      this.deps.store.updateState(id, (state) => {
        const key = followKey(input.projectId, input.runId);
        const { [key]: gone, ...follows } = state.follows;
        // Unfollowing stops the cards, not the authorship: a follow written before `created` existed moves there.
        return { ...state, follows, ...(gone?.created ? { created: withCreated(state.created, key, gone.at) } : {}) };
      });
    }
    return { projectId: input.projectId, runId: input.runId, following };
  }

  /** `at` bounds what it hears: a follow reports what happens after it, never history. */
  private recordFollow(id: string, projectId: string, runId: string, at: string, created: boolean): void {
    if (!this.deps.store.get(id)) return;
    this.deps.store.updateState(id, (state) => {
      const key = followKey(projectId, runId);
      const kept = Object.entries(state.follows).filter(([other]) => other !== key)
        .sort(([, a], [, b]) => msOf(a.at) - msOf(b.at)).slice(-(FOLLOW_LIMIT - 1));
      // Re-following keeps the entry whole: its `turns` bound must not reset.
      return {
        ...state,
        follows: Object.fromEntries([...kept, [key, { ...state.follows[key], at: state.follows[key]?.at ?? at, ...(created ? { created } : {}) }]]),
        ...(created ? { created: withCreated(state.created, key, at) } : {}),
      };
    });
    // A task that settled before the follow was written passed the live listener unheard.
    void this.catchUp(id, projectId, runId).catch(() => undefined);
  }

  private async catchUp(id: string, projectId: string, runId: string): Promise<void> {
    const manager = this.deps.store.get(id);
    const source = manager ? (await this.sources(manager)).find((candidate) => candidate.id === projectId) : undefined;
    if (!manager || !source?.available) return;
    const runs = source.runs().filter((run) => run.id === runId || run.dispatch?.rootRunId === runId);
    this.deliverFollowed(projectId, join(source.root, '.ai', 'cezar'), runs, (other) => source.runs().find((run) => run.id === other), manager.id);
  }

  /** A run in a project's store changed (the live listener): within seconds, no model call. */
  taskChanged(projectId: string, dataDir: string, run: RunRecord, getRun: (runId: string) => RunRecord | undefined): void {
    this.deliverFollowed(projectId, dataDir, [run], getRun);
  }

  /** A project's whole run list, at attach and at boot: what happened while nobody listened. */
  reconcileProject(projectId: string, dataDir: string, runs: RunRecord[]): void {
    const byId = new Map(runs.map((run) => [run.id, run]));
    this.deliverFollowed(projectId, dataDir, runs, (runId) => byId.get(runId));
    this.reconcileAsks(projectId, runs);
  }

  private async reconcileFollows(): Promise<void> {
    const prefixes = new Set(this.deps.store.list().flatMap((manager) => [
      ...Object.keys(this.deps.store.state(manager.id).follows),
      // Cards naming a task: one that ended while cezar was down expires or is flagged now.
      ...this.deps.store.messages(manager.id).filter(openAsk).flatMap((message) => { const work = namedWork(message); return [...work.aboutTasks, ...work.mentionedTasks]; }),
    ].map((key) => key.split('/')[0])));
    if (prefixes.size === 0) return;
    for (const source of await this.deps.projects()) {
      if (this.disposed) return;
      if (source.available && prefixes.has(source.id)) this.reconcileProject(source.id, join(source.root, '.ai', 'cezar'), source.runs());
    }
  }

  /** A dispatched child reaches its root's followers only when it needs the user; a follow of the child itself hears all of it. */
  private deliverFollowed(projectId: string, dataDir: string, runs: RunRecord[], getRun: (runId: string) => RunRecord | undefined, only?: string): void {
    if (this.disposed) return;
    const followers = this.deps.store.list().flatMap((manager) => {
      if ((only !== undefined && manager.id !== only) || !connectedTo(manager, projectId)) return [];
      const { follows } = this.deps.store.state(manager.id);
      return Object.keys(follows).some((key) => key.startsWith(`${projectId}/`)) ? [{ manager, follows }] : [];
    });
    if (followers.length === 0) return;
    for (const run of runs) {
      const event = taskEventOf(projectId, run);
      if (!event) continue;
      const rootId = run.dispatch?.parentRunId ? run.dispatch.rootRunId : run.id;
      for (const { manager, follows } of followers) {
        const key = follows[followKey(projectId, run.id)]
          ? followKey(projectId, run.id)
          : rootId !== run.id && event.state === 'needs-you' ? followKey(projectId, rootId) : undefined;
        const follow = key ? follows[key] : undefined;
        if (!key || !follow || msOf(event.at) < msOf(follow.at)) continue;
        try {
          this.postTaskEvent(manager, projectId, dataDir, run, event, key, rootId !== run.id ? getRun(rootId) ?? { id: rootId } : undefined);
        } catch (error) {
          console.warn(`[cezar] manager ${manager.id} task card: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  /** The card at once; then one follow-up turn per burst of events, unless the manager turned them off. */
  private postTaskEvent(manager: Manager, projectId: string, dataDir: string, run: RunRecord, event: TaskEvent, follow: string, root?: Pick<RunRecord, 'id'> & Partial<RunRecord>): boolean {
    const { store } = this.deps;
    const id = manager.id;
    const messageId = `task-report:${event.ledger}`;
    if (store.message(id, messageId)) return false;
    const title = run.titleSummary ?? run.title;
    const card = `[[task:${projectId}/${run.id}]]`;
    const detail = firstLine(event.detail, REPORT_REASON_LIMIT);
    const resumes = event.state === 'failed' && run.autoResumeAt ? resumeLabel(run.autoResumeAt, undefined) : undefined;
    const under = root ? ` (dispatched under "${root.titleSummary ?? root.title ?? root.id}")` : '';
    // A wait with no question is a turn that ended: its last message is what the user answers.
    const why = detail ?? (event.state === 'needs-you' ? 'waiting for your reply' : undefined);
    const state = `${TASK_STATE_LINE[event.state]}${under}${why ? `: ${why}` : '.'}${resumes ? ` It resumes on its own at ${resumes}.` : ''}`;
    const final = event.state === 'done' || event.state === 'review' || event.state === 'needs-you' ? finalAssistantText(dataDir, run.id) : undefined;
    const clipped = final && final.length > TASK_REPORT_TEXT_LIMIT ? `${final.slice(0, TASK_REPORT_TEXT_LIMIT)}…` : final;
    const important = event.state === 'failed' || event.state === 'needs-you';
    const switched = run.agentSwitch?.summary;
    this.postDirect(id, {
      messageId,
      turn: 'watch',
      text: `${card}\n\n**${state}**${switched ? `\n\n${switched}` : ''}${clipped ? `\n\n${clipped}` : ''}`,
      ...(important ? { headline: `${title}: ${TASK_STATE_LINE[event.state].toLowerCase()}${detail ? ` (${detail})` : ''}`.slice(0, HEADLINE_LIMIT) } : {}),
      fields: { taskReport: { projectId, runId: run.id, state: event.state, ...(root ? { rootRunId: root.id } : {}) } },
      attentionKeys: event.attentionKeys,
    });
    const askId = event.state === 'needs-you' ? openTaskAskId(run) : undefined;
    // The id a relayed card names, so the inbox shows one question, not two (Questions inbox spec).
    const relay = askId ? ` Its open question's id is "${askId}": a card that asks it for the task declares "about":[{"task":"${projectId}/${run.id}","ask":"${askId}"}].` : '';
    const line = `${card} "${title}": ${state}${clipped ? ' Its final message is on the card; `cez-manager task` reads the rest.' : ''}${relay}`;
    // The follow-up acts on what the task said, so it gets the words, not just the state.
    const excerpt = final ? (final.length > FOLLOWUP_EXCERPT_LIMIT ? `${final.slice(0, FOLLOWUP_EXCERPT_LIMIT)}…` : final) : undefined;
    const followup = excerpt ? `${line}${FINAL_MESSAGE_MARK}${excerpt}` : line;
    // A cancel is the user's own doing, and an auto-resume will report again: neither needs a turn.
    // Nor does an inactive manager take one: it hears the note on its next chat (spec 2026-11-19-manager-deactivate).
    if (manager.followUp === false || event.state === 'cancelled' || resumes || this.inactive(id)) {
      this.addNote(id, `Task update, posted to the chat by cezar: ${line}`);
      return true;
    }
    // A manager and a task answering each other is one turn per round: past the bound, the user decides.
    const now = this.now();
    const recent = (store.state(id).follows[follow]?.turns ?? []).filter((at) => now - msOf(at) < FOLLOWUP_TURN_WINDOW_MS);
    if (recent.length >= FOLLOWUP_TURNS_PER_TASK) {
      this.addNote(id, `Task update, posted to the chat by cezar (no follow-up turn: this task already had ${FOLLOWUP_TURNS_PER_TASK} follow-ups within the hour): ${line}`);
      return true;
    }
    store.updateState(id, (current) => ({
      ...current,
      follows: current.follows[follow] ? { ...current.follows, [follow]: { ...current.follows[follow], turns: [...recent, this.iso()] } } : current.follows,
      followups: [...current.followups.filter((entry) => entry.ledger !== event.ledger), { ledger: event.ledger, line: followup }].slice(-PENDING_FOLLOWUP_LIMIT),
    }));
    this.scheduleFollowup(id);
    return true;
  }

  /** Coalesced: a burst of events, or a tree settling, is one turn. The queue keeps it behind a chat. */
  private scheduleFollowup(id: string, delay = FOLLOWUP_COALESCE_MS): void {
    if (this.disposed || this.followupTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.followupTimers.delete(id);
      const runtime = this.runtime(id);
      if (runtime.deleted || !this.deps.store.get(id) || runtime.queue.some((item) => item.kind === 'followup')) return;
      this.enqueue(id, { kind: 'followup' });
    }, delay);
    timer.unref?.();
    this.followupTimers.set(id, timer);
  }

  /** Delayed, then skipped if the chat was read meanwhile: an open tab needs no interruption. */
  private alert(id: string, message: { id: string; seq: number }, body: string, kind: AttentionKind): void {
    const { notifySystem, pushSignal, store } = this.deps;
    // An inactive manager raises nothing: its tasks' own surfaces (Questions, Now) still show them.
    if ((!notifySystem && !pushSignal) || this.inactive(id)) return;
    const timer = outsideRelayScope(() => setTimeout(() => {
      this.alerts.delete(timer);
      const manager = store.get(id);
      if (!manager || manager.notify === false || manager.inactive || !unseen(store.state(id), message)) return;
      notifySystem?.(manager.name, body);
      pushSignal?.(id, kind);
    }, SYSTEM_NOTIFY_DELAY_MS));
    timer.unref?.();
    this.alerts.add(timer);
  }

  /** A task newly waiting on the user wakes the phone before the model is asked, whatever it says. */
  private pushWaitingTasks(id: string, fresh: ManagerSnapshot['attention']): void {
    const { pushSignal, store } = this.deps;
    if (!pushSignal || this.inactive(id)) return;
    const waiting = fresh.filter((item) => item.kind === 'task-needs-you').map((item) => item.key);
    const pushed = this.pushedAttention.get(id) ?? new Set<string>();
    const newKeys = waiting.filter((key) => !pushed.has(key));
    // Only keys still fresh are worth remembering; the rest were reported and will not come back.
    this.pushedAttention.set(id, new Set(waiting));
    if (newKeys.length === 0 || store.get(id)?.notify === false) return;
    pushSignal(id, 'task');
  }

  private async watchTurn(
    id: string,
    manager: Manager,
    snapshot: ManagerSnapshot,
    fresh: ManagerSnapshot['attention'],
    forced: boolean,
    turn: ActiveTurn,
  ): Promise<void> {
    const { store } = this.deps;
    turn.sourceTasks = fresh.flatMap((item) => item.runId ? [{ projectId: item.projectId, runId: item.runId }] : []);
    const startedAt = this.now();
    const result = await this.drive(id, manager, watchPrompt(snapshot, fresh, this.openCards(id), await this.taskQuestions(manager), manager.instructions), turn, () => undefined).catch(turnFailure);
    this.reportTurn(manager, turn, startedAt, result);
    if (!store.get(id)) return;
    this.addCost(id, result.costUsd);
    // A user's Stop leaves the keys fresh for the next check; a hung backend is a failure the chat shows.
    if (turn.stopped && !turn.timedOut) return;
    const error = turn.timedOut ? TURN_LIMIT_ERROR : result.error;
    const lastMessage = store.messages(id).at(-1);
    const resetAt = this.usageLimit(result, turn);
    if (resetAt) {
      // Not a failure: no backoff, and its keys stay fresh for the check after the reset.
      const repeat = lastMessage?.kind === 'assistant' && lastMessage.turn === 'watch' && lastMessage.resumeAt ? lastMessage : undefined;
      const messageId = repeat?.id ?? randomUUID();
      this.publish(id, {
        id: messageId,
        seq: repeat?.seq ?? store.nextSeq(id),
        at: this.iso(),
        kind: 'assistant',
        turn: 'watch',
        text: result.commands.length === 0 ? result.text.trim() : '',
        streaming: false,
        commands: [],
        resumeAt: resetAt.toISOString(),
      }, true);
      this.armResume(id, resetAt, messageId);
      return;
    }
    if (error) {
      // Nobody asked for this turn: the cause goes to diagnostics, and the chat hears only of a streak.
      const advice = turn.timedOut ? TURN_LIMIT_ERROR : this.recordFailure(id, 'watch', failureCause(error, result.text), result.runner);
      const failures = store.updateState(id, (state) => ({ ...state, watchFailures: state.watchFailures + 1 })).watchFailures;
      if (failures < WATCH_NOTICE_AFTER) return;
      const text = `Background checks keep failing. ${advice}`;
      // One line for the whole streak: a dead login must not add a message every check.
      const noticeId = store.state(id).watchNoticeId;
      const repeat = lastMessage?.kind === 'notice' && lastMessage.id === noticeId ? lastMessage : undefined;
      if (repeat?.text === text) return;
      const notice = { id: repeat?.id ?? randomUUID(), seq: repeat?.seq ?? store.nextSeq(id), at: this.iso(), kind: 'notice' as const, text };
      this.publish(id, notice, true);
      store.updateState(id, (state) => ({ ...state, watchNoticeId: notice.id }));
      return;
    }
    const reportedAt = this.iso();
    store.updateState(id, (state) => ({
      ...state,
      watchFailures: 0,
      watchNoticeId: undefined,
      reported: { ...state.reported, ...Object.fromEntries(snapshot.attention.map((item) => [item.key, reportedAt])) },
    }));
    // A quiet check may still withdraw its own cards.
    const closes = parseAskCloseMarkers(result.text);
    const raw = stripAskCloseMarkers(result.text).trim();
    if (!raw || QUIET_LINE.test(raw)) {
      this.closeMarked(id, closes);
      if (forced) this.addNotice(id, 'Checked: nothing needs you right now.');
      return;
    }
    const judgement = judged(raw);
    const written = this.publish(id, {
      id: randomUUID(),
      seq: store.nextSeq(id),
      at: this.iso(),
      kind: 'assistant',
      turn: 'watch',
      text: judgement.text,
      sourceTasks: taskSources(judgement.text).length ? taskSources(judgement.text) : turn.sourceTasks,
      ...judgedFields(judgement),
      streaming: false,
      commands: result.commands,
      ...(this.deps.costVisible() && result.costUsd > 0 ? { costUsd: result.costUsd } : {}),
    }, true);
    this.settleAsks(id, written, closes);
    const body = alertBody(judgement);
    if (body) this.alert(id, written, body, judgement.important ? 'message' : 'question');
  }

  /** `manager_turn_completed`, and the turn's duration as a timing (stopped turns time nothing). */
  private reportTurn(manager: Manager, turn: ActiveTurn, startedAt: number, result: DriveResult): void {
    const { telemetry } = this.deps;
    if (!telemetry) return;
    const trigger = MANAGER_TURN_TRIGGER[turn.kind];
    const outcome = turn.timedOut || (result.error && !turn.stopped) ? 'error' : turn.stopped ? 'stopped' : 'ok';
    telemetry.track('manager_turn_completed', `${trigger}:${outcome}`);
    if (outcome === 'stopped') return;
    telemetry.timing('manager_turn', this.now() - startedAt, {
      operation: trigger,
      target: manager.runner !== undefined && isRunnerId(manager.runner) ? manager.runner : 'default',
      outcome: turn.timedOut ? 'timeout' : outcome === 'error' ? 'error' : 'ok',
    });
  }

  /** Keeps a failed turn's real cause in the cockpit log and the manager's state; returns the line a user may see. */
  private recordFailure(id: string, turn: ManagerTurnKind, cause: string, runner: RunnerId | undefined): string {
    const kind: ManagerFailureKind = classifyManagerFailure(cause);
    console.warn(`[cezar] manager ${id}: ${turn} turn failed (${kind}): ${cause}`);
    this.deps.store.updateState(id, (state) => ({ ...state, lastFailure: { at: this.iso(), turn, kind, cause: cause.slice(0, OUTPUT_LIMIT) } }));
    return managerFailureMessage(kind, cause, runner, kind === 'usage-limit' ? parseUsageLimit(cause, this.now())?.resetAt : undefined);
  }

  /** Logged for the settings menu, where the user can allow the pattern when it is read-only. */
  private recordBashDenial(id: string, command: string): void {
    const manager = this.deps.store.get(id);
    if (!manager) return;
    const verdict = isManagerBashAllowed(command, manager.bashAllow);
    const reason = verdict.ok ? 'Claude Code refused it' : verdict.reason;
    const text = command.trim().slice(0, DENIAL_COMMAND_LIMIT);
    this.deps.store.updateState(id, (state) => {
      const previous = state.bashDenials.find((denial) => denial.command === text);
      const rest = state.bashDenials.filter((denial) => denial.command !== text);
      return { ...state, bashDenials: [{ command: text, reason, at: this.iso(), count: (previous?.count ?? 0) + 1 }, ...rest].slice(0, DENIALS_KEPT) };
    });
  }

  private addCost(id: string, usd: number): void {
    if (usd > 0) this.deps.store.updateState(id, (state) => ({ ...state, costUsd: state.costUsd + usd }));
  }

  /** One agent session, resumed when there is one; a failed resume restarts from a recap once. */
  private async drive(
    id: string,
    manager: Manager,
    prompt: string,
    turn: ActiveTurn,
    onProgress: (progress: Progress) => void,
  ): Promise<DriveResult> {
    const { store } = this.deps;
    const runner = await this.runnerOf(manager);
    const sessionKey = `${runner}|${manager.agentProfile ?? ''}`;
    const state = store.state(id);
    const field = SESSION_FIELD[turn.kind];
    const resumeId = state.sessionKey === sessionKey && this.resumes(turn.kind, state.sessions[turn.kind]) ? state[field] : undefined;
    const resumable = resumeId !== undefined;
    const sources = await this.sources(manager);
    const profile = supportsProfiles(runner) ? await resolveProfileEnvForRoot(undefined, runner, manager.agentProfile) : { env: {} };
    const planProvider = runner === 'claude' || runner === 'codex' ? runner : undefined;
    const planProfile = 'profile' in profile ? profile.profile : undefined;
    turn.planAccount = planProvider && planProfile
      ? await ledgerAccountRef(planProvider, planProfile).catch(() => undefined)
      : undefined;
    const planAccount = turn.planAccount;
    // Stopped or deleted during setup: building the spec would recreate the workdir.
    if (turn.stopped) return { text: '', commands: [], costUsd: 0 };
    const apiUrl = process.env.CEZ_API_URL;
    let shimDir: string | undefined;
    try {
      shimDir = ensureManagerShim();
    } catch (error) {
      console.warn(`[cezar] manager shim: ${error instanceof Error ? error.message : String(error)}`);
    }
    const locked = agentModelsLocked();
    let writable: string | undefined;
    if (runner === 'claude' && turn.kind !== 'watch') {
      try {
        // Real path: Claude matches the resolved one, and a symlinked home would never match.
        writable = realpathSync(store.filesDir(id));
      } catch {
        // a read-only home: the turn still runs, it just cannot Write
      }
    }
    // An unattended watch reads untrusted PR text; where `bashAllowlist` is no fence, the backend's
    // own read-only mode is. The snapshot is already in the prompt.
    const readOnlyWatch = turn.kind === 'watch' && !ALLOWLIST_FENCED.has(runner) && canEnforceReadOnly(runner);
    const bashHook = runner === 'claude' ? managerBashHookCommand() : undefined;
    // Read per turn, so a revoke applies from the next one; a watch reads untrusted text and gets none.
    const connectorTurn = runner === 'claude' && turn.kind !== 'watch';
    // A new chat session hears what it would otherwise have remembered; a watch or job is self-contained.
    // A fresh session never saw the cards a resumed one would get by id.
    const unseen = turn.cards?.ids ? prompt.replace(turn.cards.ids, () => turn.cards!.full) : prompt;
    const freshPrompt = turn.kind === 'chat' ? `${this.preamble(id, sources)}${unseen}` : prompt;
    const connectorRules = connectorTurn ? connectorAllowRules(manager.connectors, state.connectors) : [];
    // A manager with nothing granted loads no connector; a watch never calls one (spec 2026-11-21 § 2.4).
    const noMcpServers = runner === 'claude' && (!connectorTurn || !hasConnectorGrant(manager.connectors));
    const base: AgentRunSpec = {
      systemPrompt: managerSystemPrompt(
        manager,
        sources.map((source) => ({ id: source.id, name: source.name, access: managerAccessOf(manager, source.id) })),
        connectorTurn ? connectorPromptSection(manager.connectors, state.connectors) : '',
        // Only where the turn can Write the file it would pass.
        {
          textInFiles: runner === 'claude' && writable !== undefined,
          memory: renderMemory(this.memoryFor(id, (profile.env as Record<string, string | undefined>).CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR).entries),
        },
      ),
      userPrompt: resumeId ? prompt : freshPrompt,
      cwd: store.workdir(id),
      allowedTools: [...MANAGER_ALLOWED_TOOLS, ...(writable ? managerWriteRules(writable) : []), ...connectorRules],
      bashAllowlist: [...MANAGER_BASH_ALLOWLIST, ...(manager.bashAllow ?? [])],
      ...(bashHook ? { bashHookCommand: bashHook } : {}),
      // The user's Bash sandbox blocks the loopback cockpit `cez-manager` talks to; the hook still vets it.
      ...(runner === 'claude' ? { sandboxExcludedCommands: [...MANAGER_SANDBOX_EXCLUDED] } : {}),
      // Attachments stay readable: "that screenshot" can come a few turns later.
      additionalDirectories: [
        ...sources.filter((source) => source.available).map((source) => source.root),
        ...(existsSync(store.attachmentsDir(id)) ? [store.attachmentsDir(id)] : []),
      ],
      ...(turn.images ? { images: turn.images } : {}),
      env: {
        ...profile.env,
        CEZ_MANAGER_ID: id,
        CEZ_MANAGER_TURN: turn.kind,
        // One memory, cezar's: Claude's own would split it per runner and grow unseen.
        ...(runner === 'claude' ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : {}),
        ...(manager.bashAllow?.length ? { [MANAGER_BASH_ALLOW_ENV]: JSON.stringify(manager.bashAllow) } : {}),
        ...(apiUrl ? { CEZ_API_URL: apiUrl } : {}),
        ...(process.env.CEZ_BIN ? { CEZ_BIN: process.env.CEZ_BIN } : {}),
        ...(shimDir ? { PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}` } : {}),
        ...(readOnlyWatch ? readOnlyEnv() : {}),
      },
      ...(readOnlyWatch ? { enforceReadOnly: true } : {}),
      ...(noMcpServers ? { noMcpServers: true } : {}),
      ...(planAccount ? { onUsageWindows: (observation) => recordUsageObservation(planAccount, observation) } : {}),
      ...(manager.model && !locked ? { model: manager.model } : {}),
      // Another backend refuses an explicit effort, so a manager moved off one drops it.
      ...(manager.effort && runnerSupportsReasoningEffort(runner) ? { reasoningEffort: manager.effort } : {}),
    };
    // Claude's Bash inherits the cockpit's env plus the turn's; the broker runs Codex's commands in the same.
    if (runner === 'codex') base.brokeredShell = codexManagerShell(manager.bashAllow, { ...process.env, ...base.env });
    // A retry is the same user turn: it counts once, measured from the session as it stood before.
    const origin: TurnOrigin = { startedAt: this.now(), ...(resumeId && state.sessions[turn.kind] ? { prior: state.sessions[turn.kind]! } : {}) };
    const first = await this.session(id, base, sessionKey, runner, resumeId, turn, onProgress, origin);
    // A turn that ran a command may have acted: running it twice could act twice.
    if (!first.error || turn.stopped || turn.timedOut || first.commands.length > 0) return { ...first, runner };
    const plan = retryPlan(classifyManagerFailure(failureCause(first.error, first.text)), resumable);
    if (plan === 'none') return { ...first, runner };
    if (plan === 'again') {
      await new Promise((resolve) => setTimeout(resolve, this.deps.retryDelayMs ?? RETRY_BACKOFF_MS).unref?.());
      if (turn.stopped || !store.get(id)) return { ...first, runner };
      const again = await this.session(id, base, sessionKey, runner, resumeId, turn, onProgress, origin);
      return { ...again, costUsd: again.costUsd + first.costUsd, runner };
    }
    const fresh = await this.session(id, { ...base, userPrompt: freshPrompt }, sessionKey, runner, undefined, turn, onProgress, { startedAt: origin.startedAt });
    return { ...fresh, costUsd: fresh.costUsd + first.costUsd, runner };
  }

  private async session(
    id: string,
    base: AgentRunSpec,
    sessionKey: string,
    runnerId: RunnerId,
    resumeId: string | undefined,
    turn: ActiveTurn,
    onProgress: (progress: Progress) => void,
    origin: TurnOrigin = { startedAt: this.now() },
  ): Promise<DriveResult> {
    const { store } = this.deps;
    // Claude takes an id we mint; every other backend mints its own and reports it (`session`).
    const sessionId = resumeId ?? (runnerId === 'claude' ? randomUUID() : undefined);
    const spec: AgentRunSpec = { ...base, ...(sessionId ? { sessionId } : {}), ...(resumeId ? { resume: true } : {}) };
    let committed = '';
    let draft = '';
    let costUsd = 0;
    let error: string | undefined;
    let saved = false;
    const commands: ManagerCommand[] = [];
    const bashCommands = new Map<string, string>();
    const text = () => [committed, draft].filter(Boolean).join('\n\n');
    const turnStats = new TurnStatsCollector();
    const turnStartedAt = origin.startedAt;
    const priorSession = origin.prior;
    // Read when the throttle flushes, not per token: re-joining a long reply per delta is quadratic.
    const snapshot: Progress = () => ({ text: text(), commands: [...commands] });
    const progress = () => onProgress(snapshot);
    const saveSession = (value: string) => {
      if (saved || !store.get(id)) return;
      saved = true;
      const field = SESSION_FIELD[turn.kind];
      store.updateState(id, (state) => ({
        ...state,
        // A transcript does not follow a runner or account change: drop its siblings with it.
        ...(state.sessionKey === sessionKey ? {} : { sessionId: undefined, watchSessionId: undefined, jobSessionId: undefined }),
        [field]: value,
        sessionKey,
      }));
    };
    const onEvent = (event: AgentEvent) => {
      turnStats.event(event);
      // An error first means no transcript exists; resuming it would only fail again.
      if (sessionId && event.type !== 'error') saveSession(sessionId);
      switch (event.type) {
        case 'session':
          saved = false;
          saveSession(event.sessionId);
          break;
        case 'text':
          committed = [committed, event.text].filter(Boolean).join('\n\n');
          draft = '';
          progress();
          break;
        case 'tool-call':
          if (event.tool === 'Bash' && typeof (event.input as { command?: unknown } | undefined)?.command === 'string') {
            bashCommands.set(event.id, (event.input as { command: string }).command);
          }
          commands.push({ id: event.id, tool: event.tool, summary: commandSummary(event.input) || event.tool });
          progress();
          break;
        case 'tool-result': {
          const bash = bashCommands.get(event.toolCallId);
          if (bash !== undefined && event.isError && BASH_DENIED.test(event.result)) this.recordBashDenial(id, bash);
          const index = commands.findIndex((command) => command.id === event.toolCallId);
          const command = commands[index];
          if (command) {
            commands[index] = { ...command, output: event.result.slice(0, OUTPUT_LIMIT), ...(event.isError ? { isError: true } : {}) };
            progress();
          }
          break;
        }
        case 'cost':
          costUsd += event.usd;
          break;
        // The first is the cause; the CLI's "exited with code 1" that follows it is only the effect.
        case 'error':
          error ??= event.message;
          break;
        case 'mcp-servers':
          // A turn that loaded none would report every server gone; the probe still sees them.
          if (!base.noMcpServers) this.observeConnectors(id, event);
          break;
        default:
          break;
      }
    };
    const onUiEvent = (event: UiEvent) => {
      if (event.type === 'item.delta' && event.field === 'text') {
        draft += event.delta;
        progress();
      }
    };
    if (turn.stopped) return { text: '', commands, costUsd };
    turn.started = true;
    this.emitChange(id);
    // Its own consumer: tasks this manager starts count on those tasks, never here.
    const planUsage = turn.planAccount ? new PlanUsageTracker(turn.planAccount.provider, turn.planAccount, {
      id: managerConsumerId(id), kind: 'manager', title: store.get(id)?.name ?? id, managerId: id,
    }, { part: turn.kind, ...(turn.ledgerMessageId ? { messageId: turn.ledgerMessageId } : {}), endOnClose: true }) : undefined;
    try {
      const runner = (this.deps.runnerFor ?? createRunner)(runnerId);
      const session = runner.startSession(spec, (event) => { planUsage?.event(event); onEvent(event); }, {
        autoEndAfterFirstTurn: true,
        onUiEvent: (event) => { planUsage?.ui(event); onUiEvent(event); },
      });
      turn.session = session;
      if (turn.stopped) session.interrupt();
      await session.result;
    } catch (cause) {
      error ??= cause instanceof Error ? cause.message : String(cause);
    }
    const sessionTurn = (priorSession?.turns ?? 0) + 1;
    const stats = turnStats.stats({
      fresh: !resumeId,
      sessionTurn,
      ...(sessionId ? { session: sessionId.slice(0, 8) } : {}),
      ...(priorSession ? { idleMs: turnStartedAt - msOf(priorSession.lastAt) } : {}),
    });
    // A watch that reported nothing new is "quiet": the hint weighs its cadence against that.
    planUsage?.close({ ...(turn.kind === 'watch' ? { quiet: !judged(text().replace(QUIET_LINE, '').trim()).text } : {}), turn: stats });
    if (saved && store.get(id)) {
      const at = this.iso();
      store.updateState(id, (state) => {
        const cardsDigest = !error && turn.cards ? turn.cards.digest : resumeId ? state.sessions[turn.kind]?.cardsDigest : undefined;
        return {
          ...state,
          sessions: {
            ...state.sessions,
            [turn.kind]: {
              // Seen only once the turn ran; a failed one keeps what the resumed transcript had.
              ...(cardsDigest !== undefined ? { cardsDigest } : {}),
              startedAt: priorSession?.startedAt ?? new Date(turnStartedAt).toISOString(),
              lastAt: at,
              turns: sessionTurn,
              ...(turnStats.context > 0 ? { contextTokens: turnStats.context } : priorSession?.contextTokens !== undefined ? { contextTokens: priorSession.contextTokens } : {}),
            },
          },
        };
      });
    }
    return { text: committed || draft, commands, costUsd, ...(error ? { error } : {}) };
  }

  // ---- the timer ---------------------------------------------------------------------------

  private nextDue(manager: Manager, now: number): number | undefined {
    if (manager.inactive) return undefined;
    const resume = this.deps.store.state(manager.id).resume;
    if (resume) return Math.max(msOf(resume.at), now);
    const dues = manager.jobs.filter((job) => job.enabled).map((job) => jobDueAt(manager, job));
    if (manager.cronMinutes > 0) dues.push(this.checkDueAt(manager, this.deps.store.state(manager.id)));
    return dues.length > 0 ? Math.max(Math.min(...dues), now) : undefined;
  }

  /** Armed for the earliest due manager, never for none. Missed ticks collapse into one. */
  private reschedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.started || this.disposed) return;
    const now = this.now();
    const dues = this.deps.store.list().flatMap((manager) => this.nextDue(manager, now) ?? []);
    if (dues.length === 0) return;
    const delay = Math.min(Math.max(Math.min(...dues) - now, TICK_FLOOR_MS), MAX_TIMER_MS);
    this.timer = outsideRelayScope(() => setTimeout(() => {
      this.tick();
      this.reschedule();
    }, delay));
    this.timer.unref?.();
  }

  /** Public for tests; the timer is its only production caller. */
  tick(): void {
    const now = this.now();
    for (const manager of this.deps.store.list()) {
      if (manager.inactive) continue;
      const runtime = this.runtime(manager.id);
      if (runtime.active || runtime.queue.length > 0) continue;
      const resume = this.deps.store.state(manager.id).resume;
      if (resume) {
        if (msOf(resume.at) > now) continue;
        // Claimed in `runTurn`: a cockpit that loses the lease drops it, as it does a timed watch.
        this.enqueue(manager.id, { kind: 'resume' });
      }
      const state = this.deps.store.state(manager.id);
      // Held by a usage limit until now: the turn they were owed.
      if (resume && state.followups.length > 0) this.enqueue(manager.id, { kind: 'followup' });
      if (manager.cronMinutes > 0 && this.checkDueAt(manager, state) <= now) {
        this.enqueue(manager.id, { kind: 'watch', forced: false });
      }
      for (const job of manager.jobs) {
        if (!job.enabled || jobDueAt(manager, job) > now) continue;
        this.enqueue(manager.id, { kind: 'job', jobId: job.id });
      }
    }
  }

  // ---- sessions and memory (spec 2026-11-21-manager-short-sessions-and-memory) ---------------

  /** Watches and jobs always start over; a chat resumes only a warm, small, young transcript. */
  private resumes(kind: ActiveTurn['kind'], meta: ManagerState['sessions']['chat']): boolean {
    if (kind !== 'chat' || !meta) return false;
    const now = this.now();
    return now - msOf(meta.lastAt) < SESSION_IDLE_MS
      && now - msOf(meta.startedAt) < SESSION_AGE_MS
      && (meta.contextTokens ?? 0) < SESSION_CONTEXT_MAX;
  }

  /** What a new chat session starts from besides memory: recent exchanges and followed tasks. */
  private preamble(id: string, sources: ManagerProjectSource[]): string {
    const { store } = this.deps;
    const messages = store.messages(id).filter((message) => !(message.kind === 'assistant' && message.streaming));
    const tasks = Object.entries(store.state(id).follows)
      .sort(([, a], [, b]) => msOf(b.at) - msOf(a.at))
      .slice(0, PREAMBLE_TASKS)
      .flatMap(([key]) => {
        const [projectId, runId] = key.split('/');
        const run = projectId && runId ? findRun(sources.find((source) => source.id === projectId)?.runs() ?? [], runId) : undefined;
        return run ? [`- [[task:${projectId}/${run.id}]] ${run.status}${run.prNumber !== undefined ? `, PR #${run.prNumber}` : ''}: ${run.title ?? run.task.slice(0, 80)}`] : [];
      });
    return sessionPreamble(messages, tasks);
  }

  /** The manager's memory, importing Claude Code's auto-memory for its workdir once. */
  private memoryFor(id: string, claudeConfigDir?: string): MemoryFile {
    const { store } = this.deps;
    const dir = store.dir(id);
    const current = readMemory(dir, (message) => console.warn(`[cezar] ${message}`)) ?? { entries: [] };
    if (current.imported) return current;
    const at = this.iso();
    const imported = claudeAutoMemory(store.workdir(id), claudeConfigDir, at).filter((entry) => !current.entries.some((other) => other.key === entry.key));
    let entries = current.entries;
    for (const entry of imported) {
      const next = setMemoryEntry({ entries }, entry.key, { kind: entry.kind, text: entry.text, ...(entry.why ? { why: entry.why } : {}) }, at, 'import');
      if ('error' in next) continue;
      entries = next.entries;
    }
    const file: MemoryFile = { entries, imported: { at, count: entries.length - current.entries.length } };
    try {
      writeMemory(dir, file);
    } catch (error) {
      console.warn(`[cezar] manager ${id} memory: ${error instanceof Error ? error.message : String(error)}`);
    }
    return file;
  }

  private memoryResponse(file: MemoryFile): ManagerMemoryResponse {
    return { entries: file.entries, limits: { entries: MANAGER_MEMORY_LIMITS.entries, bytes: MANAGER_MEMORY_LIMITS.bytes }, usedBytes: memoryBytes(file.entries) };
  }

  /** Memory reaches every later system prompt unfenced, and a watch reads untrusted text: no write
   *  lands while one runs. The route cannot tell the cockpit from the agent, so the user's waits too. */
  private watching(id: string): boolean {
    return this.runtimes.get(id)?.active?.kind === 'watch';
  }

  /** The Claude config dir a turn would import from: the manager's account, not the server's own. */
  private async claudeConfigDir(manager: Manager): Promise<string | undefined> {
    const runner = await this.runnerOf(manager);
    const profile = supportsProfiles(runner) ? await resolveProfileEnvForRoot(undefined, runner, manager.agentProfile) : { env: {} };
    return (profile.env as Record<string, string | undefined>).CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR;
  }

  async memory(id: string): Promise<ManagerMemoryResponse | undefined> {
    const manager = this.deps.store.get(id);
    if (!manager) return undefined;
    return this.memoryResponse(this.memoryFor(id, await this.claudeConfigDir(manager)));
  }

  async setMemory(id: string, key: string, input: PutManagerMemoryInput): Promise<ManagerMemoryResponse | ManagerRefusal | undefined> {
    const manager = this.deps.store.get(id);
    if (!manager) return undefined;
    if (this.watching(id)) return { error: MEMORY_DURING_WATCH, status: 409 };
    const next = setMemoryEntry(this.memoryFor(id, await this.claudeConfigDir(manager)), key, input, this.iso(), input.source);
    if ('error' in next) return next;
    writeMemory(this.deps.store.dir(id), next);
    return this.memoryResponse(next);
  }

  async removeMemory(id: string, key: string): Promise<ManagerMemoryResponse | ManagerRefusal | undefined> {
    const manager = this.deps.store.get(id);
    if (!manager) return undefined;
    if (this.watching(id)) return { error: MEMORY_DURING_WATCH, status: 409 };
    const next = removeMemoryEntry(this.memoryFor(id, await this.claudeConfigDir(manager)), key);
    if ('error' in next) return next;
    writeMemory(this.deps.store.dir(id), next);
    return this.memoryResponse(next);
  }

  // ---- connectors (spec 2026-11-12-manager-connectors) --------------------------------------

  private async runnerOf(manager: Manager): Promise<RunnerId> {
    return manager.runner !== undefined && isRunnerId(manager.runner) ? manager.runner : this.deps.defaultRunner();
  }

  /** Every Claude session's init, chat, watch, job, probe and call alike: the status churns. */
  private observeConnectors(id: string, event: Extract<AgentEvent, { type: 'mcp-servers' }>): ObservedConnectors | undefined {
    if (!this.deps.store.get(id)) return undefined;
    return this.deps.store.updateState(id, (state) => ({ ...state, connectors: observeConnectors(event, state.connectors, this.iso()) })).connectors;
  }

  private connectorsOf(manager: Manager, runner: RunnerId): ManagerConnectorsResponse {
    if (runner !== 'claude') return { available: false, reason: CONNECTORS_CLAUDE_ONLY, servers: [] };
    const observed = this.deps.store.state(manager.id).connectors;
    return { available: true, ...(observed ? { observedAt: observed.observedAt } : {}), servers: connectorInfos(manager.connectors, observed) };
  }

  async connectors(id: string): Promise<ManagerConnectorsResponse | undefined> {
    const manager = this.deps.store.get(id);
    return manager ? this.connectorsOf(manager, await this.runnerOf(manager)) : undefined;
  }

  /** A Claude session with no tools, ended as soon as its init reports the servers: no model turn is needed. */
  async refreshConnectors(id: string): Promise<ManagerConnectorsResponse | ManagerRefusal | undefined> {
    const manager = this.deps.store.get(id);
    if (!manager) return undefined;
    if (manager.inactive) return { error: MANAGER_INACTIVE, status: 409 };
    const runner = await this.runnerOf(manager);
    if (runner !== 'claude') return this.connectorsOf(manager, runner);
    const profile = await resolveProfileEnvForRoot(undefined, runner, manager.agentProfile);
    let session: AgentSession | undefined;
    let seen = false;
    const stop = () => {
      if (!session) return;
      if (session.hardStop) session.hardStop();
      else session.interrupt();
    };
    try {
      session = (this.deps.runnerFor ?? createRunner)(runner).startSession({
        userPrompt: 'Reply with OK.',
        cwd: this.deps.store.workdir(id),
        allowedTools: [],
        env: { ...profile.env, CEZ_MANAGER_ID: id },
      }, (event) => {
        if (event.type !== 'mcp-servers') return;
        this.observeConnectors(id, event);
        seen = true;
        stop();
      }, { autoEndAfterFirstTurn: true });
      // An init that arrived before `session` was assigned could not stop it.
      if (seen) stop();
      const limit = setTimeout(stop, CONNECTOR_PROBE_LIMIT_MS);
      limit.unref?.();
      await session.result.catch(() => undefined).finally(() => clearTimeout(limit));
    } catch (error) {
      console.warn(`[cezar] manager ${id} connector probe: ${error instanceof Error ? error.message : String(error)}`);
    }
    const current = this.deps.store.get(id);
    return current ? this.connectorsOf(current, runner) : undefined;
  }

  /**
   * One approved call, and nothing else: a one-shot session whose only allowed tool is that one,
   * fenced by a `PreToolUse` hook that denies any input but the approved one.
   */
  private async callConnector(id: string, action: ConnectorCall): Promise<{ ok: boolean; result: string }> {
    const { store } = this.deps;
    const manager = store.get(id);
    if (!manager) return { ok: false, result: 'manager not found' };
    if (manager.inactive) return { ok: false, result: 'This manager is inactive: reactivate it to run the call.' };
    const runner = await this.runnerOf(manager);
    if (runner !== 'claude') return { ok: false, result: CONNECTORS_CLAUDE_ONLY };
    const name = action.connectorName ?? connectorDisplayName(action.connector, store.state(id).connectors);
    const unavailable = { ok: false, result: `${name} is temporarily unavailable. Try again when it reconnects.` };
    const tool = connectorToolName(action.connector, action.tool);
    const approved = canonicalJson(action.args);
    const profile = await resolveProfileEnvForRoot(undefined, runner, manager.agentProfile);
    const fence = connectorCallFence(tool, action.args);
    const inputs = new Map<string, unknown>();
    const results: Array<{ input: unknown; result: string; isError: boolean }> = [];
    let gone = false;
    let text = '';
    let error: string | undefined;
    let session: AgentSession | undefined;
    const stop = () => {
      if (!session) return;
      if (session.hardStop) session.hardStop();
      else session.interrupt();
    };
    try {
      session = (this.deps.runnerFor ?? createRunner)(runner).startSession({
        systemPrompt: 'You run one tool call the user approved in cezar, exactly as approved, and nothing else.',
        userPrompt: connectorCallPrompt(tool, action.args),
        cwd: store.workdir(id),
        allowedTools: [tool],
        env: { ...profile.env, CEZ_MANAGER_ID: id },
        claudeSettings: fence.settings,
        ...(manager.model && !agentModelsLocked() ? { model: manager.model } : {}),
      }, (event) => {
        switch (event.type) {
          case 'mcp-servers': {
            const server = this.observeConnectors(id, event)?.servers.find((candidate) => candidate.key === action.connector);
            // `pending` may still connect within the session; anything else will not.
            if (!server || (server.status !== 'pending' && (server.status !== 'connected' || !event.tools.includes(tool)))) {
              gone = true;
              stop();
            }
            break;
          }
          case 'tool-call':
            if (event.tool === tool) inputs.set(event.id, event.input);
            break;
          case 'tool-result':
            if (inputs.has(event.toolCallId)) results.push({ input: inputs.get(event.toolCallId), result: event.result, isError: event.isError });
            break;
          case 'text':
            text += event.text;
            break;
          case 'error':
            error = event.message;
            break;
          default:
            break;
        }
      }, { autoEndAfterFirstTurn: true });
      if (gone) stop();
      const limit = setTimeout(stop, CONNECTOR_CALL_LIMIT_MS);
      limit.unref?.();
      await session.result.catch((cause) => {
        error ??= cause instanceof Error ? cause.message : String(cause);
      }).finally(() => clearTimeout(limit));
    } finally {
      fence.cleanup();
    }
    const done = results.find((call) => !call.isError);
    if (done) {
      // The hook is the fence; this only says so loudly if it ever failed open.
      if (canonicalJson(done.input ?? {}) !== approved) return { ok: false, result: `The call ran with input other than the approved one. Check ${name} now.` };
      // The summary leads so the card reads as a sentence; the raw reply stays for the manager.
      const summary = text.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 300);
      const raw = clipResult(done.result);
      return { ok: true, result: [summary, raw].filter(Boolean).join('\n') || `Called ${action.tool}.` };
    }
    if (gone || text.includes(CONNECTOR_UNAVAILABLE)) return unavailable;
    const failed = results.at(-1);
    if (failed) return { ok: false, result: clipResult(`The call failed: ${failed.result}`) };
    return { ok: false, result: error ? clipResult(`The call did not run: ${error}`) : 'The call did not run.' };
  }

  // ---- the agent's tools -------------------------------------------------------------------

  private async toolScope(id: string, projectId: string | undefined, write: boolean): Promise<{ manager: Manager; source?: ManagerProjectSource } | ManagerRefusal> {
    const manager = this.deps.store.get(id);
    if (!manager) return { error: 'manager not found', status: 404 };
    if (write && this.runtimes.get(id)?.active?.kind === 'watch') return { error: WATCH_REFUSAL, status: 409 };
    if (projectId === undefined) return { manager };
    const source = (await this.sources(manager)).find((candidate) => candidate.id === projectId);
    if (!source) return { error: `this manager is not connected to project ${projectId}`, status: 403 };
    return { manager, source };
  }

  private async forward(path: string, init?: { method: string; body?: unknown }): Promise<Response> {
    return this.deps.request(`/api/v1${path}`, {
      method: init?.method ?? 'GET',
      headers: { host: '127.0.0.1', ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  }

  /** Whether the project runs tasks in its checkout by default (spec 2026-10-20-trunk-based-projects).
   *  An unreadable config answers no: the request then goes out as asked. */
  private async inPlaceProject(prefix: string): Promise<boolean> {
    const response = await this.forward(`${prefix}/config`).catch(() => undefined);
    if (!response?.ok) return false;
    const config = (await response.json().catch(() => ({}))) as { taskWorkspace?: unknown };
    return config.taskWorkspace === 'in-place';
  }

  private static async refusalOf(response: Response): Promise<ManagerRefusal> {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    const status = response.status;
    return {
      error: typeof body.error === 'string' ? body.error : `${status} ${response.statusText}`,
      status: status === 400 || status === 403 || status === 404 || status === 409 ? status : 502,
    };
  }

  /** Tool reads and writes can discover a source after the turn started. */
  private rememberTaskSource(id: string, projectId: string, runId: string): void {
    const active = this.runtimes.get(id)?.active;
    if (active && !active.sourceTasks?.some((entry) => entry.projectId === projectId && entry.runId === runId)) {
      active.sourceTasks = [...(active.sourceTasks ?? []), { projectId, runId }];
    }
  }

  async taskDetail(id: string, projectId: string, runId: string): Promise<ManagerTaskDetail | ManagerRefusal> {
    const scope = await this.toolScope(id, projectId, false);
    if ('error' in scope) return scope;
    const source = scope.source;
    const rows = source ? taskDetailRows(source.runs(), runId) : undefined;
    if (!source || !rows) return { error: 'task not found', status: 404 };
    this.rememberTaskSource(id, projectId, rows.task.runId);
    const lastMessage = lastAssistantText(source.root, rows.task.runId);
    return { ...rows, ...(lastMessage ? { lastMessage } : {}) };
  }

  /** The user's own chat message, read off the log: `fromMessage` copies it verbatim, attachments too. */
  private forwardOf(id: string, ref: string): Forward | ManagerRefusal {
    const { store } = this.deps;
    const newestFirst = [...store.messages(id)].reverse();
    const wanted = ref === 'last' ? this.runtimes.get(id)?.active?.messageIds?.at(-1) : ref;
    const message = wanted ? newestFirst.find((candidate) => candidate.id === wanted) : newestFirst.find((candidate) => candidate.kind === 'user');
    if (message?.kind !== 'user') return { error: ref === 'last' ? 'there is no user message to forward' : `no user message ${ref} in this chat`, status: 404 };
    const images: AttachmentInput[] = [];
    const skipped: string[] = [];
    let total = 0;
    for (const attachment of message.attachments ?? []) {
      const label = attachment.name ?? attachment.file;
      let data: string;
      try {
        data = readFileSync(join(store.attachmentsDir(id), attachment.file)).toString('base64');
      } catch {
        skipped.push(label);
        continue;
      }
      // The bounds `POST /runs` and `/messages` hold an attachment list to (`attachmentInputSchema`).
      if (data.length > ATTACHMENT_BASE64_LIMIT || total + data.length > MAX_ATTACHMENTS_TOTAL_BASE64 || images.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
        skipped.push(label);
        continue;
      }
      total += data.length;
      images.push({ mediaType: attachment.mediaType, data, ...(attachment.name ? { name: attachment.name } : {}) });
    }
    return {
      text: message.text,
      images,
      forwarded: { messageId: message.id, chars: message.text.length, attachments: images.length, ...(skipped.length > 0 ? { skipped } : {}) },
    };
  }

  /** The text a task receives: the model's words, then the forwarded message. Placeholders refused. */
  private composed(id: string, written: string | undefined, input: { fromMessage?: string; allowPlaceholder?: boolean }): { text: string; forward?: Forward } | ManagerRefusal {
    const forward = input.fromMessage !== undefined ? this.forwardOf(id, input.fromMessage) : undefined;
    if (forward && 'error' in forward) return forward;
    // A forward brings the content itself, so only bare text can have lost it to a placeholder.
    const marker = forward || input.allowPlaceholder ? undefined : placeholderIn(written);
    if (marker) return { error: placeholderRefusal(marker), status: 400 };
    const text = forward ? withForwarded(written, forward.text, forward.images.length) : written ?? '';
    if (text.length > FORWARD_TEXT_LIMIT) {
      return { error: `the text and the forwarded message come to ${text.length} characters; a task takes at most ${FORWARD_TEXT_LIMIT}. Shorten your part, or forward without one.`, status: 400 };
    }
    return { text, ...(forward ? { forward } : {}) };
  }

  /** `retry`: the task being retried — its pair ranks first while still allowed, and its model and effort stay only on its runner. */
  async createTask(id: string, input: ManagerCreateTaskInput, retry?: { runner?: string; agentProfile?: string; allowed: boolean }): Promise<ManagerCreateTaskResponse | ManagerRefusal> {
    const scope = await this.toolScope(id, input.projectId, true);
    if ('error' in scope) return scope;
    const readOnly = managerAccessOf(scope.manager, input.projectId) === 'read';
    if (readOnly) {
      if (input.dispatch || (input.workflow && input.workflow !== 'quick-task')) {
        return { error: `${input.projectId} is read-only for this manager: only a plain read-only task can start there`, status: 403 };
      }
    }
    const composed = this.composed(id, input.task, input);
    if ('error' in composed) return composed;
    const { forward } = composed;
    const agents = scope.manager.taskAgents?.filter((agent): agent is ManagerTaskAgent & { runner: RunnerId } => isRunnerId(agent.runner));
    const preferred = await this.runnerOf(scope.manager);
    const candidates = agents?.filter((agent) => (!input.runner || agent.runner === input.runner)
      && (input.agentProfile === undefined || agent.agentProfile === input.agentProfile));
    if (candidates?.length === 0) {
      return { error: 'Choose an agent account from the manager’s selected accounts for new tasks', status: 403 };
    }
    const root = scope.source?.root;
    const now = this.now();
    let choice: TaskAgentChoice | undefined;
    let fallbackOptions: AccountOption[] | undefined;
    /** The runner picked when every listed account has capacity: --model/--effort are refused, not dropped, there. */
    let firstRunner: string | undefined;
    if (agents && candidates) {
      // The manager's settings are the default: a retried task's own account, then its own runner, then list order.
      const rank = (agent: ManagerTaskAgent) => (retry?.allowed && agent.runner === retry.runner && agent.agentProfile === retry.agentProfile ? 0 : agent.runner === preferred ? 1 : 2);
      const ordered = [...candidates].sort((a, b) => rank(a) - rank(b));
      const allowed = await Promise.all([...agents].sort((a, b) => rank(a) - rank(b)).map((agent) => this.accountOption(agent.runner, agent.agentProfile, root)));
      const options = ordered.map((agent) => allowed.find((option) => option.runner === agent.runner && option.agentProfile === agent.agentProfile)!);
      choice = chooseTaskAgent(options, {
        explicitAccount: input.agentProfile !== undefined, fromSettings: true, allowed, now,
        ...(input.runner && candidates.length < agents.length ? { narrowedBy: `--runner ${input.runner}` } : {}),
      });
      firstRunner = options[0]?.runner;
      const picked = choice.chosen;
      // An explicit --runner or --account keeps a usage-limit fallback on that runner.
      const sameRunner = input.runner !== undefined || input.agentProfile !== undefined;
      // The whole list, the task's own account included: admission skips whichever account just ran
      // out, so a dispatched child on another listed account still falls back to this one.
      fallbackOptions = allowed.filter((option, index) => (!sameRunner || option.runner === picked.runner)
        && allowed.findIndex((other) => other.runner === option.runner && other.account === option.account) === index);
    }
    const runner = choice?.chosen.runner ?? scope.manager.taskRunner ?? input.runner ?? preferred;
    const agentProfile = choice ? choice.chosen.agentProfile : input.agentProfile;
    if (!isRunnerId(runner)) return { error: `unknown runner: ${runner}`, status: 400 };
    const accountIssue = await this.accountIssue(runner, agentProfile);
    if (accountIssue) return accountIssue;
    choice ??= chooseTaskAgent([await this.accountOption(runner, agentProfile, root)], { explicitAccount: agentProfile !== undefined, fromSettings: false, now });
    // --model/--effort are checked on the runner the task really landed on. A runner the flags did not
    // pin (a limit skip off the first listed runner, a retry on another runner) drops only what fails
    // there; anywhere else a bad flag is refused with the valid choices, as before.
    const unpinned = (firstRunner !== undefined && !input.runner && firstRunner !== runner)
      || (retry?.runner !== undefined && retry.runner !== runner);
    let carried = input;
    if (input.model || input.effort) {
      const issue = await this.modelIssue(runner, input.model, input.effort);
      if (issue && !unpinned) return issue;
      if (issue) {
        // Dropped only when another allowed runner can use it: a flag the manager typed that no listed
        // runner accepts (a typo) is refused with the valid choices, as when nothing moved. A retry's
        // flags are the old run's, so they are only ever dropped.
        const runners = retry ? [] as RunnerId[] : [...new Set((agents ?? []).map((agent) => agent.runner))].filter((other) => other !== runner);
        const usable = async (check: (other: RunnerId) => Promise<ManagerRefusal | undefined>) => {
          for (const other of runners) if (!(await check(other))) return true;
          return false;
        };
        const refusedHere = (model?: string, effort?: string) => this.modelIssue(runner, model, effort);
        // Refused as if nothing had moved: the valid choices of the first listed runner, not the landed one.
        const asFirst = (firstRunner ?? runner) as RunnerId;
        if (!retry && input.model && (await refusedHere(input.model)) && !(await usable((other) => this.modelIssue(other, input.model, undefined)))) {
          return (await this.modelIssue(asFirst, input.model, undefined)) ?? issue;
        }
        if (!retry && input.effort && (await refusedHere(undefined, input.effort)) && !(await usable((other) => this.modelIssue(other, undefined, input.effort)))) {
          return (await this.modelIssue(asFirst, undefined, input.effort)) ?? issue;
        }
        const model = input.model && !(await this.modelIssue(runner, input.model, undefined)) ? input.model : undefined;
        const effort = input.effort && !(await this.modelIssue(runner, model, input.effort)) ? input.effort : undefined;
        carried = { ...input, model, effort };
        const dropped = [input.model && !model && `--model ${input.model}`, input.effort && !effort && `--effort ${input.effort}`].filter(Boolean).join(' and ');
        choice = { ...choice, reason: `${choice.reason}; ${dropped} dropped: not valid on ${runner}` };
      }
    }
    // A fallback entry carries the requested model only where that runner accepts it.
    const modelValidOn = new Map<string, boolean>();
    const fallback: Array<{ provider: RunnerId; profileId: string; model?: string }> | undefined = fallbackOptions && [];
    for (const option of fallbackOptions ?? []) {
      if (input.model && !modelValidOn.has(option.runner)) modelValidOn.set(option.runner, !(await this.modelIssue(option.runner, input.model, undefined)));
      fallback!.push({ provider: option.runner, profileId: option.account, ...(input.model && modelValidOn.get(option.runner) ? { model: input.model } : {}) });
    }
    const agentNote = `Agent chosen by manager ${scope.manager.name}: ${choice.chosen.runner} · ${choice.chosen.label} — ${choice.reason}`;
    const prefix = `/p/${encodeURIComponent(input.projectId)}`;
    // A dispatch root always gets its own worktree, which overrides a trunk-based project's in-place
    // workspace: no Commit to the base branch, no auto-land. The project's model wins over the flag.
    const dispatchIgnored = input.dispatch === true && (await this.inPlaceProject(prefix));
    const dispatch = input.dispatch === true && !dispatchIgnored;
    // Before the request: anything the run does after it starts is news to this manager.
    const followedAt = this.iso();
    const response = await this.forward(`${prefix}/runs`, {
      method: 'POST',
      body: {
        workflow: input.workflow ?? 'quick-task',
        task: composed.text,
        ...(forward && forward.images.length > 0 ? { images: forward.images } : {}),
        ...(readOnly ? { readOnly: true, enforceReadOnly: true } : {}),
        runner,
        ...(agentProfile !== undefined ? { agentProfile } : {}),
        ...(carried.model ? { model: carried.model } : {}),
        ...(carried.effort ? { reasoningEffort: carried.effort } : {}),
        ...(dispatch ? { dispatch: {} } : {}),
        startedByManager: { id: scope.manager.id, name: scope.manager.name },
        managerAgent: { note: agentNote.slice(0, 500), ...(fallback ? { fallback: fallback.slice(0, 10) } : {}) },
      },
    });
    if (!response.ok) return ManagerEngine.refusalOf(response);
    const run = (await response.json()) as { id: string };
    this.recordFollow(id, input.projectId, run.id, followedAt, true);
    this.deps.telemetry?.track('manager_task_started', managerWorkflowLabel(input.workflow));
    if (input.title) {
      await this.forward(`${prefix}/runs/${encodeURIComponent(run.id)}`, { method: 'PATCH', body: { title: input.title } }).catch(() => undefined);
    }
    this.rememberTaskSource(id, input.projectId, run.id);
    const named = `${input.title ?? ''}\n${input.task ?? ''}`;
    this.managerActed(id, { tasks: taskSources(named).map((task) => followKey(task.projectId, task.runId)), prs: prRefs(named) }, 'you started a task on it since');
    return {
      projectId: input.projectId,
      runId: run.id,
      ...(forward ? { forwarded: forward.forwarded } : {}),
      ...(dispatchIgnored ? { notice: `dispatch ignored: ${input.projectId} runs tasks in place` } : {}),
      agent: {
        runner: choice.chosen.runner,
        ...(choice.chosen.agentProfile !== undefined ? { agentProfile: choice.chosen.agentProfile } : {}),
        account: choice.chosen.account,
        label: choice.chosen.label,
        reason: choice.reason,
        ...(choice.queuedUntil !== undefined ? { queuedUntil: new Date(choice.queuedUntil).toISOString() } : {}),
      },
      ...(choice.warning ? { warning: choice.warning } : {}),
    };
  }

  /** One account's usage-limit state, from the workspace holds; unknown = capacity. */
  private async accountOption(runner: RunnerId, agentProfile: string | undefined, repoRoot?: string): Promise<AccountOption> {
    const state = await this.deps.accountLimit?.(runner, agentProfile, repoRoot).catch(() => undefined);
    return {
      runner,
      ...(agentProfile !== undefined ? { agentProfile } : {}),
      account: state?.account ?? agentProfile ?? 'default',
      label: state?.label ?? agentProfile ?? 'automatic account',
      ...(state?.until !== undefined ? { until: state.until } : {}),
    };
  }

  /** The accounts new tasks may use and their limit state, for `cez-manager status`. */
  private async accountStates(manager: Manager, sources: ManagerProjectSource[]): Promise<ManagerAccountState[]> {
    const root = sources.find((source) => source.available)?.root;
    const agents = manager.taskAgents?.filter((agent): agent is ManagerTaskAgent & { runner: RunnerId } => isRunnerId(agent.runner))
      ?? [{ runner: manager.taskRunner && isRunnerId(manager.taskRunner) ? manager.taskRunner : await this.runnerOf(manager) }];
    const now = this.now();
    return Promise.all(agents.map(async (agent) => {
      const option = await this.accountOption(agent.runner, agent.agentProfile, root);
      return {
        runner: option.runner,
        ...(option.agentProfile !== undefined ? { agentProfile: option.agentProfile } : {}),
        account: option.account,
        label: option.label,
        ...(option.until !== undefined && option.until > now ? { outOfLimitsUntil: new Date(option.until).toISOString() } : {}),
      };
    }));
  }

  /** A live task takes the message; a finished one is continued with it. */
  async taskMessage(id: string, input: ManagerTaskMessageInput): Promise<ManagerTaskMessageResponse | ManagerRefusal> {
    const scope = await this.toolScope(id, input.projectId, true);
    if ('error' in scope) return scope;
    // A write task told what to do next would be write access by proxy; so would an Ask task,
    // whose read-only tools some backends ignore.
    if (managerAccessOf(scope.manager, input.projectId) === 'read' && !scope.source?.runs().find((run) => run.id === input.runId)?.enforceReadOnly) {
      return { error: `${input.projectId} is read-only for this manager: it can only message read-only tasks`, status: 403 };
    }
    const composed = this.composed(id, input.text, input);
    if ('error' in composed) return composed;
    const { forward } = composed;
    const body = { text: composed.text, ...(forward && forward.images.length > 0 ? { images: forward.images } : {}) };
    this.rememberTaskSource(id, input.projectId, input.runId);
    const sent = { ok: true as const, ...(forward ? { forwarded: forward.forwarded } : {}) };
    this.managerActed(id, { tasks: [followKey(input.projectId, input.runId)] }, 'you messaged that task since');
    const path = `/p/${encodeURIComponent(input.projectId)}/runs/${encodeURIComponent(input.runId)}`;
    if (input.model || input.effort) {
      // A live session cannot change engine mid-turn: only a Continue takes a model.
      const run = scope.source?.runs().find((candidate) => candidate.id === input.runId);
      if (!run) return { error: 'task not found', status: 404 };
      // An idle park has no live session, so a Continue may change its engine like a finished task's.
      if (LIVE_STATUSES.has(run.status) && !isIdleParked(run)) {
        return { error: `task ${input.runId} is ${run.status}: --model and --effort apply only when continuing a finished task. Send the message without them, or wait for it to finish`, status: 409 };
      }
      const issue = await this.modelIssue(run.runner ?? 'claude', input.model, input.effort);
      if (issue) return issue;
      const continued = await this.forward(`${path}/continue`, {
        method: 'POST',
        body: { ...body, ...(input.model ? { model: input.model } : {}), ...(input.effort ? { reasoningEffort: input.effort } : {}) },
      });
      return continued.ok ? sent : ManagerEngine.refusalOf(continued);
    }
    const delivered = await this.forward(`${path}/messages`, { method: 'POST', body });
    if (delivered.ok) return sent;
    if (delivered.status !== 409) return ManagerEngine.refusalOf(delivered);
    const continued = await this.forward(`${path}/continue`, { method: 'POST', body });
    return continued.ok ? sent : ManagerEngine.refusalOf(continued);
  }

  /** `--model`/`--effort` against the runner and the host's model catalog; a 400 naming the valid ones. */
  private async modelIssue(runner: string, model: string | undefined, effort: string | undefined): Promise<ManagerRefusal | undefined> {
    if (!isRunnerId(runner)) return undefined;
    let catalog: TaskModelCatalog | undefined;
    if ((MODEL_DISCOVERY_RUNNERS as readonly string[]).includes(runner)) {
      const response = await this.forward(`/models?${new URLSearchParams({ runner })}`).catch(() => undefined);
      if (response?.ok) catalog = (await response.json().catch(() => undefined)) as TaskModelCatalog | undefined;
    }
    const issue = taskModelIssue({ runner, model, effort, catalog });
    return issue ? { error: issue, status: 400 } : undefined;
  }

  /**
   * Stops a task and every task it dispatched through the cockpit's own cancel route. By default
   * only a task this manager started; `cancelAnyTask` widens that to its write projects.
   */
  async cancelTask(id: string, input: ManagerCancelTaskInput): Promise<ManagerCancelTaskResponse | ManagerRefusal> {
    const scope = await this.toolScope(id, input.projectId, true);
    if ('error' in scope) return scope;
    const { manager, source } = scope;
    if (managerAccessOf(manager, input.projectId) === 'read') {
      return { error: `${input.projectId} is read-only for this manager: it cannot cancel tasks there`, status: 403 };
    }
    const runs = source?.runs() ?? [];
    const run = findRun(runs, input.runId);
    if (!run) return { error: 'task not found', status: 404 };
    if (run.startedByManager?.id !== manager.id && manager.cancelAnyTask !== true) {
      return {
        error: `task ${input.runId} was not started by this manager, so it cannot cancel it. Ask the user to cancel it, or to allow "Cancel or switch any task" in your settings`,
        status: 403,
      };
    }
    const liveDescendants = descendantsOf(runs, run.id).filter((child) => LIVE_STATUSES.has(child.status)).map((child) => child.id);
    const response = await this.forward(`/p/${encodeURIComponent(input.projectId)}/runs/${encodeURIComponent(run.id)}/cancel`, {
      method: 'POST',
      body: { ...(input.reason ? { reason: input.reason } : {}), cancelledBy: manager.name },
    });
    if (!response.ok) return ManagerEngine.refusalOf(response);
    const { cancelled } = (await response.json()) as { cancelled: boolean };
    this.managerActed(id, { tasks: [followKey(input.projectId, run.id)] }, 'you cancelled that task since');
    const after = new Map((source?.runs() ?? []).map((candidate) => [candidate.id, candidate.status]));
    return {
      runId: run.id,
      cancelled,
      status: after.get(run.id) ?? run.status,
      children: liveDescendants.filter((childId) => after.get(childId) === 'cancelled'),
    };
  }

  async switchTask(id: string, input: ManagerSwitchTaskInput): Promise<ManagerCreateTaskResponse | ManagerRefusal> {
    const scope = await this.toolScope(id, input.projectId, true);
    if ('error' in scope) return scope;
    const run = findRun(scope.source?.runs() ?? [], input.runId);
    if (!scope.source || !run) return { error: 'task not found', status: 404 };
    return this.changeTaskAgent(scope.manager, scope.source.root, run, input);
  }

  private async changeTaskAgent(manager: Manager, repoRoot: string, run: RunRecord, input: ManagerSwitchTaskInput): Promise<ManagerCreateTaskResponse | ManagerRefusal> {
    const { projectId } = input;
    if (managerAccessOf(manager, projectId) === 'read') {
      return { error: `${projectId} is read-only for this manager: it cannot switch task agents there`, status: 403 };
    }
    if (run.startedByManager?.id !== manager.id && manager.cancelAnyTask !== true) {
      return { error: `task ${run.id} was not started by this manager. Ask the user to switch it, or to allow "Cancel or switch any task" in your settings`, status: 403 };
    }
    const current = taskAgentSelection(run, run.runner ?? (await loadConfig(repoRoot)).defaultRunner);
    const runner = input.runner ?? current.runner;
    if (!isRunnerId(runner)) return { error: `unknown runner: ${runner}`, status: 400 };
    const currentAccount = runner === current.runner ? current.agentProfile : undefined;
    const candidates = manager.taskAgents?.filter((agent) => agent.runner === runner);
    // An account-less entry allows the project's resolved account, just as in fallback admission.
    const automatic = candidates?.some((agent) => agent.agentProfile === undefined)
      ? (await this.accountOption(runner, undefined, repoRoot)).account
      : undefined;
    const allowed = candidates?.map((agent) => agent.agentProfile ?? automatic ?? DEFAULT_AGENT_ACCOUNT_ID);
    const preferredAccount = runner === current.runner ? currentAccount ?? automatic : undefined;
    const agentProfile = input.agentProfile ?? (allowed
      ? allowed.find((account) => account === preferredAccount) ?? allowed[0]
      : currentAccount);
    if ((allowed && (agentProfile === undefined || !allowed.includes(agentProfile)))
      || (!allowed && manager.taskRunner && manager.taskRunner !== runner)) {
      return { error: 'Choose an agent account from the manager’s selected accounts for new tasks', status: 403 };
    }
    const accountIssue = await this.accountIssue(runner, agentProfile);
    if (accountIssue) return accountIssue;
    // Send only explicit pins. The workflow resolves inherited pins independently for each step.
    const { model, effort } = input;
    const issue = model || effort ? await this.modelIssue(runner, model, effort) : undefined;
    if (issue) return issue;
    const response = await this.forward(`/p/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(run.id)}/switch-agent`, {
      method: 'POST',
      body: {
        runner, agentProfile, model,
        reasoningEffort: effort,
        changedBy: manager.name,
      },
    });
    if (!response.ok) return ManagerEngine.refusalOf(response);
    const { summary } = (await response.json()) as SwitchRunAgentResponse;
    this.rememberTaskSource(manager.id, projectId, run.id);
    this.managerActed(manager.id, { tasks: [followKey(projectId, run.id)] }, 'you switched that task’s agent since');
    return { projectId, runId: run.id, notice: summary };
  }

  /** With agent flags, reopen the same failed task. A plain retry repeats the workflow from scratch. */
  async retryTask(id: string, input: ManagerRetryTaskInput): Promise<ManagerCreateTaskResponse | ManagerRefusal> {
    const scope = await this.toolScope(id, input.projectId, true);
    if ('error' in scope) return scope;
    const run = findRun(scope.source?.runs() ?? [], input.runId);
    if (!scope.source || !run) return { error: 'task not found', status: 404 };
    if (run.status !== 'failed' && run.status !== 'cancelled') {
      return { error: `task ${input.runId} is ${run.status}: only a failed or cancelled task can be retried. Use \`task say\` to continue it`, status: 409 };
    }
    if (input.runner || input.agentProfile || input.model || input.effort) {
      return this.changeTaskAgent(scope.manager, scope.source.root, run, input);
    }
    if (run.workflow === '(planned)') return { error: 'an inline plan cannot be retried: start a new task with its objective instead', status: 409 };
    const effort = run.reasoningEffort && (['low', 'medium', 'high', 'max'] as const).find((level) => level === run.reasoningEffort);
    const allowed = scope.manager.taskAgents
      ? scope.manager.taskAgents.some((agent) => agent.runner === run.runner && agent.agentProfile === run.agentProfile)
      : !scope.manager.taskRunner || scope.manager.taskRunner === run.runner;
    // With an allowed-accounts list the retry takes the manager's default (limit-aware), its old account first.
    const pinned = allowed && !scope.manager.taskAgents;
    const created = await this.createTask(id, {
      projectId: input.projectId,
      task: run.task,
      // The task text was checked when it first started; a placeholder there is the user's own.
      allowPlaceholder: true,
      workflow: run.workflow,
      ...(run.titleOrigin === 'user' ? { title: run.title } : {}),
      ...(pinned && run.runner ? { runner: run.runner } : {}),
      ...(pinned && run.agentProfile ? { agentProfile: run.agentProfile } : {}),
      ...(run.model ? { model: run.model } : {}),
      ...(effort ? { effort } : {}),
    }, { runner: run.runner, agentProfile: run.agentProfile, allowed });
    if (!('error' in created)) this.managerActed(id, { tasks: [followKey(input.projectId, run.id)] }, 'you retried that task since');
    return created;
  }

  /** Checked against the forge now, so a card never offers a merge that was already impossible. */
  private async stampAction(id: string, action: ManagerActionRequest): Promise<ManagerActionRequest | ManagerRefusal> {
    if (action.type === 'add-job') return action;
    // Claude's server name, never the agent's: the card is what the user decides on.
    if (action.type === 'connector-call') return { ...action, connectorName: connectorDisplayName(action.connector, this.deps.store.state(id).connectors).slice(0, 200) };
    const prefix = `/p/${encodeURIComponent(action.projectId)}`;
    if (action.type === 'merge-pr') {
      const response = await this.forward(`${prefix}/github/prs/${action.number}/merge-state`);
      if (!response.ok) return ManagerEngine.refusalOf(response);
      const body = (await response.json()) as { available: boolean; reason?: string; mergeState?: { title: string; state: string; headSha: string } };
      if (!body.available || !body.mergeState) return { error: body.reason ?? 'GitHub merge is unavailable', status: 409 };
      if (body.mergeState.state !== 'open') return { error: `#${action.number} is already ${body.mergeState.state}`, status: 409 };
      // The forge's title, never the agent's: the card is what the user decides on.
      return { ...action, title: body.mergeState.title.slice(0, 1000), headSha: body.mergeState.headSha };
    }
    const response = await this.forward(`${prefix}/automations/${encodeURIComponent(action.automationId)}`);
    if (!response.ok) return ManagerEngine.refusalOf(response);
    const { automation } = (await response.json()) as { automation?: AutomationDefinition };
    if (!automation) return { error: 'automation not found', status: 404 };
    if (automation.enabled) return { error: 'that automation is already enabled', status: 409 };
    const { id: _id, revision: _revision, enabled: _enabled, createdAt: _createdAt, updatedAt: _updatedAt, ...definition } = automation;
    return { ...action, name: automation.name.slice(0, 1000), revision: automation.revision, summary: clipSummary(JSON.stringify(definition)) };
  }

  async propose(id: string, input: ManagerProposeActionInput): Promise<{ actionId: string; status: ManagerActionStatus; replaced?: string[]; alsoWaitingIn?: string[] } | ManagerRefusal> {
    const scope = await this.toolScope(id, actionProject(input.action), true);
    if ('error' in scope) return scope;
    const refused = accessRefusal(scope.manager, input.action);
    if (refused) return { error: refused, status: 403 };
    if (input.action.type === 'connector-call') {
      if (managerConnectorToolMode(scope.manager.connectors?.[input.action.connector], input.action.tool) === 'allow') {
        return { error: `${connectorToolName(input.action.connector, input.action.tool)} is granted without asking: call it directly instead of proposing it`, status: 400 };
      }
      if ((await this.runnerOf(scope.manager)) !== 'claude') return { error: CONNECTORS_CLAUDE_ONLY, status: 409 };
    }
    const action = await this.stampAction(id, input.action);
    if ('error' in action) return action;
    // From here to `publish` nothing awaits, so two racing proposals see each other's card.
    const same = (other: ManagerActionRequest) => actionKey(other) === actionKey(action) && sameMethod(other, action);
    const pending = this.deps.store.messages(id).find((message) => message.kind === 'action' && message.status === 'pending' && same(message.action));
    if (pending) return { actionId: pending.id, status: 'pending' };
    // One waiting card per PR or automation: a new head, method or revision replaces the older card.
    const replaced: string[] = [];
    for (const older of this.deps.store.messages(id)) {
      if (older.kind !== 'action' || older.status !== 'pending' || cardSubject(older.action) === undefined || cardSubject(older.action) !== cardSubject(action)) continue;
      this.settleAction(id, older, 'dismissed', replacedBy(action));
      replaced.push(older.id);
    }
    const alsoWaitingIn = this.alsoWaitingIn(id, action);
    const message: ManagerMessage = {
      id: randomUUID(),
      seq: this.deps.store.nextSeq(id),
      at: this.iso(),
      kind: 'action',
      sourceTasks: this.actionSources(action, input.reason ?? '', scope.source?.runs() ?? []),
      action,
      ...(input.reason ? { reason: input.reason } : {}),
      status: 'pending',
    };
    this.publish(id, message, true);
    if (action.type === 'merge-pr') this.managerActed(id, { prs: [{ projectId: action.projectId, number: action.number }] }, `you proposed merging #${action.number} since`);
    this.deps.telemetry?.track('manager_action_proposed', managerActionLabel(action));
    this.emitChange(id);
    // An approval always waits on the user, so it never needs the agent's judgement.
    this.alert(id, message, `Needs your approval: ${describeAction(action)}`, 'approval');
    return { actionId: message.id, status: 'pending', ...(replaced.length ? { replaced } : {}), ...(alsoWaitingIn.length ? { alsoWaitingIn } : {}) };
  }

  /**
   * A card's Source task, never the turn's context (a task read or followed earlier names an
   * unrelated card): a merge card takes the task that opened or declared its PR, plus any task the
   * reason names that carries the same PR; other cards only what their reason names.
   */
  private actionSources(action: ManagerActionRequest, reason: string, runs: RunRecord[]): ManagerTaskSource[] {
    const named = taskSources(reason);
    if (action.type !== 'merge-pr') return named;
    const tied = runs
      .map((run) => ({ run, tie: prTie(run, action.number) }))
      .filter((entry): entry is { run: RunRecord; tie: 0 | 1 | 2 } => entry.tie !== undefined);
    const owner = tied
      .filter((entry) => entry.tie < 2)
      .sort((a, b) => a.tie - b.tie || Number(Boolean(a.run.archived)) - Number(Boolean(b.run.archived)) || (a.run.createdAt < b.run.createdAt ? 1 : a.run.createdAt > b.run.createdAt ? -1 : 0))[0]?.run;
    const sources = owner ? [{ projectId: action.projectId, runId: owner.id }] : [];
    for (const source of named) {
      if (source.projectId !== action.projectId || sources.some((entry) => entry.runId === source.runId)) continue;
      if (tied.some((entry) => entry.run.id === source.runId)) sources.push(source);
    }
    return sources;
  }

  /** Other managers' chats with a card waiting on the same PR or automation: allowed, but said. */
  private alsoWaitingIn(id: string, action: ManagerActionRequest): string[] {
    const subject = cardSubject(action);
    if (subject === undefined) return [];
    return this.deps.store.list()
      .filter((manager) => manager.id !== id && this.deps.store.messages(manager.id).some((message) => message.kind === 'action' && message.status === 'pending' && cardSubject(message.action) === subject))
      .map((manager) => manager.name);
  }

  /** Cards stored before one-per-PR (or written by two cockpits at once): the newest stays waiting. */
  private collapseDuplicateCards(id: string): void {
    const newest = new Map<string, Extract<ManagerMessage, { kind: 'action' }>>();
    const cards = this.deps.store.messages(id).filter((message): message is Extract<ManagerMessage, { kind: 'action' }> => message.kind === 'action' && message.status === 'pending');
    for (const card of cards) {
      const subject = cardSubject(card.action);
      if (subject === undefined) continue;
      const kept = newest.get(subject);
      if (!kept || card.seq > kept.seq) newest.set(subject, card);
    }
    for (const card of cards) {
      const subject = cardSubject(card.action);
      const kept = subject === undefined ? undefined : newest.get(subject);
      if (kept && kept.id !== card.id) this.settleAction(id, card, 'dismissed', replacedBy(kept.action));
    }
  }

  /** The only path to a merge or an enabled automation; the agent's tools cannot reach it. */
  async decide(
    id: string,
    actionId: string,
    decision: 'approve' | 'reject' | 'dismiss',
    ctx: ManagerTelemetryContext = {},
    onlyIfStale = false,
  ): Promise<{ ok: true } | ManagerRefusal> {
    const manager = this.deps.store.get(id);
    if (!manager) return { error: 'manager not found', status: 404 };
    let message = this.deps.store.message(id, actionId);
    if (message?.kind !== 'action') return { error: 'action not found', status: 404 };
    if (message.status !== 'pending') return { error: `this action is already ${message.status}`, status: 409 };
    if (decision === 'dismiss') {
      const stale = message.action.type === 'merge-pr'
        ? await this.closedPr(message.action)
        : message.action.type === 'enable-automation' ? await this.outdatedEnable(message.action) : undefined;
      if (onlyIfStale && !stale) return { error: 'this proposal is still current', status: 409 };
      // Re-read after the forge call: another tab may have decided meanwhile.
      const current = this.deps.store.message(id, actionId);
      // That read itself may have closed the card (`pullRequestClosed`): the dismissal asked for is done.
      if (stale && current?.kind === 'action' && current.status === 'dismissed') return { ok: true as const };
      if (current?.kind !== 'action' || current.status !== 'pending') return { error: 'this action was already decided', status: 409 };
      message = current;
      if (!onlyIfStale) this.deps.telemetry?.track('manager_action_decided', `${managerActionLabel(message.action)}:dismiss`, ctx);
      this.settleAction(id, message, 'dismissed', stale ?? 'Dismissed');
      return { ok: true as const };
    }
    // A connector call is a model session: it waits on the card until the manager is reactivated.
    if (decision === 'approve' && message.action.type === 'connector-call' && manager.inactive) return { error: MANAGER_INACTIVE, status: 409 };
    const type = managerActionLabel(message.action);
    this.deps.telemetry?.track('manager_action_decided', `${type}:${decision}`, ctx);
    const proposedAt = Date.parse(message.at);
    if (Number.isFinite(proposedAt)) this.deps.telemetry?.timing('manager_action_decision', Math.max(0, this.now() - proposedAt), { operation: type, target: decision, outcome: 'ok' });
    const settle = (status: ManagerActionStatus, result: string) => this.settleAction(id, message, status, result);
    if (decision === 'reject') {
      settle('rejected', 'Rejected');
      return { ok: true as const };
    }
    this.publish(id, { ...message, status: 'running' }, true);
    const projectId = actionProject(message.action);
    let outcome: { ok: boolean; result: string; dismissed?: boolean };
    try {
      const connected = projectId === undefined || (await this.sources(manager)).some((source) => source.id === projectId);
      // Read fresh: access may have been lowered while the card waited.
      const refused = accessRefusal(this.deps.store.get(id) ?? manager, message.action);
      outcome = !connected
        ? { ok: false, result: `This manager is no longer connected to ${projectId}.` }
        : refused
          ? { ok: false, result: refused }
          : await this.perform(id, message.action);
    } catch (cause) {
      // `running` has no other exit but a restart.
      outcome = { ok: false, result: cause instanceof Error ? cause.message : String(cause) };
    }
    settle(outcome.dismissed ? 'dismissed' : outcome.ok ? 'done' : 'failed', outcome.result);
    return { ok: true as const };
  }

  private settleAction(id: string, message: Extract<ManagerMessage, { kind: 'action' }>, status: ManagerActionStatus, result: string): void {
    // Deleted while the action ran: writing the result would recreate its directory.
    if (!this.deps.store.get(id)) return;
    this.publish(id, { ...message, status, result }, true);
    this.addNote(id, `${describeAction(message.action)}: ${result}`);
    this.emitChange(id);
  }

  /** Why a merge card is moot ("#12 was already merged"), or `undefined` while its PR is open or unknown. */
  private async closedPr(action: Extract<ManagerActionRequest, { type: 'merge-pr' }>): Promise<string | undefined> {
    const state = await this.prStateOf(action.projectId, action.number);
    return state ? `#${action.number} was already ${state}` : undefined;
  }

  /** `merged`/`closed` as the forge says now, or `undefined` while open or unknown. */
  private async prStateOf(projectId: string, number: number): Promise<'merged' | 'closed' | undefined> {
    try {
      const response = await this.forward(`/p/${encodeURIComponent(projectId)}/github/prs/${number}/merge-state?refresh=1`);
      if (!response.ok) return undefined;
      const body = (await response.json()) as { available?: boolean; mergeState?: { state?: string } };
      const state = body.available ? body.mergeState?.state : undefined;
      return state === 'merged' || state === 'closed' ? state : undefined;
    } catch {
      return undefined;
    }
  }

  /** Watch checks close merge cards whose PR left the open list, confirmed one by one: the list is capped. */
  private async dismissStaleMerges(id: string, snapshot: ManagerSnapshot): Promise<void> {
    const open = new Map(snapshot.projects.filter((project) => project.available && !project.prsUnavailable).map((project) => [project.projectId, new Set(project.prs.map((pr) => pr.number))]));
    const suspects = this.deps.store.messages(id).filter((message): message is Extract<ManagerMessage, { kind: 'action' }> =>
      message.kind === 'action' && message.status === 'pending' && message.action.type === 'merge-pr' &&
      open.get(message.action.projectId)?.has(message.action.number) === false);
    for (const message of suspects) {
      if (message.action.type !== 'merge-pr') continue;
      const stale = await this.closedPr(message.action);
      const current = this.deps.store.message(id, message.id);
      if (stale && current?.kind === 'action' && current.status === 'pending') this.settleAction(id, current, 'dismissed', stale);
    }
  }

  /**
   * cezar just read from GitHub that a PR left the open state (a chip's status, a merge-state read,
   * a poll): close every pending merge card for it, without asking GitHub again. Only a pending
   * card settles, so a second signal for the same PR changes nothing and tells the manager nothing.
   * `verify`: an automation poll reads `origin`, which in a fork clone is not the repo the card's
   * number belongs to, so its signal only triggers the card's own stale check.
   */
  async pullRequestClosed(root: string, number: number, state: 'merged' | 'closed', verify = false): Promise<void> {
    await this.expireAsksForPr(root, number, state, verify);
    const pending = this.deps.store.list().flatMap((manager) => this.deps.store.messages(manager.id)
      .filter((message) => message.kind === 'action' && message.status === 'pending' && message.action.type === 'merge-pr' && message.action.number === number)
      .map((message) => ({ id: manager.id, message })));
    if (pending.length === 0) return;
    const target = resolve(root);
    const projects = new Set((await this.deps.projects()).filter((project) => resolve(project.root) === target).map((project) => project.id));
    for (const { id, message } of pending) {
      if (message.kind !== 'action' || message.action.type !== 'merge-pr' || !projects.has(message.action.projectId)) continue;
      const current = this.deps.store.message(id, message.id);
      if (current?.kind !== 'action' || current.status !== 'pending') continue;
      if (verify) await this.decide(id, current.id, 'dismiss', {}, true);
      else this.settleAction(id, current, 'dismissed', `#${number} was already ${state}`);
    }
  }

  /** Why an enable card is moot (edited, deleted, already on), or `undefined` while current or unknown. */
  private async outdatedEnable(action: Extract<ManagerActionRequest, { type: 'enable-automation' }>): Promise<string | undefined> {
    try {
      const response = await this.forward(`/p/${encodeURIComponent(action.projectId)}/automations/${encodeURIComponent(action.automationId)}`);
      if (response.status === 404) return 'Automation was deleted since the proposal';
      if (!response.ok) return undefined;
      const { automation } = (await response.json()) as { automation?: { revision?: number; enabled?: boolean } };
      if (!automation) return undefined;
      if (automation.enabled) return 'Automation is already enabled';
      return automation.revision !== action.revision ? `Automation changed since the proposal (rev ${action.revision} -> ${automation.revision})` : undefined;
    } catch {
      return undefined;
    }
  }

  /** Watch checks close enable cards whose automation was edited, deleted or enabled meanwhile. */
  private async dismissStaleEnables(id: string, snapshot: ManagerSnapshot): Promise<void> {
    const available = new Set(snapshot.projects.filter((project) => project.available).map((project) => project.projectId));
    const suspects = this.deps.store.messages(id).filter((message): message is Extract<ManagerMessage, { kind: 'action' }> =>
      message.kind === 'action' && message.status === 'pending' && message.action.type === 'enable-automation' && available.has(message.action.projectId));
    for (const message of suspects) {
      if (message.action.type !== 'enable-automation') continue;
      const stale = await this.outdatedEnable(message.action);
      const current = this.deps.store.message(id, message.id);
      if (stale && current?.kind === 'action' && current.status === 'pending') this.settleAction(id, current, 'dismissed', stale);
    }
  }

  private async perform(id: string, action: ManagerActionRequest): Promise<{ ok: boolean; result: string; dismissed?: boolean }> {
    if (action.type === 'connector-call') return this.callConnector(id, action);
    if (action.type === 'add-job') {
      // Counted from now: an approved job must not fire seconds after the click.
      const added = this.addJob(id, { name: action.name, prompt: action.prompt, everyMinutes: action.everyMinutes, enabled: true, lastRunAt: this.iso() });
      return 'error' in added ? { ok: false, result: added.error } : { ok: true, result: `Added job ${action.name}` };
    }
    const prefix = `/p/${encodeURIComponent(action.projectId)}`;
    if (action.type === 'enable-automation') {
      const current = await this.forward(`${prefix}/automations/${encodeURIComponent(action.automationId)}`);
      if (!current.ok) return { ok: false, result: (await ManagerEngine.refusalOf(current)).error };
      const { automation } = (await current.json()) as { automation?: { revision?: number } };
      if (automation?.revision !== action.revision) return { ok: false, result: 'This automation changed after the proposal. Ask for a new one.' };
      const response = await this.forward(`${prefix}/automations/${encodeURIComponent(action.automationId)}/enable`, { method: 'POST' });
      if (response.ok) return { ok: true, result: `Enabled ${action.name ?? action.automationId}` };
      return { ok: false, result: (await ManagerEngine.refusalOf(response)).error };
    }
    const state = await this.forward(`${prefix}/github/prs/${action.number}/merge-state?refresh=1`);
    const body = (await state.json().catch(() => ({}))) as { available?: boolean; reason?: string; mergeState?: { state?: string; headSha: string; defaultMethod: 'merge' | 'squash' | 'rebase' | null; methods: Array<'merge' | 'squash' | 'rebase'> } };
    if (!body.available || !body.mergeState) return { ok: false, result: body.reason ?? 'GitHub merge is unavailable' };
    const prState = body.mergeState.state;
    if (prState === 'merged' || prState === 'closed') return { ok: false, dismissed: true, result: `#${action.number} was already ${prState}` };
    const method = action.method ?? body.mergeState.defaultMethod ?? body.mergeState.methods[0];
    if (!method) return { ok: false, result: 'This repository allows no merge method.' };
    // The head the user was shown: a push after the proposal refuses instead of merging unseen code.
    const merged = await this.forward(`${prefix}/github/prs/${action.number}/merge`, {
      method: 'POST',
      body: { method, expectedHeadSha: action.headSha ?? body.mergeState.headSha },
    });
    if (merged.ok) return { ok: true, result: `Merged #${action.number}` };
    return { ok: false, result: (await ManagerEngine.refusalOf(merged)).error };
  }

  /** Reached only from an approved `add-job`; the cockpit edits jobs through `update`. */
  private addJob(id: string, input: Omit<ManagerJob, 'id'>): ManagerJob | ManagerRefusal {
    const manager = this.deps.store.get(id);
    if (!manager) return { error: 'manager not found', status: 404 };
    if (manager.jobs.length >= 32) return { error: 'a manager holds at most 32 jobs', status: 409 };
    const job: ManagerJob = { ...input, id: randomUUID() };
    this.deps.store.update(id, (manager) => ({ ...manager, jobs: [...manager.jobs.filter((other) => other.id !== job.id), job], updatedAt: this.iso() }));
    this.reschedule();
    this.emitChange(id);
    return job;
  }

  async removeJob(id: string, jobId: string): Promise<{ ok: true } | ManagerRefusal> {
    const scope = await this.toolScope(id, undefined, true);
    if ('error' in scope) return scope;
    if (!scope.manager.jobs.some((job) => job.id === jobId)) return { error: 'job not found', status: 404 };
    this.deps.store.update(id, (manager) => ({ ...manager, jobs: manager.jobs.filter((job) => job.id !== jobId), updatedAt: this.iso() }));
    this.reschedule();
    this.emitChange(id);
    return { ok: true as const };
  }
}

const firstFreeAvatar = (managers: readonly Manager[]): number => {
  const taken = new Set(managers.map((manager) => manager.avatar));
  const free = Array.from({ length: 64 }, (_, index) => index).find((index) => !taken.has(index));
  return free ?? managers.length % 64;
};

const SUMMARY_LIMIT = 8_000;

/** Long on purpose: the end of a definition is its prompt, and a card must not hide that. */
const clipSummary = (text: string): string =>
  text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}… (cut, open the automation to read it all)` : text;

const pendingAction = (message: ManagerMessage): boolean => message.kind === 'action' && message.status === 'pending';

const LIVE_STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'waiting']);

/** Every task a run dispatched, recursively (`dispatch.parentRunId`). */
function descendantsOf(runs: RunRecord[], rootId: string): RunRecord[] {
  const found: RunRecord[] = [];
  const seen = new Set([rootId]);
  for (let frontier = [rootId]; frontier.length > 0;) {
    const children = runs.filter((run) => run.dispatch?.parentRunId !== undefined && frontier.includes(run.dispatch.parentRunId) && !seen.has(run.id));
    for (const child of children) seen.add(child.id);
    found.push(...children);
    frontier = children.map((child) => child.id);
  }
  return found;
}

/** The question alone: the rest of a watch or job reply stays out of the session that can act. */
const askNote = (message: Extract<ManagerMessage, { kind: 'assistant' }>): string =>
  `Your ${message.turn} turn asked the user, who answers in their next message: ${(message.ask?.questions ?? []).map((question) => `${question.header}: ${question.question}`).join(' / ')}`.slice(0, 2_000);

const actionProject = (action: ManagerActionRequest): string | undefined =>
  action.type === 'add-job' || action.type === 'connector-call' ? undefined : action.projectId;

/** Also read at the decision: a grant revoked while the card waited fails it. */
const accessRefusal = (manager: Manager, action: ManagerActionRequest): string | undefined => {
  if (action.type === 'connector-call') {
    return managerConnectorToolMode(manager.connectors?.[action.connector], action.tool) === 'deny'
      ? `${action.tool} on ${action.connectorName ?? action.connector} is not granted to this manager: the user can grant it in its settings under Connectors.`
      : undefined;
  }
  const projectId = actionProject(action);
  return projectId !== undefined && managerAccessOf(manager, projectId) === 'read'
    ? `${projectId} is read-only for this manager: it cannot merge or enable anything there.`
    : undefined;
};

const actionKey = (action: ManagerActionRequest): string => {
  // The stamped facts count: a stale card must not stand in for what changed since.
  if (action.type === 'merge-pr') return `merge:${action.projectId}:${action.number}:${action.headSha}`;
  if (action.type === 'enable-automation') return `enable:${action.projectId}:${action.automationId}:${action.revision}`;
  if (action.type === 'connector-call') return `connector:${action.connector}:${action.tool}:${canonicalJson(action.args)}`;
  return `job:${action.name}:${action.everyMinutes}:${action.prompt}`;
};

/** What one waiting card may exist for: a PR or an automation. Other kinds may repeat. */
const cardSubject = (action: ManagerActionRequest): string | undefined => {
  if (action.type === 'merge-pr') return `merge:${action.projectId}:${action.number}`;
  if (action.type === 'enable-automation') return `enable:${action.projectId}:${action.automationId}`;
  return undefined;
};

const sameMethod = (a: ManagerActionRequest, b: ManagerActionRequest): boolean =>
  a.type !== 'merge-pr' || b.type !== 'merge-pr' || a.method === b.method;

/** The closed card's line, in the dismissed wording of #2241/#2292. */
const replacedBy = (action: ManagerActionRequest): string => {
  if (action.type === 'merge-pr') return `Replaced by a newer proposal${action.headSha ? ` for head ${action.headSha.slice(0, 12)}` : ''}${action.method ? ` (${action.method})` : ''}`;
  if (action.type === 'enable-automation') return `Replaced by a newer proposal (revision ${action.revision})`;
  return 'Replaced by a newer proposal';
};

export const describeAction = (action: ManagerActionRequest): string => {
  if (action.type === 'merge-pr') return `Merge of ${action.projectId}#${action.number}`;
  if (action.type === 'enable-automation') return `Enabling automation ${action.name ?? action.automationId}`;
  if (action.type === 'connector-call') return `Calling ${action.tool} on ${action.connectorName ?? action.connector}`;
  return `Adding job ${action.name}`;
};

const RESULT_LIMIT = 4_000;

const clipResult = (text: string): string =>
  text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT)}… (cut)` : text.trim();

/** True when `test` holds for any item, asked one at a time. */
async function someAsync<T>(items: T[], test: (item: T) => Promise<boolean>): Promise<boolean> {
  for (const item of items) if (await test(item)) return true;
  return false;
}
