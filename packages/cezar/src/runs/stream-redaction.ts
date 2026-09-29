import { redactSecrets } from '../core/secret-redaction.ts';

type WireEvent = { type: string; stepId?: string; [key: string]: unknown };
type Pending = { itemId: string; field: string; stepId?: string; text: string };

/** Keep only an unresolved known-secret prefix between live delta frames.
 * Safe prose keeps streaming; memory per field is bounded by the longest
 * registered secret. Snapshot replacements reset the same field's context.
 */
export class StreamRedaction {
  private readonly runs = new Map<string, Map<string, Pending>>();

  transform(runId: string, event: WireEvent, secrets: readonly string[]): WireEvent {
    if (event.type === 'item.delta' && typeof event.itemId === 'string' &&
        typeof event.field === 'string' && typeof event.delta === 'string') {
      const context = { itemId: event.itemId, field: event.field, ...(event.stepId !== undefined ? { stepId: event.stepId } : {}) };
      const key = this.key(context);
      const pending = this.runs.get(runId)?.get(key)?.text ?? '';
      return { ...event, delta: this.split(runId, context, pending + event.delta, secrets) };
    }
    if ((event.type === 'item.started' || event.type === 'item.updated') &&
        event.item && typeof event.item === 'object') {
      const item = event.item as Record<string, unknown>;
      if (typeof item.id !== 'string') return event;
      const field = item.kind === 'tool' ? 'output' : item.kind === 'reasoning' ? 'reasoning' : 'text';
      const property = field === 'output' ? 'output' : 'text';
      const text = typeof item[property] === 'string' ? item[property] as string : '';
      const safe = this.split(runId, { itemId: item.id, field, ...(event.stepId !== undefined ? { stepId: event.stepId } : {}) }, text, secrets);
      return { ...event, item: { ...item, ...(typeof item[property] === 'string' ? { [property]: safe } : {}) } };
    }
    return event;
  }

  /** Drain before the terminal event receives its sequence number. These
   * tails cannot be full credentials: split() retained only proper prefixes.
   */
  drain(runId: string, event: WireEvent): WireEvent[] {
    const completed = event.type === 'item.completed';
    if (!completed && event.type !== 'turn.completed' && event.type !== 'session.ended') return [];
    const item = event.item as { id?: unknown } | undefined;
    const fields = this.runs.get(runId);
    if (!fields) return [];
    const result: WireEvent[] = [];
    for (const [key, pending] of fields) {
      if (pending.stepId !== event.stepId || (completed && pending.itemId !== item?.id)) continue;
      fields.delete(key);
      result.push({ type: 'item.delta', itemId: pending.itemId, field: pending.field,
        ...(pending.stepId !== undefined ? { stepId: pending.stepId } : {}), delta: pending.text });
    }
    if (fields.size === 0) this.runs.delete(runId);
    return result;
  }

  clear(runId: string): void { this.runs.delete(runId); }

  private key(context: Omit<Pending, 'text'>): string {
    return JSON.stringify([context.stepId, context.itemId, context.field]);
  }

  private split(runId: string, context: Omit<Pending, 'text'>, text: string, secrets: readonly string[]): string {
    const safe = redactSecrets(text, secrets);
    let keep = 0;
    for (const secret of secrets) {
      for (let length = Math.min(secret.length - 1, safe.length); length > keep; length--) {
        if (safe.endsWith(secret.slice(0, length))) { keep = length; break; }
      }
    }
    const key = this.key(context);
    if (keep > 0) {
      let fields = this.runs.get(runId);
      if (!fields) { fields = new Map(); this.runs.set(runId, fields); }
      fields.set(key, { ...context, text: safe.slice(-keep) });
    } else {
      const fields = this.runs.get(runId);
      fields?.delete(key);
      if (fields?.size === 0) this.runs.delete(runId);
    }
    return keep ? safe.slice(0, -keep) : safe;
  }
}
