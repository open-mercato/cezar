import { execFile } from 'node:child_process';

import { questionCardPartlyReasked, questionCardReplaces, questionCardSharedHeaders, TASK_ASKS_MAX, type QuestionClosed, type TaskAskRecord } from '@open-mercato/cezar-contract';

import type { AskCloseMarker } from '../core/ask.ts';

/**
 * A task's own questions (`RunRecord.asks`) and the rules that close or flag them, as pure
 * functions (Questions inbox spec `.ai/specs/2026-11-17-questions-inbox.md` § Close rules). The
 * store applies them; the run manager and the inbox provider decide when.
 */

/** Statuses that end a run's open questions. `failed` is not one: Continue can still answer (#2286). */
export const ASK_ENDING_STATUSES: ReadonlySet<string> = new Set(['done', 'review', 'cancelled']);

export function isOpenAsk(ask: TaskAskRecord): boolean {
  return ask.closed === undefined;
}

/** The one refusal text for acting on a question that already closed (inbox, card, stale tab). */
export const QUESTION_ALREADY_CLOSED = 'question already closed';

/** The card `askRequestId` answers exists and already closed: a stale tab's reply. */
export function askAlreadyClosed(run: { asks?: readonly TaskAskRecord[] }, askRequestId: string | undefined): boolean {
  return askRequestId !== undefined && (run.asks ?? []).some((ask) => ask.requestId === askRequestId && ask.closed !== undefined);
}

export function openTaskAsks(asks: readonly TaskAskRecord[] | undefined): TaskAskRecord[] {
  return (asks ?? []).filter(isOpenAsk);
}

const headerKey = (header: string): string => header.trim().toLowerCase();

const cardOf = (ask: TaskAskRecord) => ({ id: ask.cardId, questions: ask.questions });

/** The open asks a new card replaces: the same card id, or one card re-asking every header (`questionCardReplaces`). */
export function asksReplacedBy(asks: readonly TaskAskRecord[] | undefined, next: TaskAskRecord): TaskAskRecord[] {
  return openTaskAsks(asks).filter((ask) => ask.requestId !== next.requestId && questionCardReplaces(cardOf(next), cardOf(ask)));
}

/** The open asks a new card re-asks only in part: they stay open, flagged `partly-reasked`. */
export function asksPartlyReasked(asks: readonly TaskAskRecord[] | undefined, next: TaskAskRecord): Array<{ ask: TaskAskRecord; headers: string[] }> {
  return openTaskAsks(asks)
    .filter((ask) => ask.requestId !== next.requestId && questionCardPartlyReasked(cardOf(next), cardOf(ask)))
    .map((ask) => ({ ask, headers: questionCardSharedHeaders(cardOf(next), cardOf(ask)) }));
}

/** The open asks a `CEZ:ASK-CLOSE <id>` names: by card id, else (no id) by a header or the request id. */
export function asksNamedBy(asks: readonly TaskAskRecord[] | undefined, marker: AskCloseMarker): TaskAskRecord[] {
  const wanted = headerKey(marker.id);
  // A marker id has no spaces, so a multi-word header also matches with its spaces dropped.
  const squash = (header: string) => headerKey(header).replace(/\s+/g, '');
  return openTaskAsks(asks).filter((ask) =>
    ask.cardId
      ? ask.cardId === marker.id
      : ask.requestId === marker.id || ask.questions.some((question) => headerKey(question.header) === wanted || squash(question.header) === wanted),
  );
}

/**
 * Bound the record to `TASK_ASKS_MAX`, evicting the oldest closed asks first. An open ask that must
 * still go comes back in `evicted`, closed with `closed`, so the caller can announce it.
 */
export function capTaskAsks(asks: TaskAskRecord[], closed: QuestionClosed): { kept: TaskAskRecord[]; evicted: TaskAskRecord[] } {
  let excess = asks.length - TASK_ASKS_MAX;
  if (excess <= 0) return { kept: asks, evicted: [] };
  const drop = new Set<TaskAskRecord>();
  for (const ask of asks) {
    if (excess === 0) break;
    if (!isOpenAsk(ask)) {
      drop.add(ask);
      excess--;
    }
  }
  const evicted: TaskAskRecord[] = [];
  for (const ask of asks) {
    if (excess === 0) break;
    if (isOpenAsk(ask)) {
      drop.add(ask);
      evicted.push({ ...ask, stale: undefined, closed });
      excess--;
    }
  }
  return { kept: asks.filter((ask) => !drop.has(ask)), evicted };
}

/** The asks that declare `about` the given task (`<projectId>/<runId>`). */
export function isAboutTask(ask: TaskAskRecord, task: string): boolean {
  return (ask.about ?? []).some((ref) => 'task' in ref && ref.task === task);
}

export function isAboutPr(ask: TaskAskRecord, pr: number): boolean {
  return (ask.about ?? []).some((ref) => 'pr' in ref && ref.pr === pr);
}

/** One line naming an ask in prompts and notes: its card id, else its headers. */
export function askLabel(ask: TaskAskRecord): string {
  return ask.cardId ?? ask.questions.map((question) => question.header).join(', ');
}

/** The text a dismiss delivers to the agent (spec § Telling the agent on dismiss). */
export function askSkippedMessage(ask: TaskAskRecord): string {
  const subject = ask.questions.map((question) => question.header).join(', ') || askLabel(ask);
  return `The user skipped your question «${subject}». Don't wait for an answer; decide yourself, or ask again later only if it still blocks you.`;
}

const ago = (from: string, now: number): string => {
  const minutes = Math.max(0, Math.round((now - Date.parse(from)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};

/**
 * The block each task turn carries while the run has open questions (spec § Relevance, "Agent
 * confirms"): the agent closes what no longer needs the user. Undefined when nothing is open.
 */
export function openAsksBlock(asks: readonly TaskAskRecord[] | undefined, exclude?: string, now = Date.now()): string | undefined {
  const open = openTaskAsks(asks).filter((ask) => ask.requestId !== exclude);
  if (open.length === 0) return undefined;
  const lines = open.map((ask) => {
    const name = ask.cardId ? `id ${ask.cardId}` : `header ${ask.questions.map((question) => question.header).join(', ')}`;
    const stale = ask.stale ? ` — may be out of date: ${ask.stale.detail}` : '';
    return `- ${name} (asked ${ago(ask.askedAt, now)} ago)${stale}`;
  });
  return [
    'Your open questions to the user (cezar):',
    ...lines,
    'Close any that no longer need the user with `CEZ:ASK-CLOSE <id> <reason>` on its own line (the header when a card has no id), or ask again with the same card "id".',
  ].join('\n');
}

const GIT_TIMEOUT_MS = 5_000;

/**
 * Did the worktree gain commits since `iso`, autosaves aside? The cheap turn-end check behind the
 * `new-commits` flag: one `git log`, no polling. Any failure answers false.
 */
export function hasCommitsSince(cwd: string, iso: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('git', ['log', `--since=${iso}`, '--format=%s', '-n', '20', 'HEAD'], { cwd, timeout: GIT_TIMEOUT_MS }, (error, stdout) => {
      if (error) return resolve(false);
      resolve(stdout.split('\n').some((subject) => subject.trim() !== '' && !subject.startsWith('cezar autosave')));
    });
  });
}
