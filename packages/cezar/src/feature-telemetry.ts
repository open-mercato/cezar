/**
 * Feature-usage telemetry: the closed label sets for "who uses automations, workflows, skills,
 * dispatch" (docs/telemetry.md), and the daily `feature_inventory`. Every label is a fixed
 * vocabulary — a user's own workflow, skill or automation name never leaves the machine.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Skill } from './skills.ts';
import type { WorkflowDef } from './workflows/types.ts';
import type { AutomationDefinition } from './automations/types.ts';
import { CREATE_AUTOMATION_SKILL_NAME } from './automations/prompts.ts';
import { BUILT_IN_GRAPH_WORKFLOWS } from './workflows/templates.ts';
import { QUICK_TASK_WORKFLOW } from './workflows/types.ts';
import { DEFAULT_SKILLS_REPOS, loadConfig } from './config.ts';
import { cezarHomeDir } from './paths.ts';
import { loadWorkspaceConfig } from './workspace/config.ts';
import { loadWorkflows } from './workflows/load.ts';
import { discoverLocalSkills } from './skills.ts';

/** Where a task came from — `task_origin`'s label. Callers that know set it on the start input;
 *  the rest is derived in `taskOriginOf`. */
export const TASK_ORIGINS = [
  'cockpit', 'cli', 'api', 'inbox', 'e2e_setup', 'scheduled_task',
  'automation_schedule', 'automation_github', 'automation_tracker',
  'dispatch_implement', 'dispatch_review',
] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];

export function taskOriginOf(input: {
  origin?: TaskOrigin;
  deviceSid?: string;
  dispatch?: { parentRunId?: string; kind?: string };
}): TaskOrigin {
  if (input.origin) return input.origin;
  if (input.dispatch?.parentRunId) return input.dispatch.kind === 'review' ? 'dispatch_review' : 'dispatch_implement';
  return input.deviceSid ? 'cockpit' : 'api';
}

/** The automation kind as a task origin; a composer "schedule send" is a task, not an automation. */
export function automationTaskOrigin(definition: Pick<AutomationDefinition, 'kind' | 'deferredStart'>): TaskOrigin {
  if (definition.deferredStart) return 'scheduled_task';
  return definition.kind === 'schedule' ? 'automation_schedule' : definition.kind === 'tracker' ? 'automation_tracker' : 'automation_github';
}

const BUILT_IN_WORKFLOW_NAMES: ReadonlySet<string> = new Set([QUICK_TASK_WORKFLOW.name, ...BUILT_IN_GRAPH_WORKFLOWS.map((w) => w.name)]);

/** `workflow_used`'s label: a built-in workflow by name, everything the user wrote as `custom`. */
export function workflowLabel(workflow: Pick<WorkflowDef, 'name' | 'source' | 'graph'>, dispatched: boolean): string {
  if (dispatched) return 'dispatch';
  if (workflow.source === 'file') return workflow.graph ? 'custom_graph' : 'custom';
  if (workflow.name === '(planned)') return 'planned';
  return BUILT_IN_WORKFLOW_NAMES.has(workflow.name) ? workflow.name : 'other_builtin';
}

/** The published Open Mercato skills (github.com/open-mercato/skills): public names, safe to send.
 *  A name missing here only folds into its source bucket. */
export const OPEN_MERCATO_SKILLS: ReadonlySet<string> = new Set([
  'om-apply-upgrade-notes', 'om-approve-merge-pr', 'om-auto-continue-pr', 'om-auto-continue-pr-loop',
  'om-auto-create-pr', 'om-auto-create-pr-loop', 'om-auto-fix-issue', 'om-auto-fix-pr',
  'om-auto-implement-spec', 'om-auto-manage-issues', 'om-auto-qa-pr', 'om-auto-review-pr',
  'om-auto-update-changelog', 'om-auto-write-spec', 'om-check-and-commit', 'om-close-fixed-issues',
  'om-code-review', 'om-create-skill', 'om-fix', 'om-followup-issue-from-pr', 'om-integration-tests',
  'om-merge-buddy', 'om-open-pr', 'om-prepare-issue', 'om-prepare-test-env', 'om-review-prs',
  'om-root-cause', 'om-setup-agent-pipeline', 'om-spec-writing', 'om-verify-in-repo',
]);
const OPEN_MERCATO_SKILLS_REPO = /^open-mercato\/skills(?:\.git)?$/i;

/** `skill_used`'s label: a public skill (Open Mercato's, cezar's own) by name; any other skill
 *  only as where it lives — `repo`, `global` or `team` — because its name may be private. */
