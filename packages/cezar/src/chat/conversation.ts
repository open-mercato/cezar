import type { ChatReceipt } from './provider.ts';
import { redactSecrets } from '../core/secret-redaction.ts';
import { prepareChatTaskTarget, type ChatTaskTarget } from './task-target.ts';
import { ChatControlRefusal, type PreparedControl } from './controls.ts';
import type { ChatActions } from './actions.ts';
import type { ConfirmationButton, ReplyKeyboard } from './dispatcher.ts';
import { receiverSecretValues, type PrivateReceiver } from '../webhooks/endpoints.ts';
import type { ProjectContext } from '../server/project-context.ts';
import type { RunRecord } from '../runs/store.ts';
import type { deliverUserMessage } from '../server/run-messages.ts';
import type { InboundStateStore } from './state.ts';
import { isChatCommand, resolveTask, CHAT_COMMANDS, type ChatCommandName, type InputUpdate } from './events.ts';
import { chatReceiptSchema } from './provider.ts';
import type { ChatPresentation } from './presentation.ts';
import { randomUUID } from 'node:crypto';
import { authorize, correlationCurrent, grantAllows, grantFresh } from './authorization.ts';
import { CommandLimiter } from './dispatcher.ts';
import type { Correlation, InboundGrant, JournalEntry } from './state.ts';
import { runLifecycleSnapshot } from '../runs/lifecycle.ts';
import { readableTaskStatus } from './presentation.ts';
import { scrubChatText } from './private-text.ts';
import { cezarHomeDir } from '../paths.ts';
import { homedir, tmpdir } from 'node:os';
import { z } from 'zod';
import type { ChatSourceRecord, ChatTaskCreateResult } from '@open-mercato/cezar-contract';
import { classifyChatMessage } from './message-router.ts';
import { groupIgnores } from './inbox.ts';
export interface ConversationDependencies {
  presentation: ChatPresentation; botId: string; username: string; state: InboundStateStore;
  receivers(): readonly PrivateReceiver[];
  receiver(id: string): PrivateReceiver | undefined;
  context(): Promise<ProjectContext>;
  deliver(project: ProjectContext, run: RunRecord, text: string, check: () => string | undefined): ReturnType<typeof deliverUserMessage>;
  createTask?(project: ProjectContext, text: string, source: ChatSourceRecord, check: () => string | undefined, target: ChatTaskTarget): Promise<ChatTaskCreateResult>;
  /** `providerLabel` names the chat the text came from, as in `[via Slack]`. */
  prepareControl?(project: ProjectContext, run: RunRecord, kind: 'cancel' | 'continue', text: string, providerLabel: string): Promise<PreparedControl | undefined>;
  actions?: ChatActions;
  episode(runId: string): string | undefined;
  reply(chatId: string, text: string, valid: () => boolean, sent?: (result: unknown) => Promise<void>, button?: ReplyKeyboard, replyTo?: ChatReceipt): void;
  now?: () => number;
  active?(): boolean;
  /** Group membership re-check; undefined means the platform could not say. */
  member?(chatId: string, userId: string): Promise<boolean | undefined>;
}
// Groups only route commands carrying the @bot suffix, so every hint shown there must carry it.
const botCommand = (name: string, username?: string) => `/${name}`;
const USAGE: Record<ChatCommandName, string> = { task: '<text>', tasks: '', status: '[task]', reply: '<task> <text>', cancel: '<task>', continue: '<task> [text]', help: '' };
/** A group help names the addressed form and no implicit context; new tasks start only from the private chat. */
export function chatHelp(presentation: ChatPresentation, username?: string): string {
  const group = username !== undefined;
  const lines = CHAT_COMMANDS.filter(({ command }) => command !== 'help' && !(group && command === 'task'))
    .map(({ command, description }) => {
      const usage = group && command === 'status' ? '<task>' : USAGE[command];
      return `${presentation.command(command, username)}${usage ? ` ${usage}` : ''} — ${description}`;
    });
  return [group ? 'Reply to a bot message to answer its task, or tap its buttons.' : 'Just type to continue your current task: answer its question or send a follow-up.',
    ...lines, 'Cancel and Continue need their own permission, and you confirm each one.', ...(group ? ['New tasks start from your private chat with the bot.'] : [])].join('\n');
}
/** How a waiting task's question can be answered from Telegram: option buttons only for one single-select question. */
export function chatAnswerMode(run: Pick<RunRecord, 'status' | 'archived' | 'attentionRequest'>): 'buttons' | 'multi_select' | 'text' {
  const questions = run.status === 'waiting' && !run.archived ? run.attentionRequest?.questions ?? [] : [];
  if (questions.length !== 1) return 'text';
  return questions[0]!.multiSelect ? 'multi_select' : questions[0]!.options?.length ? 'buttons' : 'text';
}
export const CHAT_ANSWER_NOTES = {
  buttons: 'Tap an option below, or Reply to this message with a different answer.',
  multi_select: 'This question accepts several options: Reply to this message with your choices.',
} as const;
interface AnswerButtons { keyboard: ConfirmationButton[][]; sent(raw: unknown): Promise<void>; release(): void }
// Telegram shows about this much of a button; the full label still reaches the agent.
const clipButton = (label: string, limit = 64) => label.length > limit ? `${label.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '')}…` : label;
/** Sent privately on approval; a group grant is used from the group, so name the addressed command. */
export function chatAccessGrantedText(presentation: ChatPresentation, chatId: string, username: string): string {
  return presentation.isGroup(chatId) ? `Access granted. In the group, use ${presentation.command('tasks', username)} to see this project’s tasks.`
    : `Access granted. Try ${presentation.command('tasks')} to see this project’s tasks.`;
}
/** Bounded in-memory once-per-window notices, so repeated messages never multiply bot replies. */
export class NoticeThrottle {
  private readonly until = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now, private readonly windowMs = 60_000, private readonly max = 1000) {}
  allow(key: string): boolean {
    const now = this.now();
    for (const [entry, until] of this.until) if (until <= now) this.until.delete(entry);
    if (this.until.has(key) || this.until.size >= this.max) return false;
    this.until.set(key, now + this.windowMs); return true;
  }
}
type SafeProject = Pick<ProjectContext, 'root'> & { store: Pick<ProjectContext['store'], 'redactRunText'> };
/** Run-derived text bound for Telegram: secret values redacted, then private local paths scrubbed. */
export const chatSafe = (project: SafeProject, runId: string, text: string, receivers: readonly PrivateReceiver[]): string =>
  scrubChatText(redactSecrets(project.store.redactRunText(runId, text), receivers.flatMap(receiverSecretValues)), [project.root, homedir(), tmpdir(), cezarHomeDir()]);
