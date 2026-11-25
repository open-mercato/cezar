import {
  parseQuestionKey,
  questionCardReplaces,
  questionKey,
  QUESTIONS_CLOSED_WINDOW_DAYS,
  type ManagerAsk,
  type ManagerMessage,
  type ManagerTaskSource,
  type QuestionClosed,
  type QuestionItem,
} from '@open-mercato/cezar-contract';
import type { QuestionProvider, QuestionResult } from '../questions/types.ts';
import type { ManagerEngine } from './engine.ts';

/**
 * A manager's decision cards in the Questions inbox (spec `.ai/specs/2026-11-17-questions-inbox.md`):
 * the pure rules (open, Older, replaced, withdrawn, what a card names) and the inbox provider. The
 * engine owns every write.
 */

export type AssistantMessage = Extract<ManagerMessage, { kind: 'assistant' }>;
export type AskMessage = AssistantMessage & { ask: ManagerAsk };

const DAY_MS = 24 * 60 * 60_000;
const msOf = (iso: string): number => Date.parse(iso) || 0;

/** Still waiting on the user: neither answered on its card nor closed for another reason. */
export const openAsk = (message: ManagerMessage): message is AskMessage =>
  message.kind === 'assistant' && message.ask !== undefined && message.askAnswer === undefined && message.askClosed === undefined;

/** Open longer than the Older threshold (`0` = off): still answerable, no longer counted. */
export const isOlder = (askedAt: string, now: number, days: number): boolean => days > 0 && now - msOf(askedAt) > days * DAY_MS;

const headerKey = (header: string): string => header.trim().toLowerCase().replace(/\s+/g, '-');

/** How the agent names a card in `CEZ:ASK-CLOSE`: its id, else its first header. */
export const cardHandle = (ask: ManagerAsk): string => ask.id ?? headerKey(ask.questions[0]?.header ?? '');

export const cardHeaders = (ask: ManagerAsk): string => ask.questions.map((question) => question.header).join(' / ');

/** Close rule "replaced": same id, or one newer card re-asking every header (`questionCardReplaces`). */
export const replaces = (newer: ManagerAsk, older: ManagerAsk): boolean => questionCardReplaces(newer, older);

/** `CEZ:ASK-CLOSE <id>`: by id, or by a header when the card has none. */
export function closeMarkerMatches(ask: ManagerAsk, marker: string): boolean {
  if (ask.id !== undefined) return ask.id === marker;
  const wanted = headerKey(marker);
  return ask.questions.some((question) => headerKey(question.header) === wanted);
}

/** Explicit task references only: never guess a task from a title or an unrelated prior card. */
export function taskSources(text: string): ManagerTaskSource[] {
  const sources = new Map<string, ManagerTaskSource>();
  for (const match of text.matchAll(/\[\[task:([^\]/\s]+)\/([^\]\s]+)\]\]/g)) {
    sources.set(match[0], { projectId: match[1]!, runId: match[2]! });
  }
  return [...sources.values()];
}

export interface PrRef {
  projectId?: string;
  number: number;
}

export function prRefs(text: string): PrRef[] {
  return [...text.matchAll(/\[\[pr:([^\]/\s]+)\/(\d+)\]\]/g)].map((match) => ({ projectId: match[1]!, number: Number(match[2]) }));
}

/** What a card declares (`about`) and what it only mentions (`[[task:…]]`, `[[pr:…]]`, its source tasks). */
export interface NamedWork {
  aboutTasks: Set<string>;
  aboutPrs: Set<number>;
  mentionedTasks: Set<string>;
  mentionedPrs: PrRef[];
}

export function namedWork(message: AskMessage): NamedWork {
  const aboutTasks = new Set<string>();
  const aboutPrs = new Set<number>();
  // An `{issue}` is accepted but never expires a card: cezar observes no issue state for managers.
  for (const ref of message.ask.about ?? []) {
    if ('task' in ref) aboutTasks.add(ref.task);
    else if ('pr' in ref) aboutPrs.add(ref.pr);
  }
  const mentionedTasks = new Set(
    [...taskSources(message.text), ...(message.sourceTasks ?? [])]
      .map((source) => `${source.projectId}/${source.runId}`)
      .filter((key) => !aboutTasks.has(key)),
  );
  const mentionedPrs = prRefs(message.text).filter((ref) => !aboutPrs.has(ref.number));
  return { aboutTasks, aboutPrs, mentionedTasks, mentionedPrs };
}

/** The projects a card's `{pr: number}` can be in: its own `[[pr:<project>/number]]`, else the tasks it names. */
export function aboutPrProjects(message: AskMessage, number: number): Set<string> {
  const mentioned = prRefs(message.text).filter((ref) => ref.number === number).map((ref) => ref.projectId!);
  if (mentioned.length > 0) return new Set(mentioned);
  const tasks = (message.ask.about ?? []).flatMap((ref) => ('task' in ref ? [ref.task.split('/')[0]!] : []));
  return new Set([...tasks, ...[...taskSources(message.text), ...(message.sourceTasks ?? [])].map((source) => source.projectId)]);
}

