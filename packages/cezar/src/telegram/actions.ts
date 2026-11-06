import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TelegramApiError, type TelegramCall } from './client.ts';
import type { TelegramSendBudget } from './send-budget.ts';
import type { TelegramUpdate } from './protocol.ts';
import type { InboundStateStore, JournalEntry } from './state.ts';

export interface ActionPreview {
  kind: 'cancel' | 'continue' | 'task' | 'answer'; receiverId: string; chatId: string; userId: string; runId?: string;
  /** Captures the grant generations and task/configuration fingerprint at preview time. */
  valid(): boolean;
  responseValid?(): boolean;
  execute?(check: () => string | undefined): Promise<boolean>;
  /** Owns the durable claim, effect, settlement and reply itself; `choice` is the tapped button. */
  perform?(update: { epoch: string; updateId: number; entry: JournalEntry }, check: () => string | undefined, choice: number): Promise<void>;
  /** Buttons sharing this one-time action, one callback id each (option buttons); default 1. */
  choices?: number;
  ttlMs?: number;
}
interface Pending extends ActionPreview { ids: string[]; expiresAt: number; messageId?: number }
export interface PendingAction { data: string; choices: string[]; valid(): boolean; sent(raw: unknown): Promise<void>; release(): void }
const JOURNAL_KIND = { cancel: 'cancel', continue: 'continue', task: 'task', answer: 'answer' } as const;
const confirmed = (action: Pending) => {
  const task = action.runId ? `task ${action.runId.slice(0, 8)}` : 'the task';
  return action.kind === 'cancel' ? `Cancelled ${task}.` : action.kind === 'continue' ? `Continuing ${task}.` : 'Done.';
};
const receipt = z.object({ message_id: z.number().int().positive().safe(), chat: z.object({ id: z.number().int().safe() }) });

