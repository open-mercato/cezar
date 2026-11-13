import type { RunnerId } from './agent-runner.ts';
import type { ModelOption } from './runner-model-catalog.ts';

/** Metadata is advisory; the native runner catalog alone establishes availability. */
export interface RoutingMetadata {
  id: string;
  context?: number;
  reasoning?: boolean;
  toolCall?: boolean;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  deprecated?: boolean;
}
export interface RoutingCandidate {
  runner: RunnerId;
  option: ModelOption;
  metadata?: RoutingMetadata;
  /** Smoothed success rate from at least five comparable prior steps. */
  historicalSuccessRate?: number;
}
export interface RoutingChoice {
  runner: RunnerId;
  model: string;
  reasoningEffort?: string;
  reason: string;
}
export interface RoutingTask {
  text: string;
  preferredRunner: RunnerId;
  allowedRunner?: RunnerId;
  verificationFailures?: number;
}

/** An explicit pin, a resumed session, or a fallback episode owns its choice. */
export function shouldUseAdaptiveRouting(input: {
  enabled: boolean;
  dryRun: boolean;
  locked: boolean;
  taskModel?: string;
  stepModel?: string;
  accountPinned?: boolean;
  resuming?: boolean;
  fallingBack?: boolean;
}): boolean {
  return input.enabled && !input.dryRun && !input.locked && !input.taskModel &&
    !input.stepModel && !input.accountPinned && !input.resuming && !input.fallingBack;
}

/** One failed check is normal feedback; escalation begins after repeated failures. */
export function shouldEscalateFromChecks(hasFailure: boolean, iterations: number): boolean {
  return hasFailure && iterations >= 3;
}

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** A deterministic local policy. No prompt or repository content is sent to a classifier. */
export function selectAdaptiveModel(task: RoutingTask, candidates: readonly RoutingCandidate[]): RoutingChoice | undefined {
  const critical = task.verificationFailures! > 0 || /\b(security|migration|production|incident|race condition|data loss|authenticat|cryptograph)\b/i.test(task.text);
  const large = task.text.length > 3000 || /\b(architecture|refactor|multi[- ]package|complex)\b/i.test(task.text);
  const requiredContext = Math.max(8_000, Math.ceil(task.text.length / 3) * 4);
  const eligible = candidates.filter((candidate) =>
    (!task.allowedRunner || candidate.runner === task.allowedRunner) &&
    !candidate.metadata?.deprecated &&
    (candidate.historicalSuccessRate === undefined || candidate.historicalSuccessRate >= 0.5) &&
    candidate.metadata?.toolCall !== false &&
    (candidate.metadata?.context === undefined || candidate.metadata.context >= requiredContext));
  if (!eligible.length) return undefined;
  const price = (candidate: RoutingCandidate): number | undefined => {
    const meta = candidate.metadata;
    return meta?.inputUsdPerMillion !== undefined && meta.outputUsdPerMillion !== undefined
      ? meta.inputUsdPerMillion * 3 + meta.outputUsdPerMillion
      : undefined;
  };
  const priced = eligible.flatMap((candidate) => price(candidate) === undefined ? [] : [price(candidate)!]);
  const low = Math.min(...priced);
  const high = Math.max(...priced);
  const score = (candidate: RoutingCandidate): number => {
    const meta = candidate.metadata;
    const cost = price(candidate);
    const costRank = cost === undefined || !Number.isFinite(low) || high === low ? 0.5 : (cost - low) / (high - low);
    const capability = (meta?.reasoning === true ? 1 : meta?.reasoning === false ? 0 : 0.5) +
      Math.min(1, Math.log2((meta?.context ?? 128_000) / 32_000) / 5);
    const preference = candidate.runner === task.preferredRunner ? 0.12 : 0;
    const reliability = candidate.historicalSuccessRate === undefined ? 0 : (candidate.historicalSuccessRate - 0.5) * 1.5;
    return (critical ? capability * 2.5 - costRank * 0.3 : large ? capability * 1.4 - costRank * 0.7 : capability * 0.3 - costRank * 1.5) + preference + reliability;
  };
  const best = [...eligible].sort((a, b) => score(b) - score(a) ||
    a.runner.localeCompare(b.runner) || a.option.id.localeCompare(b.option.id))[0]!;
  const efforts = (best.option.reasoningEfforts ?? []).map((entry) => entry.id)
    .filter((id) => EFFORTS.includes(id));
  const desired = critical ? 'high' : large ? 'medium' : 'low';
  const selectedEffort = efforts.find((id) => id === desired)
    ?? efforts.filter((id) => EFFORTS.indexOf(id) <= EFFORTS.indexOf(desired)).at(-1)
    ?? efforts[0];
  return {
    runner: best.runner,
    model: best.option.id,
    ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}),
    reason: critical ? 'critical task or repeated verification failure' : large ? 'large or architectural task' : 'ordinary task',
  };
}