/** A task or PR the card names, declared or mentioned. */
export function namesWork(message: AskMessage, work: { tasks?: string[]; prs?: PrRef[] }): boolean {
  const named = namedWork(message);
  if (work.tasks?.some((task) => named.aboutTasks.has(task) || named.mentionedTasks.has(task))) return true;
  return work.prs?.some((pr) => named.aboutPrs.has(pr.number)
    || named.mentionedPrs.some((ref) => ref.number === pr.number && (ref.projectId === undefined || pr.projectId === undefined || ref.projectId === pr.projectId))) === true;
}

/** "4m", "3h", "2d". */
export function ageLabel(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

const OPEN_CARDS_LISTED = 20;

/** Every manager turn re-checks its own open cards (spec § Relevance, "Agent confirms"). */
export function openCardsBlock(cards: AskMessage[], now: number): string {
  if (cards.length === 0) return '';
  const lines = cards.slice(-OPEN_CARDS_LISTED).map((card) => {
    const stale = card.askStale ? `; may be out of date: ${card.askStale.detail}` : '';
    return `- ${cardHandle(card.ask)} (${cardHeaders(card.ask)}), asked ${ageLabel(now - msOf(card.at))} ago${stale}`;
  });
  const more = cards.length > OPEN_CARDS_LISTED ? `\n- …and ${cards.length - OPEN_CARDS_LISTED} older` : '';
  return `Your questions still waiting on the user:\n${lines.join('\n')}${more}\nClose any that no longer need the user with a line \`CEZ:ASK-CLOSE <id> <reason>\`, or ask again with the same id.\n\n`;
}

/** What a session already heard about its open cards: their ids and staleness, never their age. */
export function openCardsDigest(cards: AskMessage[]): string {
  return cards.slice(-OPEN_CARDS_LISTED).map((card) => `${cardHandle(card.ask)}${card.askStale ? '!' : ''}`).join(',');
}

/** The same cards a resumed session was already shown: their ids only (spec 2026-11-21 § 2.4). */
export function openCardsUnchanged(cards: AskMessage[]): string {
  if (cards.length === 0) return '';
  return `Your questions still waiting on the user, unchanged since your last turn: ${cards.slice(-OPEN_CARDS_LISTED).map((card) => cardHandle(card.ask)).join(', ')}.\n\n`;
}

/** One card as the engine hands it over; `answeredAt` only for a card answered on itself. */
export interface ManagerAskCard {
  managerId: string;
  managerName: string;
  message: AskMessage;
  answeredAt?: string;
}

export type ManagerAskResult = { ok: true; card: ManagerAskCard } | { ok: false; status: 404 | 409; error: string };

export interface ManagerAskChange {
  card: ManagerAskCard;
  closed: boolean;
}

const ANSWER_LIMIT = 4_000;

export function questionItemOf(card: ManagerAskCard): QuestionItem {
  const { message } = card;
  const sources = new Map<string, ManagerTaskSource>();
  for (const source of [...(message.sourceTasks ?? []), ...taskSources(message.text)]) sources.set(`${source.projectId}/${source.runId}`, source);
  const closed: QuestionClosed | undefined = message.askClosed
    ?? (message.askAnswer !== undefined ? { reason: 'answered', at: card.answeredAt ?? message.at, answer: message.askAnswer.slice(0, ANSWER_LIMIT) } : undefined);
  return {
    key: questionKey({ kind: 'manager', managerId: card.managerId, messageId: message.id }),
    source: { kind: 'manager', managerId: card.managerId, name: card.managerName },
    ...(message.ask.id ? { cardId: message.ask.id } : {}),
    askedAt: message.at,
    questions: message.ask.questions,
    ...(message.ask.about ? { about: message.ask.about } : {}),
    ...(sources.size > 0 ? { sourceTasks: [...sources.values()].map(({ projectId, runId }) => ({ projectId, runId })) } : {}),
    ...(message.askStale && !closed ? { stale: message.askStale } : {}),
    older: false,
    ...(closed ? { closed } : {}),
  };
}

const result = (outcome: ManagerAskResult): QuestionResult =>
  outcome.ok ? { ok: true, item: questionItemOf(outcome.card) } : outcome;

const notFound: QuestionResult = { ok: false, status: 404, error: 'question not found' };

/** The manager engine's questions for the inbox: open cards plus those closed in the last 7 days. */
export function createManagerQuestionProvider(engine: ManagerEngine): QuestionProvider {
  const target = (key: string) => {
    const parsed = parseQuestionKey(key);
    return parsed?.kind === 'manager' ? parsed : undefined;
  };
  return {
    list: async () => {
      const cutoff = engine.clock() - QUESTIONS_CLOSED_WINDOW_DAYS * DAY_MS;
      return engine.askCards(cutoff)
        .map(questionItemOf)
        .filter((item) => !item.closed || msOf(item.closed.at) >= cutoff);
    },
    owns: (key) => target(key) !== undefined,
    answer: async (key, text, options) => {
      const parsed = target(key);
      return parsed ? result(engine.answerAsk(parsed.managerId, parsed.messageId, text, options?.reactivate === true)) : notFound;
    },
    dismiss: async (key) => {
      const parsed = target(key);
      return parsed ? result(engine.dismissAsk(parsed.managerId, parsed.messageId)) : notFound;
    },
    close: async (key, closed) => {
      const parsed = target(key);
      return parsed ? result(engine.closeAsk(parsed.managerId, parsed.messageId, closed)) : notFound;
    },
    onChange: (listener) => engine.onAskChange((change) => listener(change.closed ? { closedItem: questionItemOf(change.card) } : {})),
  };
}