/** Safe option labels, numbered when scrubbing or clipping would show two identical buttons. */
export function chatOptionLabels(project: SafeProject, runId: string, labels: readonly string[], receivers: readonly PrivateReceiver[], buttonLimit = 64): string[] {
  const safe = labels.map(label => chatSafe(project, runId, label, receivers));
  return new Set(safe.map(label => clipButton(label, buttonLimit))).size < safe.length ? safe.map((label, index) => `${index + 1}. ${label}`) : safe;
}
const shortId = (id: string) => id.slice(0, 8);
const readableStatus = readableTaskStatus;
const clipTitle = (title: string) => title.length > 60 ? `${title.slice(0, 59).replace(/[\uD800-\uDBFF]$/, '')}…` : title;
const FINISHED = ['done', 'failed', 'cancelled', 'review'];
const EXPIRED = 'This message is older than 15 minutes and was not carried out. Send it again.';
const PERMISSION_NAMES = { start: 'Start', cancel: 'Cancel', continue: 'Continue' } as const;
const needs = (label: string, permission: keyof typeof PERMISSION_NAMES, action: string) =>
  `${action} from ${label} needs the ${PERMISSION_NAMES[permission]} permission. Ask the cezar operator to turn it on in the cockpit.`;
const receiptSchema = chatReceiptSchema;
type Finish = (result: JournalEntry['state'], reason: string, text?: string) => Promise<void>;

