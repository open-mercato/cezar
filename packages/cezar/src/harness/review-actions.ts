import type { HarnessReviewActionInput, HarnessReviewActionResponse } from '@open-mercato/cezar-contract';
import { mkdirSync } from 'node:fs';
import type { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { agentModelsLocked } from '../core/agent-model-policy.ts';
import { harnessArtifactDir, snapshotHarnessReviewSubject } from './driver.ts';
import { readLedger, saveLedger } from './ledger.ts';
import { harnessActionRevision, inspectHarnessEnvironment, projectedHarnessFindings } from './review-state.ts';

export async function requestHarnessReviewAction(
  project: { root: string; dataDir: string; store: RunStore; manager: RunManager },
  id: string,
  input: HarnessReviewActionInput,
): Promise<{ ok: true; value: HarnessReviewActionResponse } | { ok: false; status: 404 | 409; error: string }> {
  const reject = (error: string, status: 404 | 409 = 409) => ({ ok: false as const, status, error });
  const { store, manager, dataDir, root } = project;
  const run = store.getRun(id);
  if (!run) return reject('not found', 404);
  if (!run.harness) return reject('This is not a multi-model run.');
  if (agentModelsLocked(root)) return reject('Unlock model selection before continuing a multi-model run.');
  if (process.env.CEZ_DRY_RUN === '1') return reject('Live multi-model actions are unavailable in dry-run mode.');
  const read = readLedger(dataDir, id);
  if (read.status !== 'valid') return reject('The review snapshot is unavailable. Restore it before continuing.');
  const ledger = read.ledger;
  if (run.archived || run.status === 'done') return reject('Reopen the task before requesting another review action.');
  if (ledger.reviewAction?.id === input.requestId) {
    if (ledger.reviewAction.action !== input.action || JSON.stringify(ledger.reviewAction.findingIds) !== JSON.stringify(input.findingIds ?? [])) {
      return reject('This action ID already identifies a different request.');
    }
    if (!manager.isActive(id) && run.status !== 'queued' && ['pending', 'running'].includes(ledger.reviewAction.status)) {
      const resumed = manager.continueRun(id);
      if (!resumed.ok) return reject(resumed.error ?? 'The run could not resume.');
    }
    return { ok: true, value: { action: ledger.reviewAction, resumed: true } };
  }
  if (manager.isActive(id) || run.status === 'queued') return reject('This run is already working. Wait for it to pause.');
  if (input.revision !== harnessActionRevision(ledger)) return reject('The review changed. Refresh it before choosing an action.');
  if (!run.worktreePath || run.worktreePath === root) return reject('This task needs its isolated worktree restored first.');
  const environment = inspectHarnessEnvironment(run.worktreePath);
  if (input.action !== 'prepare' && environment.status !== 'ready') return reject(environment.detail);
  if (input.action === 'prepare' && environment.status !== 'ready' && !environment.installCommand) {
    return reject('Repair the project setup in the task terminal, then retry verification.');
  }
  const implementationStarted = ledger.phases.some((phase) => phase.id === 'implement' && phase.status === 'done');
  if (input.action !== 'prepare' && !implementationStarted) return reject('Implementation must finish before a final verification or repair.');
  if (ledger.outcome.pendingDecision) return reject('Resolve the pending specification or council decision first.');
  if (ledger.pendingMessages.some((message) => !message.consumedAt)) return reject('Apply the queued instructions before requesting a separate review action.');
  const findings = projectedHarnessFindings(ledger);
  const selected = input.findingIds ?? [];
  if (input.action === 'fix' && selected.some((key) => !findings.some((row) => row.id === key && row.kind === 'implementation' && ['open', 'fixed-unverified'].includes(row.status)))) {
    return reject('One of the selected findings has changed or is already resolved. Refresh the review.');
  }
  let subjectSha256: string;
  try {
    mkdirSync(harnessArtifactDir(dataDir, id), { recursive: true });
    subjectSha256 = await snapshotHarnessReviewSubject(run.worktreePath, harnessArtifactDir(dataDir, id));
  } catch {
    return reject('The current worktree could not be verified. Restore it before continuing.');
  }
  const fresh = readLedger(dataDir, id);
  if (fresh.status !== 'valid' || harnessActionRevision(fresh.ledger) !== input.revision || manager.isActive(id) || store.getRun(id)?.status === 'queued') {
    return reject('The run changed while the action was being checked. Refresh the review.');
  }
  const round = 1 + Math.max(0, ...ledger.councils.filter((row) => row.kind === 'implementation').map((row) => Number(row.round) || 0));
  const action = {
    id: input.requestId, action: input.action, status: 'pending' as const,
    round, findingIds: selected, requestedAt: new Date().toISOString(), subjectSha256, onePass: implementationStarted,
  };
  ledger.findingHistory = findings;
  ledger.reviewAction = action;
  ledger.stage = { ...ledger.stage, status: 'pending' };
  ledger.outcome = { status: 'pending', blockingReasons: [] };
  saveLedger(dataDir, id, ledger);
  const resumed = manager.continueRun(id);
  if (!resumed.ok) {
    saveLedger(dataDir, id, fresh.ledger);
    return reject(`The action could not resume: ${resumed.error}`);
  }
  store.appendEvent(id, { type: 'harness.review-action.updated', action });
  store.appendEvent(id, { type: 'harness.outcome.updated', outcome: ledger.outcome });
  store.appendEvent(id, { type: 'harness.stage.updated', stage: ledger.stage });
  store.appendEvent(id, { type: 'note', message: input.action === 'prepare'
    ? 'Project setup requested. The install command runs from this task worktree; the run then resumes.'
    : input.action === 'verify' ? 'Final verification requested: checks and one fresh review, without another repair loop.'
      : `Repair requested for ${selected.length} selected finding(s): one repair pass, checks and one fresh review.` });
  return { ok: true, value: { action, resumed: true } };
}
