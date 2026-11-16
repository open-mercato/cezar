import { createHash } from 'node:crypto';
import {
  agentAdmissionConfigSchema,
  agentAdmissionDecisionSchema,
  type AgentAdmissionConfig,
  type AgentAdmissionDecision,
} from '@open-mercato/cezar-contract';
import type { RunnerId } from './core/agent-runner.ts';
import type { RunRecord } from './runs/store.ts';
import {
  isLifecycleConfigTracked,
  readLifecycleConfigRaw,
  TRACKED_CONFIG_ERROR,
} from './worktree-lifecycle/config.ts';
import { executeLifecycleCommand, type LifecycleExecutorOutput } from './worktree-lifecycle/executor.ts';

export class AgentAdmissionError extends Error {}

export interface AgentAdmissionContext {
  schemaVersion: 1;
  phase: 'before-agent';
  projectId?: string;
  projectRoot: string;
  workspace: {
    path: string;
    branch?: string;
    baseBranch?: string;
  };
  run: {
    id: string;
    title: string;
    task: string;
    issueNumber?: number;
    prNumber?: number;
    tracker?: RunRecord['automationTracker'];
    automation?: RunRecord['automation'];
    dispatch?: RunRecord['dispatch'];
  };
  launch: {
    kind: 'workflow' | 'continuation';
    stepId: string;
    runner: RunnerId;
    sessionId?: string;
  };
}
export interface AgentAdmissionResult {
  configured: boolean;
  decision: AgentAdmissionDecision;
  revision?: string;
}

async function readAgentAdmissionConfig(projectRoot: string): Promise<{ config?: AgentAdmissionConfig; revision?: string }> {
  const raw = await readLifecycleConfigRaw(projectRoot);
  if (!Object.hasOwn(raw, 'agentAdmission')) return {};
  if (await isLifecycleConfigTracked(projectRoot)) throw new AgentAdmissionError(TRACKED_CONFIG_ERROR.replace('Worktree scripts', 'Agent admission'));
  const parsed = agentAdmissionConfigSchema.safeParse(raw.agentAdmission);
  if (!parsed.success) {
    throw new AgentAdmissionError(`Invalid agent admission configuration: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  return {
    config: parsed.data,
    revision: createHash('sha256').update(JSON.stringify(raw.agentAdmission)).digest('hex'),
  };
}

/** Run the trusted local admission command in the native task workspace. */
export async function admitAgent(
  projectRoot: string,
  context: AgentAdmissionContext,
  options: {
    signal?: AbortSignal;
    onOutput?: (frame: LifecycleExecutorOutput) => Promise<void> | void;
  } = {},
): Promise<AgentAdmissionResult> {
  const loaded = await readAgentAdmissionConfig(projectRoot);
  if (!loaded.config) return { configured: false, decision: { decision: 'allow' } };

  let stdout = '';
  const result = await executeLifecycleCommand({
    command: loaded.config.beforeAgent.command,
    cwd: context.workspace.path,
    timeoutSeconds: loaded.config.beforeAgent.timeoutSeconds,
    signal: options.signal,
    env: { CEZ_AGENT_ADMISSION_CONTEXT: JSON.stringify(context) },
    onOutput: async frame => {
      if (frame.stream === 'stdout') stdout += frame.text;
      await options.onOutput?.(frame);
    },
  });
  if (result.state !== 'succeeded') {
    throw new AgentAdmissionError(`Agent admission command ${result.state}${result.reason ? `: ${result.reason}` : result.exitCode === null ? '' : ` (exit ${result.exitCode})`}`);
  }
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new AgentAdmissionError('Agent admission command must print exactly one JSON decision line');
  let raw: unknown;
  try { raw = JSON.parse(lines[0]!); }
  catch { throw new AgentAdmissionError('Agent admission command did not print valid JSON'); }
  const decision = agentAdmissionDecisionSchema.safeParse(raw);
  if (!decision.success) throw new AgentAdmissionError(`Invalid agent admission decision: ${decision.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  return { configured: true, decision: decision.data, revision: loaded.revision };
}
