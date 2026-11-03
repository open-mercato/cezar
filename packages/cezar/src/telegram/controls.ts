import { createHash } from 'node:crypto';
import type { ProjectContext } from '../server/project-context.ts';
import type { RunRecord } from '../runs/store.ts';
import { runLifecycleSnapshot } from '../runs/lifecycle.ts';
import { agentModelsLocked } from '../core/agent-model-policy.ts';
import { recordedProfileFor } from '../server/recorded-profile.ts';
import { cancelUserRun, continueUserRun, type ContinueDependencies } from '../server/run-controls.ts';

export class TelegramControlRefusal extends Error {
  constructor(readonly reason: 'account_unknown') { super(reason); }
}
export interface PreparedControl {
  summary: string;
  valid(): boolean;
  execute(check: () => string | undefined): Promise<boolean>;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fingerprint(project: ProjectContext, run: RunRecord): string {
  const session = [...run.steps].reverse().find(step => step.sessionId);
  return hash({ id: run.id, status: run.status, archived: run.archived ?? false,
    continuation: runLifecycleSnapshot(run).continuation, runner: run.runner, effectiveRunner: run.runner ?? 'claude',
    model: run.model ?? null, locked: agentModelsLocked(project.root), account: run.agentProfile ?? null,
    savedAccount: recordedProfileFor(run, run.runner ?? 'claude') ?? null,
    session: session ? [session.sessionId, session.backend, session.profileId] : null, lifecycle: run.worktreeLifecycle });
}
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')}…` : text;
const named = (run: RunRecord) => `task ${run.id.slice(0, 8)}${run.title ? ` · ${clip(run.title, 60)}` : ''}`;
/** Telegram requires recorded account affinity; the HTTP helper retains its existing defaults. */
export async function prepareTelegramControl(project: ProjectContext, run: RunRecord, kind: 'cancel' | 'continue', text: string,
  deps: ContinueDependencies): Promise<PreparedControl | undefined> {
  const saved = fingerprint(project, run);
  const valid = () => {
    const current = project.store.getRun(run.id);
    return !!current && !current.archived && fingerprint(project, current) === saved;
  };
  if (!valid()) return;
  if (kind === 'cancel') {
    if (!['queued', 'running', 'waiting'].includes(run.status)) return;
    return { summary: `Cancel ${named(run)}?`, valid,
      execute: async check => !check() && valid() && cancelUserRun(project, run.id).cancelled };
  }
  if (!['done', 'failed', 'cancelled', 'review'].includes(run.status) || !run.runner) return;
  const runner = run.runner, account = run.agentProfile ?? recordedProfileFor(run, runner);
  if (!account) throw new TelegramControlRefusal('account_unknown');
  if (!run.steps.some(step => step.sessionId) && !(run.worktreeLifecycle?.phase === 'setup' && run.worktreeLifecycle.state === 'cancelled')) return;
  const resolved = await deps.resolveProfile(runner, account);
  if ('error' in resolved || !valid()) return;
  const accountHash = hash(resolved.profile);
  const blocked = await deps.providerActionError([runner], { repoRoot: project.root, profileFor: () => account });
  if (blocked || !valid()) return;
  const model = agentModelsLocked(project.root) ? 'Backend settings' : run.model ?? 'Auto / backend default';
  return {
    summary: `Continue ${named(run)}?\nProvider: ${runner}\nAccount: ${account}\nModel: ${model}\nContinuing may incur costs.\n\n`
      + (text.trim() ? `Message:\n${text}` : 'No message: the agent picks up where it stopped.'), valid,
    execute: async check => {
      if (check() || !valid()) return false;
      const result = await continueUserRun(project, run, { text: text ? `[via Telegram] ${text}` : undefined, agentProfile: account }, {
        ...deps,
        resolveProfile: async (provider, profileId) => {
          const latest = await deps.resolveProfile(provider, profileId);
          return 'error' in latest || hash(latest.profile) !== accountHash ? { error: 'account_changed' } : latest;
        },
        beforeEffect: () => check() ?? (valid() ? undefined : 'configuration_changed'),
      });
      return result.status === 200;
    },
  };
}
