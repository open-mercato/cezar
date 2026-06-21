// Shared types for the per-action model + acceptance configuration.
// Used by the loader (page.tsx), the save mutations, and the form view.

export type ActionModel = 'claude-opus-4-7' | 'claude-sonnet-4-6' | 'claude-haiku-4-5';

export type AcceptanceMode = 'auto' | 'human-in-the-loop';

export interface AutoConfidenceConfig {
  autoAcceptAbove: number;
}

export interface HitlConfidenceConfig {
  autoDenyBelow: number;
  autoAcceptAbove: number;
}

export type ConfidenceConfig = AutoConfidenceConfig | HitlConfidenceConfig;

export const DEFAULT_MODEL: ActionModel = 'claude-sonnet-4-6';
export const DEFAULT_ACCEPTANCE_MODE: AcceptanceMode = 'auto';
export const DEFAULT_AUTO_CONFIG: AutoConfidenceConfig = { autoAcceptAbove: 0 };
export const DEFAULT_HITL_CONFIG: HitlConfidenceConfig = {
  autoDenyBelow: 60,
  autoAcceptAbove: 92,
};

export const KNOWN_MODELS: ActionModel[] = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
];

export function isAcceptanceMode(v: unknown): v is AcceptanceMode {
  return v === 'auto' || v === 'human-in-the-loop';
}

export function isActionModel(v: unknown): v is ActionModel {
  return typeof v === 'string' && (KNOWN_MODELS as string[]).includes(v);
}

/**
 * Coerce an unknown DB value into a valid ConfidenceConfig for the given
 * mode. Missing / malformed values fall back to the per-mode defaults.
 * Always returns the shape that matches `mode`, even if the stored row was
 * written under the other mode (lets the user toggle modes safely without
 * losing the runner's invariant).
 */
export function coerceConfidenceConfig(value: unknown, mode: AcceptanceMode): ConfidenceConfig {
  const obj = (value && typeof value === 'object' ? (value as Record<string, unknown>) : {}) ?? {};
  const clamp = (v: unknown, fallback: number): number => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(100, Math.round(n)));
  };

  if (mode === 'auto') {
    return {
      autoAcceptAbove: clamp(obj.autoAcceptAbove, DEFAULT_AUTO_CONFIG.autoAcceptAbove),
    };
  }
  // Floor `high` at 1 so the `low < high` invariant can hold even when the
  // stored row came from `mode: 'auto'` with autoAcceptAbove: 0.
  const high = Math.max(1, clamp(obj.autoAcceptAbove, DEFAULT_HITL_CONFIG.autoAcceptAbove));
  const low = clamp(obj.autoDenyBelow, DEFAULT_HITL_CONFIG.autoDenyBelow);
  // Enforce invariant: 0 <= low < high.
  return {
    autoDenyBelow: Math.max(0, Math.min(low, high - 1)),
    autoAcceptAbove: high,
  };
}

/**
 * Validate a payload arriving from the form before writing to the DB.
 * Returns the canonicalised value or an error message.
 */
export function validateConfidenceConfig(
  mode: AcceptanceMode,
  raw: unknown,
): { ok: true; value: ConfidenceConfig } | { ok: false; error: string } {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const toInt = (v: unknown): number | null => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    const n = Math.round(v);
    if (n < 0 || n > 100) return null;
    return n;
  };

  const high = toInt(obj.autoAcceptAbove);
  if (high === null) return { ok: false, error: 'autoAcceptAbove must be a number in 0..100' };

  if (mode === 'auto') {
    return { ok: true, value: { autoAcceptAbove: high } };
  }

  const low = toInt(obj.autoDenyBelow);
  if (low === null) return { ok: false, error: 'autoDenyBelow must be a number in 0..100' };
  if (low >= high)
    return { ok: false, error: 'autoDenyBelow must be strictly less than autoAcceptAbove' };
  return { ok: true, value: { autoDenyBelow: low, autoAcceptAbove: high } };
}