/** Ephemeral capabilities; durable intent lives in the inbound journal, never in callback_data. */
export class TelegramActions {
  private readonly pending = new Map<string, { action: Pending; choice: number }>();
  constructor(private readonly deps: {
    budget?: TelegramSendBudget; botId: string; state: InboundStateStore; call: TelegramCall; now?: () => number;
    reply(chatId: string, text: string, valid: () => boolean): void;
    /** Group membership re-check; undefined from it means Telegram could not say. */
    member?(chatId: string, userId: string): Promise<boolean | undefined>;
  }) {}
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private valid(action: Pending): boolean {
    try { return action.expiresAt > this.now() && action.valid(); } catch { return false; }
  }
  prune(): void { for (const [id, row] of this.pending) if (!this.valid(row.action)) this.pending.delete(id); }
  clear(): void { this.pending.clear(); }
  private actions(): Pending[] { return [...new Set([...this.pending.values()].map(row => row.action))]; }
  private drop(action: Pending): void { for (const id of action.ids) if (this.pending.get(id)?.action === action) this.pending.delete(id); }
  create(preview: ActionPreview): PendingAction | undefined {
    this.prune();
    const choices = preview.choices ?? 1, actions = this.actions();
    // Limits count actions, not buttons: one question's option row is one pending answer.
    if (!preview.valid() || choices < 1 || choices > 10 || actions.length >= 100 || actions.filter(row => row.userId === preview.userId).length >= 5) return;
    const ids = Array.from({ length: choices }, () => randomBytes(24).toString('base64url'));
    const action: Pending = { ...preview, ids, expiresAt: this.now() + Math.min(preview.ttlMs ?? 120_000, 15 * 60_000) };
    ids.forEach((id, choice) => this.pending.set(id, { action, choice }));
    return { data: ids[0]!, choices: ids, valid: () => this.pending.get(ids[0]!)?.action === action && this.valid(action), sent: async raw => {
      const result = receipt.safeParse(raw);
      if (!result.success || String(result.data.chat.id) !== action.chatId || !this.valid(action)) { this.drop(action); return; }
      // A retried send can produce a second message; only the acknowledged receipt authorizes clicks.
      action.messageId = result.data.message_id;
    }, release: () => { if (action.messageId === undefined) this.drop(action); } };
  }
  private async call(method: 'answerCallbackQuery' | 'editMessageReplyMarkup', body: object): Promise<void> {
    if (this.deps.budget?.methodReady(method) === false) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.deps.call(method, body, controller.signal), new Promise<void>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(); }, 1500);
      })]);
    } catch (error) {
      if (error instanceof TelegramApiError && error.status === 429) this.deps.budget?.cooldownMethod(method, this.now() + (error.retryAfter ?? 5) * 1000);
      // Telegram UI cleanup cannot authorize or undo a task action.
    }
    finally { if (timer) clearTimeout(timer); }
  }
  async process(update: TelegramUpdate, epoch: string): Promise<void> {
    const callback = update.callback_query;
    if (!callback) return;
    // A replayed update was already acknowledged and must not consume or answer anything again.
    if (this.deps.state.duplicate(epoch, update.update_id)) return;
    const row = callback.data ? this.pending.get(callback.data) : undefined, action = row?.action;
    const shown = action && !callback.from.is_bot && callback.message && !callback.message.chat.is_forum
      && String(callback.message.chat.id) === action.chatId && callback.message.message_id === action.messageId && this.valid(action);
    const matches = shown && String(callback.from.id) === action.userId;
    // Consume synchronously, before acknowledging or writing: different update IDs must not race.
    if (matches) this.drop(action);
    const member = matches && action.chatId.startsWith('-') && this.deps.member ? await this.deps.member(action.chatId, action.userId).catch(() => undefined) : true;
    const acknowledgment = this.call('answerCallbackQuery', { callback_query_id: callback.id,
      text: !matches ? (shown ? 'This button belongs to another person.'
        : 'This button is no longer available: it expired, was used, or the task changed. Send the command again.')
        : member === false ? 'You are no longer a member of this group, so this was not carried out.'
          : member === undefined ? 'Could not confirm your group membership. Nothing was done; try again in a minute.'
            : action.kind === 'answer' ? 'Sending your answer…' : 'Checking confirmation…' });
    try {
      const { state } = this.deps;
      if (!matches) {
        await state.finish(epoch, update.update_id, { id: randomUUID(), epoch, updateId: update.update_id, at: this.now(), botId: this.deps.botId,
          kind: 'rejection_summary', state: 'rejected', reason: 'unauthorized', count: 1 }); return;
      }
      const entry: JournalEntry = { id: randomUUID(), actionId: action.ids[0], epoch, updateId: update.update_id, at: this.now(),
        botId: this.deps.botId, receiverId: action.receiverId, chatId: action.chatId, userId: action.userId,
        ...(action.runId ? { runId: action.runId } : {}), kind: JOURNAL_KIND[action.kind], state: 'claimed', reason: 'pending' };
      if (member !== true) { await state.finish(epoch, update.update_id, { ...entry, state: 'rejected', reason: member === false ? 'not_member' : 'membership_unknown' }); return; }
      if (action.perform) {
        await action.perform({ epoch, updateId: update.update_id, entry }, () => this.valid(action) ? undefined : 'action_changed', row!.choice);
        return;
      }
      if (!await state.claim(entry)) return;
      let outcome: JournalEntry['state'] = 'rejected', reason = 'action_changed';
      try {
        if (this.valid(action) && action.execute) {
          const accepted = await action.execute(() => this.valid(action) ? undefined : 'action_changed');
          outcome = accepted ? 'accepted' : 'rejected'; reason = accepted ? 'executed' : 'action_refused';
        }
      } catch { outcome = 'uncertain'; reason = 'action_uncertain'; }
      await state.finish(epoch, update.update_id, { ...entry, state: outcome, reason });
      this.deps.reply(action.chatId, outcome === 'accepted' ? confirmed(action) : outcome === 'uncertain'
        ? 'The result is uncertain. Check the task in the cockpit before trying again.' : 'Not completed. Check the task state and your permissions in the cockpit.', () => {
          try { return (action.responseValid ?? action.valid)(); } catch { return false; }
        });
    } finally {
      await acknowledgment;
      if (matches) await this.call('editMessageReplyMarkup', { chat_id: action.chatId, message_id: action.messageId, reply_markup: { inline_keyboard: [] } });
    }
  }
}
