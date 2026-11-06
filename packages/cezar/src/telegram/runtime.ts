import type { TelegramSendBudget } from './send-budget.ts';
import { TelegramActions } from './actions.ts';
import { processGroupEvent } from './group-events.ts';
import type { BotLease } from './ownership.ts';
import type { Correlation, InboundStateStore } from './state.ts';
import type { Pairings } from './pairing.ts';
import { TelegramApiError, type TelegramCall } from './client.ts';
import { BotOwnershipError } from './ownership.ts';
import { runLifecycleSnapshot } from '../runs/lifecycle.ts';
import { NoticeThrottle, TELEGRAM_ANSWER_NOTES, TelegramConversation, telegramAccessGrantedText, telegramAnswerMode, telegramOptionLabels, telegramSafe, type ConversationDependencies } from './conversation.ts';
import { formatTelegramText, readableCompletionReason } from '../webhooks/telegram.ts';
import { safeAgentText } from '../webhooks/excerpt.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import { renderTelegramSourceOutcome, renderTelegramTaskReply, TelegramReplies } from './dispatcher.ts';
import { TelegramPoller, type PollerHealth } from './poller.ts';
import { authorize, GroupMembership } from './authorization.ts';
import { TELEGRAM_COMMANDS } from './protocol.ts';
import { z } from 'zod';
import type { RunRecord } from '../runs/store.ts';
interface RuntimeDependencies extends Pick<ConversationDependencies, 'receiver' | 'context' | 'deliver' | 'createTask' | 'prepareControl' | 'episode' | 'now'> {
  budget?: TelegramSendBudget; botId: string; state: InboundStateStore; lease: BotLease; pairings: Pairings;
  call: TelegramCall; enabled?(): boolean;
  /** Every live receiver of the project: metadata and agent prose use all their secrets. */
  receivers(): readonly PrivateReceiver[]; assertCredentials(): Promise<void>; changed(): void;
  /** Delay before startup attempt `attempt + 1`; tests shorten it. */
  startupRetryMs?(attempt: number): number;
}
const OUTCOME_STATES = ['policy_refused', 'expired', 'uncertain'];
type TelegramSource = NonNullable<RunRecord['telegramSource']>;
// A final the outbound webhook already sent to the source chat (before this runtime delivered) counts as this run's final.
const WEBHOOK_FINALS = ['task.review_ready', 'task.finished', 'task.failed', 'task.cancelled'];
const identity = z.object({ id: z.number().int().positive().safe(), username: z.string().regex(/^[A-Za-z0-9_]{1,64}$/), first_name: z.string().max(256).optional() });
export class TelegramBotRuntime {
  private poller?: TelegramPoller;
  private actions?: TelegramActions;
  private conversation?: TelegramConversation;
  private replies?: TelegramReplies;
  private unregisterRuns?: () => void;
  private readonly pendingRunReplies = new Set<string>();
  private readonly observedSources = new Set<string>();
  // Bounded by the source journal. Accepted sends remain fenced even if receipt persistence fails.
  private readonly terminalRetries = new Map<string, { revision: string; attempts: number; nextAt: number; fenced: boolean }>();
  /** The run's finishedAt each source's last terminal notice reported. */
  private readonly deliveredFinish = new Map<string, string>();
  /** Sources settled by recovery, whose requester never heard "Started task". */
  private readonly recoveredSources = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private closing?: Promise<void>;
  private closed = false;
  private startup?: Promise<void>;
  private readonly startupAbort = new AbortController();
  private username?: string;
  private startupHealth?: PollerHealth;
  private startupRetry?: ReturnType<typeof setTimeout>;
  private startupAttempts = 0;
  private readonly now = () => this.deps.now?.() ?? Date.now();
  private readonly pairingNotices = new NoticeThrottle(this.now);
  private readonly wrongChatNotices = new NoticeThrottle(this.now);
  constructor(private readonly deps: RuntimeDependencies) {}
  private lostNotices = 0;
  /** A refused final waits for queue room; the 1 s maintenance tick reconciles it again. */
  private retryObserve = false;
  get running(): boolean { return !this.closed; }
  /** Startup in flight or waiting on its own retry timer: discovery must not restart it. */
  get starting(): boolean { return !this.closed && !this.poller && !this.startupHealth; }
  health(): PollerHealth & { droppedReplies: number } {
    return { ...(this.poller?.health() ?? this.startupHealth ?? { state: 'stopped' as const }), droppedReplies: (this.replies?.dropped ?? 0) + this.lostNotices };
  }
  /** Pairing notices share the reply queue, so a busy budget delays them instead of dropping them silently. */
  /** Private approval notice; a group grant names the addressed group command. */
  notifyAccessGranted(userId: string, grantChatId: string): void {
    if (this.username) this.notify(userId, telegramAccessGrantedText(grantChatId, this.username));
  }
  notify(chatId: string, text: string): void {
    if (this.closed) return;
    if (!this.replies) { this.lostNotices++; return; }
    this.replies.enqueue(chatId, text, () => !this.closed);
  }
  private needed(): boolean {
    if (this.closed || this.deps.enabled?.() === false) return false;
    const { state, pairings, botId, receiver } = this.deps;
    if (pairings.hasBot(botId)) return true;
    const snapshot = state.snapshot();
    return snapshot.grants.some(grant => authorize(snapshot, grant.chatId, grant.userId, receiver));
  }
  /** Exactly the condition under which observeRun sends this run's notices. */
  deliversSource(run: RunRecord): boolean {
    return !this.closed && !!this.replies && !!this.unregisterRuns && this.sourceValid(run);
  }
  private sourceValid(run: RunRecord): boolean {
    const source = run.telegramSource;
    return !!source && this.deps.state.snapshot().sources.find(row => row.id === source.id && row.runId === run.id)?.state === 'finished'
      && this.sourceGrantValid(source);
  }
  private sourceOutcomeValid(source: TelegramSource): boolean {
    return OUTCOME_STATES.includes(source.state) && this.sourceGrantValid(source);
  }
  /**
   * The source's binding is enabled and its requester still holds that grant and may act. Only delivery
   * reads this: a permission edit or Disable/Enable must not divert the task's own notices; effects re-check generations.
   */
  private sourceGrantValid(source: TelegramSource): boolean {
    if (this.closed || this.deps.enabled?.() === false) return false;
    try { this.deps.lease.assertOwner(); this.deps.state.assertReady(); } catch { return false; }
    const snapshot = this.deps.state.snapshot();
    if (source.botId !== this.deps.botId || source.projectId !== snapshot.binding.projectId) return false;
    const binding = snapshot.receivers.find(row => row.receiverId === source.receiverId && row.chatId === source.chatId);
    const grant = snapshot.grants.find(row => row.id === source.grantId && row.chatId === source.chatId && row.userId === source.userId);
    return binding?.enabled === true && !!grant && authorize(snapshot, source.chatId, source.userId, this.deps.receiver)?.id === grant.id;
  }
  private async observeSourceOutcome(source: TelegramSource): Promise<void> {
    if (!this.replies || !this.sourceOutcomeValid(source)) return;
    const phase = `source-outcome:${source.id}`;
    if (this.pendingRunReplies.has(phase) || this.deps.state.snapshot().correlations.some(row => row.type === phase)) return;
    const markFailed = () => this.deps.state.change(state => {
      const row = state.sources.find(row => row.id === source.id);
      if (row && OUTCOME_STATES.includes(row.state)) { row.state = 'delivery_failed'; row.updatedAt = this.now(); }
    }).catch(() => undefined);
    this.pendingRunReplies.add(phase);
    const accepted = this.replies.deliver(source.chatId, renderTelegramSourceOutcome(source), {
      key: phase, expiresInMs: 7 * 86400_000, valid: () => !this.closed && this.sourceOutcomeValid(source),
      sent: async result => {
        const receipt = z.object({ message_id: z.number().int().positive().safe().optional() }).safeParse(result);
        if (!receipt.success || !receipt.data.message_id) { await markFailed(); return; }
        const messageId = receipt.data.message_id;
        await this.deps.state.change(state => {
          if (state.correlations.some(row => row.type === phase)) return;
          const binding = state.receivers.find(row => row.receiverId === source.receiverId);
          if (!binding) throw new Error('Telegram receiver disappeared');
          state.correlations.push({ receiverId: source.receiverId, chatId: source.chatId, messageId,
            deliveryRevision: binding.deliveryRevision, bindingGeneration: state.binding.generation, enableGeneration: binding.generation,
            runId: source.runId ?? source.id, type: phase, sequence: 2, episodeId: source.episodeId, continuation: 0, createdAt: this.now() });
        });
      },
      // Without this a refused send stays an outcome and is retried on every update.
      failed: async () => { await markFailed(); },
      settled: () => { this.pendingRunReplies.delete(phase); },
    });
    if (!accepted) this.pendingRunReplies.delete(phase);
  }
  /** False leaves preparation eligible for the next targeted reconciliation. */
  private async observeRun(run: RunRecord): Promise<boolean> {
    const source = run.telegramSource;
    if (!source || source.botId !== this.deps.botId || !this.replies || !this.sourceValid(run)) return false;
    const status = run.archived && !['done', 'review', 'failed', 'cancelled'].includes(run.status) ? 'expired' : run.status;
    if (status === 'queued') return true; // The source-creation path already sent the one acknowledgement.
    const terminal = ['done', 'review', 'failed', 'cancelled', 'expired'].includes(status);
    const lifecycle = runLifecycleSnapshot(run);
    // A Continue adds its step before the status leaves terminal: that event repeats the final already delivered.
    if (terminal && this.deliveredFinish.get(source.id) === (run.finishedAt ?? '')
      && run.steps.some(step => step.id === `continue-${lifecycle.continuation}` && step.status === 'pending' && !step.startedAt)) return true;
    const progressKey = `source-progress:${source.id}:${lifecycle.continuation}`;
    if (terminal || status === 'running') this.replies.cancel(progressKey);
    // "Started task" or "Continuing task" already said it is running; only a later change of course is news.
    if (status === 'running' && !this.recoveredSources.has(source.id)
      && !this.deps.state.snapshot().correlations.some(row => row.runId === run.id && row.continuation === lifecycle.continuation)) return true;
    // The request id lives in the row, not the type: a uuid would overflow the 64-char type.
    const phase = terminal ? `source-final:${source.id}` : `source-progress:${source.id}:${status}`;
    const requestId = terminal ? undefined : run.attentionRequest?.requestId;
    const episodeId = status === 'waiting' ? this.deps.episode(run.id) : undefined;
    const sourceChat = (row: Correlation) => row.receiverId === source.receiverId && row.chatId === source.chatId;
    const recorded = (correlations: readonly Correlation[], episodeId?: string) => correlations.some(row => row.runId === run.id
      && (row.type === phase ? row.requestId === requestId && row.continuation === lifecycle.continuation
          && (!episodeId || row.episodeId === episodeId || row.episodeId === source.episodeId)
        : terminal && WEBHOOK_FINALS.includes(row.type) ? sourceChat(row) && row.continuation === lifecycle.continuation
        : !!episodeId && row.type === 'task.attention_required' && sourceChat(row)
          && row.episodeId === episodeId && row.continuation === lifecycle.continuation && row.requestId === requestId));
    if (recorded(this.deps.state.snapshot().correlations, episodeId)) {
      if (terminal) this.deliveredFinish.set(source.id, run.finishedAt ?? '');
      return true;
    }
    const revision = `${phase}:${lifecycle.continuation}:${episodeId ?? ''}:${requestId ?? ''}`;
    if (this.pendingRunReplies.has(revision)) return true;
    const retry = this.terminalRetries.get(source.id);
    if (terminal && retry?.revision === revision) {
      if (retry.fenced) return true;
      if (retry.nextAt > this.now()) { this.retryObserve = true; return false; }
    }
    const project = await this.deps.context().catch(() => undefined);
    if (!project) return false;
    const current = () => {
      const latest = project.store.getRun(run.id);
      return !this.closed && !!latest && this.sourceValid(latest)
        && runLifecycleSnapshot(latest).continuation === lifecycle.continuation
        && latest.status === lifecycle.status && latest.archived === lifecycle.archived
        && (terminal || (latest.attentionRequest?.requestId === requestId
          && (status !== 'waiting' || this.deps.episode(run.id) === episodeId)));
    };
    if (!current()) return false;
    // A waiting notice is answerable only as an attention correlation of the run's current episode.
    const episodeSequence = Number(episodeId?.slice(episodeId.lastIndexOf('-') + 1));
    const answerable = !!episodeId && Number.isSafeInteger(episodeSequence) && episodeSequence >= 1;
    if (recorded(this.deps.state.snapshot().correlations, episodeId) || this.pendingRunReplies.has(revision)) return true;
    const safe = (text: string) => telegramSafe(project, run.id, text, this.deps.receivers());
    const excerptAllowed = () => {
      const receiver = this.deps.receiver(source.receiverId);
      return current() && status === 'waiting' && !run.attentionRequest?.questions.length
        && receiver?.profile === 'standard' && receiver.includeAgentExcerpt === true;
    };
    const prose = (kind: 'excerpt' | 'answer') => safeAgentText({ dataDir: project.dataDir, runId: run.id,
      until: new Date(this.now()).toISOString(), kind, receivers: () => this.deps.receivers(), redact: safe });
    // The requester asked for this task, so its reply goes back to their private chat without the
    // excerpt opt-in — the final and a free-text question alike; /status never carries it (owner decision 2026-11-02).
    const replied = status === 'done' || status === 'review' || (status === 'waiting' && !run.attentionRequest?.questions.length);
    const answer = replied && !source.chatId.startsWith('-') ? await prose('answer') : undefined;
    let excerpt = !answer && excerptAllowed() ? await prose('excerpt') : undefined;
    if (excerpt && !excerptAllowed()) excerpt = undefined;
    // Reading a transcript yields: a newer event or another observer may have won meanwhile.
    if (!current()) return false;
    if (recorded(this.deps.state.snapshot().correlations, episodeId) || this.pendingRunReplies.has(revision)) return true;
    const title = safe(run.title);
    const error = run.error ? safe(run.error) : undefined;
    const questions = run.attentionRequest?.questions.map(question => {
      // Numbered like the buttons whenever two labels would look the same.
      const labels = telegramOptionLabels(project, run.id, question.options?.map(option => option.label) ?? [], this.deps.receivers());
      return { ...question, question: safe(question.question),
        ...(question.options ? { options: question.options.map((option, index) => ({ ...option, label: labels[index]!,
          ...(option.description ? { description: safe(option.description) } : {}) })) } : {}) };
    });
    const result = run.status === 'done' && run.completionReason ? readableCompletionReason[run.completionReason] : undefined;
    const mode = status === 'waiting' && answerable ? telegramAnswerMode(run) : 'text';
    const grant = mode === 'buttons' ? this.deps.state.snapshot().grants.find(row => row.id === source.grantId) : undefined;
    const buttons = grant ? this.conversation?.answerButtons(project, run, grant) : undefined;
    // With buttons, their note is the only reply hint.
    const pullRequest = run.pullRequestUrl ?? run.referencedPullRequestUrl;
    const rendered = renderTelegramTaskReply({ id: run.id, title, status, ...(excerpt ? { excerpt } : {}), ...(answer ? { answer } : {}), ...(result ? { result } : {}), ...(error ? { error } : {}), ...(questions ? { questions } : {}),
      links: { pullRequest: pullRequest ? safe(pullRequest) : undefined, issue: run.referencedIssueUrl ? safe(run.referencedIssueUrl) : undefined },
      privateChat: !source.chatId.startsWith('-'), ...(status === 'waiting' && (!answerable || buttons) ? { replyable: false } : {}) });
    const note = buttons ? TELEGRAM_ANSWER_NOTES.buttons : mode === 'multi_select' ? TELEGRAM_ANSWER_NOTES.multi_select : undefined;
    // The note is a convenience: a notice that cannot fit it still goes out, with its buttons.
    const noted = note ? `${rendered}\n\n${formatTelegramText(note)}` : rendered;
    const text = noted.length <= 4096 ? noted : rendered;
    const markFailed = () => this.deps.state.change(state => {
      const row = state.sources.find(row => row.id === source.id && row.runId === run.id);
      if (row?.state === 'finished') { row.state = 'delivery_failed'; row.updatedAt = this.now(); }
    }).catch(() => undefined);
    // Unreachable while the renderer bounds itself to 4096; kept as a fence, never a resend loop.
    if (text.length > 4096) { buttons?.release(); await markFailed(); return true; }
    const retryTerminal = () => {
      if (!terminal || !this.sourceValid(run)) return;
      const previous = this.terminalRetries.get(source.id);
      if (previous?.revision === revision && previous.fenced) return;
      const attempts = (previous?.revision === revision ? previous.attempts : 0) + 1;
      const fenced = attempts > 8;
      this.terminalRetries.set(source.id, { revision, attempts, fenced,
        nextAt: this.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempts - 1, 6)) });
      if (fenced) { void markFailed(); return; }
      this.observedSources.delete(source.id); this.retryObserve = true;
    };
    this.pendingRunReplies.add(revision);
    const accepted = this.replies.deliver(source.chatId, text, {
      key: terminal ? revision : progressKey, expiresInMs: terminal ? 7 * 86400_000 : 30 * 60_000,
      valid: () => current() && (!excerpt || excerptAllowed()),
      sent: async result => {
        await buttons?.sent(result);
        const receipt = z.object({ message_id: z.number().int().positive().safe().optional() }).safeParse(result);
        const messageId = receipt.success ? receipt.data.message_id : undefined;
        if (!messageId) { await markFailed(); return; }
        try {
          await this.deps.state.change(state => {
            if (recorded(state.correlations, answerable ? episodeId : undefined)) return;
            const binding = state.receivers.find(row => row.receiverId === source.receiverId);
            if (!binding) throw new Error('Telegram receiver disappeared');
            state.correlations.push({ receiverId: source.receiverId, chatId: source.chatId, messageId, deliveryRevision: binding.deliveryRevision,
              // The binding's current generation, so a reply to this notice still routes after a re-enable.
              bindingGeneration: state.binding.generation, enableGeneration: binding.generation, runId: run.id,
              ...(answerable ? { type: 'task.attention_required', sequence: episodeSequence, episodeId: episodeId!, continuation: lifecycle.continuation }
                : { type: phase, sequence: terminal ? 2 : 1, episodeId: episodeId ?? source.episodeId, continuation: lifecycle.continuation }),
              ...(requestId && run.attentionRequest ? { requestId, askedAt: run.attentionRequest.askedAt } : {}), createdAt: this.now() });
          });
        } catch {
          // Telegram accepted the message, but the receipt could not be made durable.
          // Fence this source so a recreated runtime never sends the same terminal notice again.
          await markFailed();
        }
      },
      failed: async () => { await markFailed(); },
      // Pending until the receipt is durable, so a run event during the send cannot queue a copy.
      settled: outcome => {
        buttons?.release(); this.pendingRunReplies.delete(revision);
        if (terminal && (outcome === 'sent' || outcome === 'failed')) {
          this.deliveredFinish.set(source.id, run.finishedAt ?? '');
          this.terminalRetries.set(source.id, { revision, attempts: 0, nextAt: 0, fenced: true });
        } else if (outcome !== 'stopped') retryTerminal();
      },
    }, buttons?.keyboard);
    if (!accepted) {
      buttons?.release(); this.pendingRunReplies.delete(revision);
      // Admission ceded this chat's final to the runtime: a full queue must not lose it.
      if (terminal) { retryTerminal(); return false; }
    }
    // Preparation completed; transport failure policy remains with the delivery path.
    return true;
  }
  /** Runs on every processed update: each newly settled source outcome must be delivered. */
  private async ensureRunObserver(): Promise<void> {
    if (this.closed) return;
    const sources = this.deps.state.snapshot().sources;
    // This set is bounded by the durable source journal, not the project's run count.
    const finished = new Set(sources.filter(source => source.state === 'finished').map(source => source.id));
    for (const id of this.observedSources) if (!finished.has(id)) this.observedSources.delete(id);
    for (const id of this.terminalRetries.keys()) if (!finished.has(id)) this.terminalRetries.delete(id);
    for (const id of this.deliveredFinish.keys()) if (!finished.has(id)) this.deliveredFinish.delete(id);
    for (const id of this.recoveredSources) if (!finished.has(id)) this.recoveredSources.delete(id);
    const uncertain = sources.some(source => source.state === 'uncertain');
    const unseen = sources.some(source => source.state === 'finished' && !this.observedSources.has(source.id));
    if (!sources.length || (this.unregisterRuns && !uncertain && !unseen && !sources.some(source => OUTCOME_STATES.includes(source.state)))) return;
    const project = !this.unregisterRuns || uncertain || unseen ? await this.deps.context().catch(() => undefined) : undefined;
    if (this.closed) return;
    // A crash between startRun and settleSource leaves an existing run marked uncertain; nobody said "Started" for it.
    if (project && uncertain) {
      const created = sources.filter(source => source.state === 'uncertain' && source.runId && project.store.getRun(source.runId)?.telegramSource?.id === source.id);
      if (created.length) await this.deps.state.change(state => {
        for (const row of state.sources) if (row.state === 'uncertain' && created.some(source => source.id === row.id)) {
          row.state = 'finished'; row.updatedAt = this.now(); this.recoveredSources.add(row.id);
        }
      }).catch(() => undefined);
    }
    for (const source of this.deps.state.snapshot().sources) {
      if (OUTCOME_STATES.includes(source.state)) void this.observeSourceOutcome(source).catch(() => undefined);
    }
    if (!project || this.closed) return;
    if (!this.unregisterRuns) {
      // Source outcomes come from the durable journal above: a run's copy of its source stays `claimed`.
      const listener = (run: RunRecord) => { void this.observeRun(run).catch(() => undefined); };
      project.store.on('run', listener); this.unregisterRuns = () => project.store.off('run', listener);
    }
    // Settlement can follow the last run event. Reconcile each newly durable source even
    // with an installed listener; never rescan all project runs on Telegram updates.
    for (const source of this.deps.state.snapshot().sources) {
      if (source.state !== 'finished' || !source.runId || this.observedSources.has(source.id)) continue;
      const run = project.store.getRun(source.runId);
      if (!run || run.telegramSource?.id !== source.id) continue;
      const reconciled = await this.observeRun(run).catch(() => false);
      if (reconciled) this.observedSources.add(source.id);
    }
  }
  start(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.startup ??= this.initialize();
  }
  private async initialize(): Promise<void> {
    try {
      const { lease, state, pairings, call, botId } = this.deps;
      await lease.validate(state.snapshot().binding);
      await this.deps.assertCredentials();
      if (this.closed) return;
      const me = identity.parse(await call('getMe', {}, this.startupAbort.signal));
      if (String(me.id) !== botId) throw new Error('bot_identity_changed');
      if (this.closed) return;
      this.username = me.username;
      // Best effort: the command menu is a convenience, never a reason to stop polling.
      void call('setMyCommands', { commands: TELEGRAM_COMMANDS }, this.startupAbort.signal).catch(() => undefined);
      this.replies = new TelegramReplies(call, this.deps.now, this.deps.budget);
      const membership = new GroupMembership((method, body) => call(method, body, this.startupAbort.signal), this.deps.now);
      const member = (chatId: string, userId: string) => membership.member(chatId, userId);
      this.actions = new TelegramActions({ budget: this.deps.budget, botId, state, call, now: this.deps.now, member, reply: (chat, text, valid) => { this.replies!.enqueue(chat, text, valid); } });
      const conversation = this.conversation = new TelegramConversation({ ...this.deps, active: () => !this.closed && this.deps.enabled?.() !== false, username: me.username, actions: this.actions, member,
        reply: (chat, text, valid, sent, button) => { this.replies!.enqueue(chat, text, valid, sent, button); } });
      this.poller = new TelegramPoller({ call, store: state, needed: () => this.needed(), now: this.deps.now,
        assertCredentials: this.deps.assertCredentials, allowedUpdates: ['message', 'callback_query', 'my_chat_member'],
        process: async (update, epoch) => {
          lease.assertOwner();
          if (this.closed || this.deps.enabled?.() === false) return;
          // A Confirm tap can create a task, so its source outcome needs the observer too.
          if (update.callback_query) { await this.actions!.process(update, epoch); await this.ensureRunObserver(); this.deps.changed(); return; }
          if (await processGroupEvent(state, update, epoch)) { this.deps.changed(); return; }
          const paired = update.message ? pairings.accept(botId, me.username, update.message) : 'ignored';
          if (paired !== 'ignored') {
            await state.finish(epoch, update.update_id);
            if (paired === 'wrong_chat') {
              const chatId = String(update.message!.chat.id);
              if (this.wrongChatNotices.allow(chatId)) this.replies!.enqueue(chatId, 'This pairing link belongs to another chat. Open it from the chat configured in the cezar cockpit.', () => !this.closed);
            }
            if (paired === 'candidate' && update.message) {
              const message = update.message, code = pairings.comparisonCode(botId, me.username, message);
              if (this.pairingNotices.allow(`pairing:${message.from!.id}`)) this.notify(String(message.chat.id), 'Pairing request received. Waiting for approval in cezar.');
              if (code) {
                if (this.wrongChatNotices.allow(`comparison:${message.from!.id}:${code}`)) {
                  this.replies!.enqueue(String(message.chat.id), `Comparison code: ${code}. Compare it with the code in the cezar cockpit before approving group access.`,
                    () => !this.closed && pairings.comparisonCode(botId, me.username, message) === code);
                }
              }
            }
            this.deps.changed(); return;
          }
          await conversation.process(update, epoch); await this.ensureRunObserver(); this.deps.changed();
        },
        onHealth: health => {
          if (['conflict', 'credentials-unavailable', 'blocked'].includes(health.state)) {
            void this.deps.state.change(snapshot => { snapshot.fatalStop = health.state as 'conflict' | 'credentials-unavailable' | 'blocked'; }).catch(() => undefined);
          }
          this.deps.changed();
        },
      });
      this.timer = setInterval(() => {
        pairings.prune(); this.replies?.prune(); this.actions?.prune();
        if (this.retryObserve) { this.retryObserve = false; void this.ensureRunObserver().catch(() => undefined); }
        if (!this.needed()) void this.stop().catch(() => undefined);
      }, 1000);
      this.timer.unref(); this.poller.start();
      await this.ensureRunObserver();
    } catch (error) {
      if (this.closed) return;
      const api = error instanceof TelegramApiError ? error : undefined;
      const state = api?.status === 401 ? 'credentials-unavailable' : api?.status === 409 ? 'conflict'
        : error instanceof BotOwnershipError || (error instanceof Error && error.message === 'bot_identity_changed')
          || (api && !(api.code === 'network' || api.code === 'dns_not_found' || api.status === 429 || (api.status ?? 0) >= 500)) ? 'blocked' : undefined;
      if (state) {
        this.startupHealth = { state };
        void this.deps.state.change(snapshot => { snapshot.fatalStop = state; }).catch(() => undefined);
      } else if (!this.poller) {
        // Transient (network, 5xx, 429, vault read): retry with bounded backoff. Health stays
        // 'stopped' meanwhile, so nothing advertises replies and an explicit enable restarts at once.
        this.startupHealth = undefined;
        const attempt = this.startupAttempts++;
        const delay = this.deps.startupRetryMs?.(attempt) ?? (api?.status === 429 ? (api.retryAfter ?? 5) * 1000 : Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6)));
        this.startupRetry = setTimeout(() => {
          this.startupRetry = undefined;
          if (this.closed) return;
          if (!this.needed()) { void this.stop().catch(() => undefined); return; }
          this.startup = this.initialize();
        }, delay);
        this.startupRetry.unref();
      }
      this.deps.changed();
    }
  }
  /** A timed-out shutdown retains the lease until every effect and writer has settled. */
  async stop(): Promise<boolean> {
    if (!this.closing) {
      this.closed = true;
      this.unregisterRuns?.(); this.unregisterRuns = undefined;
      this.actions?.clear();
      this.startupAbort.abort();
      if (this.timer) clearInterval(this.timer);
      if (this.startupRetry) clearTimeout(this.startupRetry);
      this.closing = (async () => {
        await this.startup?.catch(() => undefined);
        await Promise.all([this.poller?.stop(), this.replies?.stop()]);
        await this.deps.state.drain();
      })();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.closing.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
