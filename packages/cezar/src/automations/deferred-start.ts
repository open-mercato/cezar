import { probeCodexIdentity } from '../core/codex-usage-probe.ts';
import { createHash } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { localTimeZone, onceInstant, type DeferredBinding, type DeferredPreviewInput, type DeferredPreview, type DeferredOptions, type AutomationSchedule } from '@open-mercato/cezar-contract';
import { loadConfig } from '../config.ts';
import { agentModelsLocked } from '../core/agent-model-policy.ts';
import { loadWorkflows } from '../workflows/load.ts';
import { forkOfBranch } from '../workflows/graph.ts';
import { stepsIssue, stepKind, workflowStepSchema, type WorkflowDef } from '../workflows/types.ts';
import { loadAgentAccounts, DEFAULT_AGENT_ACCOUNT_ID, selectionFor } from '../workspace/agent-accounts.ts';
import { selectProfile } from '../workspace/agent-profiles.ts';
import type { AutomationDefinition } from './types.ts';

class DeferredResolutionError extends Error {}
export class DeferredPrelaunchError extends Error {}
export class DeferredBindingError extends DeferredPrelaunchError {}

export function digest(value: unknown): string {
  function stable(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)]));
    return v;
  }
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

/** Expand actual workflow runners before requiring any provider profile directory. */
async function resolveDeferredPlan(root: string, task: DeferredPreviewInput['task']) {
  // shortcut: deferred bindings pin native accounts only; support API ownership before scheduling it.
  if (task.llmProviderId) throw new DeferredResolutionError('Tasks using an API provider can only start now.');
  const config = await loadConfig(root);
  if (agentModelsLocked(root) && task.model?.trim()) throw new Error('Model selection is locked for this project.');
  const catalog = (await loadWorkflows(root)).workflows;
  let workflow: WorkflowDef | undefined;
  if (task.steps) {
    const parsedSteps = task.steps.map(step => workflowStepSchema.parse(step));
    const issue = stepsIssue(parsedSteps);
    if (issue) throw new Error(issue);
    workflow = { name: '(planned)', source: 'built-in', steps: parsedSteps };
  } else workflow = catalog.find(w => w.name === task.workflow);
  if (!workflow) throw new Error('The selected workflow is unavailable.');
  const runner = task.runner ?? config.defaultRunner;
  const store = await loadAgentAccounts();
  const locked = agentModelsLocked(root);
  const models: { runner: string; model?: string; step?: string }[] = [];
  const references: WorkflowDef[] = [];
  type Context = { runner: typeof runner; model?: string; agentProfile?: string };
  type Work = Context & { step: string };
  const work: Work[] = [];
  let visits = 0;
  // Bounds apply to expanded occurrences, not unique names: a wide DAG can grow exponentially.
  function visit(def: WorkflowDef, context: Context, ancestors: string[], prefix = ''): void {
    if (ancestors.includes(def.name)) throw new DeferredResolutionError(`Workflow reference cycle: ${[...ancestors, def.name].join(' → ')}.`);
    if (ancestors.length >= 32) throw new DeferredResolutionError('Workflow reference depth limit (32) exceeded.');
    const childContext = (node: { runner?: typeof runner; model?: string }): Context => {
      const childRunner = node.runner ?? task.dispatch?.runner ?? context.runner;
      // Mirrors dispatch() in run.ts: an inherited model only follows its own runner (43bdda11).
      const inherited = (model: string | undefined, owner: typeof runner) => owner === childRunner ? model : undefined;
      return {
        runner: childRunner,
        model: locked ? undefined : (node.model || (inherited(task.dispatch?.model, task.dispatch?.runner ?? context.runner)
          ?? inherited(context.model, context.runner))) || undefined,
        // dispatch() does not carry the parent's composer account override into startRun().
      };
    };
    for (const node of def.graph?.nodes ?? def.steps) {
      if (++visits > 4096) throw new DeferredResolutionError('Workflow expansion limit (4096 nodes) exceeded.');
      const step = `${prefix}${node.id}`;
      if (!('type' in node)) {
        if (stepKind(node) !== 'agent') continue;
        const backend = node.runner ?? context.runner;
        // Same rule as runAgentStep: the task's model only follows its own runner.
        work.push({ ...context, runner: backend, model: locked ? undefined : node.model ?? (backend === context.runner ? context.model : undefined),
          agentProfile: backend === context.runner ? context.agentProfile : undefined, step });
      } else if (node.type === 'workflow') {
        const child = catalog.find(w => w.name === node.workflow);
        if (!child) throw new DeferredResolutionError(`Referenced workflow "${node.workflow}" is unavailable.`);
        references.push(child);
        visit(child, childContext(node), [...ancestors, def.name], `${step}/`);
      } else if (node.type === 'dispatch' || node.type === 'agent' && def.graph && forkOfBranch(def.graph, node.id)) {
        work.push({ ...childContext(node), step });
      } else if (node.type === 'agent') {
        const backend = node.runner ?? context.runner;
        // Same rule as runAgentStep: the task's model only follows its own runner.
        work.push({ ...context, runner: backend, model: locked ? undefined : node.model ?? (backend === context.runner ? context.model : undefined),
          agentProfile: backend === context.runner ? context.agentProfile : undefined, step });
      }
    }
  }
  visit(workflow, { runner, model: locked ? undefined : task.model, agentProfile: task.agentProfile }, []);
  models.push(...work.map(step => ({ runner: step.runner, step: step.step, model: step.model })));
  return { workflow, runner, store, references, work, models };
}

