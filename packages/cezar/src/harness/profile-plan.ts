import type { HarnessProfile } from './types.js';

export interface ResolvedRunnerRef {
  runner: 'claude' | 'codex' | 'opencode';
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  adapterId?: string;
}

export interface ResolvedAdvisorRef {
  runner: 'harness';
  model: string;
  family: string;
}

export type ResolvedReviewerRef = ResolvedRunnerRef | ResolvedAdvisorRef;

export interface ResolvedHarnessPlan {
  profile: HarnessProfile;
  orchestrator: ResolvedRunnerRef;
  implementer: ResolvedRunnerRef;
  reviewers: ResolvedReviewerRef[];
  reviewPolicy: 'advisory' | 'all-required' | 'quorum';
  packetized: boolean;
}

export type ResolveHarnessPlanResult =
  | { ok: true; plan: ResolvedHarnessPlan }
  | { ok: false; error: string };

function effortOf(value: unknown): ResolvedRunnerRef['effort'] {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'max') return value;
  if (value === 'xhigh') return 'max';
  return undefined;
}

function commandRunner(entry: Record<string, unknown>): ResolvedRunnerRef['runner'] | null {
  const commands = entry.commands as Record<string, unknown> | undefined;
  const command =
    (Array.isArray(commands?.worker) ? commands?.worker : undefined) ??
    (Array.isArray(commands?.review) ? commands?.review : undefined);
  const binary = command?.[0];
  if (binary === 'claude' || binary === 'codex' || binary === 'opencode') return binary;
  const family = entry.family;
  if (family === 'anthropic') return 'claude';
  if (family === 'openai') return 'codex';
  return null;
}

function runnerRef(id: string, entry: Record<string, unknown>): ResolvedRunnerRef | null {
  const runner = commandRunner(entry);
  if (!runner) return null;
  return {
    runner,
    model: typeof entry.model === 'string' ? entry.model : '',
    effort: effortOf(entry.reasoningEffort),
    adapterId: id,
  };
}

/**
 * Resolve one of the five public profiles against the trusted agentHarness
 * config. No fallback is implicit: a missing profile/model or unusable worker
 * is a preflight error with the exact binding named.
 */
export function resolveHarnessPlan(
  profile: HarnessProfile,
  agentHarness: Record<string, unknown> | undefined,
): ResolveHarnessPlanResult {
  const host: ResolvedRunnerRef = { runner: 'claude', model: '' };
  if (profile === 'standard') {
    return {
      ok: true,
      plan: {
        profile,
        orchestrator: host,
        implementer: host,
        reviewers: [],
        reviewPolicy: 'advisory',
        packetized: false,
      },
    };
  }
  if (!agentHarness) {
    return {
      ok: false,
      error: `profile "${profile}" requires agentHarness configuration — run cez-setup-harness`,
    };
  }
  const profiles = agentHarness.profiles as Record<string, unknown> | undefined;
  const configured = profiles?.[profile] as
    | {
        workers?: unknown;
        reviewers?: unknown;
        reviewPolicy?: { mode?: unknown; requiredReviewers?: unknown };
      }
    | undefined;
  if (!configured) {
    return { ok: false, error: `profile "${profile}" is not defined in agentHarness.profiles` };
  }
  const models = (agentHarness.models as Record<string, unknown> | undefined) ?? {};
  const workers = Array.isArray(configured.workers)
    ? configured.workers.filter((id): id is string => typeof id === 'string')
    : [];
  const reviewerIds = Array.isArray(configured.reviewers)
    ? configured.reviewers.filter((id): id is string => typeof id === 'string')
    : [];

  const needsWorker =
    profile === 'optimized' ||
    profile === 'multi-optimized' ||
    profile === 'high-assurance';
  const needsCouncil =
    profile === 'multi' ||
    profile === 'multi-optimized' ||
    profile === 'high-assurance';
  if (needsWorker && workers.length === 0) {
    return { ok: false, error: `profile "${profile}" requires a configured worker` };
  }
  if (profile === 'multi' && workers.length > 0) {
    return {
      ok: false,
      error: 'profile "multi" must use the host implementer; remove configured workers',
    };
  }
  if (profile === 'optimized' && reviewerIds.length > 0) {
    return {
      ok: false,
      error: 'profile "optimized" uses fresh host review; remove configured reviewers',
    };
  }
  if (needsCouncil && reviewerIds.length === 0) {
    return { ok: false, error: `profile "${profile}" requires a configured reviewer council` };
  }

  let implementer = host;
  if (workers.length > 0) {
    const workerId = workers[0]!;
    const entry = models[workerId];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: `profile "${profile}" references missing worker "${workerId}"` };
    }
    const resolved = runnerRef(workerId, entry as Record<string, unknown>);
    if (!resolved) {
      return {
        ok: false,
        error: `worker "${workerId}" has no supported claude/codex/opencode command binding`,
      };
    }
    implementer = resolved;
  }

  const reviewers: ResolvedReviewerRef[] = [];
  for (const reviewerId of reviewerIds) {
    const entry = models[reviewerId];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: `profile "${profile}" references missing reviewer "${reviewerId}"` };
    }
    const model = entry as Record<string, unknown>;
    const family = typeof model.family === 'string' ? model.family : undefined;
    if (!family) {
      return { ok: false, error: `reviewer "${reviewerId}" has no provider family` };
    }
    reviewers.push({ runner: 'harness', model: reviewerId, family });
  }

  const declaredMode = configured.reviewPolicy?.mode;
  const reviewPolicy =
    declaredMode === 'quorum'
      ? 'quorum'
      : declaredMode === 'all-required' || reviewerIds.length > 0
        ? 'all-required'
        : 'advisory';
  return {
    ok: true,
    plan: {
      profile,
      orchestrator: host,
      implementer,
      reviewers,
      reviewPolicy,
      packetized: profile === 'high-assurance',
    },
  };
}
