import type { AgentBackend } from '../agents/agent-runner.js';
import type { Skill } from '../skills/skill-catalog.js';
import {
  formatLabelCatalogPrompt,
  type LabelPromptScope,
  type WorkspaceLabel,
} from '../labels/label-catalog.js';

/**
 * The built-in autofix step ids that exist *today* via `AutofixOrchestrator`.
 * `verify-in-repo` maps to today's already-fixed preflight + analyzer
 * `noActionNeeded`; `root-cause` = analyzer; `fix` = fixer; `review` = reviewer.
 * The full declarative workflow engine (more step kinds, loops, gates) lands in
 * Phase 2 — these ids are stable so bindings carry over.
 */
export const AUTOFIX_STEP_IDS = ['verify-in-repo', 'root-cause', 'fix', 'review'] as const;

export type WorkflowStepId = string;

/**
 * GUI/CLI-editable, per workspace (optionally per repo): which skill / backend /
 * model / extra tools to use for one workflow step. All fields nullable ⇒ "use
 * the built-in default". A bound skill *augments* the built-in step prompt; it
 * never replaces it (and can't change the step's output schema).
 */
export interface WorkflowBinding {
  stepId: WorkflowStepId;
  skillName: string | null;
  backend: AgentBackend | null;
  model: string | null;
  extraTools: string[];
}

/** Workspace-level workflow toggles. Conservative defaults: triage on, autofix off. */
export interface WorkspaceWorkflowSettings {
  autoTriageEnabled: boolean;
  autofixEnabled: boolean;
  separateCommentPerStep: boolean;
}

export const DEFAULT_WORKSPACE_WORKFLOW_SETTINGS: WorkspaceWorkflowSettings = {
  autoTriageEnabled: true,
  autofixEnabled: false,
  separateCommentPerStep: false,
};

/** The resolved per-step configuration the orchestrator actually runs with. */
export interface ResolvedStepConfig {
  systemPrompt: string;
  backend: AgentBackend;
  model: string;
  extraTools: string[];
  skillName: string | null;
}

/**
 * Resolution chain (docs §3.5): `step binding → run launch override → workspace
 * default → built-in default`.
 *  - backend = `binding?.backend ?? runOverride?.backend ?? builtinBackend ?? 'anthropic-api'`
 *  - model   = `binding?.model ?? builtinModel`
 *  - if `binding?.skillName` resolves to a known skill, its `body` is appended
 *    to the built-in system prompt under a `## Repo-specific guidance` header
 *  - extraTools = `binding?.extraTools ?? []`
 *
 * With no binding the output `systemPrompt` is the built-in prompt **verbatim**
 * (no trailing whitespace added), backend `'anthropic-api'`, model `builtinModel`.
 */
export function resolveStepConfig(args: {
  stepId: WorkflowStepId;
  builtinSystemPrompt: string;
  builtinModel: string;
  builtinBackend?: AgentBackend;
  binding?: WorkflowBinding | null;
  // TODO(phase-1a): `model` here is typed `AgentBackend` per spec — looks like a
  // copy/paste slip; kept as-spec'd, `runOverride.model` is unused for now.
  runOverride?: { backend?: AgentBackend; model?: AgentBackend };
  skills: Skill[];
  /** Workspace label catalog. When present, an entry is appended to the
   *  system prompt under "## Repository label catalog" (see
   *  {@link formatLabelCatalogPrompt}). */
  labels?: WorkspaceLabel[];
  /** Which scope of the catalog to include for this step. Defaults to `'both'`. */
  labelScope?: LabelPromptScope;
}): ResolvedStepConfig {
  const { builtinSystemPrompt, builtinModel, binding, runOverride, skills, labels, labelScope } =
    args;

  const backend: AgentBackend =
    binding?.backend ?? runOverride?.backend ?? args.builtinBackend ?? 'anthropic-api';
  const model = binding?.model ?? builtinModel;
  const extraTools = binding?.extraTools ?? [];

  let systemPrompt = builtinSystemPrompt;
  if (binding?.skillName) {
    const skill = skills.find((s) => s.name === binding.skillName);
    if (skill) {
      systemPrompt = `${builtinSystemPrompt}\n\n## Repo-specific guidance\n\n${skill.body}`;
    }
  }

  const catalog = formatLabelCatalogPrompt(labels ?? null, labelScope ?? 'both');
  if (catalog) {
    systemPrompt = `${systemPrompt}\n\n${catalog}`;
  }

  return { systemPrompt, backend, model, extraTools, skillName: binding?.skillName ?? null };
}