export class ChatConversation {
  private readonly limiter: CommandLimiter;
  private readonly notices: NoticeThrottle;
  private readonly now: () => number;
  constructor(private readonly deps: ConversationDependencies) {
    this.now = deps.now ?? Date.now; this.limiter = new CommandLimiter(this.now); this.notices = new NoticeThrottle(this.now);
  }
  private currentGrant(chatId: string, userId: string): InboundGrant | undefined {
    if (this.deps.active?.() === false) return undefined;
    this.deps.state.assertReady();
    return authorize(this.deps.state.snapshot(), chatId, userId, this.deps.receiver);
  }
  private valid(grant: InboundGrant): boolean {
    try {
      const current = this.currentGrant(grant.chatId, grant.userId);
      return current?.id === grant.id && current.generation === grant.generation && current.enableGeneration === grant.enableGeneration;
    } catch { return false; }
  }
  /**
   * Check freshness against the durable grant, not the snapshot captured when
   * this message entered the conversation. A state change can update
   * approvedAt while retaining the grant's identity and generations.
   */
  private fresh(grant: InboundGrant, messageDate: number): boolean {
    const snapshot = this.deps.state.snapshot();
    const current = snapshot.grants.find(row => row.id === grant.id && row.receiverId === grant.receiverId
      && row.chatId === grant.chatId && row.userId === grant.userId);
    return current !== undefined && grantFresh(snapshot, current, messageDate, this.now());
  }
  private say(chatId: string, text: string, valid: () => boolean, throttled = false, replyTo?: ChatReceipt): void {
    if (throttled && !this.notices.allow(chatId)) return;
    this.deps.reply(chatId, this.deps.presentation.formatText(text, this.deps.presentation.maxText, this.deps.username), valid, undefined, undefined, replyTo);
  }
  async process(update: InputUpdate, epoch: string): Promise<void> {
    const { state } = this.deps;
    if (state.duplicate(epoch, update.sequence)) return;
    const message = update.message;
    if (!message) { await state.finish(epoch, update.sequence); return; }
    const command = message.command;
    if (command.kind === 'ignore') { await state.finish(epoch, update.sequence); return; }
    const chatId = String(message.chat.id), userId = String(message.user.id);
    const group = message.chat.kind !== 'private';
    if (groupIgnores(message, state.snapshot().correlations)) { await state.finish(epoch, update.sequence); return; }
    const original = message.replyTo && state.snapshot().correlations.find(row => row.chatId === chatId && (row.messageId === message.replyTo || row.replyTo?.messageId === message.replyTo));
    const replyTo = original ? original.replyTo ?? { chatId, messageId: original.messageId } : undefined;
    const c = (name: string) => this.deps.presentation.command(name, group ? this.deps.username : undefined);
    const HELP = chatHelp(this.deps.presentation, group ? this.deps.username : undefined);
    const grant = this.currentGrant(chatId, userId);
    const entry: JournalEntry = { id: randomUUID(), epoch, updateId: update.sequence, at: this.now(), botId: this.deps.botId, chatId, userId,
      ...(grant ? { receiverId: grant.receiverId } : {}), kind: command.kind === 'command' && isChatCommand(command.name)
        ? command.name as JournalEntry['kind'] : command.kind === 'text' && message.replyTo ? 'answer' : 'unknown_command',
      state: 'rejected', reason: 'unsupported' };
    const finish = async (result: JournalEntry['state'], reason: string, text?: string, throttled = false) => {
      await state.finish(epoch, update.sequence, { ...entry, state: result, reason });
      if (text) this.say(chatId, text, grant ? () => this.valid(grant) : () => true, throttled, replyTo);
    };
    if (!grant) {
      // A paired person whose access is paused hears why; strangers in unbound groups hear nothing, so the bot cannot be probed there.
      const snapshot = state.snapshot();
      const notice = snapshot.grants.some(row => row.chatId === chatId && row.userId === userId) ? 'Replies are currently off for this chat. Check the cezar cockpit.'
        : !group ? 'To control tasks, start pairing in the cezar cockpit.'
          : snapshot.receivers.some(row => row.chatId === chatId) ? 'Ask the cezar operator to approve you for task control in this group.' : undefined;
      await finish('rejected', 'unauthorized', notice, true); return;
    }
    if (!this.limiter.accept(userId)) { await finish('rejected', 'rate_limited', 'Too many commands. Try again in a minute.', true); return; }
    const contentLength = command.kind === 'command' && ['reply', 'continue'].includes(command.name)
      ? (command.args.match(/^\S+(?:\s+([\s\S]*))?$/)?.[1] ?? '').length : command.kind === 'command' && command.name === 'task' ? command.args.length : message.text!.length;
    if (contentLength > 4000) { await finish('rejected', 'too_long', 'Message is too long (maximum 4,000 characters).'); return; }
    // Bare text never starts work: an answer sent without Reply must not become a paid task.
    if (command.kind === 'unknown' || (command.kind === 'command' && !isChatCommand(command.name))) {
      await finish('rejected', 'unsupported', HELP); return;
    }
    if (command.kind === 'command' && command.name === 'help') { await finish('accepted', 'read', HELP); return; }
    if (command.kind === 'command' && command.name === 'task') {
      if (group) { await finish('rejected', 'unsupported', 'Start new tasks from your private chat with the bot.'); return; }
      if (!grantAllows(grant, 'start')) { await finish('rejected', 'permission_denied', needs(this.deps.presentation.label, 'start', 'Starting tasks')); return; }
      if (!command.args) { await finish('rejected', 'empty_text', `Describe the task after ${c('task')}, for example: ${c('task')} fix the failing login test`); return; }
    }
    if (!this.fresh(grant, message.at)) { await finish('rejected', 'expired', EXPIRED, true); return; }
    if (group && this.deps.member) {
      const member = await this.deps.member(chatId, userId).catch(() => undefined);
      if (member === false) { await finish('rejected', 'not_member', 'You are no longer a member of this group, so this was not carried out.'); return; }
      if (member === undefined) { await finish('rejected', 'membership_unknown', 'Could not confirm your group membership. Nothing was done; try again in a minute.', true); return; }
    }
    let project: ProjectContext;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      project = await Promise.race([this.deps.context(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('context timeout')), 30_000);
      })]);
    } catch {
      await finish('rejected', 'context_unavailable', 'The project is unavailable. Nothing was run.'); return;
    }
    finally { if (timer) clearTimeout(timer); }
    if (!this.valid(grant)) { await finish('rejected', 'grant_changed'); return; }
    if (!this.fresh(grant, message.at)) { await finish('rejected', 'expired', EXPIRED, true); return; }
    if (command.kind === 'command' && command.name === 'task') { await this.previewTask(project, command.args, grant, message.id, finish, replyTo); return; }
    const runs = project.store.listRuns().filter(run => !run.archived);
    if (command.kind === 'command' && command.name === 'tasks') {
      const lines: string[] = [];
      // Waiting tasks first; dispatch children only when they need an answer.
      const listed = runs.filter(run => run.status === 'waiting' || !run.dispatch?.parentRunId);
      for (const run of [...listed.filter(run => run.status === 'waiting'), ...listed.filter(run => run.status !== 'waiting')].slice(0, 10)) {
        const line = `${shortId(run.id)} · ${readableStatus(run.status)} · ${chatSafe(project, run.id, run.title, this.deps.receivers()).slice(0, 180)}`;
        if (this.deps.presentation.formatText([...lines, line].join('\n'), Number.MAX_SAFE_INTEGER).length > this.deps.presentation.maxText) break;
        lines.push(line);
      }
      await finish('accepted', 'read', lines.join('\n') || 'No tasks found.'); return;
    }
    const route = classifyChatMessage(update, { botUsername: this.deps.username, chatId, userId, receiverId: grant.receiverId,
      state: state.snapshot(), runs, episode: this.deps.episode });
    let correlation: Correlation | undefined;
    let run: RunRecord | undefined, text: string;
    // A follow-up is ordinary text for the task in context: it answers, queues or continues by the task's state.
    let followUp = false;
    if (route.kind === 'explicit-reply') {
      run = project.store.getRun(route.correlation.runId);
      if (!run || run.archived) { await finish('rejected', 'unknown_reply', `I cannot find the task of that message. Use ${c('tasks')}.`); return; }
      text = route.text;
      // Only a question notice pins the answer to its question; a Reply to a final or progress notice is a follow-up.
      if (route.correlation.type === 'task.attention_required') correlation = route.correlation; else followUp = true;
    } else if (route.kind === 'unmatched-reply') {
      // Groups already dropped uncorrelated Replies above.
      await finish('rejected', 'unknown_reply', `I cannot match this reply to a task. Just type to continue your current task, or use ${c('reply')} <task> <text>.`);
      return;
    } else if (route.kind === 'implicit-reply') {
      run = project.store.getRun(route.runId);
      if (!run || run.archived) { await finish('rejected', 'unknown_task', `I cannot find that task. Use ${c('tasks')} or ${c('reply')} <task> <text>.`); return; }
      text = route.text; followUp = true;
    } else if (route.kind === 'unhandled') {
      await finish('rejected', 'unsupported', HELP); return;
    } else if (command.kind === 'command' && command.name === 'status' && !command.args.trim()) {
      if (group) { await finish('rejected', 'unknown_task', `Add a task ID: ${c('status')} <task>. Use ${c('tasks')} to list tasks.`); return; }
      // Only the sender's own chat-started task: a bare /status must not reveal what others started.
      run = runs.filter(row => row.chatSource?.provider === this.deps.state.snapshot().provider && row.chatSource.botId === this.deps.botId && row.chatSource.chatId === chatId && row.chatSource.userId === userId)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
      if (!run) { await finish('rejected', 'unknown_task', `You have not started a task from this chat yet. Use ${c('status')} <task> or ${c('tasks')}.`); return; }
      text = '';
    } else if (command.kind === 'command') {
      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(command.args);
      run = match ? resolveTask(match[1]!, runs) : undefined; text = match?.[2] ?? '';
    } else { await finish('rejected', 'unsupported', HELP); return; }
    if (!run || run.archived) { await finish('rejected', 'unknown_task', 'No unique task found. Provide the full ID or a longer prefix (at least 8 characters).'); return; }
    entry.runId = run.id;
    if (followUp) entry.kind = 'answer';
    const named = command.kind === 'command' ? command.name : undefined;
    if (named === 'reply' && !text.trim()) { await finish('rejected', 'empty_text', 'Add your answer after the task ID.'); return; }
    // Addressing a task makes it the private chat's context; /cancel does not, nothing follows it.
    if (!group && named !== 'cancel') await this.remember(grant, run.id);
    if (named === 'status') { await this.status(project, run, grant, finish, c, replyTo); return; }
    if (followUp && FINISHED.includes(run.status)) {
      entry.kind = 'continue';
      if (!grantAllows(grant, 'continue')) {
        await finish('rejected', 'permission_denied', `Task ${shortId(run.id)} is ${readableStatus(run.status).toLowerCase()}. ${needs(this.deps.presentation.label, 'continue', 'Continuing it')} Or resume it in the cockpit.`);
        return;
      }
      await this.previewControl(project, grant, run, 'continue', text, message.at, finish, replyTo); return;
    }
    if (named === 'cancel' || named === 'continue') {
      if (!grantAllows(grant, named)) { await finish('rejected', 'permission_denied', needs(this.deps.presentation.label, named, named === 'cancel' ? 'Cancelling tasks' : 'Continuing tasks')); return; }
      await this.previewControl(project, grant, run, named, text, message.at, finish, replyTo); return;
    }
    const runId = run.id;
    const check = followUp && ['running', 'queued'].includes(run.status)
      ? () => this.followUpRefusal(project, runId, grant, message.at) : () => this.answerRefusal(project, runId, grant, correlation, message.at);
    await this.deliverAnswer(project, grant, runId, text, check, entry, finish, c);
  }
  private async remember(grant: InboundGrant, runId: string): Promise<void> {
    await this.deps.state.remember({ receiverId: grant.receiverId, chatId: grant.chatId, userId: grant.userId, runId, at: this.now() });
  }
  private async status(project: ProjectContext, run: RunRecord, grant: InboundGrant, finish: Finish, c: (name: string) => string, replyTo?: ChatReceipt): Promise<void> {
    const { state } = this.deps, chatId = grant.chatId;
    const snapshot = runLifecycleSnapshot(run), episodeId = this.deps.episode(run.id);
    // Only run-derived fields are scrubbed: the fixed hints below name commands such as /reply.
    const safe = (text: string) => chatSafe(project, run.id, text, this.deps.receivers());
    const body = [`Task ${shortId(run.id)}`, readableStatus(run.status), safe(run.title)];
    const mode = chatAnswerMode(run), buttons = mode === 'buttons' ? this.answerButtons(project, run, grant, replyTo) : undefined;
    if (run.status === 'waiting') {
      if (run.attentionRequest) for (const question of run.attentionRequest.questions) {
        const options = question.options ?? [], labels = chatOptionLabels(project, run.id, options.map(option => option.label), this.deps.receivers(), this.deps.presentation.buttonTextLimit);
        body.push(safe(question.question), ...options.map((option, index) => `${labels[index]}${option.description ? ` — ${safe(option.description)}` : ''}`));
      }
      else body.push(`This task is waiting. Open the cockpit to read the question, then Reply to this message or use ${c('reply')} <task> <text>.`);
      if (buttons) body.push(CHAT_ANSWER_NOTES.buttons);
      else if (mode === 'multi_select') body.push(CHAT_ANSWER_NOTES.multi_select);
      body.push(`Reply to this message to answer task ${shortId(run.id)}.`);
    }
    const rendered = this.deps.presentation.formatText(body.join('\n'), this.deps.presentation.maxText, this.deps.username);
    await finish('accepted', 'read');
    const bound = state.snapshot().receivers.find(receiver => receiver.receiverId === grant.receiverId)!;
    this.deps.reply(chatId, rendered, () => this.valid(grant), async raw => {
      await buttons?.sent(raw);
      const receipt = receiptSchema.safeParse(raw), sequence = Number(episodeId?.slice(episodeId.lastIndexOf('-') + 1));
      if (!receipt.success || String(receipt.data.chatId) !== chatId || !episodeId || snapshot.status !== 'waiting' || !Number.isSafeInteger(sequence) || sequence < 1) return;
      const next: Correlation = { receiverId: grant.receiverId, chatId, messageId: receipt.data.messageId, ...(replyTo ? { replyTo } : {}), privateChat: !this.deps.presentation.isGroup(chatId),
        deliveryRevision: bound.deliveryRevision, bindingGeneration: state.snapshot().binding.generation, enableGeneration: bound.generation,
        runId: snapshot.id, type: 'task.attention_required', sequence, episodeId, continuation: snapshot.continuation, createdAt: this.now(),
        ...(snapshot.attentionRequest ? { requestId: snapshot.attentionRequest.requestId, askedAt: snapshot.attentionRequest.askedAt } : {}) };
      await state.change(draft => { if (this.valid(grant)) draft.correlations.push(next); });
    }, buttons?.keyboard, replyTo);
  }
  /** The one Cancel/Continue preview: a Confirm button bound to this grant, binding and task fingerprint. */
  private async previewControl(project: ProjectContext, grant: InboundGrant, run: RunRecord, kind: 'cancel' | 'continue', text: string,
    messageDate: number, finish: Finish, replyTo?: ChatReceipt): Promise<void> {
    const { state, prepareControl, actions } = this.deps;
    if (!prepareControl || !actions) { await finish('rejected', 'unsupported', `This action is unavailable from ${this.deps.presentation.label}. Use the cockpit.`); return; }
    let prepared: PreparedControl | undefined, refusal = 'configuration_unknown';
    try { prepared = await prepareControl(project, run, kind, text, this.deps.presentation.label); } catch (error) { if (error instanceof ChatControlRefusal) refusal = error.reason; }
    if (!prepared || !this.valid(grant) || !this.fresh(grant, messageDate)) {
      await finish('rejected', refusal, `The task state or saved account does not allow this ${kind === 'cancel' ? 'cancellation' : 'continuation'}. Check the cockpit.`); return;
    }
    const snapshot = state.snapshot(), binding = snapshot.receivers.find(row => row.receiverId === grant.receiverId)!;
    const signature = JSON.stringify([snapshot.binding.generation, binding.deliveryRevision]);
    const control = prepared, valid = () => {
      if (!this.valid(grant) || !control.valid()) return false;
      const latest = state.snapshot(), receiver = latest.receivers.find(row => row.receiverId === grant.receiverId);
      return signature === JSON.stringify([latest.binding.generation, receiver?.deliveryRevision]);
    };
    const pending = actions.create({ kind, replyTo, receiverId: grant.receiverId, chatId: grant.chatId, userId: grant.userId, runId: run.id,
      valid, responseValid: () => this.valid(grant), execute: control.execute });
    if (!pending) { await finish('rejected', 'confirmation_limit', 'Too many pending confirmations. Try again in two minutes.'); return; }
    await finish('accepted', 'preview');
    this.deps.reply(grant.chatId, this.deps.presentation.formatText(chatSafe(project, run.id, control.summary, this.deps.receivers())), pending.valid, pending.sent,
      { text: 'Confirm', data: pending.data }, replyTo);
  }
  /** A follow-up to a working task needs a current grant and a task that has not finished. */
  private followUpRefusal(project: ProjectContext, runId: string, grant: InboundGrant, messageDate: number): string | undefined {
    if (!this.valid(grant) || !this.fresh(grant, messageDate)) return 'grant_changed';
    const current = project.store.getRun(runId);
    return !current || current.archived || !['running', 'queued', 'waiting'].includes(current.status) ? 'not_running' : undefined;
  }
  /** Reply, /reply and option buttons share these checks: grant, waiting status, then correlation/episode/requestId freshness. */
  private answerRefusal(project: ProjectContext, runId: string, grant: InboundGrant, correlation: Correlation | undefined, messageDate?: number): string | undefined {
    if (!this.valid(grant) || (messageDate !== undefined && !this.fresh(grant, messageDate))) return 'grant_changed';
    const current = project.store.getRun(runId);
    if (!current || current.archived || current.status !== 'waiting') return 'not_waiting';
    if (correlation && !correlationCurrent(this.deps.state.snapshot(), correlation, current, this.deps.episode(runId))) return 'stale_reply';
    return undefined;
  }
  /** The one delivery path for an answer, whether typed or tapped. */
  private async deliverAnswer(project: ProjectContext, grant: InboundGrant, runId: string, text: string, check: () => string | undefined, entry: JournalEntry,
    finish: Finish, c: (name: string) => string): Promise<void> {
    const refusal = check();
    if (refusal) {
      const current = project.store.getRun(runId);
      await finish('rejected', refusal, refusal !== 'grant_changed' && current && !current.archived && FINISHED.includes(current.status)
        ? `Task ${shortId(runId)} is ${readableStatus(current.status).toLowerCase()} and no longer waiting for an answer. Resume it in the cockpit${grant.permissions.includes('continue') ? ` or with ${c('continue')} ${shortId(runId)} <text>` : ''}.`
        : `The question is out of date or the task is not waiting. Check ${c('status')} <task> and use ${c('reply')} for the current question.`); return;
    }
    if (!text.trim()) { await finish('rejected', 'empty_text', 'Add your answer after the task ID.'); return; }
    const run = project.store.getRun(runId)!;
    const named = `task ${shortId(runId)} · ${clipTitle(chatSafe(project, runId, run.title, this.deps.receivers()))}`;
    if (!await this.deps.state.claim({ ...entry, state: 'claimed', reason: 'pending' })) return;
    let outcome: 'accepted' | 'queued' | 'deferred' | 'rejected' | 'uncertain', reason: string, response: string;
    try {
      const result = await this.deps.deliver(project, run, `[via ${this.deps.presentation.label}] ${text}`, check);
      if (result.status !== 200) { outcome = 'rejected'; reason = 'delivery_refused'; response = 'Delivery refused: the account or task state does not allow this message. Check the cockpit.'; }
      else if ('queued' in result.body) { outcome = 'queued'; reason = 'queued'; response = `Queued for ${named}: the agent reads it after its current step.`; }
      else if ('deferred' in result.body) { outcome = 'deferred'; reason = 'deferred'; response = `Saved for ${named}; it is delivered when the session starts.`; }
      else { outcome = 'accepted'; reason = 'delivered'; response = `Delivered to ${named}.`; }
    } catch { outcome = 'uncertain'; reason = 'delivery_uncertain'; response = `I cannot tell whether the message reached task ${shortId(runId)}. Check ${c('status')} ${shortId(runId)}.`; }
    await finish(outcome, reason, response);
  }
  private tapFinish(grant: InboundGrant, epoch: string, updateId: number, entry: JournalEntry, replyTo?: ChatReceipt): Finish {
    return async (result, reason, text) => {
      await this.deps.state.finish(epoch, updateId, { ...entry, state: result, reason });
      if (text) this.say(grant.chatId, text, () => this.valid(grant), false, replyTo);
    };
  }
  /**
   * One option button per choice of a single single-select question. Each button carries only an
   * ephemeral action id; the label is delivered through the same path and checks as a Reply.
   */
  answerButtons(project: ProjectContext, run: RunRecord, grant: InboundGrant, replyTo?: ChatReceipt): AnswerButtons | undefined {
    const { state, actions } = this.deps, request = run.attentionRequest, options = request?.questions[0]?.options;
    if (!actions || !request || !options || chatAnswerMode(run) !== 'buttons') return undefined;
    const episodeId = this.deps.episode(run.id), sequence = Number(episodeId?.slice(episodeId.lastIndexOf('-') + 1));
    const snapshot = state.snapshot(), bound = snapshot.receivers.find(row => row.receiverId === grant.receiverId);
    if (!episodeId || !Number.isSafeInteger(sequence) || sequence < 1 || !bound || bound.chatId !== grant.chatId) return undefined;
    // The same freshness record a Reply carries; only the Telegram message id is unknown before sending.
    const correlation: Correlation = { receiverId: grant.receiverId, chatId: grant.chatId, messageId: '1', privateChat: !this.deps.presentation.isGroup(grant.chatId), deliveryRevision: bound.deliveryRevision,
      bindingGeneration: snapshot.binding.generation, enableGeneration: bound.generation, runId: run.id, type: 'task.attention_required', sequence, episodeId,
      continuation: runLifecycleSnapshot(run).continuation, requestId: request.requestId, askedAt: request.askedAt, createdAt: this.now() };
    if (this.answerRefusal(project, run.id, grant, correlation)) return undefined;
    const labels = options.map(option => option.label);
    const pending = actions.create({ kind: 'answer', replyTo, receiverId: grant.receiverId, chatId: grant.chatId, userId: grant.userId, runId: run.id,
      choices: labels.length, ttlMs: 15 * 60_000,
      valid: () => !this.answerRefusal(project, run.id, grant, correlation), responseValid: () => this.valid(grant),
      perform: ({ epoch, updateId, entry }, check, choice) => this.deliverAnswer(project, grant, run.id, labels[choice]!,
        () => check() ?? this.answerRefusal(project, run.id, grant, correlation), entry, this.tapFinish(grant, epoch, updateId, entry, replyTo),
        name => this.deps.presentation.command(name, this.deps.presentation.isGroup(grant.chatId) ? this.deps.username : undefined)),
    });
    if (!pending) return undefined;
    const shown = chatOptionLabels(project, run.id, labels, this.deps.receivers(), this.deps.presentation.buttonTextLimit);
    return { keyboard: pending.choices.map((data, index) => [{ text: clipButton(shown[index]!, this.deps.presentation.buttonTextLimit), data: data }]),
      sent: pending.sent, release: pending.release };
  }
  /** `/task` only previews; the Confirm tap claims the durable source and creates the task (spec 2026-10-29-telegram-setup-and-replies §Telegram-originated tasks). */
  private async previewTask(project: ProjectContext, text: string, grant: InboundGrant, sourceMessageId: string, finish: Finish, replyTo?: ChatReceipt): Promise<void> {
    const { state, actions, createTask } = this.deps;
    if (!actions || !createTask) { await finish('rejected', 'unsupported', `Starting tasks from ${this.deps.presentation.label} is unavailable. Use the cockpit.`); return; }
    const target = await prepareChatTaskTarget(project.root);
    const signature = () => {
      const snapshot = state.snapshot();
      return JSON.stringify([snapshot.binding.projectId, snapshot.binding.generation, snapshot.receivers.find(row => row.receiverId === grant.receiverId)?.deliveryRevision]);
    };
    const saved = signature(), valid = () => this.valid(grant) && signature() === saved;
    const pending = actions.create({ kind: 'task', replyTo, receiverId: grant.receiverId, chatId: grant.chatId, userId: grant.userId, choices: 2,
      valid, responseValid: () => this.valid(grant),
      perform: async ({ epoch, updateId, entry }, check, choice) => {
        if (choice === 1) { await this.tapFinish(grant, epoch, updateId, entry, replyTo)('rejected', 'declined', 'Not started.'); return; }
        await this.startTask(project, text, grant, sourceMessageId, epoch, updateId, entry, () => check() ?? (valid() ? undefined : 'grant_changed'), target, replyTo);
      },
    });
    if (!pending) { await finish('rejected', 'confirmation_limit', 'Too many pending confirmations. Try again in two minutes.'); return; }
    await finish('accepted', 'preview');
    const summary = `Start a new task?\nProject: ${project.id}\nWorkflow: ${target.workflow}\nProvider: ${target.runner}\nThe agent can run shell commands on this machine and may incur costs.\n\n${text}`;
    this.deps.reply(grant.chatId, this.deps.presentation.formatText(summary, this.deps.presentation.maxText, this.deps.username), pending.valid, async raw => {
        await pending.sent(raw);
        const receipt = receiptSchema.safeParse(raw);
        if (!replyTo && receipt.success && receipt.data.chatId === grant.chatId) replyTo = receipt.data;
      },
      [[{ text: 'Confirm', data: pending.choices[0]! }, { text: 'Cancel', data: pending.choices[1]! }]], replyTo);
  }
  private async startTask(project: ProjectContext, text: string, grant: InboundGrant, sourceMessageId: string, epoch: string, updateId: number,
    tap: JournalEntry, check: () => string | undefined, target: ChatTaskTarget, replyTo?: ChatReceipt): Promise<void> {
    const { state } = this.deps, now = this.now();
    // Claimed on the Confirm tap's update: replaying it, or a second tap, finds the claim and starts nothing.
    const source: ChatSourceRecord = { provider: this.deps.state.snapshot().provider, id: randomUUID(), botId: this.deps.botId, epoch, projectId: state.snapshot().binding.projectId,
      receiverId: grant.receiverId, grantId: grant.id, grantGeneration: grant.generation, enableGeneration: grant.enableGeneration,
      chatId: grant.chatId, userId: grant.userId, sourceMessageId, ...(replyTo ? { replyTo } : {}), updateId, episodeId: randomUUID(), requestId: randomUUID(), runId: randomUUID(),
      state: 'claimed', createdAt: now, updatedAt: now };
    const entry: JournalEntry = { ...tap, kind: 'task' };
    if (!await state.claimSource({ ...entry, state: 'claimed', reason: 'pending' }, source)) return;
    // The runtime observer owns every source outcome message, so a refusal here is only recorded.
    if (check()) { await state.settleSource(epoch, updateId, source.id, { ...entry, state: 'rejected', reason: 'grant_changed' }, { state: 'expired' }); return; }
    let result: ChatTaskCreateResult;
    try { result = await this.deps.createTask!(project, text, source, check, target); }
    catch { result = { created: false, reason: 'creation_failed' }; }
    if (result.created) {
      await state.settleSource(epoch, updateId, source.id, { ...entry, runId: result.runId, state: 'accepted', reason: 'task_created' },
        { state: 'finished', runId: result.runId });
      this.say(grant.chatId, `Started task ${shortId(result.runId)}.`, () => this.valid(grant));
      return;
    }
    const reason = result.reason, outcome = { ...entry, state: reason === 'creation_failed' ? 'uncertain' as const : 'rejected' as const, reason };
    await state.settleSource(epoch, updateId, source.id, outcome,
      reason === 'creation_failed' ? { state: 'uncertain' } : { state: 'policy_refused', policyReason: reason });
  }
}
