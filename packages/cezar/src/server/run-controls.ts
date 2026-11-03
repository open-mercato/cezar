import type { AttachmentEntry, ContinueInput, ContinueResponse } from '@open-mercato/cezar-contract';
import type { ProviderId } from '../core/provider-auth.ts';
import { AGENT_MODELS_LOCKED_ERROR, agentModelsLocked } from '../core/agent-model-policy.ts';
import type { RunRecord } from '../runs/store.ts';
import type { PastedContent } from '../workflows/run.ts';
import type { ProjectContext } from './project-context.ts';
import { providerForExistingRun, recordedProfileFor, type ProviderAccountScope } from './provider-action-gate.ts';

export interface ContinueDependencies {
  providerActionError(required: readonly ProviderId[], scope: ProviderAccountScope): Promise<string | null>;
  resolveProfile(provider: ProviderId, profileId?: string): Promise<{ profile: unknown } | { error: string }>;
  resolveAttachments(entries: AttachmentEntry[] | undefined): PastedContent[] | string;
  /** HTTP leaves this absent; remote adapters revalidate after asynchronous gates. */
  beforeEffect?(): string | undefined;
}
/** Receipt ownership remains with HTTP; every caller keeps the same engine/account checks. */
export async function continueUserRun(project: Pick<ProjectContext, 'root' | 'manager'>, run: RunRecord, input: ContinueInput, deps: ContinueDependencies):
Promise<{ status: 200; body: ContinueResponse } | { status: 400 | 409; body: { error: string | undefined } }> {
  if (agentModelsLocked(project.root) && input.model?.trim()) return { status: 409, body: { error: AGENT_MODELS_LOCKED_ERROR } };
  const blocked = await deps.providerActionError([providerForExistingRun(run, input.runner)], {
    repoRoot: project.root,
    // A runner switch drops the run's account (`continueRun`), so only the same runner inherits it.
    profileFor: provider => input.agentProfile ?? (provider === (run.runner ?? 'claude') ? recordedProfileFor(run, provider) : undefined),
  });
  if (blocked) return { status: 409, body: { error: blocked } };
  // A deleted account id answers 400 rather than reopening on another login (billing boundary).
  if (input.agentProfile !== undefined) {
    const account = await deps.resolveProfile(providerForExistingRun(run, input.runner), input.agentProfile);
    if ('error' in account) return { status: 400, body: { error: account.error } };
  }
  const images = deps.resolveAttachments(input.images);
  if (typeof images === 'string') return { status: 400, body: { error: images } };
  const refused = deps.beforeEffect?.();
  if (refused) return { status: 409, body: { error: refused } };
  const result = project.manager.continueRun(run.id, { text: input.text, images, runner: input.runner, model: input.model, agentProfile: input.agentProfile });
  return result.ok ? { status: 200, body: { continued: true } } : { status: 409, body: { error: result.error } };
}
export function cancelUserRun(project: Pick<ProjectContext, 'manager'>, id: string): { cancelled: boolean } {
  return { cancelled: project.manager.cancel(id) };
}
