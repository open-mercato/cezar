type AuxiliaryMethod = 'answerCallbackQuery' | 'editMessageReplyMarkup';
export interface SendReservation { sent(): void; release(): void }
interface Ticket {
  id: string; chat: string; readyAt: number; expiresAt: number; valid(): boolean;
  /** True while its consumer cannot start the send now; a parked ticket never wins (spec 2026-10-29-telegram-setup-and-replies §Service boundaries). */
  parked?(): boolean;
}
/** A wall-clock deadline that never waits longer than the interval that set it. */
interface Deadline { until: number; span: number }
/** Telegram asks for at most minutes; a hostile or broken Retry-After cannot mute a bot for longer. */
export const MAX_TELEGRAM_COOLDOWN_MS = 3_600_000;
// 429 cooldowns outlive a recreated budget (webhook service recovery) within this process.
const sharedCooldowns = new Map<string, Deadline>();
/** Test seam: the registry is process-wide by design. */
export function clearSharedTelegramCooldowns(): void { sharedCooldowns.clear(); }
/** Controller-owned admission only: payloads stay in the reply queue or durable outbox. */
export class TelegramSendBudget {
  private tickets = new Map<string, Ticket>();
  private chats: string[] = [];
  private chatNext = new Map<string, Deadline>();
  private botNext: Deadline = { until: 0, span: 0 };
  private reserved?: symbol;
  private releaseListeners = new Set<() => void>();
  private keys = new Set<string>();
  private methodNext = new Map<AuxiliaryMethod, Deadline>();
  constructor(private readonly now: () => number = Date.now) {}
  /** Remaining wait, clamped so a backward wall-clock step cannot extend it. */
  private until(deadline: Deadline | undefined): number {
    if (!deadline) return 0;
    const now = this.now();
    if (deadline.until > now + deadline.span) deadline.until = now + deadline.span;
    return deadline.until;
  }
  private later(current: Deadline | undefined, until: number, cap = Number.POSITIVE_INFINITY): Deadline {
    const now = this.now(), span = Math.max(0, Math.min(cap, until - now));
    return this.until(current) >= now + span ? current! : { until: now + span, span };
  }
  private valid(ticket: Ticket): boolean {
    try { return ticket.expiresAt > this.now() && ticket.valid(); } catch { return false; }
  }
  private parked(ticket: Ticket): boolean {
    try { return ticket.parked?.() ?? false; } catch { return true; }
  }
  private prune(): void {
    for (const [id, ticket] of this.tickets) if (!this.valid(ticket)) this.tickets.delete(id);
    const live = new Set([...this.tickets.values()].map(ticket => ticket.chat));
    this.chats = this.chats.filter(chat => live.has(chat));
    for (const [chat, deadline] of this.chatNext) if (this.until(deadline) <= this.now()) this.chatNext.delete(chat);
  }
  offer(ticket: Ticket, firstInChat = false): boolean {
    this.prune();
    if (!this.valid(ticket)) { this.cancel(ticket.id); return false; }
    const previous = this.tickets.get(ticket.id);
    if (previous && previous.chat !== ticket.chat) this.cancel(ticket.id);
    if (!this.tickets.has(ticket.id) && this.tickets.size >= 200) {
      // Keep room for ephemeral command replies even when a durable
      // notification backlog fills the shared ticket cap.
      const reply = ticket.id === 'reply' || ticket.id.startsWith('reply:');
      if (!reply) return false;
      const evict = [...this.tickets.keys()].find(id => id !== 'reply' && !id.startsWith('reply:'));
      if (!evict) return false;
      this.tickets.delete(evict);
    }
    if (firstInChat) { this.tickets.delete(ticket.id); this.tickets = new Map([[ticket.id, ticket], ...this.tickets]); }
    else this.tickets.set(ticket.id, ticket);
    if (!this.chats.includes(ticket.chat)) this.chats.push(ticket.chat);
    return true;
  }
  cancel(id: string): void { this.tickets.delete(id); this.prune(); }
  /** Bind this budget to a bot credential so its 429 cooldown survives a recreated budget. */
  share(key: string): void {
    if (this.keys.has(key)) return;
    this.keys.add(key);
    const shared = sharedCooldowns.get(key);
    if (shared && this.until(shared) > this.now()) this.botNext = this.later(this.botNext, shared.until);
    else if (this.until(this.botNext) > this.now()) sharedCooldowns.set(key, this.botNext);
  }
  cooldown(until: number): void {
    if (!Number.isFinite(until)) return;
    this.botNext = this.later(this.botNext, until, MAX_TELEGRAM_COOLDOWN_MS);
    const now = this.now();
    for (const [key, deadline] of sharedCooldowns) if (this.until(deadline) <= now) sharedCooldowns.delete(key);
    for (const key of this.keys) sharedCooldowns.set(key, this.botNext);
  }
  /** Select the one globally-ready ticket; consumers must not filter before this point. */
  winner(): string | undefined {
    this.prune(); const now = this.now();
    if (this.reserved || this.until(this.botNext) > now) return;
    for (const chat of this.chats) {
      if (this.until(this.chatNext.get(chat)) > now) continue;
      // A delayed notification or retry must not hide a ready reply in the
      // same chat. Preserve insertion order among tickets that are ready.
      const ready = [...this.tickets.values()].find(ticket => ticket.chat === chat && ticket.readyAt <= now && !this.parked(ticket));
      if (ready) return ready.id;
    }
    return undefined;
  }
  methodReady(method: AuxiliaryMethod): boolean { return this.until(this.methodNext.get(method)) <= this.now(); }
  cooldownMethod(method: AuxiliaryMethod, until: number): void {
    if (Number.isFinite(until)) this.methodNext.set(method, this.later(this.methodNext.get(method), until, MAX_TELEGRAM_COOLDOWN_MS));
  }
  /** Reserve only for an already-ready durable claim, never for a timer or scheduler wait. */
  reserve(id: string): SendReservation | undefined {
    if (this.winner() !== id) return;
    const ticket = this.tickets.get(id)!, token = Symbol(); this.reserved = token; let sent = false;
    return {
      release: () => {
        if (this.reserved !== token) return;
        this.reserved = undefined;
        const listeners = [...this.releaseListeners]; this.releaseListeners.clear();
        for (const listener of listeners) try { listener(); } catch { /* A waiter cannot break release. */ }
      },
      sent: () => {
        if (this.reserved !== token || sent) return;
        sent = true; this.tickets.delete(id);
        this.chats = this.chats.filter(chat => chat !== ticket.chat);
        if ([...this.tickets.values()].some(row => row.chat === ticket.chat)) this.chats.push(ticket.chat);
        this.botNext = this.later(this.botNext, this.now() + 100);
        this.chatNext.set(ticket.chat, { until: this.now() + 1000, span: 1000 });
      },
    };
  }
  /** Run once when the current reservation is released (immediately when there is none). */
  afterRelease(listener: () => void): void {
    if (this.reserved) this.releaseListeners.add(listener); else listener();
  }
  take(id: string): boolean {
    const reservation = this.reserve(id); if (!reservation) return false;
    reservation.sent(); reservation.release(); return true;
  }
  /** Return the earliest time at which this budget can change its winner; never while a send is reserved. */
  nextCheck(): number {
    if (this.reserved) return Number.POSITIVE_INFINITY;
    this.prune();
    const now = this.now(), botNext = this.until(this.botNext);
    const deadlines: number[] = [];
    for (const ticket of this.tickets.values()) {
      deadlines.push(Math.max(now + 100, botNext, this.until(this.chatNext.get(ticket.chat)), ticket.readyAt));
    }
    return deadlines.length ? Math.min(...deadlines) : Math.max(now + 100, botNext);
  }
}
