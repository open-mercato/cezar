import type { RunRecord } from '../runs/store.ts';
import { stepKind } from './types.ts';

/**
 * The model a continued turn runs on (#1488): the one the step that owns the session ran on,
 * else the run's. `StepState.model` is the raw model a turn was spawned with ('' = deliberately
 * auto); a record that predates it falls back to the owning step's `model:` in `workflowDef`.
 * A pin belongs to its step's runner, so a runner that differs from `backend` never lends it.
 * Returns `undefined` for "let the backend pick"; the caller applies `agentModelsLocked`.
 */
export function resolveContinuationModel(
  record: RunRecord | undefined,
  turnStepId: string,
  sessionId: string | undefined,
  backend: string,
): string | undefined {
  if (!record) return undefined;
  const asModel = (value: string): string | undefined => (value === '' ? undefined : value);
  // An explicit pick in the Continue composer is stamped on the new turn's own step.
  const explicit = record.steps.find((s) => s.id === turnStepId)?.model;
  if (explicit !== undefined) return asModel(explicit);
  // A fresh session (backend or account switch) owns no step: the run's model applies.
  if (sessionId === undefined) return record.model;
  const sameSession = record.steps.filter((s) => s.sessionId === sessionId && s.id !== turnStepId);
  const latest = [...sameSession].reverse().find((s) => s.model !== undefined);
  if (latest?.model !== undefined) return asModel(latest.model);
  const owner = sameSession[0];
  const def = owner ? record.workflowDef?.steps.find((s) => s.id === owner.id) : undefined;
  if (def && stepKind(def) === 'agent' && def.model && (def.runner === undefined || def.runner === backend)) {
    return def.model;
  }
  return record.model;
}