async function bindDeferredPlan(root: string, plan: Awaited<ReturnType<typeof resolveDeferredPlan>>) {
  const { workflow, runner, store, references, work, models } = plan;
  const accounts: DeferredBinding['accounts'] = [];
  for (const step of work) {
    const backend = step.runner;
    const chosen = step.agentProfile ?? selectionFor(store, root, backend) ?? DEFAULT_AGENT_ACCOUNT_ID;
    if (backend === 'pi' && chosen !== DEFAULT_AGENT_ACCOUNT_ID) throw new Error('Pi supports only the default account.');
    if (chosen !== DEFAULT_AGENT_ACCOUNT_ID && !store.accounts.some(a => a.id === chosen && a.provider === backend)) throw new Error('The selected account no longer exists.');
    let account: DeferredBinding['accounts'][number];
    if (backend === 'pi') {
      // Pi carries no per-provider profile/env. Its discovery-only Claude fallback
      // is not an execution dependency. An empty path binds the native default,
      // not a filesystem account; the first-step launch guard uses the same rule.
      account = { runner: backend, id: DEFAULT_AGENT_ACCOUNT_ID, path: '' };
    } else {
      const profile = selectProfile(store, { provider: backend, repoRoot: root, profileId: chosen });
      await access(profile.path, constants.R_OK);
      account = { runner: backend, id: profile.id, path: await realpath(profile.path) };
    }
    // The runtime's first-agent guard looks up by runner, not by node or account id.
    if (accounts.some(a => a.runner === account.runner && (a.id !== account.id || a.path !== account.path))) {
      throw new DeferredResolutionError(`Workflow uses multiple accounts for ${backend}; scheduled launch cannot bind them safely. Choose one account or start now.`);
    }
    if (!accounts.some(a => a.runner === account.runner)) accounts.push(account);
  }
  const binding: DeferredBinding = { runner, accounts, models, revision: digest({ root, workflow, ...(references.length ? { references } : {}), runner, accounts, models: models.map(({ runner, model }) => ({ runner, model })), modelPolicy: agentModelsLocked(root) }) };
  return { workflow, binding, models };
}

/** Shared by preview, confirmation and launch; no model, worktree or run is created here. */
export async function resolveDeferredExecution(root: string, task: DeferredPreviewInput['task']) {
  return bindDeferredPlan(root, await resolveDeferredPlan(root, task));
}

export async function validateDeferredBinding(root: string, definition: AutomationDefinition): Promise<void> {
  if (!definition.deferredStart) return;
  const { prompt, ...fields } = definition.task;
  let current: Awaited<ReturnType<typeof resolveDeferredExecution>>;
  try { current = await resolveDeferredExecution(root, { ...fields, task: prompt }); }
  catch (error) { throw new DeferredBindingError(`${unresolvedReason(error)} Restore it and retry, or cancel and submit the task again.`); }
  if (current.binding.revision !== definition.deferredStart.binding.revision) {
    const saved = definition.deferredStart.binding;
    const withoutIdentity = (accounts: DeferredBinding['accounts']) => accounts.map(({ identity: _identity, ...account }) => account);
    const mismatch = digest(withoutIdentity(saved.accounts)) !== digest(withoutIdentity(current.binding.accounts)) ? 'Account or profile location changed'
      : saved.models && digest(saved.models) !== digest(current.binding.models) ? 'Workflow step models changed' : 'Workflow or execution settings changed';
    throw new DeferredBindingError(`${mismatch}. Cancel this scheduled task and submit it again with the intended settings.`);
  }
  for (const account of definition.deferredStart.binding.accounts) {
    if (!account.identity || account.runner !== 'codex') continue;
    const live = await probeCodexIdentity({ id: account.id, provider: 'codex', label: account.id, path: account.path, configDir: account.path, isDefault: account.id === 'default' });
    // No answer (timeout, busy probe) is not evidence of another login: let Retry try again.
    if ('unavailable' in live) throw new DeferredPrelaunchError('The signed-in Codex account could not be checked right now. Retry in a moment.');
    if (live.identity !== account.identity) throw new DeferredBindingError('The signed-in Codex account changed. Sign back in to the scheduled account and retry, or cancel and submit the task again.');
  }
}

/** A user-facing reason the saved or selected execution cannot be resolved. */
function unresolvedReason(error: unknown): string {
  if (error instanceof DeferredResolutionError) return error.message;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'EACCES') return "The selected account's profile directory is missing or unreadable. Sign in with this agent once, or choose another account.";
  const known = ['Pi supports only the default account.', 'The selected account no longer exists.', 'The selected workflow is unavailable.', 'Model selection is locked for this project.'];
  return error instanceof Error && known.includes(error.message) ? error.message : 'The workflow or account cannot be verified. Check the selected account and workflow.';
}