export function skillLabel(skill: Pick<Skill, 'name' | 'source' | 'team'>): string {
  if (skill.source === 'builtin' && skill.name === CREATE_AUTOMATION_SKILL_NAME) return skill.name;
  if (OPEN_MERCATO_SKILLS.has(skill.name)) return skill.name;
  if (skill.source === 'team') return skill.team && OPEN_MERCATO_SKILLS_REPO.test(skill.team.repo) && /^[a-z0-9-]{1,64}$/.test(skill.name) ? skill.name : 'team';
  return skill.source === 'global' ? 'global' : 'repo';
}

/** What an automation listens to — the label of `automation_created`, `automation_deleted` and
 *  `automation_fired`.
 *  GitHub: its one event, or `github:multi`; tracker: the tracker; schedule: its cadence. */
export function automationLabel(definition: Pick<AutomationDefinition, 'kind' | 'events' | 'schedule' | 'trackerTrigger'>): string {
  if (definition.kind === 'schedule') return `schedule:${definition.schedule?.type ?? 'unknown'}`;
  if (definition.kind === 'tracker') return `tracker:${definition.trackerTrigger?.association.kind ?? 'unknown'}`;
  const events = definition.events ?? [];
  return events.length === 1 ? `github:${events[0]}` : 'github:multi';
}

/** One `feature_inventory` row: what is configured on this machine, counted. */
export interface InventoryRow {
  label: InventoryLabel;
  value: number;
}
export const INVENTORY_LABELS = [
  'projects', 'automations_enabled', 'automations_paused', 'workflows_custom',
  'skills_repo', 'skills_global', 'skills_repos_custom', 'tracker_connections',
] as const;
export type InventoryLabel = (typeof INVENTORY_LABELS)[number];

function readAutomations(root: string): Array<{ enabled?: unknown; deferredStart?: unknown }> {
  try {
    const raw = JSON.parse(readFileSync(join(root, '.ai/cezar/automations.json'), 'utf8')) as { automations?: unknown };
    return Array.isArray(raw.automations) ? raw.automations.filter((a): a is Record<string, unknown> => !!a && typeof a === 'object') : [];
  } catch {
    return [];
  }
}

function countTrackerConnections(): number {
  try {
    return readdirSync(join(cezarHomeDir(), 'tracker-connections')).filter((f) => /^[0-9a-f]{64}\.env$/.test(f)).length;
  } catch {
    return 0;
  }
}

/**
 * The daily feature inventory, across every registered project: how many automations, custom
 * workflows, skills and tracker connections exist. Read-only, never throws; a project that
 * cannot be read counts as nothing. Only non-zero rows are returned — an installation counts
 * under a label exactly when it has that feature set up.
 */
export async function collectFeatureInventory(): Promise<InventoryRow[]> {
  const counts = new Map<InventoryLabel, number>();
  const add = (label: InventoryLabel, n: number) => counts.set(label, (counts.get(label) ?? 0) + n);
  let roots: string[] = [];
  try {
    const projects = (await loadWorkspaceConfig()).projects ?? [];
    roots = projects
      .map((p) => (p && typeof p === 'object' ? (p as { root?: unknown }).root : undefined))
      .filter((root): root is string => typeof root === 'string' && existsSync(root));
  } catch {
    roots = [];
  }
  add('projects', roots.length);
  let globalSkills = 0;
  for (const root of roots) {
    try {
      for (const automation of readAutomations(root)) {
        if (automation.deferredStart) continue;
        add(automation.enabled === true ? 'automations_enabled' : 'automations_paused', 1);
      }
      const { workflows } = await loadWorkflows(root);
      add('workflows_custom', workflows.filter((w) => w.source === 'file').length);
      const skills = await discoverLocalSkills(root);
      add('skills_repo', skills.filter((s) => s.source === 'cezar' || s.source === 'ai' || s.source === 'agents').length);
      globalSkills = Math.max(globalSkills, skills.filter((s) => s.source === 'global').length);
      const { skillsRepos } = await loadConfig(root);
      if (JSON.stringify(skillsRepos) !== JSON.stringify(DEFAULT_SKILLS_REPOS) && skillsRepos.length > 0) add('skills_repos_custom', 1);
    } catch {
      // one unreadable project never hides the others
    }
  }
  add('skills_global', globalSkills);
  add('tracker_connections', countTrackerConnections());
  return INVENTORY_LABELS.map((label) => ({ label, value: counts.get(label) ?? 0 })).filter((row) => row.value > 0);
}