export type ResetResolver = (execution: Awaited<ReturnType<typeof resolveDeferredExecution>>) => Promise<{ notBefore: string; observation: string; revision: string } | { reason: string; message: string }>;
export async function previewDeferredStart(root: string, input: DeferredPreviewInput, enabled: boolean, resolveReset?: ResetResolver, now = Date.now()): Promise<{ preview: DeferredPreview; binding?: DeferredBinding; schedule?: AutomationSchedule }> {
  const unavailable = (reason: string, message: string) => ({ preview: { available: false as const, reason, message } });
  if (!enabled) return unavailable('automations-off', 'Scheduling is disabled on this server.');
  if (input.task.images?.length) return unavailable('attachments', 'Remove attachments to schedule this task.');
  if (input.task.todoId) return unavailable('linked-todo', 'Tasks linked to a todo can only start now.');
  let execution: Awaited<ReturnType<typeof resolveDeferredExecution>>;
  try { execution = await resolveDeferredExecution(root, input.task); }
  catch (error) { return unavailable('account-unverifiable', unresolvedReason(error)); }
  const timeZone = localTimeZone();
  let notBefore: string;
  let observation: string | undefined;
  let resetRevision: string | undefined;
  if (input.start.kind === 'at') {
    const instant = onceInstant({ type: 'once', ...input.start }, timeZone);
    if (instant === null || instant <= now) return unavailable('window-over', 'Choose a future date and time in the server time zone.');
    notBefore = new Date(instant).toISOString();
    for (const account of execution.binding.accounts) {
      // Dry runs mock the CLI; there is no login to read, so the profile location is the binding.
      if (account.runner !== 'codex' || process.env.CEZ_DRY_RUN === '1') continue;
      // Previews re-run as the user types; the short cache keeps that to one app-server per window.
      // Launch revalidation always reads fresh.
      const live = await probeCodexIdentity({ id: account.id, provider: 'codex', label: account.id, path: account.path, configDir: account.path, isDefault: account.id === 'default' }, { force: false });
      if ('unavailable' in live) return unavailable('account-unverifiable', 'The signed-in Codex account cannot be checked right now. Retry the preview.');
      // An API-key login exposes no identity; spec #6 falls back to the profile-location binding.
      if (live.identity) account.identity = live.identity;
    }
  } else {
    if (execution.binding.accounts.length !== 1) return unavailable('multi-account', 'Reset scheduling requires one provider and account for every agent step.');
    if (!['claude', 'codex'].includes(execution.binding.accounts[0]!.runner)) return unavailable('unsupported', 'Reset data is unavailable for this provider. Choose a date and time.');
    if (!resolveReset) return unavailable('no-data', 'No observed reset is available. Choose a date and time.');
    const reset = await resolveReset(execution);
    if ('reason' in reset) return unavailable(reset.reason, reset.message);
    ({ notBefore, observation, revision: resetRevision } = reset);
  }
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(notBefore));
  const get = (type: string) => parts.find(p => p.type === type)!.value;
  const schedule: AutomationSchedule = { type: 'once', date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')) };
  return { binding: execution.binding, schedule, preview: { available: true, notBefore, timeZone, previewRevision: digest({ root, binding: execution.binding, notBefore, resetRevision }), ...(observation ? { observation } : {}) } };
}

/** Resolve composed execution locally; opening the picker must never probe an agent. */
export async function deferredStartOptions(root: string, task: DeferredPreviewInput['task'], enabled: boolean): Promise<DeferredOptions> {
  const timeZone = localTimeZone();
  const unavailable = (reason: string, message: string) => ({ timeZone, usageReset: { available: false as const, reason, message } });
  if (!enabled) return unavailable('automations-off', 'Scheduling is disabled on this server.');
  if (task.images?.length || task.todoId) return unavailable('immediate-only', 'Attachments and linked todos can only start now.');
  try {
    const plan = await resolveDeferredPlan(root, task);
    // Capability is independent of installation: unsupported runners need no profile check.
    if (plan.work.some(step => step.runner !== 'claude' && step.runner !== 'codex')) {
      return unavailable('unsupported', 'After usage limit resets is available for Claude and Codex. Choose a date and time for this workflow.');
    }
    const { binding } = await bindDeferredPlan(root, plan);
    if (binding.accounts.length !== 1) return unavailable('multi-account', 'After usage limit resets requires one provider and account across the workflow. Choose a date and time instead.');
    const provider = binding.accounts[0]!.runner;
    if (provider !== 'claude' && provider !== 'codex') return unavailable('unsupported', 'After usage limit resets is available for Claude and Codex. Choose a date and time for this workflow.');
    return { timeZone, usageReset: { available: true, provider } };
  } catch (error) {
    return unavailable('account-unverifiable', unresolvedReason(error));
  }
}
